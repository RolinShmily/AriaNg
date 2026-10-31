'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const outputRoot = path.join(repositoryRoot, 'build', 'aria2-webui');
const distRoot = path.join(repositoryRoot, 'dist');
const runtimeFiles = [
    ['server.cjs', 'server.cjs'],
    ['start-aria2.ps1', 'start-aria2.ps1'],
    ['ecosystem.config.cjs', 'ecosystem.config.cjs'],
    ['README.md', 'README.md'],
    ['managed-rpc.js', 'webui/managed-rpc.js']
];
const runtimeScripts = '<script src="/runtime-config.js"></script>' +
    '<script src="managed-rpc.js"></script>';

function requireFile(filePath) {
    if (!fs.statSync(filePath).isFile()) {
        throw new Error(`Expected a regular file: ${filePath}`);
    }
}

function verifyAssets(webRoot, html) {
    const check = (base, reference) => {
        if (/^(?:[a-z]+:|\/\/|#)/i.test(reference) || reference === '/runtime-config.js') return;
        const pathname = reference.split(/[?#]/)[0].trim();
        requireFile(path.resolve(reference.startsWith('/') ? webRoot : base,
            reference.startsWith('/') ? `.${pathname}` : pathname));
    };
    for (const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) {
        check(webRoot, match[1]);
    }
    const cssRoot = path.join(webRoot, 'css');
    for (const file of fs.readdirSync(cssRoot)) {
        const css = fs.readFileSync(path.join(cssRoot, file), 'utf8');
        for (const match of css.matchAll(/url\(['"]?([^'"\)]+)['"]?\)/g)) {
            check(cssRoot, match[1]);
        }
    }
}

function build() {
    // Use Node directly so Windows does not need a shell or a global Gulp CLI.
    const gulpEntry = require.resolve('gulp/bin/gulp.js', { paths: [repositoryRoot] });
    // The default task uses gulp.series('clean', 'build'); separate CLI tasks run in parallel.
    const result = spawnSync(process.execPath, [gulpEntry, 'default'], {
        cwd: repositoryRoot,
        stdio: 'inherit',
        shell: false
    });

    if (result.error) {
        throw new Error(`Could not start the AriaNg build: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`AriaNg build failed (${result.signal || `exit code ${result.status}`}).`);
    }

    // Copy only these runtime files; never include local data or runtime secrets.
    for (const [source] of runtimeFiles) {
        requireFile(path.join(__dirname, source));
    }
    const distIndex = path.join(distRoot, 'index.html');
    requireFile(distIndex);
    const html = fs.readFileSync(distIndex, 'utf8');
    const closingBody = /<\/body\s*>/gi;
    if ((html.match(closingBody) || []).length !== 1) {
        throw new Error('Expected exactly one closing </body> tag in dist/index.html.');
    }

    // Only remove the fixed generated package directory, never a user's data.
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.cpSync(distRoot, path.join(outputRoot, 'webui'), { recursive: true });
    // Upstream copies Font Awesome only; Bootstrap CSS also references these fonts.
    fs.cpSync(path.join(repositoryRoot, 'node_modules', 'bootstrap', 'dist', 'fonts'),
        path.join(outputRoot, 'webui', 'fonts'), { recursive: true });
    for (const [source, destination] of runtimeFiles) {
        fs.copyFileSync(path.join(__dirname, source), path.join(outputRoot, destination));
    }

    const outputIndex = path.join(outputRoot, 'webui', 'index.html');
    fs.writeFileSync(outputIndex, html.replace(closingBody, `${runtimeScripts}$&`), 'utf8');

    for (const [, destination] of runtimeFiles) {
        requireFile(path.join(outputRoot, destination));
    }
    requireFile(outputIndex);
    const packagedHtml = fs.readFileSync(outputIndex, 'utf8');
    if (!packagedHtml.includes(runtimeScripts) ||
        packagedHtml.indexOf(runtimeScripts) > packagedHtml.search(/<\/body\s*>/i)) {
        throw new Error('Runtime scripts are missing or out of order in the packaged index.html.');
    }

    verifyAssets(path.join(outputRoot, 'webui'), packagedHtml);
    console.log(`Runtime package built: ${outputRoot}`);
}

try {
    build();
} catch (error) {
    console.error(`Custom build failed: ${error.message}`);
    process.exitCode = 1;
}
