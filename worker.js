const { workerData, parentPort } = require('worker_threads');
const path = require('path');
const fs = require('fs');

// Mock/Proxy logger to send logs back to parent
const logger = (type, message, username) => {
    parentPort.postMessage({
        type: 'log',
        logType: type,
        message: message,
        username: username
    });
};

async function startWorker() {
    const { toolName, ramMethod, config, session, engineCode } = workerData;
    const username = (session?.username || '__global__').toLowerCase();

    try {
        // Setup environment similar to server's customRequire
        const moduleObj = { exports: {} };
        const customRequire = (id) => {
            // Re-implement the same logic as in server.js for worker context
            if (id === 'ffmpeg-static') return require('ffmpeg-static');
            if (id === '@ffprobe-installer/ffprobe') return require('@ffprobe-installer/ffprobe');

            // For common modules, just require them
            const allowed = [
                'instagram-private-api',
                'instagram-private-api/dist/services/publish.service',
                'jimp', 'jimp-compact', 'pureimage', 'opentype.js', 'pngjs', 'jpeg-js',
                'axios', 'chalk', 'fs', 'path', 'async_hooks', 'bluebird', 'fluent-ffmpeg',
                'chance', 'stream', 'os'
            ];

            if (allowed.includes(id) || id.startsWith('instagram-private-api')) {
                return require(id);
            }
            return require(id);
        };

        // Execute the engine code in this thread
        (function (module, exports, __dirname, require) {
            eval(engineCode);
        })(moduleObj, moduleObj.exports, path.join(process.cwd(), 'tools'), customRequire);

        const SvcHandler = moduleObj.exports.instagram;
        if (!SvcHandler) throw new Error('Failed to load Instagram Engine in Worker');

        const ig = new SvcHandler();

        // Setup internal state
        if (typeof ig.setLogger === 'function') {
            ig.setLogger((type, msg, user) => logger(type, msg, user || username));
        }

        // Handle process control from parent
        parentPort.on('message', (msg) => {
            if (msg.type === 'stop') {
                ig.isStopped = true;
                if (typeof ig.stop === 'function') ig.stop();
                process.exit(0);
            }
        });

        // Login
        await ig.loginWithExtensionSession(false, true, session);

        // Run Tool
        if (ig[ramMethod]) {
            await ig[ramMethod](config);
        } else {
            throw new Error(`Method ${ramMethod} not found in engine`);
        }

        // Notify completion
        parentPort.postMessage({ type: 'finished', toolName, username });

    } catch (err) {
        logger('err', `[WORKER ERROR] ${err.message}`, username);
        parentPort.postMessage({ type: 'error', error: err.message, username });
        process.exit(1);
    }
}

startWorker();
