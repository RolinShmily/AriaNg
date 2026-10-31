'use strict';

// Run with: node --test .custom/test.cjs (no frontend dependencies or PM2 required).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { randomBytes } = require('node:crypto');
const { fork, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { loadOptions, readSecret, rpcCall, createWebServer, assertPortFree } = require('./server.cjs');
const { normalizeLock } = require('./install-deps.cjs');

const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const unitTimeout = 10000;

async function bounded(operation, timeout, description) {
    let timer;
    try {
        return await Promise.race([operation, new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}.`)), timeout);
        })]);
    } finally {
        clearTimeout(timer);
    }
}

async function temporaryDirectory(t, beforeRemoval = async () => {}) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aria2 runtime 测试 '));
    t.after(async () => {
        await beforeRemoval();
        await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    return root;
}

async function listen(server, port = 0) {
    await bounded(new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve();
        });
    }), 2000, 'loopback listen');
    return server.address().port;
}

async function close(server) {
    if (!server.listening) return;
    await bounded(new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        if (server.closeAllConnections) server.closeAllConnections();
    }), 2000, 'test server close');
}

async function unusedPort() {
    const server = net.createServer();
    const port = await listen(server);
    await close(server);
    return port;
}

function request(port, requestPath = '/', { method = 'GET', headers = {}, body, timeout = 2000 } = {}) {
    return new Promise((resolve, reject) => {
        // Pass the raw path so Node's URL normalization cannot hide traversal attempts.
        const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method,
            agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('error', reject);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.setTimeout(timeout, () => req.destroy(new Error('Test HTTP request timed out.')));
        req.on('error', reject);
        req.end(body);
    });
}

async function eventually(predicate, timeout, description) {
    const deadline = Date.now() + timeout;
    do {
        if (await predicate()) return;
        await sleep(75);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${description}.`);
}

function portClosed(port) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: '127.0.0.1', port });
        socket.setTimeout(500);
        socket.once('connect', () => { socket.destroy(); resolve(false); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
        socket.once('error', (error) => {
            socket.destroy();
            if (error.code === 'ECONNREFUSED') resolve(true);
            else reject(error);
        });
    });
}

test('loadOptions validates ports and resolves only explicitly supplied fixture paths', { timeout: unitTimeout }, () => {
    const profile = path.resolve(os.tmpdir(), 'synthetic profile 测试');
    const defaults = loadOptions({ USERPROFILE: profile });
    assert.equal(defaults.webPort, 6880);
    assert.equal(defaults.rpcPort, 6800);
    assert.equal(defaults.dataDir, path.join(profile, '.aria2'));
    assert.equal(defaults.downloadDir, path.join(profile, 'Downloads'));
    assert.equal(defaults.aria2Path, path.join(profile, 'scoop', 'apps', 'aria2', 'current', 'aria2c.exe'));
    assert.equal(defaults.webRoot, path.join(__dirname, 'webui'));
    for (const name of ['ARIA2_WEBUI_PORT', 'ARIA2_RPC_PORT']) {
        for (const value of ['0', '-1', '65536', '1.5', 'NaN', 'Infinity', '6800x', ' ']) {
            assert.throws(() => loadOptions({ USERPROFILE: profile, [name]: value }),
                new RegExp(`${name} must be an integer`));
        }
    }
    assert.throws(() => loadOptions({ ARIA2_WEBUI_PORT: '45678', ARIA2_RPC_PORT: '45678' }), /different ports/);
    const explicit = loadOptions({ USERPROFILE: profile, ARIA2_WEBUI_PORT: '1', ARIA2_RPC_PORT: '65535',
        ARIA2_DATA_DIR: 'fixture data', ARIA2_DOWNLOAD_DIR: 'fixture downloads',
        ARIA2_PATH: 'fixture aria2.exe', ARIA2_POWERSHELL: 'fixture powershell.exe' });
    assert.equal(explicit.webPort, 1);
    assert.equal(explicit.rpcPort, 65535);
    assert.equal(explicit.dataDir, path.resolve('fixture data'));
    assert.equal(explicit.downloadDir, path.resolve('fixture downloads'));
    assert.equal(explicit.aria2Path, path.resolve('fixture aria2.exe'));
    assert.equal(explicit.powershell, 'fixture powershell.exe');
});

test('readSecret uses the last assignment, ignores comments, handles BOM and refuses an empty effective secret', () => {
    const secret = randomBytes(32).toString('hex');
    const config = `\uFEFF# rpc-secret=ignored\r\nrpc-secret=old\r\n rpc-secret = ${secret} \r\n; rpc-secret=ignored\r\n`;
    // Boolean comparisons ensure assertion diagnostics never print a credential.
    assert.ok(readSecret(config) === secret, 'the final active assignment must win');
    assert.ok(readSecret(`rpc-secret=\nrpc-secret=${secret}\n`) === secret);
    for (const invalid of ['', '# rpc-secret=comment', 'RPC-SECRET=wrong-case',
        `rpc-secret=${secret}\nrpc-secret= \t\r\n`]) {
        assert.throws(() => readSecret(invalid), /nonempty rpc-secret/);
    }
});

test('assertPortFree rejects an occupied loopback port and releases its successful probe', { timeout: unitTimeout }, async (t) => {
    const occupied = net.createServer();
    t.after(() => close(occupied));
    const port = await listen(occupied);
    await assert.rejects(assertPortFree(port), /unavailable \(EADDRINUSE\)/);
    await close(occupied);
    await assertPortFree(port);
    assert.equal(await listen(occupied, port), port);
});

test('rpcCall authenticates requests and rejects bad responses, disconnects and timeouts', { timeout: unitTimeout }, async (t) => {
    const secret = randomBytes(32).toString('hex');
    let received;
    const mock = http.createServer(async (req, res) => {
        let body = '';
        for await (const chunk of req) body += chunk;
        received = { method: req.method, url: req.url, contentType: req.headers['content-type'],
            length: Number(req.headers['content-length']), bytes: Buffer.byteLength(body), json: JSON.parse(body) };
        switch (received.json.method) {
        case 'aria2.getVersion': res.end(JSON.stringify({ jsonrpc: '2.0', id: 'aria2-webui', result: { version: 'fixture' } })); break;
        case 'test.invalid': res.end('invalid JSON'); break;
        case 'test.error': res.end(JSON.stringify({ error: { code: 1, message: 'fixture' } })); break;
        case 'test.missing': res.end('{}'); break;
        case 'test.status': res.writeHead(503); res.end('{"result":true}'); break;
        case 'test.large': res.end('x'.repeat(1024 * 1024 + 1)); break;
        case 'test.disconnect': req.socket.destroy(); break;
        case 'test.timeout': break; // The client deadline must destroy this request.
        default: res.end('{"result":null}');
        }
    });
    t.after(() => close(mock));
    const port = await listen(mock);
    assert.deepEqual(await rpcCall(port, secret, 'aria2.getVersion'), { version: 'fixture' });
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/jsonrpc');
    assert.equal(received.contentType, 'application/json');
    assert.equal(received.length, received.bytes);
    assert.equal(received.json.jsonrpc, '2.0');
    assert.equal(received.json.method, 'aria2.getVersion');
    assert.equal(received.json.params.length, 1);
    assert.ok(received.json.params[0] === `token:${secret}`, 'request uses the test credential');
    assert.equal(await rpcCall(port, secret, 'test.null'), null);
    for (const method of ['invalid', 'error', 'missing', 'status', 'large', 'disconnect', 'timeout']) {
        const started = Date.now();
        await assert.rejects(rpcCall(port, secret, `test.${method}`, 150), (error) => {
            assert.ok(error instanceof Error);
            assert.ok(!error.message.includes(secret), 'RPC errors must not expose credentials');
            return true;
        });
        assert.ok(Date.now() - started < 2500, 'failed requests must finish within a bounded interval');
    }
});

test('createWebServer confines static files and protects runtime configuration', { timeout: 20000 }, async (t) => {
    let server;
    const root = await temporaryDirectory(t, async () => { if (server) await close(server); });
    const webRoot = path.join(root, 'webui');
    const outside = path.join(root, 'webui-private');
    await fs.mkdir(path.join(webRoot, 'assets'), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>isolated fixture</title>');
    await fs.writeFile(path.join(webRoot, 'assets', 'hello 中文.js'), 'window.fixture = true;');
    await fs.writeFile(path.join(webRoot, '.hidden'), 'hidden fixture');
    await fs.writeFile(path.join(outside, 'outside.txt'), 'outside fixture');
    // Directory junctions do not require Windows' file-symlink privilege.
    await fs.symlink(outside, path.join(webRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    const secret = `${randomBytes(16).toString('hex')}</script><script>fixture</script>`;
    const webPort = await unusedPort();
    server = await createWebServer({ webRoot, webPort, rpcPort: 43210, secret });
    await listen(server, webPort);
    const origin = `http://127.0.0.1:${webPort}`;
    await t.test('serves only fixture assets, supports HEAD and sets security headers', async () => {
        const index = await request(webPort, '/?cache=fixture');
        assert.equal(index.status, 200);
        assert.equal(index.body, '<!doctype html><title>isolated fixture</title>');
        assert.match(index.headers['content-type'], /^text\/html/);
        assert.equal(index.headers['cache-control'], 'no-store');
        assert.equal(index.headers['x-content-type-options'], 'nosniff');
        assert.equal(index.headers['cross-origin-resource-policy'], 'same-origin');
        assert.equal(index.headers['referrer-policy'], 'same-origin');
        const assetPath = '/assets/hello%20%E4%B8%AD%E6%96%87.js';
        const asset = await request(webPort, assetPath);
        assert.equal(asset.status, 200);
        assert.equal(asset.body, 'window.fixture = true;');
        assert.match(asset.headers['content-type'], /^text\/javascript/);
        const head = await request(webPort, assetPath, { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(head.body, '');
        assert.equal(Number(head.headers['content-length']), Buffer.byteLength(asset.body));
        assert.equal((await request(webPort, '/missing')).status, 404);
        assert.equal((await request(webPort, '/assets')).status, 404);
        assert.equal((await request(webPort, '/%E0%A4%A')).status, 400);
        const post = await request(webPort, '/', { method: 'POST' });
        assert.equal(post.status, 405);
        assert.equal(post.headers.allow, 'GET, HEAD');
    });
    await t.test('blocks traversal, dotfiles, Windows path syntax and links outside the real root', async () => {
        for (const target of ['/../webui-private/outside.txt', '/%2e%2e/webui-private/outside.txt',
            '/assets/../../webui-private/outside.txt', '/assets/%2e%2e/%2e%2e/webui-private/outside.txt',
            '/%2ehidden', '/.hidden', '/assets/.git/config', '/%5c..%5cwebui-private%5coutside.txt',
            '/C:%5cWindows%5cwin.ini', '/index.html:stream', '/%00index.html', '/escape/outside.txt',
            '/.custom/server.cjs', '/server.cjs', '/aria2.conf']) {
            const response = await request(webPort, target);
            assert.ok([403, 404].includes(response.status), `must deny ${target}`);
            assert.ok(!response.body.includes('outside fixture'));
            assert.ok(!response.body.includes('hidden fixture'));
            assert.ok(!response.body.includes(secret));
        }
    });
    await t.test('rejects hostile hosts, origins and cross-site fetches before serving assets', async () => {
        for (const headers of [{ Host: `attacker.invalid:${webPort}` }, { Host: `127.0.0.1:${webPort + 1}` },
            { Origin: 'https://attacker.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
            const response = await request(webPort, '/', { headers });
            assert.equal(response.status, 403);
            assert.equal(response.headers['access-control-allow-origin'], undefined);
        }
    });
    await t.test('runtime JS requires a local referer, is executable, escapes HTML and is never cached', async () => {
        for (const referer of [undefined, 'invalid URL', 'https://attacker.invalid/',
            `${origin}.attacker.invalid/`, 'null', `https://127.0.0.1:${webPort}/`, `http://127.0.0.1:${webPort + 1}/`]) {
            const response = await request(webPort, '/runtime-config.js', { headers: referer === undefined ? {} : { Referer: referer } });
            assert.equal(response.status, 403);
            assert.ok(!response.body.includes(secret));
            assert.equal(response.headers['cache-control'], 'no-store');
        }
        for (const host of [`127.0.0.1:${webPort}`, `localhost:${webPort}`]) {
            const otherHost = host.startsWith('127.') ? `localhost:${webPort}` : `127.0.0.1:${webPort}`;
            assert.equal((await request(webPort, '/runtime-config.js', {
                headers: { Host: host, Referer: `http://${otherHost}/` }
            })).status, 403, 'local aliases still have different origins');
            assert.equal((await request(webPort, '/', {
                headers: { Host: host, Origin: `http://${otherHost}` }
            })).status, 403, 'Origin must match the requested host exactly');
            const response = await request(webPort, '/runtime-config.js?fixture=1', {
                headers: { Host: host, Referer: `http://${host}/index.html`, 'Sec-Fetch-Site': 'same-origin' }
            });
            assert.equal(response.status, 200);
            assert.match(response.headers['content-type'], /^text\/javascript/);
            assert.equal(response.headers['cache-control'], 'no-store');
            assert.equal(response.headers['access-control-allow-origin'], undefined);
            assert.ok(!response.body.includes('</script>'), 'HTML delimiters must be escaped');
            const sandbox = { window: {} };
            vm.runInNewContext(response.body, sandbox, { timeout: 500 });
            const rpc = sandbox.window.aria2WebUiRpc;
            assert.ok(rpc.secret === secret, 'runtime JS carries only the fixture credential');
            assert.equal(rpc.rpcHost, '127.0.0.1');
            assert.equal(rpc.rpcPort, '43210');
            assert.equal(rpc.rpcInterface, 'jsonrpc');
            assert.equal(rpc.httpMethod, 'POST');
            const head = await request(webPort, '/runtime-config.js', { method: 'HEAD',
                headers: { Host: host, Referer: `http://${host}/` } });
            assert.equal(head.status, 200);
            assert.equal(head.body, '');
            assert.equal(head.headers['cache-control'], 'no-store');
        }
    });
});

test('legacy lock compatibility preserves every locked source and integrity without modifying its input', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const original = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
    const snapshot = JSON.stringify(original);
    const normalized = normalizeLock(manifest, original);
    assert.equal(JSON.stringify(original), snapshot);
    if (original.lockfileVersion !== 1) {
        assert.equal(normalized, original);
        return;
    }
    let count = 0;
    function compare(deps, parent = '') {
        for (const [name, entry] of Object.entries(deps || {})) {
            const location = `${parent}node_modules/${name}`;
            const converted = normalized.packages[location];
            assert.ok(converted, `missing locked dependency ${location}`);
            assert.equal(converted.integrity, entry.integrity);
            if (String(entry.version).startsWith('git+')) {
                assert.equal(converted.resolved, entry.version);
                assert.equal(converted.version, '1.1.2');
            } else {
                assert.equal(converted.version, entry.version);
                assert.equal(converted.resolved, entry.resolved);
            }
            count++;
            compare(entry.dependencies, `${location}/`);
        }
    }
    compare(original.dependencies);
    assert.equal(Object.keys(normalized.packages).length, count + 1);
    const changed = JSON.parse(snapshot);
    changed.dependencies['angular-input-dropdown'].version += '-different-commit';
    assert.throws(() => normalizeLock(manifest, changed), /Unrecognized Git dependency/);
});

// Discover only the executable. Never open the user's aria2 configuration or session.
const scoopAria2 = path.join(process.env.USERPROFILE || os.homedir(), 'scoop', 'apps', 'aria2', 'current', 'aria2c.exe');

async function authenticatedRpc(port, secret, method, params = []) {
    const response = await request(port, '/jsonrpc', { method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'isolated-test', method, params: [`token:${secret}`, ...params] }) });
    assert.equal(response.status, 200, 'test-owned RPC must return HTTP 200');
    let result;
    try { result = JSON.parse(response.body); }
    catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error('Test-owned RPC returned invalid JSON.');
    }
    assert.ok(!result.error, `test-owned RPC ${method} must succeed`);
    return result.result;
}

function startSupervisor(serverPath, env, cwd) {
    // Do not inherit ARIA2_* or NODE_OPTIONS from the user's shell. Logs are deliberately
    // discarded: assertion output must never disclose test or user credentials.
    const safeEnv = {};
    for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP']) {
        if (process.env[name] !== undefined) safeEnv[name] = process.env[name];
    }
    const child = fork(serverPath, [], { cwd, env: { ...safeEnv, ...env }, execArgv: [],
        windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    const state = { child, ready: false, exited: false, code: null, signal: null, failed: false };
    child.on('message', (message) => { if (message === 'ready') state.ready = true; });
    child.on('error', () => { state.failed = true; });
    child.on('exit', (code, signal) => { state.exited = true; state.code = code; state.signal = signal; });
    return state;
}

async function waitReady(state) {
    await eventually(() => {
        assert.ok(!state.failed && !state.exited, 'isolated supervisor must remain alive until IPC ready');
        return state.ready;
    }, 40000, 'supervisor IPC ready');
}

async function waitExited(state, timeout = 18000) {
    await eventually(() => state.exited, timeout, 'supervisor exit');
}

test('Windows Scoop aria2: isolated IPC startup, session persistence, restart and unexpected exit',
    { timeout: 120000, skip: process.platform !== 'win32' ? 'requires Windows and Scoop aria2' : false }, async (t) => {
        try { await fs.access(scoopAria2); }
        catch (error) {
            if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
            t.skip('Scoop aria2 is not installed');
            return;
        }
        const states = [];
        let webPort;
        let rpcPort;
        const secret = randomBytes(32).toString('hex');
        const localSource = http.createServer((req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '7' });
            res.end('fixture');
        });
        const root = await temporaryDirectory(t, cleanupOwned);
        const packageDir = path.join(root, '独立 runtime package');
        const dataDir = path.join(root, '独立 DataDir');
        const downloadDir = path.join(root, '独立 Downloads');
        const profileDir = path.join(root, '独立 profile');
        await fs.mkdir(path.join(packageDir, 'webui'), { recursive: true });
        await fs.mkdir(dataDir);
        await fs.mkdir(downloadDir);
        await fs.mkdir(profileDir);
        for (const filename of ['server.cjs', 'start-aria2.ps1']) {
            await fs.copyFile(path.join(__dirname, filename), path.join(packageDir, filename));
        }
        await fs.writeFile(path.join(packageDir, 'webui', 'index.html'), '<title>独立 lifecycle fixture</title>');
        webPort = await unusedPort();
        for (let attempt = 0; attempt < 10; attempt++) {
            rpcPort = await unusedPort();
            if (rpcPort !== webPort) break;
        }
        assert.notEqual(rpcPort, webPort, 'fixture ports must differ');
        const configPath = path.join(dataDir, 'aria2.conf');
        const sessionPath = path.join(dataDir, 'aria2.session');
        const config = [
            '# Owned exclusively by node:test. Preserve this configuration across restart.',
            `dir=${downloadDir}`, `rpc-secret=${secret}`, 'enable-rpc=true', 'rpc-listen-all=false',
            `rpc-listen-port=${rpcPort}`, 'daemon=false', 'continue=true', 'enable-dht=false',
            'enable-dht6=false', 'enable-peer-exchange=false', 'bt-enable-lpd=false',
            'show-console-readout=false', 'summary-interval=0', `input-file=${sessionPath}`,
            `save-session=${sessionPath}`, 'save-session-interval=60', 'max-concurrent-downloads=2', ''
        ].join('\r\n');
        await fs.writeFile(configPath, config);
        const env = { USERPROFILE: profileDir, HOME: profileDir, NODE_ENV: 'test',
            ARIA2_WEBUI_PORT: String(webPort), ARIA2_RPC_PORT: String(rpcPort),
            ARIA2_DATA_DIR: dataDir, ARIA2_DOWNLOAD_DIR: downloadDir, ARIA2_PATH: scoopAria2 };
        const sourcePort = await listen(localSource);
        let sourceRequests = 0;
        localSource.on('request', () => { sourceRequests++; });
        // Stop owned processes before deleting their configuration and session files.
        async function cleanupOwned() {
            await close(localSource);
            for (const state of states) {
                if (!state.exited && state.child.connected) {
                    try {
                        await bounded(new Promise((resolve) => state.child.send('shutdown', () => resolve())),
                            2000, 'cleanup IPC send');
                    } catch (error) {
                        t.diagnostic(`Owned IPC cleanup: ${error.name}; continuing with RPC/process cleanup.`);
                    }
                }
            }
            // Only the authenticated test RPC endpoint may be asked to shut down.
            if (states.length && !(await portClosed(rpcPort))) {
                try { await authenticatedRpc(rpcPort, secret, 'aria2.forceShutdown'); }
                catch (error) { t.diagnostic(`Owned RPC cleanup: ${error.code || error.name}`); }
            }
            for (const state of states) {
                if (state.exited) continue;
                try { await waitExited(state, 12000); }
                catch (error) {
                    if (state.exited) continue;
                    try {
                        await execFileAsync('taskkill.exe', ['/PID', String(state.child.pid), '/T', '/F'],
                            { windowsHide: true, timeout: 3000 });
                    } catch (killError) {
                        if (!state.exited) throw new Error(`Owned process cleanup failed (${killError.code || killError.name}).`);
                    }
                    await waitExited(state, 3000);
                }
            }
            if (states.length) {
                await eventually(async () => (await portClosed(webPort)) && (await portClosed(rpcPort)),
                    5000, 'owned ports to close during cleanup');
            }
        }
        const serverPath = path.join(packageDir, 'server.cjs');
        const first = startSupervisor(serverPath, env, packageDir);
        states.push(first);
        await waitReady(first);
        assert.equal((await request(webPort)).body, '<title>独立 lifecycle fixture</title>');
        assert.equal((await request(webPort, '/runtime-config.js')).status, 403);
        const runtime = await request(webPort, '/runtime-config.js', { headers: { Referer: `http://127.0.0.1:${webPort}/` } });
        assert.equal(runtime.status, 200);
        assert.equal(runtime.headers['cache-control'], 'no-store');
        const sandbox = { window: {} };
        vm.runInNewContext(runtime.body, sandbox, { timeout: 500 });
        assert.ok(sandbox.window.aria2WebUiRpc.secret === secret, 'supervisor reuses the test-generated key');
        const version = await rpcCall(rpcPort, secret, 'aria2.getVersion');
        assert.ok(typeof version.version === 'string');
        const uri = `http://127.0.0.1:${sourcePort}/paused-fixture.bin`;
        const gid = await authenticatedRpc(rpcPort, secret, 'aria2.addUri', [[uri], { pause: 'true', dir: downloadDir }]);
        assert.match(gid, /^[a-f0-9]{16}$/i);
        const paused = await authenticatedRpc(rpcPort, secret, 'aria2.tellStatus', [gid, ['gid', 'status', 'dir']]);
        assert.equal(paused.status, 'paused');
        assert.equal(path.resolve(paused.dir), downloadDir);
        await bounded(new Promise((resolve, reject) => first.child.send('shutdown', (error) => error ? reject(error) : resolve())),
            2000, 'graceful shutdown IPC send');
        await waitExited(first);
        assert.equal(first.code, 0, 'IPC shutdown must exit successfully');
        assert.equal(first.signal, null);
        await eventually(async () => (await portClosed(webPort)) && (await portClosed(rpcPort)), 5000, 'both ports after graceful shutdown');
        const session = await fs.readFile(sessionPath, 'utf8');
        assert.ok(session.includes(uri), 'saved session must include the paused local task');
        assert.ok((await fs.readFile(configPath, 'utf8')) === config, 'launcher preserves existing configuration byte for byte');
        const second = startSupervisor(serverPath, env, packageDir);
        states.push(second);
        await waitReady(second);
        const restored = await authenticatedRpc(rpcPort, secret, 'aria2.tellWaiting', [0, 100, ['gid', 'status', 'files']]);
        const restoredTask = restored.find((item) => item.files.some((file) => file.uris.some((entry) => entry.uri === uri)));
        assert.ok(restoredTask, 'restart restores the task from the saved session');
        assert.equal(restoredTask.status, 'paused');
        assert.equal(restoredTask.gid, gid);
        assert.ok(readSecret(await fs.readFile(configPath, 'utf8')) === secret, 'restart preserves the test key');
        assert.ok((await fs.readFile(configPath, 'utf8')) === config, 'restart leaves configuration unchanged');
        assert.equal((await request(webPort)).status, 200);
        assert.equal(sourceRequests, 0, 'a paused task must never fetch even the local fixture');
        assert.deepEqual(await fs.readdir(downloadDir), [], 'paused task leaves the independent download directory empty');
        await authenticatedRpc(rpcPort, secret, 'aria2.shutdown');
        await waitExited(second);
        assert.ok(Number.isInteger(second.code) && second.code !== 0,
            'aria2 exiting without an IPC shutdown must make the supervisor fail');
        await eventually(async () => (await portClosed(webPort)) && (await portClosed(rpcPort)), 5000, 'both ports after unexpected aria2 exit');
    });
