'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const gitPackage = 'angular-input-dropdown';
const gitSource = 'git+https://github.com/mayswind/angular-input-dropdown.git#68670e39816698b3eb98c0e740a0efe77d5fbdd1';

function normalizeLock(manifest, lock) {
    if (lock.lockfileVersion !== 1) return lock;
    const packages = { '': {
        name: manifest.name, version: manifest.version, engines: manifest.engines,
        dependencies: manifest.dependencies, devDependencies: manifest.devDependencies
    } };
    function visit(dependencies, parent = '', ancestors = []) {
        for (const [name, entry] of Object.entries(dependencies || {})) {
            const location = `${parent}node_modules/${name}`;
            const item = {};
            for (const key of ['version', 'resolved', 'integrity', 'dev', 'optional']) {
                if (Object.hasOwn(entry, key)) item[key] = entry[key];
            }
            if (String(entry.version).startsWith('git+')) {
                if (name !== gitPackage || entry.version !== gitSource || manifest.dependencies[name] !== gitSource) {
                    throw new Error(`Unrecognized Git dependency in legacy lock: ${name}.`);
                }
                // The pinned commit's package.json declares 1.1.2. The source stays pinned.
                item.version = '1.1.2';
                item.resolved = gitSource;
            }
            if (entry.bundled) item.inBundle = true;
            const scopes = [entry.dependencies || {}, dependencies, ...ancestors];
            for (const [required, range] of Object.entries(entry.requires || {})) {
                const targetScope = scopes.find((scope) => Object.hasOwn(scope, required));
                const optional = targetScope && targetScope[required].optional && !entry.optional;
                const key = optional ? 'optionalDependencies' : 'dependencies';
                if (!item[key]) item[key] = {};
                item[key][required] = range;
            }
            packages[location] = item;
            visit(entry.dependencies, `${location}/`, [dependencies, ...ancestors]);
        }
    }
    visit(lock.dependencies);
    return { name: lock.name, version: lock.version, lockfileVersion: 3, requires: true, packages };
}

function npmCommand(args) {
    if (process.platform !== 'win32') return { command: 'npm', args };
    const executableDir = path.dirname(fs.realpathSync(process.execPath));
    const candidates = [
        process.env.npm_execpath,
        path.join(executableDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    ].filter(Boolean);
    const cli = candidates.find((candidate) => path.basename(candidate) === 'npm-cli.js' && fs.existsSync(candidate));
    if (!cli) throw new Error('Cannot locate npm-cli.js next to Node.js. Install Node.js with its bundled npm.');
    return { command: process.execPath, args: [cli, ...args] };
}

function canonicalSource(source) {
    return source && source.replace('git+ssh://git@github.com/', 'git+https://github.com/');
}

function verifyInstalled(directory, lock) {
    const hidden = JSON.parse(fs.readFileSync(path.join(directory, 'node_modules', '.package-lock.json'), 'utf8'));
    for (const [location, expected] of Object.entries(lock.packages)) {
        if (!location) continue;
        const actual = hidden.packages[location];
        if (!actual && expected.optional) continue; // OS-specific optional packages may be omitted.
        if (!actual || actual.version !== expected.version || actual.integrity !== expected.integrity ||
            canonicalSource(actual.resolved) !== canonicalSource(expected.resolved)) {
            throw new Error(`Installed dependency does not match the locked version/source/integrity: ${location}.`);
        }
    }
}

function install() {
    const root = path.resolve(__dirname, '..');
    const destination = path.join(root, 'node_modules');
    if (fs.existsSync(destination)) {
        throw new Error('node_modules already exists. Use the existing install, or move it aside before running this installer.');
    }
    const manifest = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    const lock = normalizeLock(JSON.parse(manifest), JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')));
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ariang-build-deps-'));
    try {
        fs.writeFileSync(path.join(temporary, 'package.json'), manifest);
        fs.writeFileSync(path.join(temporary, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n');
        const npm = npmCommand(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error']);
        const result = spawnSync(npm.command, npm.args, { cwd: temporary, shell: false, stdio: 'inherit' });
        if (result.error) throw result.error;
        if (result.status !== 0) throw new Error(`npm ci failed (${result.signal || result.status}).`);
        verifyInstalled(temporary, lock);
        if (fs.existsSync(destination)) throw new Error('Another install created node_modules; leaving it untouched.');
        try {
            fs.renameSync(path.join(temporary, 'node_modules'), destination);
        } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            fs.cpSync(path.join(temporary, 'node_modules'), destination, { recursive: true, errorOnExist: true, force: false });
        }
        console.log('Locked build dependencies installed; repository manifests and lockfile were not changed.');
    } finally {
        fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
}

module.exports = { normalizeLock, verifyInstalled };
if (require.main === module) {
    try {
        install();
    } catch (error) {
        console.error(`Dependency install failed: ${error.message}`);
        process.exitCode = 1;
    }
}
