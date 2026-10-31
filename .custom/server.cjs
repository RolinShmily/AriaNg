'use strict';

const fsp = require('node:fs/promises');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function port(value, name) {
    const result = Number(value);
    if (!Number.isInteger(result) || result < 1 || result > 65535) {
        throw new Error(`${name} must be an integer from 1 to 65535.`);
    }
    return result;
}

function loadOptions(env = process.env) {
    const profile = env.USERPROFILE || os.homedir();
    const options = {
        webPort: port(env.ARIA2_WEBUI_PORT || 6880, 'ARIA2_WEBUI_PORT'),
        rpcPort: port(env.ARIA2_RPC_PORT || 6800, 'ARIA2_RPC_PORT'),
        dataDir: path.resolve(env.ARIA2_DATA_DIR || path.join(profile, '.aria2')),
        downloadDir: path.resolve(env.ARIA2_DOWNLOAD_DIR || path.join(profile, 'Downloads')),
        aria2Path: path.resolve(env.ARIA2_PATH || path.join(profile, 'scoop', 'apps', 'aria2', 'current', 'aria2c.exe')),
        powershell: env.ARIA2_POWERSHELL || path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        webRoot: path.join(__dirname, 'webui'),
        startupTimeout: 30000
    };
    if (options.webPort === options.rpcPort) {
        throw new Error('WebUI and RPC must use different ports.');
    }
    return options;
}

function readSecret(config) {
    let secret = '';
    for (const line of config.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const match = /^\s*rpc-secret\s*=(.*)$/.exec(line);
        if (match) secret = match[1].trim();
    }
    if (!secret) throw new Error('aria2.conf must contain a nonempty rpc-secret.');
    return secret;
}

function rpcCall(rpcPort, secret, method, timeout = 1500) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: 'aria2-webui', method, params: [`token:${secret}`] });
        const req = http.request({
            hostname: '127.0.0.1', port: rpcPort, path: '/jsonrpc', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                text += chunk;
                if (text.length > 1024 * 1024) res.destroy(new Error('RPC response is too large.'));
            });
            res.on('error', reject);
            res.on('end', () => {
                try {
                    const response = JSON.parse(text);
                    if (res.statusCode !== 200 || response.error || !Object.hasOwn(response, 'result')) {
                        throw new Error(`aria2 RPC ${method} failed; check the local configuration.`);
                    }
                    resolve(response.result);
                } catch (error) {
                    reject(error instanceof SyntaxError ? new Error('Invalid aria2 RPC response.') : error);
                }
            });
        });
        req.setTimeout(timeout, () => req.destroy(new Error(`aria2 RPC ${method} timed out.`)));
        req.on('error', (error) => reject(new Error(`aria2 RPC ${method}: ${error.code || 'request failed'}.`)));
        req.end(body);
    });
}

async function assertPortFree(value) {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', (error) => reject(new Error(`127.0.0.1:${value} is unavailable (${error.code}).`)));
        probe.listen({ host: '127.0.0.1', port: value, exclusive: true }, () => probe.close(resolve));
    });
}

const mimeTypes = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
    '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject'
};

function isInside(root, target) {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function createWebServer({ webRoot, webPort, rpcPort, secret }) {
    const root = await fsp.realpath(webRoot);
    const hosts = new Set([`127.0.0.1:${webPort}`, `localhost:${webPort}`]);
    const runtime = {
        rpcAlias: 'Local aria2', rpcHost: '127.0.0.1', rpcPort: String(rpcPort),
        rpcInterface: 'jsonrpc', protocol: 'http', httpMethod: 'POST', rpcRequestHeaders: '', secret
    };
    const runtimeScript = `window.aria2WebUiRpc = ${JSON.stringify(runtime).replace(/</g, '\\u003c')};\n`;
    return http.createServer((req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.setHeader('Referrer-Policy', 'same-origin');
        res.setHeader('Cache-Control', 'no-store');
        const fail = (code, message) => {
            res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(req.method === 'HEAD' ? undefined : message);
        };
        const serve = async () => {
            const requestOrigin = `http://${req.headers.host}`;
            if (!hosts.has(req.headers.host) ||
                (req.headers.origin && req.headers.origin !== requestOrigin) ||
                req.headers['sec-fetch-site'] === 'cross-site') {
                fail(403, 'Local access only.');
                return;
            }
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.setHeader('Allow', 'GET, HEAD');
                fail(405, 'Method not allowed.');
                return;
            }
            let pathname;
            try {
                pathname = decodeURIComponent(req.url.split('?')[0]);
            } catch (error) {
                if (!(error instanceof URIError)) throw error;
                fail(400, 'Invalid URL.');
                return;
            }
            if (pathname === '/runtime-config.js') {
                let refererOrigin;
                try {
                    refererOrigin = new URL(req.headers.referer).origin;
                } catch (error) {
                    if (!(error instanceof TypeError)) throw error;
                }
                if (refererOrigin !== requestOrigin) {
                    fail(403, 'Load configuration from the local WebUI.');
                    return;
                }
                res.writeHead(200, { 'Content-Type': mimeTypes['.js'] });
                res.end(req.method === 'HEAD' ? undefined : runtimeScript);
                return;
            }
            if (!pathname.startsWith('/') || /[\\:\0]/.test(pathname) ||
                pathname.split('/').some((part) => part.startsWith('.'))) {
                fail(403, 'Invalid path.');
                return;
            }
            if (pathname === '/') pathname = '/index.html';
            const candidate = path.resolve(root, `.${pathname}`);
            if (!isInside(root, candidate)) {
                fail(403, 'Invalid path.');
                return;
            }
            let file;
            try {
                file = await fsp.realpath(candidate);
                if (!isInside(root, file)) {
                    fail(403, 'Invalid path.');
                    return;
                }
                if (!(await fsp.stat(file)).isFile()) {
                    fail(404, 'Not found.');
                    return;
                }
                const content = await fsp.readFile(file);
                res.writeHead(200, {
                    'Content-Type': mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream',
                    'Content-Length': content.length
                });
                res.end(req.method === 'HEAD' ? undefined : content);
            } catch (error) {
                if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
                    fail(404, 'Not found.');
                    return;
                }
                throw error;
            }
        };
        serve().catch((error) => {
            console.error(`[aria2-webui] HTTP request failed (${error.code || error.name}).`);
            if (!res.headersSent) fail(500, 'Request failed.');
            else res.destroy();
        });
    });
}

function waitForExit(child, timeout) {
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
        const finish = (exited) => {
            clearTimeout(timer);
            child.removeListener('exit', onExit);
            resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeout);
        child.once('exit', onExit);
    });
}

async function run() {
    if (process.platform !== 'win32') throw new Error('This runtime requires Windows and Scoop aria2.');
    const options = loadOptions();
    await fsp.access(path.join(options.webRoot, 'index.html'));
    await fsp.access(options.aria2Path);
    await assertPortFree(options.rpcPort);
    await assertPortFree(options.webPort);

    let child;
    let server;
    let secret;
    let rpcReady = false;
    let stopping = false;
    let stopPromise;
    const stop = (code) => {
        if (stopPromise) return stopPromise;
        stopping = true;
        stopPromise = (async () => {
            if (server) {
                server.close();
                server.closeAllConnections();
            }
            if (rpcReady) {
                for (const method of ['aria2.saveSession', 'aria2.shutdown']) {
                    try {
                        await rpcCall(options.rpcPort, secret, method, 1000);
                    } catch (error) {
                        console.error(`[aria2-webui] ${error.message}`);
                    }
                }
            }
            if (!(await waitForExit(child, rpcReady ? 7000 : 1000))) {
                if (rpcReady) {
                    try {
                        await rpcCall(options.rpcPort, secret, 'aria2.forceShutdown', 1000);
                    } catch (error) {
                        console.error(`[aria2-webui] ${error.message}`);
                    }
                }
                if (!(await waitForExit(child, 1000))) {
                    console.error('[aria2-webui] Launcher did not exit; terminating its process tree.');
                    try {
                        await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 2000 });
                    } catch (error) {
                        console.error(`[aria2-webui] Process cleanup failed (${error.code || error.name}); aria2 also monitors this supervisor PID.`);
                    }
                }
            }
            process.exit(code);
        })();
        return stopPromise;
    };
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => void stop(0));
    process.on('message', (message) => { if (message === 'shutdown') void stop(0); });
    process.on('disconnect', () => void stop(0));

    try {
        child = spawn(options.powershell, [
            '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-File', path.join(__dirname, 'start-aria2.ps1'),
            '-DataDir', options.dataDir, '-DownloadDir', options.downloadDir,
            '-RpcPort', String(options.rpcPort), '-ParentProcessId', String(process.pid),
            '-Aria2Path', options.aria2Path
        ], { shell: false, detached: false, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
        let childError;
        child.on('error', (error) => { childError = error; });
        child.on('exit', (code) => {
            if (!stopping && rpcReady) {
                console.error(`[aria2-webui] aria2 launcher exited unexpectedly (code ${code}).`);
                void stop(1);
            }
        });
        console.log('[aria2-webui] Starting Scoop aria2; waiting for authenticated RPC.');
        const deadline = Date.now() + options.startupTimeout;
        let lastError;
        while (!stopping && Date.now() < deadline) {
            if (childError) throw new Error(`Cannot start PowerShell (${childError.code || childError.name}).`);
            if (child.exitCode !== null || child.signalCode !== null) throw new Error('aria2 exited before RPC became ready.');
            try {
                secret = readSecret(await fsp.readFile(path.join(options.dataDir, 'aria2.conf'), 'utf8'));
                await rpcCall(options.rpcPort, secret, 'aria2.getVersion', 700);
                rpcReady = true;
                break;
            } catch (error) {
                lastError = error;
                await delay(200);
            }
        }
        if (stopping) return;
        if (!rpcReady) throw new Error(`RPC startup timed out. ${lastError ? lastError.message : ''}`);
        if (child.exitCode !== null || child.signalCode !== null) throw new Error('aria2 exited during startup.');
        server = await createWebServer({ ...options, secret });
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(options.webPort, '127.0.0.1', resolve);
        });
        server.on('error', (error) => {
            console.error(`[aria2-webui] Web server failed (${error.code || error.name}).`);
            void stop(1);
        });
        if (stopping) return;
        console.log(`[aria2-webui] Ready: http://127.0.0.1:${options.webPort}`);
        if (process.send) process.send('ready');
    } catch (error) {
        console.error(`[aria2-webui] ${error.message}`);
        await stop(1);
    }
}

module.exports = { loadOptions, readSecret, rpcCall, createWebServer, assertPortFree };
if (require.main === module) {
    run().catch((error) => {
        console.error(`[aria2-webui] ${error.message}`);
        process.exitCode = 1;
    });
}
