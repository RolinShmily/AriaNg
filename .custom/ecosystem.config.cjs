'use strict';

const os = require('node:os');
const path = require('node:path');
const profile = process.env.USERPROFILE || os.homedir();

module.exports = {
    apps: [{
        name: 'aria2-webui',
        cwd: __dirname,
        script: path.join(__dirname, 'server.cjs'),
        interpreter: process.execPath,
        exec_mode: 'fork',
        instances: 1,
        autorestart: true,
        restart_delay: 2000,
        min_uptime: 5000,
        max_restarts: 10,
        wait_ready: true,
        listen_timeout: 35000,
        shutdown_with_message: true,
        kill_timeout: 15000,
        time: true,
        env: {
            NODE_ENV: 'production',
            ARIA2_WEBUI_PORT: process.env.ARIA2_WEBUI_PORT || '6880',
            ARIA2_RPC_PORT: process.env.ARIA2_RPC_PORT || '6800',
            ARIA2_DATA_DIR: process.env.ARIA2_DATA_DIR || path.join(profile, '.aria2'),
            ARIA2_DOWNLOAD_DIR: process.env.ARIA2_DOWNLOAD_DIR || path.join(profile, 'Downloads'),
            ARIA2_PATH: process.env.ARIA2_PATH || path.join(profile, 'scoop', 'apps', 'aria2', 'current', 'aria2c.exe')
        }
    }]
};
