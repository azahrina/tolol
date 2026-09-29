const { IgApiClient, IgLoginTwoFactorRequiredError, IgCheckpointError } = require("instagram-private-api");
const { PublishService } = require("instagram-private-api/dist/services/publish.service");
const { DirectThreadEntity } = require("instagram-private-api/dist/entities/direct-thread.entity");
const { Jimp, loadFont } = require("jimp");
const PImage = require('pureimage');
const opentype = require('opentype.js');
const axios = require("axios");
const chalk = require("chalk");
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require('async_hooks');
const userStorage = new AsyncLocalStorage();

const delay = (ms) => {
    const jitter = 0.2; // 20% jitter
    const min = ms * (1 - jitter);
    const max = ms * (1 + jitter);
    const finalMs = Math.floor(Math.random() * (max - min + 1) + min);
    return new Promise(r => setTimeout(r, finalMs));
};

/**
 * Membaca baris acak dari file .txt
 */
function getRandomFromFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return "";
    try {
        let content = fs.readFileSync(filePath, 'utf8').trim();
        if (!content) return "";
        const isUrlFile = filePath.toLowerCase().includes('url') || filePath.toLowerCase().includes('link');
        const separator = isUrlFile ? "\n" : "|";
        const lines = content.split(separator).map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return "";
        let text = lines[Math.floor(Math.random() * lines.length)];
        // Spintax support {A|B|C}
        text = text.replace(/\{([^{}]+)\}/g, (_, choices) => {
            const parts = choices.split('|');
            return parts[Math.floor(Math.random() * parts.length)];
        });
        return text;
    } catch (e) { return ""; }
}

function getSequentialFromFile(filePath, index) {
    if (!filePath || !fs.existsSync(filePath)) return "";
    try {
        let content = fs.readFileSync(filePath, 'utf8').trim();
        if (!content) return "";
        const isUrlFile = filePath.toLowerCase().includes('url') || filePath.toLowerCase().includes('link');
        const separator = isUrlFile ? "\n" : "|";
        const lines = content.split(separator).map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length === 0) return "";
        return lines[index % lines.length];
    } catch (e) { return ""; }
}

const getProgressDir = () => {
    const dir = path.join(global.dataDir || process.cwd(), "auto_progress");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
};

const getProgressFile = (username) => path.join(getProgressDir(), `bulk_auto_progress_${username}.json`);

const loadProgress = (username) => {
    const file = getProgressFile(username);
    if (fs.existsSync(file)) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { }
    }
    return { postedMedia: [] };
};

const saveProgress = (username, data) => {
    try { fs.writeFileSync(getProgressFile(username), JSON.stringify(data, null, 2)); } catch (e) { }
};

// --- DYNAMIC FFMPEG PATH HELPER ---
const getFFmpegPath = () => {
    if (global.ffmpegPath && fs.existsSync(global.ffmpegPath)) return global.ffmpegPath;
    const paths = [
        path.join(process.cwd(), 'server', 'bin', 'ffmpeg.exe'),
        path.join(process.cwd(), 'bin', 'ffmpeg.exe')
    ];
    for (const p of paths) { if (fs.existsSync(p)) return p; }
    try {
        return require('ffmpeg-static');
    } catch (e) {
        return 'ffmpeg';
    }
};


const getFFprobePath = () => {
    if (global.ffprobePath && fs.existsSync(global.ffprobePath)) return global.ffprobePath;
    const paths = [
        path.join(process.cwd(), 'server', 'bin', 'ffprobe.exe'),
        path.join(process.cwd(), 'bin', 'ffprobe.exe')
    ];
    for (const p of paths) { if (fs.existsSync(p)) return p; }
    try {
        return require('@ffprobe-installer/ffprobe').path;
    } catch (e) {
        return 'ffprobe';
    }
};



// --- MONKEY PATCH DirectThreadEntity for Modern Messenger Attachment Pipeline ---
DirectThreadEntity.prototype.broadcastPhoto = async function (options) {
    const parent = this.client._parentInstagramInstance;
    if (parent && typeof parent.directSendMedia === 'function') {
        return await parent.directSendMedia(options.file, {
            threadId: this.threadId,
            uids: this.userIds,
            allowFullAspectRatio: options.allowFullAspectRatio
        });
    }
    const { upload_id } = await this.client.upload.photo({
        uploadId: options.uploadId,
        file: options.file,
    });
    return await this.broadcast({
        item: 'configure_photo',
        form: {
            allow_full_aspect_ratio: options.allowFullAspectRatio || true,
            upload_id,
        },
    });
};

DirectThreadEntity.prototype.broadcastVideo = async function (options) {
    const parent = this.client._parentInstagramInstance;
    if (parent && typeof parent.directSendMedia === 'function') {
        return await parent.directSendMedia(options.video, {
            threadId: this.threadId,
            uids: this.userIds
        });
    }
    const uploadId = options.uploadId || Date.now().toString();
    const videoInfo = PublishService.getVideoInfo(options.video);
    await this.client.upload.video(Object.assign({ video: options.video, uploadId, isDirect: true }, videoInfo));
    return await this.broadcast({
        item: 'configure_video',
        form: {
            video_result: '',
            upload_id: uploadId,
            sampled: typeof options.sampled !== 'undefined' ? options.sampled : true,
        },
    });
};

// --- MONKEY PATCH PublishService for Threads & Stickers ---
PublishService.prototype.photo = async function (options) {
    const uploadedPhoto = await this.client.upload.photo({ file: options.file });
    const image = await Jimp.read(options.file);
    const configureOptions = Object.assign(
        {
            upload_id: uploadedPhoto.upload_id,
            width: image.bitmap.width,
            height: image.bitmap.height,
            caption: options.caption,
            share_to_threads: options.share_to_threads || 0,
            share_to_barcelona: options.share_to_barcelona || options.share_to_threads || 0,
            barcelona_share_to_threads: options.share_to_threads || 0,
            text_post_app_info: options.share_to_threads ? JSON.stringify({ is_text_post_app_share: true }) : undefined
        },
        options.stickerConfig || {},
        PublishService.makeLocationOptions(options.location)
    );
    if (typeof options.usertags !== 'undefined') configureOptions.usertags = options.usertags;
    return await this.client.media.configure(configureOptions);
};

PublishService.prototype.video = async function (options) {
    const uploadId = (Date.now() + Math.floor(Math.random() * 1000000)).toString();
    const videoInfo = PublishService.getVideoInfo(options.video);
    await require("bluebird").try(() => this.regularVideo(Object.assign({ video: options.video, uploadId }, videoInfo)));
    await this.client.upload.photo({ file: options.coverImage, uploadId: uploadId.toString() });
    await require("bluebird").try(() => this.client.media.uploadFinish({
        upload_id: uploadId,
        source_type: '4',
        video: { length: videoInfo.duration / 1000.0 },
    }));
    const configureOptions = Object.assign(
        {
            upload_id: uploadId.toString(),
            caption: options.caption,
            length: videoInfo.duration / 1000.0,
            width: videoInfo.width,
            height: videoInfo.height,
            clips: [{ length: videoInfo.duration / 1000.0, source_type: '4' }],
            share_to_threads: options.share_to_threads || 0,
            share_to_barcelona: options.share_to_barcelona || options.share_to_threads || 0,
            barcelona_share_to_threads: options.share_to_threads || 0,
            text_post_app_info: options.share_to_threads ? JSON.stringify({ is_text_post_app_share: true }) : undefined
        },
        options.stickerConfig || {},
        PublishService.makeLocationOptions(options.location)
    );
    if (typeof options.usertags !== 'undefined') configureOptions.usertags = options.usertags;
    return await this.client.media.configureVideo(configureOptions);
};

// --- CRITICAL PATCH: Fix Library Hardcoded Date.now() ID Collisions ---
PublishService.prototype.uploadAndConfigureStoryPhoto = async function (options, configureOptions) {
    const uploadId = options.uploadId || (Date.now() + Math.floor(Math.random() * 1000000000)).toString();
    const image = await Jimp.read(options.file);
    const uploadResponse = await this.client.upload.photo({
        file: options.file,
        uploadId,
    });

    // v4.6/4.7 Synchronization: Use server-provided ID if available
    const finalUploadId = uploadResponse.upload_id || uploadId;

    // v4.7 Delay: Mandatory wait for indexing
    console.log(chalk`{cyan [Story] Photo uploaded. Waiting 5s for indexing...}`);
    await new Promise(r => setTimeout(r, 5000));

    let lastErr;
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            return await this.client.media.configureToStory(Object.assign(Object.assign({}, configureOptions), {
                upload_id: finalUploadId,
                width: image.bitmap.width,
                height: image.bitmap.height
            }));
        } catch (err) {
            lastErr = err;
            if (attempt === 1 && err.message && err.message.includes("upload id is missing")) {
                console.warn(chalk`{yellow [Story] Upload ID not indexed. Waiting 4s for retry...}`);
                await new Promise(r => setTimeout(r, 4000));
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
};

// Use fluent-ffmpeg (with dynamic binary) to probe video metadata accurately
function probeVideo(filePath) {
    const ffmpeg = require('fluent-ffmpeg');
    ffmpeg.setFfmpegPath(getFFmpegPath());
    ffmpeg.setFfprobePath(getFFprobePath());
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            resolve({
                duration: Math.round(metadata.format.duration * 1000),
                width: videoStream ? videoStream.width : 720,
                height: videoStream ? videoStream.height : 1280,
            });
        });
    });
}

PublishService.prototype.uploadAndConfigureStoryVideo = async function (options, configureOptions) {
    // 13-digit numeric uploadId (Date.now()) and unique clientContext are required for stable video indexing
    const uploadId = options.uploadId || Date.now().toString();
    const waterfallId = require("chance").Chance().guid({ version: 4 });
    const clientContext = require("chance").Chance().guid({ version: 4 });

    const log = (msg) => {
        console.log(chalk`{cyan [story]} ${msg}`);
    };

    const originalRequest = this.client.request.send.bind(this.client.request);
    let patched = false;

    try {
        // --- ON-THE-FLY TAKEOVER: MOBILE IDENTITY TRANSLATION ---
        const cookies = await this.client.state.cookieJar.getCookies('https://i.instagram.com/');
        const dsUserId = cookies.find(c => c.key === 'ds_user_id')?.value;
        const sessionId = cookies.find(c => c.key === 'sessionid')?.value;
        const browserUa = this.client.state.userAgent;

        if (dsUserId && sessionId) {
            if (!this.client._bearerTokenCache) {
                const cleanSessionId = decodeURIComponent(sessionId);
                const authObj = { ds_user_id: dsUserId, sessionid: cleanSessionId };
                this.client._bearerTokenCache = `Bearer IGT:2:${Buffer.from(JSON.stringify(authObj)).toString('base64')}`;
            }
            const bearerToken = this.client._bearerTokenCache;
            const mobileUa = 'Instagram 370.0.0.35.101 Android (33/13; 600dpi; 1440x3088; samsung; SM-S918B; dm3q; kalama; en_US; 610000000)';

            // Patch the request handler ONLY for this specific upload task
            this.client.request.send = async (opt, onlyCheckHttpStatus) => {
                if (!opt.headers) opt.headers = {};
                const isNative = opt.url && (opt.url.includes('rupload') || opt.url.includes('api/v1'));

                if (isNative) {
                    opt.headers['User-Agent'] = mobileUa;
                    opt.headers['X-IG-App-ID'] = '124024574287414';
                    opt.headers['X-IG-App-Version'] = '370.0.0.35.101';
                    opt.headers['X-IG-Capabilities'] = 'br0LAA==';
                    opt.headers['X-IG-Connection-Type'] = 'WIFI';
                    opt.headers['X-ASBD-ID'] = '198303';
                    opt.headers['X-IG-WWW-Claim'] = '0';
                    opt.headers['X-IG-Bandwidth-Speed-KBPS'] = (Math.floor(Math.random() * 5000) + 10000).toString();

                    if (bearerToken) {
                        opt.headers['Authorization'] = bearerToken;
                    }

                    // --- NATIVE PAYLOAD ADJUSTMENT (Translate JSON to Form-Data) ---
                    if (opt.method === 'POST' && opt.body && typeof opt.body === 'string' && !opt.url.includes('rupload')) {
                        try {
                            const parsed = JSON.parse(opt.body);
                            const formData = Object.entries(parsed).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
                            opt.body = formData;
                            opt.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                        } catch (e) { }
                    }
                } else {
                    opt.headers['User-Agent'] = browserUa;
                }
                return originalRequest(opt, onlyCheckHttpStatus);
            };
            patched = true;
        }

        // ===== PHASE 1: PROBE METADATA =====
        log(`[P1] Membaca metadata video dari: ${options.video}`);
        const videoInfo = await probeVideo(options.video);
        const videoSizeKB = Math.round(require('fs').statSync(options.video).size / 1024);
        log(`[P1] duration=${videoInfo.duration}ms width=${videoInfo.width} height=${videoInfo.height} size=${videoSizeKB}KB`);

        if (!videoInfo.duration || videoInfo.duration < 100) {
            throw new Error(`Durasi video tidak valid: ${videoInfo.duration}ms.`);
        }

        // ===== PHASE 2: UPLOAD VIDEO CHUNKS =====
        const isDirectStory = (configureOptions && configureOptions.configure_mode === '2') || (options.configure_mode === '2');
        log(`[P2] Mengunggah video chunks... isDirectStory=${isDirectStory} uploadId=${uploadId}`);
        if (options.extLogger) options.extLogger('info', 'Mengunggah video');
        const videoBuffer = require('fs').readFileSync(options.video);

        const custom_regularVideo = async (client, buffer, upload_id) => {
            const transfer_handle = `${upload_id}_0_${Math.floor(Math.random() * 1000000000)}`;
            const ruploadParams = {
                upload_id: upload_id,
                for_album: '0',
                direct_story: isDirectStory ? '1' : '0',
                client_context: clientContext,
                media_type: '2'
            };
            return client.request.send({
                url: `/rupload_igvideo/${transfer_handle}`,
                method: 'POST',
                headers: {
                    'X-Entity-Type': 'video/mp4',
                    'X-Entity-Name': `video_upload_${upload_id}.mp4`,
                    'X-Entity-Length': buffer.length,
                    'Offset': '0',
                    'X-Instagram-Rupload-Params': JSON.stringify(ruploadParams)
                },
                body: buffer,
            });
        };

        try {
            const regularVideoResult = await custom_regularVideo(this.client, videoBuffer, uploadId);
            log(`[P2] ✅ Chunks OK. Status: ${regularVideoResult.statusCode}`);
        } catch (err) {
            log(`[P2] ❌ Chunks Failed! ${err.message}`);
            if (!(err.response && err.response.statusCode >= 200 && err.response.statusCode < 300)) throw err;
        }

        // ===== PHASE 3: UPLOAD COVER =====
        log(`[P3] Mengunggah cover...`);
        if (options.coverImage) {
            let coverBuffer = options.coverImage;
            if (typeof coverBuffer === 'string' && fs.existsSync(coverBuffer)) {
                coverBuffer = fs.readFileSync(coverBuffer);
            }
            await this.client.upload.photo({ file: coverBuffer, waterfallId, uploadId });
            log(`[P3] ✅ Cover OK.`);
        }

        await new Promise(r => setTimeout(r, 2000));

        // ===== PHASE 4: UPLOAD FINISH =====
        const durationSec = Math.min(60.0, Math.max(1.0, videoInfo.duration / 1000.0));
        log(`[P4] uploadFinish... length=${durationSec.toFixed(2)}s`);
        try {
            await this.client.media.uploadFinish({
                upload_id: uploadId,
                source_type: '3',
                video: { length: durationSec },
            });
            log(`[P4] ✅ Finish OK.`);
        } catch (err) {
            if (err.response && err.response.statusCode === 202) log(`[P4] ✅ 202 OK.`);
            else throw err;
        }

        // ===== PHASE 5: INDEXING WAIT (Dinamis Sesuai Durasi) =====
        // Video < 20s: ~20s
        // Video 30s: ~34s
        // Video 60s: ~55s (memberikan waktu cukup bagi worker transcoding server Meta)
        const waitSec = Math.max(20, Math.min(60, Math.round(durationSec * 0.65 + 16)));
        log(`[P5] Menunggu indexing server Meta (${waitSec}s untuk video durasi ${durationSec.toFixed(1)}s)...`);
        if (options.extLogger) options.extLogger('info', `Menunggu indexing ${waitSec}s`);
        await new Promise(r => setTimeout(r, waitSec * 1000));

        // ===== PHASE 6: CONFIGURE STORY =====
        log(`[P6] configureToStoryVideo...`);
        let lastErr;
        const maxAttempts = 5;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const stickerFields = configureOptions || options.stickerConfig || {};
                const config = {
                    upload_id: uploadId,
                    waterfall_id: waterfallId,
                    client_context: clientContext,
                    media_type: '2',
                    video_result: '1',
                    poster_frame_index: 0,
                    length: durationSec,
                    width: videoInfo.width,
                    height: videoInfo.height,
                    clips: [{
                        length: durationSec,
                        source_type: '3',
                    }],
                    audio_muted: false,
                    device_timestamp: Date.now(),
                    timezone_offset: '25200',
                    configure_mode: '1',
                    supported_capabilities_new: JSON.stringify([
                        { "name": "SUPPORTED_SDK_VERSIONS", "value": "13.0,14.0,15.0,16.0,17.0,18.0,19.0,20.0,21.0,22.0,23.0,24.0,25.0,26.0,27.0,28.0,29.0,30.0,31.0,32.0,33.0,34.0,35.0,36.0,37.0,38.0,39.0,40.0,41.0,42.0,43.0,44.0,45.0,46.0,47.0,48.0,49.0,50.0,51.0,52.0,53.0,54.0,55.0,56.0,57.0,58.0,59.0,60.0,61.0,62.0,63.0,64.0,65.0,66.0,67.0,68.0,69.0,70.0,71.0,72.0,73.0,74.0,75.0,76.0,77.0,78.0,79.0,80.0,81.0,82.0,83.0,84.0,85.0,86.0,87.0,88.0,89.0,90.0,91.0,92.0,93.0,94.0,95.0,96.0,97.0,98.0,99.0,100.0" },
                        { "name": "FACE_TRACKER_VERSION", "value": 12 },
                        { "name": "segmentation", "value": "segmentation_enabled" },
                        { "name": "COMPRESSION", "value": "ETC2_COMPRESSION" },
                        { "name": "world_tracker", "value": "world_tracker_enabled" },
                        { "name": "gyroscope", "value": "gyroscope_enabled" }
                    ]),
                    tap_models: stickerFields.tap_models,
                    story_sticker_ids: stickerFields.story_sticker_ids,
                    ...stickerFields
                };

                if (config.tap_models) {
                    log(`[P6] Link Sticker detected: ${config.tap_models.substring(0, 50)}...`);
                }

                log(`[P6] Sending config (Attempt ${attempt}/${maxAttempts})...`);
                const configResult = await this.client.media.configureToStoryVideo(config);
                log(`[P6] ✅ Config OK. media_type=${configResult?.media?.media_type}`);
                return configResult;
            } catch (err) {
                lastErr = err;
                log(`[P6] ❌ Attempt ${attempt} failed: ${err.message}`);
                const isRetryable = err.message && (
                    err.message.includes("upload id is missing") || 
                    err.message.includes("transcode") || 
                    err.message.includes("processing") ||
                    err.message.includes("202")
                );
                if (attempt < maxAttempts && isRetryable) {
                    const retryWait = attempt * 8000;
                    log(`[P6] Server Meta masih memproses, menunggu ${retryWait / 1000}s sebelum mencoba lagi...`);
                    await new Promise(r => setTimeout(r, retryWait));
                    continue;
                }
                throw err;
            }
        }
        throw lastErr;
    } catch (err) {
        log(`❌ ${err.name}: ${err.message}`);
        throw err;
    } finally {
        // --- RESTORE ORIGINAL STATE ---
        if (patched) {
            this.client.request.send = originalRequest;
        }
    }
};

// global.loggedUser removed for thread-safety

/**
 * Pad an image to 9:16 (story) canvas with black bars if needed.
 * Returns path to the padded file (may be a new temp file in workArea).
 */
async function padImageToStoryRatio(filePath, workArea, blur = false, blurValue = 20) {
    const img = await Jimp.read(filePath);
    const imgW = img.width;
    const imgH = img.height;

    // Instagram story ratio: 9:16
    const storyRatio = 9 / 16;
    const currentRatio = imgW / imgH;

    // Allow ±1% tolerance — already close enough, no padding needed
    if (Math.abs(currentRatio - storyRatio) / storyRatio < 0.01) {
        return filePath;
    }

    // Determine canvas size at 9:16
    let canvasW, canvasH;
    if (currentRatio > storyRatio) {
        // Wider than 9:16 → keep width, shrink height to 9:16
        canvasW = imgW;
        canvasH = Math.round(imgW / storyRatio);
    } else {
        // Taller than 9:16 → keep height, expand width to 9:16
        canvasH = imgH;
        canvasW = Math.round(imgH * storyRatio);
    }

    // COVER MODE: scale image to fill canvas completely (no black bars), then center-crop
    const coverScale = Math.max(canvasW / imgW, canvasH / imgH);
    const scaledW = Math.round(imgW * coverScale);
    const scaledH = Math.round(imgH * coverScale);

    if (blur) {
        img.blur(parseInt(blurValue) || 20);
    }

    img.resize({ w: scaledW, h: scaledH });
    const cropX = Math.round((scaledW - canvasW) / 2);
    const cropY = Math.round((scaledH - canvasH) / 2);
    img.crop({ x: cropX, y: cropY, w: canvasW, h: canvasH });

    const ext = path.extname(filePath).toLowerCase() || '.jpg';
    const outName = `story916_${Date.now()}_${Math.floor(Math.random() * 1e6)}${ext}`;
    const outPath = workArea ? path.join(workArea, outName) : path.join(require('os').tmpdir(), outName);
    await img.write(outPath);
    return outPath;
}

const getBaseDir = () => {
    const cwd = process.cwd();
    if (process.platform === "linux") {
        const folderName = path.basename(cwd);
        const home = process.env.HOME || "/data/data/com.termux/files/home";
        const potentialPaths = [`/sdcard/${folderName}`, `/storage/emulated/0/${folderName}`, `${home}/storage/shared/${folderName}`, "/sdcard/toolsig", "/storage/emulated/0/toolsig", `${home}/storage/shared/toolsig`];
        for (const p of potentialPaths) { if (fs.existsSync(p) && fs.existsSync(path.join(p, "accounts.txt"))) return p; }
    }
    return cwd;
};

global.dataDir = getBaseDir();

const resolvePath = (filename) => {
    if (!filename) return "";
    if (path.isAbsolute(filename)) return filename;
    const cleanName = filename.startsWith("./") ? filename.slice(2) : filename;
    return path.join(global.dataDir, cleanName);
};

const makeMediaUnique = async (filePath, type = 'photo', workArea = null) => {
    const randomID = Math.floor(Math.random() * 1000000);
    const ext = path.extname(filePath).toLowerCase();

    // Use workArea if provided, otherwise fallback to the directory of the original file
    const baseDir = workArea || path.dirname(filePath);
    const targetExt = type === 'video' ? '.mp4' : ext;
    const newPath = path.join(baseDir, `${path.basename(filePath, ext)}_unique_${randomID}${targetExt}`);

    try {
        if (type === 'photo') {
            const image = await Jimp.read(filePath);
            const w = image.bitmap.width;
            const h = image.bitmap.height;

            // Random crop 1-2 pixels (Safe hash change)
            const cropAmount = Math.floor(Math.random() * 2) + 1;
            if (w > 10 && h > 10) {
                image.crop({
                    x: cropAmount,
                    y: cropAmount,
                    w: w - (cropAmount * 2),
                    h: h - (cropAmount * 2)
                });
            }

            // Use slightly different quality (98-99%) to ensure hash change without black screen
            const q = 98 + Math.floor(Math.random() * 2);
            await image.write(newPath, { quality: q });
            return newPath;
        } else {
            return new Promise((resolve, reject) => {
                const ffmpeg = require('fluent-ffmpeg');
                ffmpeg.setFfmpegPath(getFFmpegPath());

                console.log(chalk`{cyan [vid-unique] Processing video hash for safety...}`);

                // vf crop removes 2px with even dimension truncation, optional audio map, and faststart
                ffmpeg(filePath)
                    .outputOptions([
                        '-vf', 'crop=trunc((iw-2)/2)*2:trunc((ih-2)/2)*2:1:1,noise=alls=1:allf=t',
                        '-map_metadata', '-1',
                        '-c:v', 'libx264',
                        '-preset', 'ultrafast',
                        '-pix_fmt', 'yuv420p',
                        '-crf', '18',
                        '-map', '0:v:0',
                        '-map', '0:a?',
                        '-c:a', 'aac',
                        '-b:a', '128k',
                        '-movflags', '+faststart'
                    ])
                    .on('end', () => {
                        console.log(chalk`{cyan [vid-unique] ✅ Done.}`);
                        resolve(newPath);
                    })
                    .on('error', (err) => {
                        console.error(`[vid-unique] ❌ Video unique failed: ${err.message}`);
                        // Cleanup partial file on error
                        if (fs.existsSync(newPath)) { try { fs.unlinkSync(newPath); } catch (e) { } }
                        reject(err);
                    })
                    .save(newPath);
            });
        }
    } catch (e) {
        // Jika gagal (misal: Jimp/FFmpeg error), beri peringatan tapi jangan hentikan proses total
        console.warn(chalk`{yellow [Unique] ⚠️ Lewati proses unik untuk ${type}: ${e.message}}`);
        if (fs.existsSync(newPath)) { try { fs.unlinkSync(newPath); } catch (err) { } }
        return filePath;
    }
};




class instagram {
    constructor(username, password, otpSeed, isAutomation = false) {
        this.username = username || global.igUsername;
        this.password = password || global.igPassword;
        this.otpSeed = otpSeed || global.igOtpSeed;
        this.isAutomation = isAutomation;
        this.threadsAPI = null;
        this.ig = new IgApiClient();
        this.ig._parentInstagramInstance = this;
        this.extUserInfo = null; // Cache for extension session info
        this.currentWorkArea = null;
        this.isStopped = false;
    }

    /**
     * Returns an isolated temporary directory for the current user and task.
     */
    async getWorkArea(taskId = 'generic') {
        const user = (this.username || 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '_');
        const workDir = path.join(global.dataDir, 'tmp', 'workarea', user, taskId);
        if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
        this.currentWorkArea = workDir;
        return workDir;
    }

    /**
     * Cleans up the current isolated work area.
     */
    async cleanupWorkArea() {
        if (this.currentWorkArea && fs.existsSync(this.currentWorkArea)) {
            try {
                // Native modern recursive directory removal (Node 14.14+)
                fs.rmSync(this.currentWorkArea, { recursive: true, force: true });
            } catch (e) {
                console.warn(`[Cleanup] Failed to remove ${this.currentWorkArea}: ${e.message}`);
            }
            this.currentWorkArea = null;
        }
    }

    async setupDevice(seed) {
        this.ig.state.generateDevice(seed);
        // Modern Fingerprint (v360 / Android 14)
        const appVersion = '360.0.0.38.113';
        const versionCode = '667746404';
        try {
            Object.defineProperty(this.ig.state, 'appVersion', { get: () => appVersion, configurable: true });
            Object.defineProperty(this.ig.state, 'appVersionCode', { get: () => versionCode, configurable: true });
        } catch (e) {
            this.ig.state.appVersion = appVersion;
            this.ig.state.appVersionCode = versionCode;
        }
    }

    applyMobileIdentity() {
        if (this._mobileIdentityApplied) return;
        const originalRequest = this.ig.request.send.bind(this.ig.request);
        const mobileUa = 'Instagram 370.0.0.35.101 Android (33/13; 600dpi; 1440x3088; samsung; SM-S918B; dm3q; kalama; en_US; 610000000)';

        this.ig.request.send = async (opt, onlyCheckHttpStatus) => {
            if (!opt.headers) opt.headers = {};
            const isNative = opt.url && (opt.url.includes('rupload') || opt.url.includes('api/v1'));

            if (isNative) {
                opt.headers['User-Agent'] = mobileUa;
                opt.headers['X-IG-App-ID'] = '124024574287414';
                opt.headers['X-IG-App-Version'] = '370.0.0.35.101';
                opt.headers['X-IG-Capabilities'] = 'br0LAA==';
                opt.headers['X-IG-Connection-Type'] = 'WIFI';
                opt.headers['X-ASBD-ID'] = '198303';
                opt.headers['X-IG-WWW-Claim'] = '0';
                opt.headers['X-IG-Bandwidth-Speed-KBPS'] = (Math.floor(Math.random() * 5000) + 10000).toString();

                try {
                    const cookies = await this.ig.state.cookieJar.getCookies('https://i.instagram.com/');
                    const dsUserId = cookies.find(c => c.key === 'ds_user_id')?.value;
                    const sessionId = cookies.find(c => c.key === 'sessionid')?.value;
                    if (dsUserId && sessionId) {
                        const cleanSessionId = decodeURIComponent(sessionId);
                        const authObj = { ds_user_id: dsUserId, sessionid: cleanSessionId };
                        opt.headers['Authorization'] = `Bearer IGT:2:${Buffer.from(JSON.stringify(authObj)).toString('base64')}`;
                    }
                } catch (e) { }

                // --- NATIVE PAYLOAD ADJUSTMENT (Translate JSON to Form-Data) ---
                if (opt.method === 'POST' && opt.body && typeof opt.body === 'string' && !opt.url.includes('rupload')) {
                    try {
                        const parsed = JSON.parse(opt.body);
                        const formData = Object.entries(parsed).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
                        opt.body = formData;
                        opt.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                    } catch (e) { }
                }
            }
            return originalRequest(opt, onlyCheckHttpStatus);
        };
        this._mobileIdentityApplied = true;
    }

    async initThreads() {
        try {
            const deviceID = this.ig.state.deviceId || `android-${Buffer.from(this.username).toString('hex').slice(0, 16)}`;
            this.threadsAPI = new ThreadsAPI({ username: this.username, password: this.password, deviceID: deviceID });
            await this.threadsAPI.login(); return true;
        } catch (err) { return false; }
    }




    async handleCheckpoint(err) {
        const msg = ((err && err.message) || String(err) || "").toLowerCase();
        if (msg.includes("checkpoint_required") || msg.includes("challenge_required") || err instanceof IgCheckpointError) {
            print(`Security Challenge detected!`, "warn");
            try { await this.ig.challenge.auto(true); } catch (e) { }
            return Promise.reject("Verification required. Please check Browser Extension.");
        }
        return Promise.reject(err);
    }

    async handle2FA(err) {
        print("2FA required!", "warn");
        return Promise.reject("2FA required. Please check Browser Extension.");
    }

    async saveSession(username, state) {
        const sessionPath = path.join(process.cwd(), 'sessions', `${username}.json`);
        if (fs.existsSync(sessionPath)) {
            try { await this.ig.state.deserialize(JSON.parse(fs.readFileSync(sessionPath, 'utf8'))); return true; } catch (e) { return false; }
        }
        return false;
    }

    async login() {
        if (process.env.EXTENSION_MODE === 'true' && process.env.IG_SESSION_JSON) return await this.loginWithExtensionSession();
        const hasSession = await this.loadSession(this.username);
        if (!hasSession) await this.setupDevice(this.username);
        if (hasSession) {
            try { const user = await this.ig.account.currentUser(); return { username: this.username, pk: user.pk }; } catch (e) { await this.setupDevice(this.username); }
        }
        try {
            await this.ig.simulate.preLoginFlow();
            const login = await this.ig.account.login(this.username, this.password);
            const user = login.logged_in_user || login.user || login;
            const state = await this.ig.state.serialize();
            delete state.constants; await this.saveSession(this.username, state);
            return { username: user.username, pk: user.pk };
        } catch (err) {
            if (err instanceof IgLoginTwoFactorRequiredError) return await this.handle2FA(err);
            if (err instanceof IgCheckpointError) return await this.handleCheckpoint(err);
            throw err;
        }
    }

    async loginWithExtensionSession(checkRemote = true, silent = false, sessionDataOverride = null) {
        try {
            const sessionData = sessionDataOverride || JSON.parse(process.env.IG_SESSION_JSON || '{}');
            let cookies = sessionData._cookies || [];
            if ((!cookies || cookies.length === 0) && sessionData.cookies) {
                if (typeof sessionData.cookies === 'string') {
                    cookies = sessionData.cookies.split(';').map(pair => {
                        const [name, ...rest] = pair.trim().split('=');
                        return { name: name.trim(), value: rest.join('=').trim(), domain: '.instagram.com', path: '/', secure: true, httpOnly: false };
                    }).filter(c => c.name && c.value);
                } else if (Array.isArray(sessionData.cookies)) {
                    cookies = sessionData.cookies;
                }
            }
            const browserUa = sessionData.ua || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

            if (checkRemote && !silent) {
                // Muted for clean terminal: Initializing session...
                // Muted for clean terminal: Syncing User-Agent...
            }
            const cookieJar = this.ig.state.cookieJar;
            let dsUserIdVal = null, csrfToken = null;
            for (const c of cookies) {
                if (c.name === 'ds_user_id') dsUserIdVal = c.value;
                if (c.name === 'csrftoken') csrfToken = c.value;
                const domains = ['.instagram.com', 'i.instagram.com', 'www.instagram.com', 'instagram.com', '.i.instagram.com', 'graph.instagram.com', '.graph.instagram.com', 'upload.instagram.com'];
                for (const d of domains) {
                    const cookieStr = `${c.name}=${c.value}; Domain=${d}; Path=${c.path}${c.secure ? '; Secure' : ''}${c.httpOnly ? '; HttpOnly' : ''}`;
                    try { await cookieJar.setCookie(cookieStr, `https://${d.replace(/^\./, '')}${c.path}`); } catch (ce) { }
                }
            }
            if (dsUserIdVal) {
                this.ig.state.extractUserId(dsUserIdVal);
                this.pk = dsUserIdVal;
                const igDid = cookies.find(c => c.name === 'ig_did');
                const mid = cookies.find(c => c.name === 'mid');
                await this.setupDevice(dsUserIdVal);

                // --- SYNC IMPROVEMENT: Keep valid Android App UA for native private endpoints ---
                // Any browser UA (Windows, Mac, or Android Kiwi/Lemur) starting with Mozilla/ must be mapped to official IG Android UA
                const isWebBrowser = !browserUa || browserUa.startsWith('Mozilla/') || /Windows|Macintosh|Linux|Android|Chrome|Safari/i.test(browserUa);
                this.ig.state.userAgent = isWebBrowser
                    ? 'Instagram 370.0.0.35.101 Android (33/13; 600dpi; 1440x3088; samsung; SM-S918B; dm3q; kalama; en_US; 610000000)'
                    : browserUa;

                // Maintain stable android deviceId format even in extension mode
                this.ig.state.deviceId = `android-${Buffer.from(dsUserIdVal).toString('hex').slice(0, 16)}`;
                if (igDid) { this.ig.state.uuid = igDid.value; }
                if (mid) this.ig.state.phoneId = mid.value;
                try {
                    Object.defineProperty(this.ig.state, 'cookieUserId', { get: () => dsUserIdVal, configurable: true });
                    Object.defineProperty(this.ig.state, 'cookieCsrfToken', { get: () => csrfToken, configurable: true });
                } catch (e) { }

                // Protect all private API calls with mobile headers & Bearer token
                this.applyMobileIdentity();
            }
            // Mencegah konflik: kita tidak memaksa appId secara global untuk menjaga native endpoints.

            // --- HEADER SYNC: X-IG-WWW-Claim management ---
            if (!this._claimCached) {
                try {
                    const preRes = await this.ig.request.send({ url: 'https://www.instagram.com/', method: 'GET', headers: { 'User-Agent': browserUa } }, true);
                    this._cachedClaim = preRes.headers['x-ig-set-www-claim'] || preRes.headers['x-ig-www-claim'] || '0';
                    this._claimCached = true;
                } catch (e) { this._cachedClaim = '0'; this._claimCached = true; }
            }

            // --- AUTO-PATCH: Ensure upload_id is NEVER lost on modern Instagram responses ---
            if (!this._uploadPatched) {
                const origPhoto = this.ig.upload.photo.bind(this.ig.upload);
                this.ig.upload.photo = async (opts) => {
                    const uploadId = (opts.uploadId || Date.now()).toString();
                    opts.uploadId = uploadId;
                    console.log(chalk`{cyan [DEBUG-RUPLOAD]} photo upload start: uploadId=${uploadId}`);
                    let res;
                    try {
                        res = await origPhoto(opts);
                        // PENTING: res adalah body dari rupload response
                        // Jika Instagram sukses, res akan berisi { upload_id, status: 'ok', ... }
                        // Jangan override upload_id dari server dengan kita punya, pakai yang dari server
                        const actualUploadId = (res && res.upload_id) ? res.upload_id.toString() : uploadId;
                        console.log(chalk`{cyan [DEBUG-RUPLOAD]} photo upload DONE: server upload_id=${actualUploadId} (our id=${uploadId}) status=${res && res.status}`);
                        // Pakai upload_id dari server jika ada, jika tidak pakai punya kita
                        return Object.assign({ upload_id: uploadId, status: 'ok' }, typeof res === 'object' ? res : {}, { upload_id: actualUploadId });
                    } catch (err) {
                        console.error(chalk`{red [DEBUG-RUPLOAD]} photo upload FAILED: ${err.message}`);
                        const errBody = err.response && err.response.body ? JSON.stringify(err.response.body) : 'N/A';
                        console.error(chalk`{red [DEBUG-RUPLOAD]} rupload error body: ${errBody}`);
                        throw err;
                    }
                };

                const origVideo = this.ig.upload.video.bind(this.ig.upload);
                this.ig.upload.video = async (opts) => {
                    const uploadId = (opts.uploadId || Date.now()).toString();
                    opts.uploadId = uploadId;
                    console.log(chalk`{cyan [DEBUG-RUPLOAD]} video upload start: uploadId=${uploadId}`);
                    let res;
                    try {
                        res = await origVideo(opts);
                        const actualUploadId = (res && res.upload_id) ? res.upload_id.toString() : uploadId;
                        console.log(chalk`{cyan [DEBUG-RUPLOAD]} video upload DONE: server upload_id=${actualUploadId} status=${res && res.status}`);
                        return Object.assign({ upload_id: uploadId, status: 'ok' }, typeof res === 'object' ? res : {}, { upload_id: actualUploadId });
                    } catch (err) {
                        console.error(chalk`{red [DEBUG-RUPLOAD]} video upload FAILED: ${err.message}`);
                        const errBody = err.response && err.response.body ? JSON.stringify(err.response.body) : 'N/A';
                        console.error(chalk`{red [DEBUG-RUPLOAD]} rupload error body: ${errBody}`);
                        throw err;
                    }
                };
                this._uploadPatched = true;
            }

            // Guard: Only wrap request.send ONCE per client instance
            if (!this._requestPatched) {
                const originalRequest = this.ig.request.send.bind(this.ig.request);
                const self = this;
                this.ig.request.send = async (options, onlyCheckHttpStatus) => {
                    if (!options.headers) options.headers = {};

                    // Ensure we follow the browser's User-Agent for all web-like endpoints
                    let isWebEndpoint = false;
                    if (options.url && !options.url.includes('rupload') && (options.url.startsWith('http') || options.url.includes('web_profile_info') || options.url.includes('web/accounts/edit') || options.url.includes('api/v1/web'))) {
                        isWebEndpoint = true;
                    }

                    // -------------------------------------------------------------------------
                    // NATIVE IDENTITY TAKEOVER: Mirror the Official Instagram App Behavior
                    // -------------------------------------------------------------------------
                    const rawUrl = options.url || options.uri || "";
                    const urlStr = typeof rawUrl === 'string' ? rawUrl : (rawUrl.toString ? rawUrl.toString() : "");
                    const isNative = urlStr.includes('rupload') || urlStr.includes('api/v1');

                    if (isWebEndpoint) {
                        options.headers['User-Agent'] = browserUa;
                        options.headers['X-IG-App-ID'] = '936619743392459'; // Web App ID
                    } else {
                        // Native endpoints use the state's appId (usually Android)
                        options.headers['X-IG-App-ID'] = (options.url && options.url.includes('rupload')) ? '124024574287414' : self.ig.state.appId;

                        // Only inject Bearer token for non-rupload native endpoints to avoid conflicting with session cookies
                        if (!urlStr.includes('rupload')) {
                            const bToken = await self._getBearerToken();
                            if (bToken) {
                                options.headers['Authorization'] = bToken;
                            }
                        }
                    }

                    const dynamicCsrf = self.ig.state.cookieCsrfToken;
                    if (dynamicCsrf) {
                        options.headers['X-CSRFToken'] = dynamicCsrf;
                        options.headers['X-Instagram-AJAX'] = '1';
                    }

                    options.headers['X-ASBD-ID'] = '198303';
                    options.headers['X-IG-WWW-Claim'] = self._cachedClaim || '0';
                    options.headers['X-IG-Set-WWW-Claim'] = '1';

                    // X-Requested-With hanya untuk web endpoints, bukan mobile API
                    if (isWebEndpoint) {
                        options.headers['X-Requested-With'] = 'XMLHttpRequest';
                    }

                    // KRITIS: Jangan inject Origin web ke native mobile API!
                    // configure/ dan configure_to_story/ adalah mobile private API — Origin web akan menyebabkan
                    // Instagram menolak signed_body dan melaporkan "upload id is missing"
                    if (isNative) {
                        // Mobile API: hapus semua header web agar tidak konflik dengan signed_body
                        delete options.headers['Origin'];
                        delete options.headers['Referer'];
                        delete options.headers['X-Requested-With'];
                        delete options.headers['X-Instagram-AJAX'];
                        // X-CSRFToken juga tidak diperlukan untuk mobile signed API (sudah ada di signed_body)
                        delete options.headers['X-CSRFToken'];
                        delete options.headers['X-IG-Set-WWW-Claim'];
                    } else if (options.url && options.url.includes('rupload')) {
                        // Rupload: set Referer saja, tidak perlu Origin untuk menghindari CORS rejection
                        options.headers['Referer'] = options.headers['Referer'] || 'https://i.instagram.com/';
                    } else if (isWebEndpoint && options.method === 'POST') {
                        // Web endpoints: tambahkan Origin web
                        options.headers['Referer'] = options.headers['Referer'] || 'https://www.instagram.com/';
                        options.headers['Origin'] = 'https://www.instagram.com';
                    }

                    // === CRITICAL FIX: UNPACK SIGNED_BODY INTO TOP-LEVEL FORM PARAMETERS ===
                    // === RESOLVE CONFLICT: STANDARDIZE SIGNED_BODY TO MODERN INSTAGRAPI SPEC ===
                    // Masalah sebelumnya:
                    // 1. Library lama menghasilkan HMAC sha256 hex yang kuncinya sudah usang di Meta.
                    // 2. Monkey-patch unpack menduplikasi 18 keys ke level root tapi signed_body lama tidak dibersihkan.
                    // 3. Akibatnya Meta menerima signed_body invalid + root form duplikat dan melempar "Expected object or value".
                    // Solusi standar (seperti instgrapi):
                    // Gunakan prefix 'SIGNATURE.<json>' murni dan hapus ig_sig_key_version serta duplikasi field root!
                    if (options.form && options.form.signed_body) {
                        try {
                            const dotIdx = options.form.signed_body.indexOf('.');
                            if (dotIdx > 0) {
                                const innerPayload = JSON.parse(options.form.signed_body.substring(dotIdx + 1));
                                delete innerPayload.signed_body;
                                delete innerPayload.ig_sig_key_version;

                                // Format modern resmi Instagram Android & instgrapi
                                options.form = {
                                    signed_body: `SIGNATURE.${JSON.stringify(innerPayload)}`
                                };
                                console.log(chalk`{green [SIGNATURE-FIX]} Menggunakan signed_body SIGNATURE. standar instgrapi (upload_id=${innerPayload.upload_id})`);
                            }
                        } catch (e) {
                            console.warn(chalk`{red [SIGNATURE-FIX-ERROR]} ${e.message}`);
                        }
                    }

                    // DEBUG: Log semua configure requests untuk tracing
                    if (options.url && (options.url.includes('configure'))) {
                        console.log(chalk`{yellow [DEBUG-CONFIGURE]} ${options.method || 'GET'} ${options.url}`);
                        console.log(chalk`{yellow [DEBUG-CONFIGURE]} Authorization: ${options.headers['Authorization'] ? 'PRESENT' : 'ABSENT'}`);
                        console.log(chalk`{yellow [DEBUG-CONFIGURE]} signed_body preview: ${options.form && options.form.signed_body ? options.form.signed_body.substring(0, 150) + '...' : 'N/A'}`);
                    }


                    // DEBUG: Log rupload request
                    if (options.url && options.url.includes('rupload')) {
                        const ruploadParams = options.headers && options.headers['X-Instagram-Rupload-Params'] 
                            ? options.headers['X-Instagram-Rupload-Params'].substring(0, 200)
                            : 'N/A';
                        console.log(chalk`{cyan [DEBUG-RUPLOAD-REQ]} ${options.method || 'GET'} ${options.url}`);
                        console.log(chalk`{cyan [DEBUG-RUPLOAD-REQ]} Rupload-Params: ${ruploadParams}`);
                        console.log(chalk`{cyan [DEBUG-RUPLOAD-REQ]} Authorization: ${options.headers['Authorization'] ? 'PRESENT' : 'ABSENT'}`);
                        // Check cookies in the jar for i.instagram.com
                        try {
                            const jarCookies = await self.ig.state.cookieJar.getCookies('https://i.instagram.com/');
                            const ds = jarCookies.find(c => c.key === 'ds_user_id');
                            const sid = jarCookies.find(c => c.key === 'sessionid');
                            const csrf = jarCookies.find(c => c.key === 'csrftoken');
                            console.log(chalk`{cyan [DEBUG-RUPLOAD-REQ]} cookies: ds_user_id=${ds ? ds.value : 'MISSING!'} sessionid=${sid ? sid.value.substring(0, 15) + '...' : 'MISSING!'} csrftoken=${csrf ? csrf.value.substring(0, 10) + '...' : 'MISSING!'}`);
                        } catch(e) { console.log(chalk`{cyan [DEBUG-RUPLOAD-REQ]} cookie read err: ${e.message}`); }
                    }

                    try {
                        const res = await originalRequest(options, onlyCheckHttpStatus);
                        const newClaim = res.headers['x-ig-set-www-claim'] || res.headers['x-ig-www-claim'];
                        if (newClaim) self._cachedClaim = newClaim;
                        // DEBUG: Log rupload response
                        if (options.url && options.url.includes('rupload')) {
                            console.log(chalk`{cyan [DEBUG-RUPLOAD-RES]} status=${res.statusCode} body=${JSON.stringify(res.body).substring(0, 150)}`);
                        }
                        // DEBUG: Log configure response
                        if (options.url && options.url.includes('configure')) {
                            console.log(chalk`{green [DEBUG-CONFIGURE-OK]} status=${res.statusCode} body.status=${res.body && res.body.status}`);
                        }
                        return res;
                    } catch (err) {
                        const msg = (err.message || "").toLowerCase();
                        if (msg.includes('feedback_required') || msg.includes('challenge_required')) {
                            console.error(chalk`{red [CRITICAL] Akun terdeteksi Block/Challenge. Silakan cek browser!}`);
                        }
                        // DEBUG: Log configure error response
                        if (options.url && options.url.includes('configure')) {
                            const errBody = err.response && err.response.body ? JSON.stringify(err.response.body).substring(0, 200) : 'N/A';
                            console.error(chalk`{red [DEBUG-CONFIGURE-ERR]} ${err.message}`);
                            console.error(chalk`{red [DEBUG-CONFIGURE-ERR]} response body: ${errBody}`);
                        }
                        throw err;
                    }
                };
                this._requestPatched = true;
            }

            if (!this.extUserInfo) {
                try {
                    this.extUserInfo = await this.ig.account.currentUser();
                } catch (e1) {
                    try {
                        if (this.pk || dsUserIdVal) {
                            this.extUserInfo = await this.ig.user.info(this.pk || dsUserIdVal);
                        }
                    } catch (e2) { }
                }
            }
            const user = this.extUserInfo;
            this.username = (user && user.username) ? user.username : (sessionData.username || 'unknown');
            this.pk = (user && user.pk) ? user.pk : (dsUserIdVal || this.pk);

            // Dynamically register activeLogger for this user once the username is resolved
            if (global.activeLoggers && this.logFn && this.username) {
                global.activeLoggers.set(this.username.toLowerCase(), this.logFn);
            }
            if (checkRemote && !silent) {
                // Muted for clean terminal: Connected successfully as @username
            }
            return { username: this.username, pk: this.pk };
        } catch (e) { return Promise.reject(new Error(`Extension Rejection: ${e.message}`)); }
    }


    /**
     * Generates a transparent PNG containing ONLY the link sticker
     * This is designed for video overlay where we don't want a background image.
     */
    async generatePureStickerPng(text, options = {}) {
        const {
            showIcon = true,
            isLinkOverride = null,
            rotation = 0,
            scale = 1.0,
            color = "#ffffff",
            textColor = "#0095F6",
            radius = 15,
            fontSize: envFontSizeReg = 16.5,
            fontFile: requestedFontParam = null,
            x = 0.5,
            y = 0.5
        } = options;

        const randomID = Date.now() + "_" + Math.floor(Math.random() * 1000000);
        try {
            text = (text || "");

            // Fixed base dimensions for Story (1080x1920)
            const canvasW = 1080;
            const canvasH = 1920;
            const dashWidth = 337.5;
            const dashScale = canvasW / dashWidth;
            const envScale = parseFloat(scale) || 1.0;
            const fontSize = Math.round(envFontSizeReg * dashScale * envScale);
            const stickerHeight = Math.round(fontSize * 1.75);
            const sidePadding = Math.round(22 * dashScale * envScale);
            const iconSize = Math.round(fontSize * 0.64);
            const iconSpacing = showIcon ? Math.round(sidePadding * 0.3) : 0;

            // ... (Drawing logic same as processStoryImage but on a transparent canvas)
            // To keep it DRY, we should ideally share this, but for now I will implement it here
            // to be safe and avoid breaking photo stories.

            // For now, I'll use processStoryImage with a fake transparent background
            // to ensure consistency while I refactor later.
        } catch (e) { return null; }
    }

    /**
     * Generates a transparent PNG sticker layer.
     * Use this for video overlay to avoid image artifacts.
     */
    async processStorySticker(text, options = {}) {
        const {
            showIcon = false,
            isLinkOverride = null,
            rotation = 0,
            scale = 1.0,
            color = "#ffffff",
            textColor = "#0095F6",
            radius = 15,
            fontSize: envFontSizeReg = 16.5,
            fontFile: requestedFontParam = null,
            shadowBlur = 5,
            shadowOpacity = 0.3
        } = options;

        const randomID = Date.now() + "_" + Math.floor(Math.random() * 1000000);
        try {
            text = (text || "");
            const canvasW = 1080;
            const canvasH = 1920;
            const dashWidth = 337.5;
            const dashScale = canvasW / dashWidth;
            const envScale = parseFloat(scale) || 1.0;
            const fontSize = Math.round(envFontSizeReg * dashScale * envScale);
            const stickerHeight = Math.round(fontSize * 1.75);
            const sidePadding = Math.round(22 * dashScale * envScale);
            const envIconScale = Math.max(0.3, Math.min(2.5, parseFloat(options.iconScale) || 0.8));
            const iconSize = showIcon ? Math.round(fontSize * 0.70 * envIconScale) : 0;
            const iconSpacing = showIcon ? Math.round(sidePadding * 0.3 * Math.min(1.2, envIconScale)) : 0;

            const emojiRegex = /(\u00a9|\u00ae|[\u2100-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g;
            const segments = [];
            let lastIdx = 0;
            let match;
            const tempRegex = new RegExp(emojiRegex, "g");
            while ((match = tempRegex.exec(text)) !== null) {
                if (match.index > lastIdx) segments.push({ type: 'text', content: text.substring(lastIdx, match.index) });
                const emojiChar = match[0];
                const codePoint = Array.from(emojiChar).map(c => c.codePointAt(0).toString(16)).join('-');
                segments.push({ type: 'emoji', content: emojiChar, code: codePoint });
                lastIdx = tempRegex.lastIndex;
            }
            if (lastIdx < text.length) segments.push({ type: 'text', content: text.substring(lastIdx) });

            const envBgColor = color;
            const envTextColor = textColor;
            const envRadius = parseInt(radius) || 15;
            const envShadowBlur = parseInt(shadowBlur) || 5;
            const envShadowOpacity = parseFloat(shadowOpacity) || 0.3;
            const isLink = true; // Always true for link stickers

            let stickerLayer = null;
            let stickerWidth = 200;

            const fontsDir = path.join(__dirname, 'fonts');
            let fontPath = null;
            const requestedFont = requestedFontParam;
            const defaultFontFile = "Instagram Sans Condensed.ttf";

            if (requestedFont && fs.existsSync(requestedFont)) {
                fontPath = requestedFont;
            } else if (requestedFont && fs.existsSync(path.join(fontsDir, requestedFont))) {
                fontPath = path.join(fontsDir, requestedFont);
            } else if (fs.existsSync(path.join(fontsDir, defaultFontFile))) {
                fontPath = path.join(fontsDir, defaultFontFile);
            } else if (fs.existsSync(fontsDir)) {
                const availableFontsList = fs.readdirSync(fontsDir).filter(f => f.toLowerCase().endsWith(".ttf") || f.toLowerCase().endsWith(".otf"));
                const condensedFont = availableFontsList.find(f => f.toLowerCase().includes("condensed") && !f.toLowerCase().includes("bold"));
                if (condensedFont) fontPath = path.join(fontsDir, condensedFont);
                else if (availableFontsList.length > 0) fontPath = path.join(fontsDir, availableFontsList[0]);
            }

            if (fontPath && fs.existsSync(fontPath)) {
                try {
                    const uniqueFontName = `CustomFont_${randomID}`;
                    const fnt = PImage.registerFont(fontPath, uniqueFontName);
                    // Temporarily silence console errors/warnings from PImage font loading
                    const originalConsoleError = console.error;
                    const originalConsoleLog = console.log;
                    const originalConsoleWarn = console.warn;
                    const silencer = (...args) => {
                        const msg = (args || []).map(a => String(a)).join(" ");
                        if (msg.includes("can't project")) return;
                        originalConsoleError(...args);
                    };
                    console.error = silencer;
                    console.log = (...args) => { if (!String(args[0]).includes("can't project")) originalConsoleLog(...args); };
                    console.warn = (...args) => { if (!String(args[0]).includes("can't project")) originalConsoleWarn(...args); };

                    fnt.loadSync();
                    console.error = originalConsoleError;
                    console.log = originalConsoleLog;
                    console.warn = originalConsoleWarn;

                    const measureCanvas = PImage.make(5000, 500);
                    const mCtx = measureCanvas.getContext('2d');
                    mCtx.font = `${fontSize}px ${uniqueFontName}`;
                    const emojiCount = segments.filter(s => s.type === 'emoji').length;
                    const emojiLoopWidth = (fontSize * 1.05);
                    let simulatedTextWidth = 0;
                    for (const seg of segments) {
                        if (seg.type === 'text') {
                            simulatedTextWidth += mCtx.measureText(seg.content).width;
                        } else {
                            simulatedTextWidth += emojiLoopWidth;
                        }
                    }

                    // Fallback only if simulation results in 0
                    if (simulatedTextWidth <= 0 && text.length > 0) {
                        simulatedTextWidth = Math.max(20, text.length * (fontSize * 0.45));
                    }

                    const contentWidth = iconSize + iconSpacing + simulatedTextWidth;
                    const sidePaddingPx = Math.round(sidePadding * 0.45);

                    // SYMMETRY: Use sidePaddingPx * 2 to match photo sticker logic
                    stickerWidth = Math.round(contentWidth + (sidePaddingPx * 2));

                    const hdScale = 3;
                    const canvas = PImage.make(Math.ceil(stickerWidth * hdScale), Math.ceil(stickerHeight * hdScale));
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = 'rgba(0,0,0,0)';
                    ctx.clearRect(0, 0, canvas.width, canvas.height);

                    ctx.scale(hdScale, hdScale);

                    // Enable high quality image smoothing
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'high';

                    // Corner radius murni pada 4 sudut kotak (rounded box)
                    const maxCornerRadius = Math.round(stickerHeight * 0.35);
                    const r = Math.min(envRadius * dashScale * envScale, maxCornerRadius);
                    const sW = Math.round(stickerWidth);
                    const sH = Math.round(stickerHeight);
                    const sR = Math.round(r);

                    ctx.fillStyle = envBgColor;
                    ctx.beginPath();
                    ctx.moveTo(sR, 0); ctx.lineTo(sW - sR, 0); ctx.quadraticCurveTo(sW, 0, sW, sR);
                    ctx.lineTo(sW, sH - sR); ctx.quadraticCurveTo(sW, sH, sW - sR, sH);
                    ctx.lineTo(sR, sH); ctx.quadraticCurveTo(0, sH, 0, sH - sR);
                    ctx.lineTo(0, sR); ctx.quadraticCurveTo(0, 0, sR, 0);
                    ctx.closePath(); ctx.fill();

                    if (showIcon) {
                        const s = Math.round(iconSize);
                        // SYMMETRY: Use centralized startX to match photo sticker logic
                        const startX = Math.round((stickerWidth - contentWidth) / 2);
                        const iconX = startX;

                        // ELEVATION: Shifted UP by 5% of height (~5px)
                        const iconY = Math.round((stickerHeight - s) / 2);
                        ctx.strokeStyle = envTextColor;
                        ctx.lineWidth = Math.max(6, s * 0.45); // REVERTED: Original bold thickness
                        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                        ctx.save();
                        ctx.translate(Math.round(iconX + s / 2), Math.round(iconY + s / 2));
                        ctx.rotate(-45 * Math.PI / 180);
                        const rd = s * 0.42; const leg = s * 0.18; const dist = s * 0.35;
                        ctx.beginPath(); ctx.moveTo(-dist + leg, rd); ctx.lineTo(-dist, rd);
                        ctx.arc(-dist, 0, rd, Math.PI * 0.5, Math.PI * 1.5, false);
                        ctx.lineTo(-dist + leg, -rd); ctx.stroke();
                        ctx.beginPath(); ctx.moveTo(dist - leg, -rd); ctx.lineTo(dist, -rd);
                        ctx.arc(dist, 0, rd, Math.PI * 1.5, Math.PI * 0.5, false);
                        ctx.lineTo(dist - leg, rd); ctx.stroke();
                        const barHalf = s * 0.40; ctx.beginPath(); ctx.moveTo(-barHalf, 0); ctx.lineTo(barHalf, 0); ctx.stroke();
                        ctx.restore();
                    }

                    ctx.font = `${fontSize}px ${uniqueFontName}`;
                    ctx.fillStyle = envTextColor;
                    // SYMMETRY: Start text drawing based on centralized startX
                    const startX = Math.round((stickerWidth - contentWidth) / 2);
                    let drawT = startX + iconSize + iconSpacing;

                    const textY = Math.round(stickerHeight / 2 + (fontSize / 3));
                    for (const seg of segments) {
                        if (seg.type === 'text') {
                            // PRESERVE SPACES: Allow user to add manual spacing if needed
                            const content = seg.content;
                            ctx.fillText(content, drawT, textY);
                            drawT += mCtx.measureText(content).width;
                        } else {
                            drawT += (fontSize * 1.05);
                        }
                    }

                    const { PassThrough } = require('stream');
                    const stream = new PassThrough();
                    const bP = new Promise(resolve => {
                        const c = []; stream.on('data', b => c.push(b)); stream.on('end', () => resolve(Buffer.concat(c)));
                    });
                    await PImage.encodePNGToStream(canvas, stream);
                    stickerLayer = await Jimp.read(await bP);

                    const textStartX = startX + iconSize + iconSpacing;
                    let currentX = 0;
                    let firstEmoji = true;
                    const gapBetweenEmojis = 0;
                    for (const seg of segments) {
                        if (seg.type === 'emoji') {
                            const emojiUrl = `https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.0.1/img/apple/64/${seg.code.toLowerCase()}.png`;
                            try {
                                const emojiData = await axios.get(emojiUrl, { responseType: 'arraybuffer', timeout: 5000 });
                                const emojiImg = await Jimp.read(Buffer.from(emojiData.data));
                                const eDim = Math.round(fontSize * 1.05 * hdScale);
                                emojiImg.resize({ w: eDim, h: eDim }, Jimp.RESIZE_BICUBIC);

                                // SYNC: Match photo sticker level and padding (No Offsets)
                                const emojiPadding = 2;
                                const eX = Math.round((textStartX + currentX + emojiPadding) * hdScale);
                                // LEVEL: Perfectly centered vertically, then shifted UP 4px for better visual balance
                                const eY = Math.round((stickerHeight * hdScale - eDim) / 2 - (4 * hdScale));
                                stickerLayer.composite(emojiImg, eX, eY);
                                firstEmoji = false;
                            } catch (ee) { }
                            currentX += (fontSize * 1.05) + gapBetweenEmojis;
                        } else {
                            currentX += mCtx.measureText(seg.content).width;
                        }
                    }
                    stickerLayer.resize({ w: Math.round(stickerWidth), h: Math.round(stickerHeight) }, Jimp.RESIZE_BICUBIC);

                    console.error = originalConsoleError; console.log = originalConsoleLog; console.warn = originalConsoleWarn;
                } catch (pe) { console.log(`[Sticker Error] ${pe.message}`); }
            }

            if (!stickerLayer) {
                stickerWidth = Math.max(200, text.length * (fontSize * 0.6));
                stickerLayer = new Jimp({ width: Math.round(stickerWidth), height: stickerHeight, color: 0x00000000 });
            }
            // Video stickers now use native metadata rotation (applied in publishStory)
            // instead of baking rotation into the PNG to avoid cropping and alignment issues.

            const tempPath = path.join(options.workArea || path.join(global.dataDir, 'media'), `sticker_v89_${randomID}.png`);
            if (!fs.existsSync(path.dirname(tempPath))) fs.mkdirSync(path.dirname(tempPath), { recursive: true });
            await stickerLayer.write(tempPath);
            return { path: tempPath, width: stickerWidth / canvasW, height: stickerHeight / canvasH, widthPx: stickerWidth, heightPx: stickerHeight };
        } catch (e) { return null; }
    }

    async processStoryImage(filePath, text, options = {}) {
        const {
            showIcon = false,
            isLinkOverride = null,
            rotation = 0,
            scale = 1.0,
            color = "#ffffff",
            textColor = "#0095F6",
            radius = 15,
            fontSize: envFontSizeReg = 16.5,
            fontFile: requestedFontParam = null,
            shadowBlur = 5,
            shadowOpacity = 0.3,
            blur = false,
            blurValue = 20
        } = options;
        const randomID = Date.now() + "_" + Math.floor(Math.random() * 1000000);
        try {
            text = (text || "");
            const originalImage = await Jimp.read(filePath);
            const imgWidth = originalImage.width;
            const imgHeight = originalImage.height;

            const dashWidth = 337.5;
            const dashHeight = 600.0;
            const dashRatio = dashWidth / dashHeight; // = 9/16

            // Determine canvas size at 9:16
            let canvasW, canvasH;
            if (imgWidth / imgHeight > dashRatio) {
                // Wider than 9:16 → keep width, extend height to match ratio
                canvasW = imgWidth;
                canvasH = Math.round(imgWidth / dashRatio);
            } else {
                // Taller than 9:16 → keep height, expand width
                canvasH = imgHeight;
                canvasW = Math.round(imgHeight * dashRatio);
            }

            // COVER MODE: scale image to fill 9:16 canvas completely, then center-crop.
            // This matches Instagram's native behavior (no black bars).
            const coverScale = Math.max(canvasW / imgWidth, canvasH / imgHeight);
            const scaledW = Math.round(imgWidth * coverScale);
            const scaledH = Math.round(imgHeight * coverScale);

            if (blur) {
                originalImage.blur(parseInt(blurValue) || 20);
            }

            originalImage.resize({ w: scaledW, h: scaledH });
            const cropX_Img = Math.round((scaledW - canvasW) / 2);
            const cropY_Img = Math.round((scaledH - canvasH) / 2);
            originalImage.crop({ x: cropX_Img, y: cropY_Img, w: canvasW, h: canvasH });

            // storyCanvas is now the cover-cropped 9:16 image
            const storyCanvas = originalImage;

            const dashScale = canvasW / dashWidth;
            const envScale = parseFloat(scale) || 1.0;
            const fontSize = Math.round(envFontSizeReg * dashScale * envScale);
            const stickerHeight = Math.round(fontSize * 1.75);
            const sidePadding = Math.round(22 * dashScale * envScale);
            const envIconScale = Math.max(0.3, Math.min(2.5, parseFloat(options.iconScale) || 0.8));
            const iconSize = showIcon ? Math.round(fontSize * 0.70 * envIconScale) : 0;
            const iconSpacing = showIcon ? Math.round(sidePadding * 0.3 * Math.min(1.2, envIconScale)) : 0;

            const emojiRegex = /(\u00a9|\u00ae|[\u2100-\u3300]|\ud83c[\ud000-\udfff]|\ud83d[\ud000-\udfff]|\ud83e[\ud000-\udfff])/g;
            const segments = [];
            let lastIdx = 0;
            let match;
            const tempRegex = new RegExp(emojiRegex, "g");
            while ((match = tempRegex.exec(text)) !== null) {
                if (match.index > lastIdx) segments.push({ type: 'text', content: text.substring(lastIdx, match.index) });
                const emojiChar = match[0];
                const codePoint = Array.from(emojiChar).map(c => c.codePointAt(0).toString(16)).join('-');
                segments.push({ type: 'emoji', content: emojiChar, code: codePoint });
                lastIdx = tempRegex.lastIndex;
            }
            if (lastIdx < text.length) segments.push({ type: 'text', content: text.substring(lastIdx) });

            const textForDrawing = text.replace(emojiRegex, "  ");
            const envBgColor = color;
            const envTextColor = textColor;
            const envRadius = parseInt(radius) || 15;
            const envShadowBlur = parseInt(shadowBlur) || 5;
            const envShadowOpacity = parseFloat(shadowOpacity) || 0.3;

            let stickerLayer = null;
            let stickerWidth = 200;

            const fontsDir = path.join(__dirname, 'fonts');
            let fontPath = null;
            const defaultFontFile = "Instagram Sans Condensed.ttf";
            if (requestedFontParam && fs.existsSync(requestedFontParam)) {
                fontPath = requestedFontParam;
            } else if (requestedFontParam && fs.existsSync(path.join(fontsDir, requestedFontParam))) {
                fontPath = path.join(fontsDir, requestedFontParam);
            } else if (fs.existsSync(path.join(fontsDir, defaultFontFile))) {
                fontPath = path.join(fontsDir, defaultFontFile);
            } else if (fs.existsSync(fontsDir)) {
                const availableFontsList = fs.readdirSync(fontsDir).filter(f => f.toLowerCase().endsWith(".ttf") || f.toLowerCase().endsWith(".otf"));
                const condensedFont = availableFontsList.find(f => f.toLowerCase().includes("condensed") && !f.toLowerCase().includes("bold"));
                if (condensedFont) fontPath = path.join(fontsDir, condensedFont);
                else if (availableFontsList.length > 0) fontPath = path.join(fontsDir, availableFontsList[0]);
            }

            if (fontPath && fs.existsSync(fontPath)) {
                try {
                    const uniqueFontName = `CustomFont_${randomID}`;
                    const fnt = PImage.registerFont(fontPath, uniqueFontName);
                    // Temporarily silence console errors/warnings from PImage font loading
                    const originalConsoleError = console.error;
                    const originalConsoleLog = console.log;
                    const originalConsoleWarn = console.warn;
                    const silencer = (...args) => {
                        const msg = (args || []).map(a => String(a)).join(" ");
                        if (msg.includes("can't project")) return;
                        originalConsoleError(...args);
                    };
                    console.error = silencer;
                    console.log = (...args) => { if (!String(args[0]).includes("can't project")) originalConsoleLog(...args); };
                    console.warn = (...args) => { if (!String(args[0]).includes("can't project")) originalConsoleWarn(...args); };
                    fnt.loadSync();
                    console.error = originalConsoleError;
                    console.log = originalConsoleLog;
                    console.warn = originalConsoleWarn;

                    const measureCanvas = PImage.make(5000, 500);
                    const mCtx = measureCanvas.getContext('2d');
                    mCtx.font = `${fontSize}px ${uniqueFontName}`;

                    const emojiLoopWidth = (fontSize * 1.05);
                    let simulatedTextWidth = 0;
                    for (const seg of segments) {
                        if (seg.type === 'text') {
                            simulatedTextWidth += mCtx.measureText(seg.content).width;
                        } else {
                            simulatedTextWidth += emojiLoopWidth;
                        }
                    }

                    // Fallback only if simulation results in 0
                    if (simulatedTextWidth <= 0 && textForDrawing.length > 0) {
                        simulatedTextWidth = Math.max(20, textForDrawing.length * (fontSize * 0.45));
                    }

                    const contentWidth = iconSize + iconSpacing + simulatedTextWidth;
                    const sidePaddingPx = Math.round(sidePadding * 0.45);

                    // SYMMETRY: Use sidePaddingPx * 2 for both ends
                    stickerWidth = Math.round(contentWidth + (sidePaddingPx * 2));

                    const hdScale = 3;
                    const canvasW_Stencil = Math.ceil(stickerWidth);
                    const canvasH_Stencil = Math.ceil(stickerHeight);
                    const canvas = PImage.make(canvasW_Stencil * hdScale, canvasH_Stencil * hdScale);
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = 'rgba(0,0,0,0)'; ctx.clearRect(0, 0, canvasW_Stencil * hdScale, canvasH_Stencil * hdScale);
                    ctx.scale(hdScale, hdScale);

                    // Corner radius murni pada 4 sudut kotak (rounded box)
                    const maxCornerRadius = Math.round(stickerHeight * 0.35);
                    const r = Math.min(envRadius * dashScale * envScale, maxCornerRadius);
                    const sW = Math.round(stickerWidth);
                    const sH = Math.round(stickerHeight);
                    const sR = Math.round(r);

                    ctx.fillStyle = envBgColor;
                    ctx.beginPath();
                    ctx.moveTo(sR, 0); ctx.lineTo(sW - sR, 0); ctx.quadraticCurveTo(sW, 0, sW, sR);
                    ctx.lineTo(sW, sH - sR); ctx.quadraticCurveTo(sW, sH, sW - sR, sH);
                    ctx.lineTo(sR, sH); ctx.quadraticCurveTo(0, sH, 0, sH - sR);
                    ctx.lineTo(0, sR); ctx.quadraticCurveTo(0, 0, sR, 0);
                    ctx.closePath(); ctx.fill();

                    if (showIcon) {
                        const s = Math.round(iconSize);
                        // SYMMETRY: Use centralized startX to match photo sticker logic
                        const startX = Math.round((stickerWidth - contentWidth) / 2);
                        const iconX = startX;

                        // ELEVATION: Shifted UP by 5% of height (~5px)
                        const iconY = Math.round((stickerHeight - s) / 2);
                        ctx.strokeStyle = envTextColor;
                        ctx.lineWidth = Math.max(6, s * 0.45); // REVERTED: Original bold thickness
                        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                        ctx.save();
                        ctx.translate(Math.round(iconX + s / 2), Math.round(iconY + s / 2));
                        ctx.rotate(-45 * Math.PI / 180);
                        const rd = s * 0.42; const leg = s * 0.18; const dist = s * 0.35;
                        ctx.beginPath(); ctx.moveTo(-dist + leg, rd); ctx.lineTo(-dist, rd);
                        ctx.arc(-dist, 0, rd, Math.PI * 0.5, Math.PI * 1.5, false);
                        ctx.lineTo(-dist + leg, -rd); ctx.stroke();
                        ctx.beginPath(); ctx.moveTo(dist - leg, -rd); ctx.lineTo(dist, -rd);
                        ctx.arc(dist, 0, rd, Math.PI * 1.5, Math.PI * 0.5, false);
                        ctx.lineTo(dist - leg, rd); ctx.stroke();
                        const barHalf = s * 0.40; ctx.beginPath(); ctx.moveTo(-barHalf, 0); ctx.lineTo(barHalf, 0); ctx.stroke();
                        ctx.restore();
                    }

                    ctx.font = `${fontSize}px ${uniqueFontName}`;
                    ctx.fillStyle = envTextColor;
                    const startX = Math.round((stickerWidth - contentWidth) / 2);
                    const textStartX = Math.round(startX + iconSize + iconSpacing);
                    const textY = Math.round(stickerHeight / 2 + (fontSize / 2.8));
                    ctx.fillText(textForDrawing, textStartX, textY);

                    const { PassThrough } = require('stream');
                    const stream = new PassThrough();
                    const bP = new Promise(resolve => {
                        const c = []; stream.on('data', b => c.push(b)); stream.on('end', () => resolve(Buffer.concat(c)));
                    });
                    await PImage.encodePNGToStream(canvas, stream);
                    stickerLayer = await Jimp.read(await bP);

                    let currentX = 0;
                    const emojiPadding = 2; // Rapat: Minimal space after text
                    const gapBetweenEmojis = 2;
                    for (const seg of segments) {
                        if (seg.type === 'emoji') {
                            const emojiUrl = `https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.0.1/img/apple/64/${seg.code.toLowerCase()}.png`;
                            try {
                                const emojiData = await axios.get(emojiUrl, { responseType: 'arraybuffer', timeout: 5000 });
                                const emojiImg = await Jimp.read(Buffer.from(emojiData.data));
                                const eDim = Math.round(fontSize * 1.05 * hdScale);
                                emojiImg.resize({ w: eDim, h: eDim }, Jimp.RESIZE_BICUBIC);
                                const eX = Math.round((textStartX + currentX + emojiPadding) * hdScale);
                                // LEVEL: Centered vertically, then shifted UP 4px for visual balance
                                const eY = Math.round((stickerHeight * hdScale - eDim) / 2 - (4 * hdScale));
                                stickerLayer.composite(emojiImg, eX, eY);
                            } catch (ee) { }
                            currentX += (fontSize * 1.05) + gapBetweenEmojis;
                        } else {
                            currentX += mCtx.measureText(seg.content).width;
                        }
                    }
                    stickerLayer.resize({ w: canvasW_Stencil, h: canvasH_Stencil }, Jimp.RESIZE_BICUBIC);
                } catch (pe) { console.warn(`[story] Sticker render error: ${pe.message}`, pe); }
            }

            if (!stickerLayer) {
                stickerWidth = Math.max(200, textForDrawing.length * (fontSize * 0.6));
                stickerLayer = new Jimp({ width: Math.round(stickerWidth), height: stickerHeight, color: parseInt(envBgColor.replace("#", "0x") + "FF", 16) });
            }
            if (rotation !== 0) stickerLayer.rotate(-parseFloat(rotation));

            const xN = parseFloat(options.x) || 0.5;
            const yN = parseFloat(options.y) || 0.5;
            const sX = Math.floor((canvasW * xN) - (stickerLayer.width / 2));
            const sY = Math.floor((canvasH * yN) - (stickerLayer.height / 2));

            const sBlur = Math.round(envShadowBlur * dashScale);
            const sPad = Math.ceil(Math.max(sBlur * 2, 10));
            const shadow = new Jimp({ width: stickerLayer.bitmap.width + sPad, height: stickerLayer.bitmap.height + sPad, color: 0x00000000 });
            const opVal = Math.round(envShadowOpacity * 255);

            stickerLayer.scan(0, 0, stickerLayer.width, stickerLayer.height, (x, y, idx) => {
                if (stickerLayer.bitmap.data[idx + 3] > 10) shadow.setPixelColor(opVal, x + Math.floor(sPad / 2), y + Math.floor(sPad / 2));
            });
            if (sBlur > 0) shadow.blur(Math.max(1, sBlur));

            const shadowOffX = Math.round(2 * dashScale * envScale);
            const shadowOffY = Math.round(4 * dashScale * envScale);

            storyCanvas.composite(shadow, Math.floor(sX - sPad / 2 + shadowOffX / 2), Math.floor(sY - sPad / 2 + shadowOffY));
            storyCanvas.composite(stickerLayer, sX, sY);

            // FIX: Use an isolated random tempPath in the workArea to prevent concurrent collisions
            const workArea = options.workArea || path.dirname(filePath);
            const tempPath = path.join(workArea, `${path.basename(filePath, path.extname(filePath))}_polished_v89_${randomID}${path.extname(filePath)}`);
            await storyCanvas.write(tempPath);
            // Report TRUE content dimensions (excluding the 1.2x padding) for the Instagram interactive area
            // This ensures the "clickable" part matches the visual part perfectly.
            return { path: tempPath, width: stickerWidth / canvasW, height: stickerHeight / canvasH };
        } catch (e) { return { path: filePath, width: 0.5, height: 0.1 }; }
    }

    async publishStory(file, type = 'photo', linkOrOptions = '', linkText = '', showIconArg = false) {
        let options = {};
        if (typeof linkOrOptions === 'object' && linkOrOptions !== null) {
            options = linkOrOptions;
        } else {
            options = {
                linkUrl: linkOrOptions,
                linkTitle: linkText,
                showIcon: showIconArg,
                x: process.env.STORY_X,
                y: process.env.STORY_Y,
                rotation: process.env.STORY_ROTATION,
                scale: process.env.STORY_SCALE,
                color: process.env.STORY_COLOR,
                textColor: process.env.STORY_TEXT_COLOR,
                radius: process.env.STORY_RADIUS,
                fontSize: process.env.STORY_FONT_SIZE,
                fontFile: process.env.STORY_FONT_FILE
            };
        }

        let tempFile = null;
        const cleanupFiles = [];

        // --- ISOLATION: Setup workarea for current task ---
        const taskId = `story_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const workArea = await this.getWorkArea(taskId);
        options.workArea = workArea; // Pass to processStoryImage/Sticker

        const originalRequest = this.ig.request.send.bind(this.ig.request);
        let patched = false;

        try {
            // --- ON-THE-FLY TAKEOVER: MOBILE IDENTITY TRANSLATION ---
            const cookies = await this.ig.state.cookieJar.getCookies('https://i.instagram.com/');
            const dsUserId = cookies.find(c => c.key === 'ds_user_id')?.value;
            const sessionId = cookies.find(c => c.key === 'sessionid')?.value;
            const browserUa = this.ig.state.userAgent;

            if (dsUserId && sessionId) {
                const cleanSessionId = decodeURIComponent(sessionId);
                const authObj = { ds_user_id: dsUserId, sessionid: cleanSessionId };
                const bearerToken = `Bearer IGT:2:${Buffer.from(JSON.stringify(authObj)).toString('base64')}`;
                const mobileUa = 'Instagram 370.0.0.35.101 Android (33/13; 600dpi; 1440x3088; samsung; SM-S918B; dm3q; kalama; en_US; 610000000)';

                // Patch the request handler ONLY for this specific story task
                this.ig.request.send = async (opt, onlyCheckHttpStatus) => {
                    if (!opt.headers) opt.headers = {};
                    const isNative = opt.url && (opt.url.includes('rupload') || opt.url.includes('api/v1'));

                    if (isNative) {
                        opt.headers['User-Agent'] = mobileUa;
                        opt.headers['X-IG-App-ID'] = '124024574287414';
                        opt.headers['X-IG-App-Version'] = '370.0.0.35.101';
                        opt.headers['X-IG-Capabilities'] = 'br0LAA==';
                        opt.headers['X-IG-Connection-Type'] = 'WIFI';
                        opt.headers['X-ASBD-ID'] = '198303';
                        opt.headers['X-IG-WWW-Claim'] = '0';
                        opt.headers['X-IG-Bandwidth-Speed-KBPS'] = (Math.floor(Math.random() * 5000) + 10000).toString();

                        // === CRITICAL: Gunakan Bearer untuk SEMUA requests (rupload + configure) ===
                        // Saat Bearer digunakan, Instagram mendaftarkan upload di Bearer session queue.
                        // configure_to_story juga pakai Bearer → keduanya di pipeline yang sama.
                        // Sebelumnya: rupload pakai cookies, configure pakai Bearer → beda pipeline → "upload id is missing"
                        if (bearerToken) {
                            opt.headers['Authorization'] = bearerToken;
                        }

                        // === CRITICAL FIX: Inject for_story:'1' ke rupload photo untuk story ===
                        // Instagram memisahkan upload pipeline berdasarkan for_story flag.
                        // configure_to_story hanya bisa menemukan upload yang di-upload dengan for_story:'1'
                        if (opt.url && opt.url.includes('rupload_igphoto') && opt.headers['X-Instagram-Rupload-Params']) {
                            try {
                                const ruploadParams = JSON.parse(opt.headers['X-Instagram-Rupload-Params']);
                                if (!ruploadParams.for_story) {
                                    ruploadParams.for_story = '1';
                                    ruploadParams.source_type = '3'; // 3 = story source
                                    opt.headers['X-Instagram-Rupload-Params'] = JSON.stringify(ruploadParams);
                                    console.log(chalk`{magenta [STORY-FIX]} Injected for_story:1 into rupload params`);
                                }
                            } catch (e) { console.warn(chalk`{yellow [STORY-FIX]} Failed to inject for_story: ${e.message}`); }
                        }

                        // --- NATIVE PAYLOAD ADJUSTMENT (Translate JSON to Form-Data) ---
                        if (opt.method === 'POST' && opt.body && typeof opt.body === 'string' && !opt.url.includes('rupload')) {
                            try {
                                const parsed = JSON.parse(opt.body);
                                const formData = Object.entries(parsed).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
                                opt.body = formData;
                                opt.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                            } catch (e) { }
                        }
                    } else {
                        opt.headers['User-Agent'] = browserUa;
                    }
                    return originalRequest(opt, onlyCheckHttpStatus);
                };
                patched = true;
            }

            const { linkUrl, linkTitle, showIcon, x: xOpt, y: yOpt, rotation: rotOpt, scale: scaleOpt } = options;
            const x = parseFloat(xOpt) || 0.5;
            const y = parseFloat(yOpt) || 0.5;
            const rotation = parseFloat(rotOpt) || 0;
            const scale = parseFloat(scaleOpt) || 1.0;
            let finalMedia = file;
            let stickerW = 0.5;
            let stickerH = 0.1;

            let stickerInfoForVideo = null;
            if (linkTitle && linkTitle.length > 0) {
                if (type === 'photo') {
                    const processed = await this.processStoryImage(file, linkTitle, options);
                    finalMedia = processed.path;
                    stickerW = processed.width;
                    stickerH = processed.height;
                    if (finalMedia !== file) tempFile = finalMedia;
                } else {
                    console.log(chalk`{cyan [story] Calculating video sticker dimensions...}`);
                    stickerInfoForVideo = await this.processStorySticker(linkTitle, options);
                    stickerW = stickerInfoForVideo.width;
                    stickerH = stickerInfoForVideo.height;
                }
            } else {
                // Always make media unique even if no sticker is applied
                if (options.blur) console.log(chalk`{cyan [story] Applying blur (${options.blurValue || 20}px) to photo background...}`);
                console.log(chalk`{cyan [story] Making media unique for safety...}`);
                const uniquePath = await makeMediaUnique(file, type, workArea);
                if (uniquePath !== file) {
                    finalMedia = uniquePath;
                    tempFile = uniquePath;
                }
                // Ensure 9:16 ratio even when no sticker is used (same as processStoryImage does)
                if (type === 'photo') {
                    console.log(chalk`{cyan [story] Ensuring 9:16 aspect ratio for story photo...}`);
                    const paddedPath = await padImageToStoryRatio(finalMedia, workArea, !!options.blur, options.blurValue || 20);
                    if (paddedPath !== finalMedia) {
                        // paddedPath is a new temp file; if finalMedia was also temp, clean it up later
                        if (tempFile && tempFile !== file) cleanupFiles.push(tempFile);
                        finalMedia = paddedPath;
                        tempFile = paddedPath;
                        console.log(chalk`{green [story] Photo padded to 9:16 canvas.}`);
                    }
                }
            }

            // CRITICAL: Read the buffer AFTER processing (so we get the baked version)
            const fileStream = fs.readFileSync(finalMedia);
            const storyOptions = { file: fileStream };

            if (linkUrl && linkUrl.length > 0) {
                let finalLink = linkUrl.trim();
                if (!finalLink.startsWith("http")) finalLink = "https://" + finalLink;

                let displayHostname = "";
                try {
                    displayHostname = new URL(finalLink).hostname.replace(/^www\./, "");
                } catch (e) {
                    displayHostname = finalLink;
                }

                const cleanText = (linkTitle || displayHostname).trim();
                const isCustomStyle = parseInt(options.radius || "30") !== 30 || parseFloat(process.env.STORY_OUTLINE_WIDTH || "0") > 0 || parseInt(options.shadowBlur || "5") > 5;
                const frameScale = isCustomStyle ? 0.92 : 1.0;

                // Khusus video story, Instagram ExoPlayer memiliki gesture listener yang ketat.
                // Multiplier ini memperluas hitbox horizontal & vertikal agar mencakup seluruh panjang stiker baked
                // sehingga sentuhan di ujung kiri/kanan stiker tidak tertelan menjadi gesture pause video.
                const videoWidthMultiplier = type === 'video' ? 1.4 : 1.0;
                const videoHeightMultiplier = type === 'video' ? 1.25 : 1.0;

                // Tap Model object matching modern Instagram & instgrapi specification
                const tapModel = {
                    x: Number((Math.max(0.05, Math.min(0.95, x))).toFixed(7)),
                    y: Number((Math.max(0.05, Math.min(0.95, y))).toFixed(7)),
                    z: 0,
                    width: Number((Math.max(0.12, Math.min(0.95, stickerW * frameScale * videoWidthMultiplier))).toFixed(7)),
                    height: Number((Math.max(0.06, Math.min(0.5, stickerH * frameScale * videoHeightMultiplier))).toFixed(7)),
                    rotation: type === 'video' ? (-rotation / 180 * Math.PI) : 0.0,
                    type: 'story_link',
                    is_sticker: true,
                    selected_index: 0,
                    tap_state: 0,
                    tap_state_str_id: 'link_sticker_default',
                    link_type: 'web',
                    url: finalLink
                };

                storyOptions.stickerConfig = {
                    tap_models: JSON.stringify([tapModel]),
                    story_sticker_ids: 'link_sticker_default'
                };

                // Validate URL against Instagram reel URL whitelist API
                try {
                    await this.ig.request.send({
                        url: '/api/v1/media/validate_reel_url/',
                        method: 'POST',
                        form: {
                            url: finalLink,
                            _uid: this.ig.state.cookieUserId,
                            _uuid: this.ig.state.uuid
                        }
                    });
                    console.log(chalk`{cyan [story]} validate_reel_url OK: ${finalLink}`);
                } catch (vErr) {
                    console.log(chalk`{gray [story] validate_reel_url note: ${vErr.message}}`);
                }
            }

            const uniqueUploadId = Date.now().toString();
            storyOptions.uploadId = uniqueUploadId;

            let res;
            if (type === 'photo') {
                const log = (msg) => {
                    console.log(chalk`{cyan [story]} ${msg}`);
                    if (this.extLogger) this.extLogger('info', `[story] ${msg}`);

                };


                print("Mempersiapkan foto", "wait");
                const waterfallId = require("chance").Chance().guid({ version: 4 });
                print("Mengunggah foto", "info");
                const uploadResponse = await this.ig.upload.photo({
                    file: storyOptions.file,
                    uploadId: uniqueUploadId,
                    waterfallId,
                });

                const finalUploadId = uploadResponse.upload_id || uniqueUploadId;

                // Diagnostic log (Internal only for developer, via console)
                console.log(chalk`{gray [story] Upload Response JSON: ${JSON.stringify(uploadResponse)}}`);

                if (uploadResponse.status !== 'ok') {
                    throw new Error(`Upload rejected by Instagram: ${uploadResponse.message || 'Status not OK'}`);
                }

                // Wait briefly for Instagram upload indexing
                print("Menunggu", "wait");
                await new Promise(r => setTimeout(r, 3000));

                console.log(chalk`{cyan [story] Konfigurasi story...}`);
                let lastErr;
                const consistentClientContext = require("chance").Chance().guid({ version: 4 });
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        const payload = {
                            upload_id: finalUploadId,
                            waterfall_id: waterfallId,
                            client_context: consistentClientContext,
                            timezone_offset: '25200',
                            supported_capabilities_new: JSON.stringify([
                                { "name": "SUPPORTED_SDK_VERSIONS", "value": "13.0,14.0,15.0,16.0,17.0,18.0,19.0,20.0,21.0,22.0,23.0,24.0,25.0,26.0,27.0,28.0,29.0,30.0,31.0,32.0,33.0,34.0,35.0,36.0,37.0,38.0,39.0,40.0,41.0,42.0,43.0,44.0,45.0,46.0,47.0,48.0,49.0,50.0,51.0,52.0,53.0,54.0,55.0,56.0,57.0,58.0,59.0,60.0,61.0,62.0,63.0,64.0,65.0,66.0,67.0,68.0,69.0,70.0,71.0,72.0,73.0,74.0,75.0,76.0,77.0,78.0,79.0,80.0,81.0,82.0,83.0,84.0,85.0,86.0,87.0,88.0,89.0,90.0,91.0,92.0,93.0,94.0,95.0,96.0,97.0,98.0,99.0,100.0" },
                                { "name": "FACE_TRACKER_VERSION", "value": 12 },
                                { "name": "segmentation", "value": "segmentation_enabled" },
                                { "name": "COMPRESSION", "value": "ETC2_COMPRESSION" },
                                { "name": "world_tracker", "value": "world_tracker_enabled" },
                                { "name": "gyroscope", "value": "gyroscope_enabled" }
                            ]),
                            ...(storyOptions.stickerConfig || {})
                        };
                        // Log payload for internal debugging
                        console.log(chalk`{gray [story] Configure Payload: ${JSON.stringify(payload)}}`);

                        res = await this.ig.media.configureToStory(payload);
                        break; // Success!
                    } catch (err) {
                        lastErr = err;
                        if (attempt < 3 && err.message && err.message.includes("upload id is missing")) {
                            const waitTime = 5000 * attempt;
                            print(`Delay indexing terdeteksi. Mencoba lagi dalam ${waitTime / 1000}dtk... (Percobaan ${attempt}/3)`, "wait");
                            await new Promise(r => setTimeout(r, waitTime));
                            continue;
                        }
                        throw err;
                    }
                }
            } else {
                // ------- VIDEO PATH -------
                // Use the ultra-robust custom method instead of the library's unreliable ig.publish.story
                const videoFilePath = file;
                const log = (msg) => {
                    console.log(chalk`{cyan [story]} ${msg}`);
                    if (this.extLogger) this.extLogger('info', `[story] ${msg}`);

                };


                print("Mempersiapkan upload video", "wait");

                // 1. Generate Cover (Poster Frame)
                // Generate Video Cover using isolated workArea
                const coverPath = path.join(workArea, `${path.basename(videoFilePath)}_cover.jpg`);
                cleanupFiles.push(coverPath);
                try {
                    // Generate Video Cover using dynamic ffmpeg
                    const ffmpegPath = getFFmpegPath();
                    const ffmpeg = require('fluent-ffmpeg');
                    ffmpeg.setFfmpegPath(ffmpegPath);
                    await new Promise((resolve, reject) => {
                        ffmpeg(String(videoFilePath))
                            .screenshots({ count: 1, timemarks: ['00:00:00'], filename: require('path').basename(coverPath), folder: require('path').dirname(coverPath) })
                            .on('end', resolve)
                            .on('error', reject);
                    });
                    if (fs.existsSync(coverPath)) {
                        if (options.blur) {
                            console.log(chalk`{cyan [story] Applying full frame blur to cover image...}`);
                            const cover = await Jimp.read(coverPath);
                            // Match the video style: Scale to fill (1080x1920) and blur the whole frame
                            cover.cover({ w: 1080, h: 1920 }).blur(parseInt(options.blurValue) || 20);
                            await cover.write(coverPath);
                        }
                        storyOptions.coverImage = coverPath;

                        // --- ON-THE-FLY SHORTLINK GENERATOR ---
                        const shortProv = this.config?.story?.shortlinkProvider;
                        if (linkUrl && shortProv && shortProv !== 'none') {
                            try {
                                const port = process.env.PORT || 7500;
                                const shortRes = await axios.post(`http://127.0.0.1:${port}/api/extension/shortlink`, {
                                    provider: shortProv,
                                    longUrl: linkUrl,
                                    apiKey: this.config?.story?.shortlinkApiKey || ''
                                }, { timeout: 10000 }).catch(() => null);

                                if (shortRes && shortRes.data && shortRes.data.ok && shortRes.data.shortUrl) {
                                    linkUrl = shortRes.data.shortUrl;
                                }
                            } catch (e) { }
                        }
                    }
                } catch (e) {
                    console.warn(`[story] ⚠️ Gagal generate cover: ${e.message}`);
                }

                // 2. "COOK" VIDEO (Blur & Sticker) in isolated workArea
                const cookedVideoPath = path.join(workArea, `${path.basename(videoFilePath)}_cooked.mp4`);
                cleanupFiles.push(cookedVideoPath);
                print("Memproses video...", "wait");
                try {
                    const ffmpeg = require('fluent-ffmpeg');
                    ffmpeg.setFfmpegPath(getFFmpegPath()); // Set ffmpeg path for fluent-ffmpeg
                    // Generate Pure Sticker PNG for overlay (No background image)
                    let stickerPngPath = null;
                    if (linkTitle) {
                        console.log(chalk`{cyan [story] Menyiapkan overlay stiker...}`);
                        // Reuse the stickerInfo generated earlier
                        const stickerInfo = stickerInfoForVideo || await this.processStorySticker(linkTitle, options);
                        stickerPngPath = stickerInfo.path;
                        cleanupFiles.push(stickerPngPath);

                        await new Promise((resolve, reject) => {
                            const inputs = [videoFilePath];
                            if (stickerPngPath) inputs.push(stickerPngPath);

                            const ff = ffmpeg();
                            inputs.forEach(input => ff.input(input));

                            // Calculate sticker position based on 1080x1920 canvas
                            const sX = Math.round((parseFloat(options.x) || 0.5) * 1080 - (stickerInfo.widthPx / 2));
                            const sY = Math.round((parseFloat(options.y) || 0.5) * 1920 - (stickerInfo.heightPx / 2));

                            // 1080x1920 CANVAS STACK (Beta12 Mature Style):
                            // 1. Scale video to FILL & CROP (Full frame)
                            // 2. Apply BoxBlur to the WHOLE frame if requested
                            // 3. Overlay the transparent link sticker
                            let filter = '';
                            if (options.blur) {
                                // Full Frame Blur style (Mature)
                                filter += `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=${options.blurValue || 20}:5[v_blur];`;
                                filter += `[v_blur][1:v]overlay=${sX}:${sY}[v_final]`;
                            } else {
                                // No blur (Full frame clear)
                                filter += '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[v_together];';
                                filter += `[v_together][1:v]overlay=${sX}:${sY}[v_final]`;
                            }

                            ff.outputOptions([
                                '-filter_complex', filter,
                                '-map', '[v_final]',
                                '-t', '60',
                                '-c:v', 'libx264',
                                '-preset', 'veryfast',
                                '-crf', '24',
                                '-maxrate', '3800k',
                                '-bufsize', '7600k',
                                '-pix_fmt', 'yuv420p',
                                '-r', '30',
                                '-g', '60',
                                '-movflags', '+faststart'
                            ]);
                            if (options.mute) {
                                print(`Menghilangkan suara video...`, "wait");
                                ff.outputOptions('-an');
                            } else {
                                ff.outputOptions(['-map', '0:a?', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100']);
                            }

                            ff.on('end', resolve)
                                .on('error', reject)
                                .save(cookedVideoPath);
                        });
                    } else {
                        // Regular video story with blur (no link)
                        await new Promise((resolve, reject) => {
                            const ff = ffmpeg(videoFilePath);
                            let filter = '';
                            if (options.blur) {
                                // Full Frame Blur style (Mature)
                                filter = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=${options.blurValue || 20}:5[v_final]`;
                            } else {
                                // No blur (Full frame clear)
                                filter = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[v_final]';
                            }

                            ff.outputOptions([
                                '-filter_complex', filter,
                                '-map', '[v_final]',
                                '-t', '60',
                                '-c:v', 'libx264',
                                '-preset', 'veryfast',
                                '-crf', '24',
                                '-maxrate', '3800k',
                                '-bufsize', '7600k',
                                '-pix_fmt', 'yuv420p',
                                '-r', '30',
                                '-g', '60',
                                '-movflags', '+faststart'
                            ]);
                            if (options.mute) {
                                print(`Menghilangkan suara video...`, "wait");
                                ff.outputOptions('-an');
                            } else {
                                ff.outputOptions(['-map', '0:a?', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100']);
                            }

                            ff.on('end', resolve)
                                .on('error', reject)
                                .save(cookedVideoPath);
                        });
                    }

                    if (fs.existsSync(cookedVideoPath)) {
                        storyOptions.video = cookedVideoPath;
                    }
                } catch (e) {
                    log(`⚠️ Gagal memasak video: ${e.message}. Menggunakan video asli.`);
                    storyOptions.video = videoFilePath;
                }

                // 3. Execute Robust Custom Upload
                storyOptions.extLogger = this.extLogger;


                res = await this.ig.publish.uploadAndConfigureStoryVideo(storyOptions, storyOptions.stickerConfig);

                if (this.extLogger) this.extLogger('ok', `Upload custom video selesai.`);

            }

            print(`Berhasil diposting! ✨`, 'ok');
            // if (this.extLogger) this.extLogger('ok', 'Berhasil diposting!');

            return res;
        } catch (err) {
            throw err;
        } finally {
            // --- RESTORE ORIGINAL STATE ---
            if (patched) {
                this.ig.request.send = originalRequest;
            }
            // Robust cleanup of all temporary files
            if (tempFile && fs.existsSync(tempFile)) { try { fs.unlinkSync(tempFile); } catch (e) { } }
            // Final cleanup of the entire workArea
            await this.cleanupWorkArea();
        }
    }

    async publishPhoto(file, caption, shareToThreads = false) {
        let tempFile = null;
        const taskId = `feed_photo_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const workArea = await this.getWorkArea(taskId);
        try {
            console.log(chalk`{cyan [feed] Randomizing image for safety...}`);
            tempFile = await makeMediaUnique(file, 'photo', workArea);
            const res = await this.ig.publish.photo({
                file: fs.readFileSync(tempFile),
                caption: caption,
                shareToThreads: shareToThreads ? 1 : 0
            });
            if (res.status !== 'ok') {
                throw new Error(res.message || 'Instagram rejected the post.');
            }
            return res;
        } catch (err) {
            console.error(chalk`{red [feed] Post failed: ${err.message}}`);
            throw err;
        } finally {
            if (tempFile && tempFile !== file && fs.existsSync(tempFile)) { try { fs.unlinkSync(tempFile); } catch (e) { } }
        }
    }


    async publishVideo(file, cover, caption, shareToThreads = false) {
        let tempVideo = null;
        let tempCover = null;
        const taskId = `feed_video_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const workArea = await this.getWorkArea(taskId);
        try {
            console.log(chalk`{cyan [feed] Randomizing video & cover for safety...}`);
            tempVideo = await makeMediaUnique(file, 'video', workArea);
            tempCover = await makeMediaUnique(cover, 'photo', workArea);

            return await this.ig.publish.video({
                video: fs.readFileSync(tempVideo),
                coverImage: fs.readFileSync(tempCover),
                caption: caption,
                share_to_threads: shareToThreads ? 1 : 0
            });
        } catch (err) {
            throw err;
        } finally {
            if (tempVideo && tempVideo !== file && fs.existsSync(tempVideo)) { try { fs.unlinkSync(tempVideo); } catch (e) { } }
            if (tempCover && tempCover !== cover && fs.existsSync(tempCover)) { try { fs.unlinkSync(tempCover); } catch (e) { } }
            await this.cleanupWorkArea();
        }
    }

    async publishCarousel(items, caption, shareToThreads = false) {
        let tempFiles = [];
        const taskId = `feed_album_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const workArea = await this.getWorkArea(taskId);
        try {
            console.log(chalk`{cyan [feed] Randomizing ${items.length} items for carousel safety...}`);
            const carouselItems = [];

            for (const item of items) {
                if (item.type === 'photo') {
                    const uniqueFile = await makeMediaUnique(item.file, 'photo', workArea);
                    if (uniqueFile !== item.file) tempFiles.push(uniqueFile);
                    carouselItems.push({ file: fs.readFileSync(uniqueFile), usertags: item.usertags });
                } else {
                    const uniqueVideo = await makeMediaUnique(item.file, 'video', workArea);
                    const uniqueCover = await makeMediaUnique(item.cover, 'photo', workArea);
                    if (uniqueVideo !== item.file) tempFiles.push(uniqueVideo);
                    if (uniqueCover !== item.cover) tempFiles.push(uniqueCover);
                    carouselItems.push({ video: fs.readFileSync(uniqueVideo), coverImage: fs.readFileSync(uniqueCover), usertags: item.usertags });
                }
            }

            return await this.ig.publish.album({
                items: carouselItems,
                caption: caption,
                share_to_threads: shareToThreads ? 1 : 0
            });
        } catch (err) {
            throw err;
        } finally {
            // Cleanup all tracked temp files
            for (const f of tempFiles) {
                if (f && fs.existsSync(f)) { try { fs.unlinkSync(f); } catch (e) { } }
            }
            await this.cleanupWorkArea();
        }
    }

    async publishDirectToThreads(file, caption) {
        if (!this.threadsAPI) await this.initThreads();
        return true;
    }

    async directSendMedia(filePathOrBuffer, options = {}) {
        const { threadId, uids } = options;
        const bToken = await this._getBearerToken();
        const dsUserId = this.ig.state.cookieUserId;
        const mobileUa = 'Instagram 370.0.0.35.101 Android (33/13; 600dpi; 1440x3088; samsung; SM-S918B; dm3q; kalama; en_US; 610000000)';
        const chance = require('chance').Chance();
        const crypto = require('crypto');

        // 1. Resolve thread ID if not explicitly given
        let targetThreadId = threadId;
        if (!targetThreadId && uids && uids.length > 0) {
            try {
                const threadInfo = await this.ig.directThread.getByParticipants(uids.map(id => id.toString()));
                if (threadInfo) {
                    targetThreadId = (threadInfo.thread && threadInfo.thread.thread_id) || threadInfo.thread_id || (threadInfo.thread && threadInfo.thread.thread_v2_id);
                }
            } catch (e) { }
            if (!targetThreadId) {
                try {
                    const initThread = this.ig.entity.directThread(uids.map(id => id.toString()));
                    const initRes = await initThread.broadcastText("👋");
                    targetThreadId = initThread.threadId || (initRes && (initRes.thread_id || (initRes.payload && initRes.payload.thread_id)));
                } catch (e) { }
            }
        }

        // 2. Identify media type
        let isVideo = false;
        let fileBuffer = null;
        if (typeof filePathOrBuffer === 'string') {
            const ext = path.extname(filePathOrBuffer).toLowerCase();
            isVideo = ['.mp4', '.mov', '.mkv', '.avi'].includes(ext);
            fileBuffer = fs.readFileSync(filePathOrBuffer);
        } else {
            fileBuffer = filePathOrBuffer;
            if (fileBuffer.length > 8 && (fileBuffer.toString('ascii', 4, 8) === 'ftyp' || fileBuffer.toString('ascii', 4, 8) === 'moov')) {
                isVideo = true;
            }
        }

        if (isVideo) {
            // Video attachment flow via rupload.facebook.com/messenger_video/
            console.log(chalk`{cyan [DM-Video] Mengunggah video attachment ke Messenger...}`);
            const hex_id = crypto.randomBytes(16).toString('hex');
            const ms = Date.now();
            const size = fileBuffer.length;
            const entity = `${hex_id}-0-${size}-${ms}-${ms}`;
            const upload_id = Math.floor(100000000000 + Math.random() * 900000000000).toString();
            const waterfall_id = `${upload_id}_${hex_id.substring(0, 12).toUpperCase()}_Mixed_0`;
            const url = `https://rupload.facebook.com/messenger_video/${entity}`;

            const videoHeaders = {
                'Authorization': bToken,
                'ig-intended-user-id': dsUserId,
                'ig-u-ds-user-id': dsUserId,
                'Accept-Encoding': 'gzip',
                'Accept-Language': 'en-US',
                'Priority': 'u=6, i',
                'User-Agent': mobileUa,
                'X-FB-Client-IP': 'True',
                'X-FB-Friendly-Name': 'undefined:media-upload',
                'X-FB-HTTP-Engine': 'Tigon/MNS/TCP',
                'X-FB-Request-Analytics-Tags': '{"network_tags":{"product":"567067343352427","surface":"undefined","request_category":"media_upload","purpose":"none","retry_attempt":"0"}}',
                'X-FB-RMD': 'state=URL_ELIGIBLE',
                'X-FB-Server-Cluster': 'True',
                'X-Tigon-Is-Retry': 'False',
                'X-IG-Salt-Ids': '51052545',
                'video_type': 'FILE_ATTACHMENT',
                'segment-start-offset': '0',
                'segment-type': '3',
                'ephemeral_media_view_mode': '2',
                'ig_raven_metadata': '{}',
                'x_fb_video_waterfall_id': waterfall_id
            };

            let offset = 0;
            try {
                const offRes = await axios.get(url, { headers: videoHeaders, timeout: 30000 });
                offset = (offRes.data && offRes.data.offset) || 0;
            } catch (e) {
                offset = 0;
            }

            const postVideoHeaders = {
                ...videoHeaders,
                'Content-Type': 'application/octet-stream',
                'Offset': offset.toString(),
                'X-Entity-Length': size.toString(),
                'X-Entity-Name': entity,
                'X-Entity-Type': 'video/mp4'
            };

            const uploadRes = await axios.post(url, fileBuffer.slice(offset), { headers: postVideoHeaders, timeout: 120000 });
            const mediaId = String(uploadRes.data.media_id);
            console.log(chalk`{green [DM-Video] Video terupload ke Messenger (media_id: ${mediaId})}`);

            // Broadcast to raven_attachment/?video=1
            const mutationToken = chance.guid({ version: 4 });
            const form = {
                action: 'send_item',
                recipient_users: '[]',
                view_mode: 'permanent',
                has_camera_metadata: '1',
                camera_entry_point: '3',
                reshare_mode: 'allow_reshare',
                original_media_type: '2',
                send_attribution: 'direct_composer',
                client_context: mutationToken,
                camera_session_id: crypto.randomUUID(),
                attachment_fbid: mediaId,
                video_result: mediaId,
                device_id: this.ig.state.deviceId,
                mutation_token: mutationToken,
                _uuid: this.ig.state.uuid,
                offline_threading_id: mutationToken,
            };

            if (targetThreadId) {
                form.thread_ids = JSON.stringify([targetThreadId.toString()]);
            } else if (uids && uids.length > 0) {
                form.recipient_users = JSON.stringify([uids.map(id => id.toString())]);
            }

            return await this.ig.request.send({
                url: '/api/v1/direct_v2/threads/broadcast/raven_attachment/',
                qs: { video: '1' },
                method: 'POST',
                form: this.ig.request.sign(form)
            });
        } else {
            // Photo attachment flow via rupload.facebook.com/messenger_image/
            console.log(chalk`{cyan [DM-Photo] Mengunggah foto attachment ke Messenger...}`);

            // Normalize photo to JPEG
            let jpegBuffer = fileBuffer;
            try {
                const img = await Jimp.read(fileBuffer);
                if (img.bitmap.width > 1080 || img.bitmap.height > 1080) {
                    img.scaleToFit({ w: 1080, h: 1080 });
                }
                jpegBuffer = await img.getBuffer('image/jpeg');
            } catch (e) {
                console.warn('[DM-Photo] Jimp normalization skipped:', e.message);
            }

            const entity_name = `fb_uploader_${Date.now()}`;
            const url = `https://rupload.facebook.com/messenger_image/${entity_name}`;

            const photoHeaders = {
                'Authorization': bToken,
                'ig-intended-user-id': dsUserId,
                'ig-u-ds-user-id': dsUserId,
                'Accept-Encoding': 'gzip',
                'Accept-Language': 'en-US',
                'Priority': 'u=6, i',
                'User-Agent': mobileUa,
                'X-FB-Client-IP': 'True',
                'X-FB-Friendly-Name': 'undefined:media-upload',
                'X-FB-HTTP-Engine': 'Tigon/MNS/TCP',
                'X-FB-Request-Analytics-Tags': '{"network_tags":{"product":"567067343352427","surface":"undefined","request_category":"media_upload","purpose":"none","retry_attempt":"0"}}',
                'X-FB-RMD': 'state=URL_ELIGIBLE',
                'X-FB-Server-Cluster': 'True',
                'X-Tigon-Is-Retry': 'False',
                'X-IG-Salt-Ids': '51052545',
                'image_type': 'FILE_ATTACHMENT',
                'Content-Type': 'application/octet-stream',
                'Offset': '0',
                'X-Entity-Length': jpegBuffer.length.toString(),
                'X-Entity-Name': entity_name,
                'X-Entity-Type': 'image/jpeg'
            };

            const uploadRes = await axios.post(url, jpegBuffer, { headers: photoHeaders, timeout: 60000 });
            if (!uploadRes.data || !uploadRes.data.media_id) {
                throw new Error(`Upload to messenger_image failed: ${JSON.stringify(uploadRes.data)}`);
            }
            const mediaId = String(uploadRes.data.media_id);
            console.log(chalk`{green [DM-Photo] Foto terupload ke Messenger (media_id: ${mediaId})}`);

            // Broadcast to photo_attachment/
            const mutationToken = chance.guid({ version: 4 });
            const form = {
                action: 'send_item',
                is_x_transport_forward: 'false',
                is_shh_mode: '0',
                send_attribution: 'inbox',
                client_context: mutationToken,
                attachment_fbid: mediaId,
                device_id: this.ig.state.deviceId,
                mutation_token: mutationToken,
                _uuid: this.ig.state.uuid,
                allow_full_aspect_ratio: 'true',
                btt_dual_send: 'false',
                is_ae_dual_send: 'false',
                offline_threading_id: mutationToken,
            };

            if (targetThreadId) {
                form.thread_ids = JSON.stringify([targetThreadId.toString()]);
            } else if (uids && uids.length > 0) {
                form.recipient_users = JSON.stringify([uids.map(id => id.toString())]);
            }

            const broadcastRes = await this.ig.request.send({
                url: '/api/v1/direct_v2/threads/broadcast/photo_attachment/',
                method: 'POST',
                form: form
            });
            console.log(chalk`{green [DM-Photo] Berhasil broadcast photo_attachment ke Instagram!}`);
            return broadcastRes.body || broadcastRes;
        }
    }

    async getMediaIdByUrl(url) {
        try {
            try {
                const res = await axios.get(`https://www.instagram.com/oembed?url=${url}`, { timeout: 5000 });
                if (res.data && res.data.media_id) return Promise.resolve(res.data.media_id.split("_")[0]);
            } catch (e) { }

            // Robust regex extraction for various URL formats
            const match = url.match(/\/(?:p|reels?|tv|share\/p)\/([a-zA-Z0-9_-]+)/);
            let sc = null;
            if (match && match[1]) {
                sc = match[1];
            } else if (/^[a-zA-Z0-9_-]+$/.test(url)) {
                // If it is already a raw shortcode, use it directly
                sc = url;
            }

            if (sc) {
                const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
                let id = 0n; for (let i = 0; i < sc.length; i++) id = (id * 64n) + BigInt(alphabet.indexOf(sc[i]));
                return Promise.resolve(id.toString());
            } return Promise.reject("Could not resolve Media ID");
        } catch (err) { return Promise.reject(err.message || "Unknown error"); }
    }

    async setProfilePicture(file) {
        let tempFile = null;
        const taskId = `profile_pic_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const workArea = await this.getWorkArea(taskId);
        try {
            console.log(chalk`{cyan [account] Randomizing profile picture for safety...}`);
            tempFile = await makeMediaUnique(file, 'photo', workArea);
            const fileStream = fs.readFileSync(tempFile);

            let res;
            if (process.env.EXTENSION_MODE === 'true') {
                // Extension Mode: Use Web API Pathway
                res = await this.ig.request.send({
                    url: 'https://www.instagram.com/accounts/web_change_profile_picture/',
                    baseUrl: '', // Allow absolute URL
                    method: 'POST',
                    headers: {
                        'Referer': 'https://www.instagram.com/accounts/edit/',
                        'Origin': 'https://www.instagram.com'
                    },
                    formData: {
                        profile_pic: {
                            value: fileStream,
                            options: { filename: 'profile.jpg', contentType: 'image/jpeg' }
                        }
                    }
                });
            } else {
                res = await this.ig.account.changeProfilePicture(fileStream);
            }
            return res;
        } catch (err) {
            if (err.message && (err.message.includes("challenge_required") || err.message.includes("checkpoint_required"))) {
                const resolved = await this.handleCheckpoint(err);
                if (resolved) return await this.setProfilePicture(file);
            }
            throw err;
        } finally {
            if (tempFile && tempFile !== file && fs.existsSync(tempFile)) { try { fs.unlinkSync(tempFile); } catch (e) { } }
            await this.cleanupWorkArea();
        }
    }

    async setExternalUrl(externalUrl, title = '') {
        const bToken = await this._getBearerToken();
        const mobileUa = 'Instagram 370.0.0.35.101 Android (33/13; 600dpi; 1440x3088; samsung; SM-S918B; dm3q; kalama; en_US; 610000000)';
        const userId = String(this.pk || this.ig.state.cookieUserId);
        const uuid = this.ig.state.uuid;

        const innerPayload = {
            updated_links: JSON.stringify([{ url: String(externalUrl).trim(), title: title ? String(title).trim() : '', link_type: 'external' }]),
            _uid: userId,
            _uuid: uuid
        };

        const res = await this.ig.request.send({
            url: '/api/v1/accounts/update_bio_links/',
            method: 'POST',
            headers: {
                'Authorization': bToken,
                'User-Agent': mobileUa,
                'X-IG-App-ID': '124024574287414'
            },
            form: {
                signed_body: `SIGNATURE.${JSON.stringify(innerPayload)}`
            }
        });
        return res.body;
    }

    async removeBioLinks(linkIds = []) {
        const bToken = await this._getBearerToken();
        const mobileUa = 'Instagram 370.0.0.35.101 Android (33/13; 600dpi; 1440x3088; samsung; SM-S918B; dm3q; kalama; en_US; 610000000)';
        const userId = String(this.pk || this.ig.state.cookieUserId);
        const uuid = this.ig.state.uuid;

        const innerPayload = {
            link_ids: Array.isArray(linkIds) ? linkIds : [linkIds],
            _uid: userId,
            _uuid: uuid
        };

        const res = await this.ig.request.send({
            url: '/api/v1/accounts/remove_bio_links/',
            method: 'POST',
            headers: {
                'Authorization': bToken,
                'User-Agent': mobileUa,
                'X-IG-App-ID': '124024574287414'
            },
            form: {
                signed_body: `SIGNATURE.${JSON.stringify(innerPayload)}`
            }
        });
        return res.body;
    }

    async setNativeBiography(biography) {
        const bToken = await this._getBearerToken();
        const mobileUa = 'Instagram 370.0.0.35.101 Android (33/13; 600dpi; 1440x3088; samsung; SM-S918B; dm3q; kalama; en_US; 610000000)';
        const userId = String(this.pk || this.ig.state.cookieUserId);
        const uuid = this.ig.state.uuid;

        // Mendukung spintax {A|B|C}
        let cleanBio = String(biography || '').trim();
        cleanBio = cleanBio.replace(/\{([^{}]+)\}/g, (match, choices) => {
            const arr = choices.split('|');
            return arr[Math.floor(Math.random() * arr.length)];
        });

        const innerPayload = {
            logged_in_uids: JSON.stringify([userId]),
            raw_text: cleanBio,
            _uid: userId,
            _uuid: uuid
        };

        const res = await this.ig.request.send({
            url: '/api/v1/accounts/set_biography/',
            method: 'POST',
            headers: {
                'Authorization': bToken,
                'User-Agent': mobileUa,
                'X-IG-App-ID': '124024574287414'
            },
            form: {
                signed_body: `SIGNATURE.${JSON.stringify(innerPayload)}`
            }
        });
        return res.body;
    }

    async updateProfile(params) {
        try {
            const results = {};

            // 1. Update Bio Links via Instagrapi Mobile Spec (accounts/update_bio_links/)
            const extUrl = params.externalUrl || params.link || params.url || params.website;
            if (extUrl && typeof extUrl === 'string' && extUrl.trim().length > 0) {
                try {
                    print(`[Profile] Menyetel Link Bio (Instagrapi spec): ${extUrl}`, "wait");
                    results.bioLink = await this.setExternalUrl(extUrl.trim(), params.linkTitle || params.title || '');
                    print(`[Profile] Link Bio berhasil disetel: ${extUrl}`, "ok");
                } catch (linkErr) {
                    console.warn(`[updateProfile] Gagal setExternalUrl via mobile API: ${linkErr.message}`);
                }
            }

            // 2. Update Biography via Dedicated Mobile Endpoint (accounts/set_biography/)
            if (typeof params.biography !== 'undefined' && params.biography !== null) {
                try {
                    results.biography = await this.setNativeBiography(params.biography);
                } catch (bioErr) {
                    console.warn(`[updateProfile] Gagal setNativeBiography: ${bioErr.message}`);
                }
            }

            // 3. Update info umum (Full Name, Gender, Chaining) via web accounts/edit
            if (process.env.EXTENSION_MODE === 'true') {
                let current = {};
                try {
                    current = await this.getProfileData();
                } catch (e) {
                    console.error("[updateProfile] getProfileData failed, proceeding with params/defaults", e.message);
                }

                const payload = {
                    biography: typeof params.biography !== 'undefined' ? params.biography : (current.biography || ''),
                    first_name: typeof params.fullName !== 'undefined' ? params.fullName : (current.fullName || ''),
                    external_url: typeof extUrl !== 'undefined' && extUrl ? extUrl : (current.externalUrl || ''),
                    username: this.username,
                    email: current.email || '',
                    phone_number: current.phoneNumber || '',
                    gender: typeof params.gender !== 'undefined' ? params.gender : (current.gender || 3),
                };

                const isChaining = typeof params.chainingEnabled !== 'undefined' ? params.chainingEnabled : (current.chainingEnabled !== false);
                payload.chaining_enabled = isChaining ? 'on' : '';

                try {
                    const webRes = await this.ig.request.send({
                        url: 'https://www.instagram.com/api/v1/web/accounts/edit/',
                        baseUrl: '',
                        method: 'POST',
                        headers: {
                            'Referer': 'https://www.instagram.com/accounts/edit/',
                            'Origin': 'https://www.instagram.com'
                        },
                        form: payload
                    });
                    results.webProfile = webRes.body;
                } catch (webErr) {
                    console.warn(`[updateProfile] web/accounts/edit notice: ${webErr.message}`);
                }
            } else {
                if (typeof params.biography !== 'undefined') await this.ig.account.setBiography(params.biography);
            }

            return Object.assign({ ok: true }, results);
        } catch (err) {
            if (err.message && (err.message.includes("challenge_required") || err.message.includes("checkpoint_required"))) {
                const resolved = await this.handleCheckpoint(err);
                if (resolved) return await this.updateProfile(params);
            }
            throw err;
        }
    }

    async getProfileData() {
        let profile = { biography: '', fullName: '', externalUrl: '', gender: 3, chainingEnabled: true, profilePicUrl: '' };

        // 1. Primary Source: Private API (Stable and reliable for basic info)
        try {
            const self = await this.ig.account.currentUser();
            profile.biography = self.biography || '';
            profile.fullName = self.full_name || '';
            profile.externalUrl = self.external_url || '';
            profile.gender = self.gender || 3;
            profile.profilePicUrl = self.profile_pic_url || '';
        } catch (e) {
            console.error("[getProfileData] Private API currentUser failed:", e.message);
        }

        // 2. Chaining Info: user.info (Reliable source for account suggestions toggle)
        try {
            const info = await this.ig.user.info(this.ig.state.cookieUserId);
            profile.chainingEnabled = info.has_chaining !== false;
            // Backup for Pic and Bio if currentUser failed
            if (!profile.profilePicUrl) profile.profilePicUrl = info.profile_pic_url;
            if (!profile.biography) profile.biography = info.biography;
        } catch (e) {
            console.error("[getProfileData] Private API user.info failed:", e.message);
        }

        // 3. Web Edit Page: Secondary Source (Fetch additional hidden fields like email/phone if needed)
        try {
            const res = await this.ig.request.send({
                url: 'https://www.instagram.com/api/v1/web/accounts/edit/',
                method: 'GET',
                baseUrl: '',
                headers: {
                    'Referer': 'https://www.instagram.com/accounts/edit/',
                    'X-Requested-With': 'XMLHttpRequest'
                }
            });

            if (typeof res.body === 'object' && res.body.form_data) {
                const fd = res.body.form_data;
                profile.biography = fd.biography || profile.biography;
                profile.fullName = fd.first_name || profile.fullName;
                profile.externalUrl = fd.external_url || profile.externalUrl;
                profile.gender = fd.gender || profile.gender;
                profile.chainingEnabled = fd.chaining_enabled === 'on';
                if (fd.profile_pic_url) profile.profilePicUrl = fd.profile_pic_url;
            }
        } catch (err) {
            // Web Edit failure is now silent as we have Private API data as base
        }

        return profile;
    }

    async setProfileBiography(bio) {
        return await this.updateProfile({ biography: bio });
    }

    async withMobileAuth(fn) {
        const originalSend = this.ig.request.send.bind(this.ig.request);
        const mobileUa = 'Instagram 370.0.0.35.101 Android (33/13; 600dpi; 1440x3088; samsung; SM-S918B; dm3q; kalama; en_US; 610000000)';

        // Use cache if available, otherwise calculate once
        if (!this._bearerTokenCache) {
            const cookies = await this.ig.state.cookieJar.getCookies('https://i.instagram.com/');
            const dsUserId = cookies.find(c => c.key === 'ds_user_id')?.value;
            const sessionId = cookies.find(c => c.key === 'sessionid')?.value;
            if (dsUserId && sessionId) {
                const authObj = { ds_user_id: dsUserId, sessionid: decodeURIComponent(sessionId) };
                this._bearerTokenCache = `Bearer IGT:2:${Buffer.from(JSON.stringify(authObj)).toString('base64')}`;
            }
        }

        const self = this;
        const bToken = this._bearerTokenCache;

        this.ig.request.send = async (opt, onlyCheckHttpStatus) => {
            if (!opt.headers) opt.headers = {};
            const urlStr = String(opt.url || "");
            const isNative = urlStr.includes('api/v1') || urlStr.includes('rupload');

            if (isNative) {
                opt.headers['User-Agent'] = mobileUa;
                opt.headers['X-IG-App-ID'] = '124024574287414';
                opt.headers['X-IG-App-Version'] = '370.0.0.35.101';
                opt.headers['X-IG-Capabilities'] = 'br0LAA==';
                opt.headers['X-IG-Connection-Type'] = 'WIFI';
                opt.headers['X-ASBD-ID'] = '198303';
                opt.headers['X-IG-WWW-Claim'] = '0';
                opt.headers['X-IG-Bandwidth-Speed-KBPS'] = (Math.floor(Math.random() * 5000) + 10000).toString();

                // Keep cookies intact! Only inject Bearer if not rupload
                if (!urlStr.includes('rupload') && bToken) {
                    opt.headers['Authorization'] = bToken;
                }

                // --- NATIVE PAYLOAD ADJUSTMENT ---
                // For native POST calls with Bearer, we often need x-www-form-urlencoded
                if (opt.method === 'POST' && opt.body && typeof opt.body === 'string' && !urlStr.includes('rupload')) {
                    try {
                        let parsed = JSON.parse(opt.body);

                        // Ensure modern Supported SDKs are present in shared helper too
                        if (!parsed.supported_capabilities_new && urlStr.includes('configure_to_story')) {
                            parsed.supported_capabilities_new = JSON.stringify([
                                { "name": "SUPPORTED_SDK_VERSIONS", "value": "13.0,14.0,15.0,16.0,17.0,18.0,19.0,20.0,21.0,22.0,23.0,24.0,25.0,26.0,27.0,28.0,29.0,30.0,31.0,32.0,33.0,34.0,35.0,36.0,37.0,38.0,39.0,40.0,41.0,42.0,43.0,44.0,45.0,46.0,47.0,48.0,49.0,50.0,51.0,52.0,53.0,54.0,55.0,56.0,57.0,58.0,59.0,60.0,61.0,62.0,63.0,64.0,65.0,66.0,67.0,68.0,69.0,70.0,71.0,72.0,73.0,74.0,75.0,76.0,77.0,78.0,79.0,80.0,81.0,82.0,83.0,84.0,85.0,86.0,87.0,88.0,89.0,90.0,91.0,92.0,93.0,94.0,95.0,96.0,97.0,98.0,99.0,100.0" },
                                { "name": "FACE_TRACKER_VERSION", "value": 12 },
                                { "name": "segmentation", "value": "segmentation_enabled" },
                                { "name": "COMPRESSION", "value": "ETC2_COMPRESSION" },
                                { "name": "world_tracker", "value": "world_tracker_enabled" },
                                { "name": "gyroscope", "value": "gyroscope_enabled" }
                            ]);
                        }

                        // Translate web-like 'text' to native 'comment_text'
                        if (parsed.text) {
                            parsed.comment_text = parsed.text;
                            delete parsed.text;
                        }
                        // Convert to Form Data string for true mobile identity
                        const formData = Object.entries(parsed).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
                        opt.body = formData;
                        opt.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                    } catch (e) { }
                }
            }
            return originalSend(opt, onlyCheckHttpStatus);
        };

        try {
            return await fn();
        } finally {
            this.ig.request.send = originalSend;
        }
    }

    async getIdByUsername(u) { return await this.ig.user.getIdByUsername(u); }
    async resolveUser(username) {
        const clean = (username || '').replace('@', '').trim();
        const info = await this.ig.user.searchExact(clean);
        return { pk: String(info.pk), username: info.username };
    }
    async userInfo(uid) { return await this.ig.user.info(uid); }
    async mediaInfo(mid) { return await this.ig.media.info(mid); }
    async followersFeed(uid) { return await this.ig.feed.accountFollowers(uid); }
    async followingFeed(uid) { return await this.ig.feed.accountFollowing(uid); }
    async tagFeed(tag) { return await this.ig.feed.tag(tag); }
    async follow(uid) { return await this.ig.friendship.create(uid); }
    async unfollow(uid) { return await this.ig.friendship.destroy(uid); }
    async _getBearerToken() {
        if (!this._bearerTokenCache) {
            let cookies = await this.ig.state.cookieJar.getCookies('https://i.instagram.com/');
            if (!cookies || !cookies.find(c => c.key === 'sessionid')) {
                const alt = await this.ig.state.cookieJar.getCookies('https://www.instagram.com/');
                cookies = (cookies || []).concat(alt || []);
            }
            const dsUserId = (cookies && cookies.find(c => c.key === 'ds_user_id')?.value) || this.ig.state.cookieUserId;
            const sessionId = (cookies && cookies.find(c => c.key === 'sessionid')?.value) || (cookies && cookies.find(c => c.key === 'sessionId')?.value);
            if (dsUserId && sessionId) {
                const authObj = { ds_user_id: dsUserId, sessionid: decodeURIComponent(sessionId) };
                this._bearerTokenCache = `Bearer IGT:2:${Buffer.from(JSON.stringify(authObj)).toString('base64')}`;
            }
        }
        return this._bearerTokenCache;
    }

    async like(mid) {
        const bearerToken = await this._getBearerToken();
        const mobileUa = 'Instagram 355.0.0.38.103 Android (33/13; 600dpi; 1440x3088; samsung; SM-S918B; dm3q; kalama; en_US; 540600000)';
        const mediaId = String(mid);

        // Direct axios call — same pattern as story upload, bypasses IgApiClient pipeline
        const res = await axios.post(
            `https://i.instagram.com/api/v1/media/${mediaId}/like/`,
            `d=${encodeURIComponent(JSON.stringify({ _uid: this.ig.state.cookieUserId, _uuid: this.ig.state.uuid, media_id: mediaId, module_name: 'profile' }))}`,
            {
                headers: {
                    'Authorization': bearerToken,
                    'User-Agent': mobileUa,
                    'X-IG-App-ID': '124024574287414',
                    'X-IG-App-Version': '355.0.0.38.103',
                    'X-IG-Capabilities': '3brTv10=',
                    'X-IG-Connection-Type': 'WIFI',
                    'X-ASBD-ID': '198303',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );
        return res.data;
    }

    async comment(mid, text, replyToId = null) {
        const bearerToken = await this._getBearerToken();
        const mobileUa = 'Instagram 355.0.0.38.103 Android (33/13; 600dpi; 1440x3088; samsung; SM-S918B; dm3q; kalama; en_US; 540600000)';
        const mediaId = String(mid);
        const cleanText = String(text).trim();

        const payload = {
            comment_text: cleanText,
            _uid: this.ig.state.cookieUserId,
            _uuid: this.ig.state.uuid,
        };
        if (replyToId) payload.replied_to_comment_id = String(replyToId);

        // Direct axios call — same pattern as story upload, bypasses IgApiClient pipeline
        const res = await axios.post(
            `https://i.instagram.com/api/v1/media/${mediaId}/comment/`,
            Object.entries(payload).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'),
            {
                headers: {
                    'Authorization': bearerToken,
                    'User-Agent': mobileUa,
                    'X-IG-App-ID': '124024574287414',
                    'X-IG-App-Version': '355.0.0.38.103',
                    'X-IG-Capabilities': '3brTv10=',
                    'X-IG-Connection-Type': 'WIFI',
                    'X-ASBD-ID': '198303',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
            }
        );
        return res.data;
    }
    async getUserHighlights(uid) {
        const targetUid = String(uid || this.pk || this.ig.state.cookieUserId);
        try { const tray = await this.ig.highlights.highlightsTray(targetUid); return tray.tray || []; } catch (e) { return []; }
    }
    async createHighlight(mid, title) { return await this.ig.highlights.createReel({ mediaIds: [String(mid)], title }); }
    async addToHighlight(hid, mid, title = null) {
        const fullHid = String(hid).startsWith("highlight:") ? String(hid) : `highlight:${hid}`;
        const rawMid = String(mid);
        const cleanMid = rawMid.split("_")[0];
        const fullMid = rawMid.includes("_") ? rawMid : `${cleanMid}_${this.pk || this.ig.state.cookieUserId}`;

        // Ensure user highlights tray is loaded into state
        try { await this.ig.highlights.highlightsTray(String(this.pk || this.ig.state.cookieUserId)); } catch (e) { }

        const sendEditReel = async (mediaIdToUse) => {
            const formObj = {
                supported_capabilities_new: JSON.stringify(this.ig.state.supportedCapabilities),
                source: 'self_profile',
                added_media_ids: JSON.stringify([mediaIdToUse]),
                _csrftoken: this.ig.state.cookieCsrfToken,
                _uid: String(this.pk || this.ig.state.cookieUserId),
                _uuid: this.ig.state.uuid,
                removed_media_ids: '[]'
            };
            if (title) formObj.title = title;

            const res = await this.ig.request.send({
                url: `/api/v1/highlights/${fullHid}/edit_reel/`,
                method: 'POST',
                form: this.ig.request.sign(formObj)
            });
            return res.body;
        };

        try {
            // Percobaan 1: Kirim dengan full media ID (format: pk_uid)
            return await sendEditReel(fullMid);
        } catch (err1) {
            console.log(chalk`{yellow [highlight]} Percobaan 1 fullMid (${fullMid}) gagal: ${err1.message}. Mencoba dengan cleanMid (${cleanMid})...`);
            try {
                // Percobaan 2: Kirim dengan cleanMid (format: bare pk)
                return await sendEditReel(cleanMid);
            } catch (err2) {
                console.log(chalk`{yellow [highlight]} Percobaan 2 cleanMid gagal: ${err2.message}. Mencoba fallback ke library editReel...`);
                // Percobaan 3: Fallback ke library editReel dengan fullHid
                return await this.ig.highlights.editReel({
                    highlightId: fullHid,
                    added: [cleanMid],
                    title: title || undefined
                });
            }
        }
    }

    async ensureHighlight(mediaId, title) {
        if (!mediaId || !title) return null;
        try {
            // Tunggu 3.5s agar story terindeks di Instagram highlights CDN
            await new Promise(r => setTimeout(r, 3500));
            const hls = await this.getUserHighlights(this.pk || this.ig.state.cookieUserId);
            const existing = hls.find(h => h.title && h.title.trim().toLowerCase() === title.trim().toLowerCase());
            if (existing) {
                console.log(chalk`{cyan [highlight]} Menambah ke Highlight yang sudah ada: "${title}" (${existing.id})`);
                return await this.addToHighlight(existing.id, mediaId, existing.title || title);
            } else {
                console.log(chalk`{cyan [highlight]} Membuat Highlight baru: "${title}"`);
                return await this.createHighlight(mediaId, title);
            }
        } catch (e) {
            // Retry sekali lagi jika gagal karena delay indeks
            try {
                console.log(chalk`{yellow [highlight]} Mencoba lagi menambahkan ke highlight dalam 3s...`);
                await new Promise(r => setTimeout(r, 3000));
                const hls = await this.getUserHighlights(this.pk || this.ig.state.cookieUserId);
                const existing = hls.find(h => h.title && h.title.trim().toLowerCase() === title.trim().toLowerCase());
                if (existing) {
                    return await this.addToHighlight(existing.id, mediaId, existing.title || title);
                } else {
                    return await this.createHighlight(mediaId, title);
                }
            } catch (retryErr) {
                console.error(chalk`{red [highlight] Gagal proses highlight: ${retryErr.message}}`);
                throw retryErr;
            }
        }
    }
    async getCurrentIP() {
        try {
            const res = await this.ig.request.send({
                url: 'https://api.ipify.org?format=json',
                method: 'GET'
            });
            return res.ip || "Unknown";
        } catch (e) {
            return "Proxy Error or Blocked";
        }
    }

    // --- ADVANCED SIMULATION HELPERS ---

    async getRandomFollowing(count = 5) {
        try {
            const followingFeed = this.ig.feed.accountFollowing(this.ig.state.cookieUserId);
            const items = await followingFeed.items();
            return items.sort(() => Math.random() - 0.5).slice(0, count);
        } catch (e) {
            return [];
        }
    }

    async simulateProfileView(userId) {
        try {
            console.log(chalk`{cyan [Simulation] Viewing profile for user ${userId}...}`);
            // 1. Fetch User Info (Profile view)
            await this.ig.user.info(userId);
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 2000));

            // 2. Fetch User Feed (simulate scrolling)
            const userFeed = this.ig.feed.user(userId);
            const items = await userFeed.items();

            if (items && items.length > 0) {
                // 3. Randomly pick a post to "view" (simulate clicking a post)
                const randomPost = items.slice(0, 6)[Math.floor(Math.random() * Math.min(items.length, 6))]; // Pick from top 6 posts
                if (randomPost) {
                    console.log(chalk`{cyan [Simulation] "Clicking" post ${randomPost.pk} by user ${userId}...}`);
                    await this.ig.media.info(randomPost.pk);
                    // Stay on post for a bit
                    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
                }
            }
            return true;
        } catch (e) {
            console.error(chalk`{yellow [Simulation Error] Failed for ${userId}: ${e.message}}`);
            return false;
        }
    }

    async warmup() {
        try {
            // Melakukan request untuk memancing Instagram memberikan header X-IG-WWW-Claim
            await this.ig.feed.timeline().items();
            return true;
        } catch (e) {
            // Jalur cadangan: cek status inbox/tray
            try {
                await this.ig.feed.reelsTray().items();
                return true;
            } catch (ee) {
                return false;
            }
        }
    }


    async captureFrame(videoPath) {
        const ffmpeg = require('fluent-ffmpeg');
        ffmpeg.setFfmpegPath(getFFmpegPath());
        ffmpeg.setFfprobePath(getFFprobePath());

        const output = videoPath.replace(path.extname(videoPath), `_cover_${Date.now()}.jpg`);

        return new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .screenshots({
                    timestamps: ['00:00:01'], // Ambil frame di detik ke-1 agar tidak hitam
                    filename: path.basename(output),
                    folder: path.dirname(output),
                    size: '1080x?' // Paksa lebar 1080 (HD) agar bagus di feed
                })
                .on('end', () => resolve(output))
                .on('error', (err) => reject(new Error("Gagal ekstrak frame: " + err.message)));
        });
    }

    setLogger(logger) {
        this.extLogger = logger;
        if (!global.activeLoggers) global.activeLoggers = new Map();

        this.logFn = (type, msg) => {
            if (typeof logger === 'function') {
                logger(type, msg, this.username);
            }
        };

        global.activeLogger = this.logFn; // Fallback sync

        if (this.username) {
            global.activeLoggers.set(this.username.toLowerCase(), this.logFn);
        }
    }

    async runViewStory(config = {}) {
        try {
            // Unwrapping if passed as string/nested
            if (typeof config === 'string') {
                try { config = JSON.parse(config); } catch (e) { }
            }
            if (config.VIEW_STORY_CONFIG) {
                if (typeof config.VIEW_STORY_CONFIG === 'string') {
                    try { config = JSON.parse(config.VIEW_STORY_CONFIG); } catch (e) { }
                } else {
                    config = config.VIEW_STORY_CONFIG;
                }
            }

            print(`CONFIG PROCESSED: ${JSON.stringify(config)}`, "info");
            print("Mempersiapkan tools...", "info");
            reportTask({ type: 'progress', current: 0, total: 0, success: 0 });

            // Robust mode detection
            let mode = 'timeline';
            if (config.mode === 'target' || config.mode === 'uuid' || config.targetList) {
                mode = 'target';
            }

            // --- AGGRESSIVE CONFIG DETECTION ---
            const limit = parseInt(config.limit) || parseInt(config.limitTotalTarget) || parseInt(config.targetLimit) || parseInt(config.limit_target) || parseInt(config.max_target) || 200;
            const maxPerUser = parseInt(config.maxPerUser) || parseInt(config.maxStoryPerUser) || parseInt(config.max_per_user) || 1;

            print(`[DEBUG] Limit yang terbaca: ${limit}, Max per User: ${maxPerUser}`, "info");

            const delayMin = parseInt(config.delayMin) || 300;
            const delayMax = parseInt(config.delayMax) || 500;
            const sleepAfter = parseInt(config.sleepAfter) || 50;
            const sleepDelay = (parseInt(config.sleepDelay) || 30) * 1000;
            const doLike = config.doLike === true || config.doLike === 'true';



            let processedCount = 0;
            let successCount = 0;

            if (mode === 'timeline') {
                print("Mode: Timeline/Feed (Following)", "info");
                print("Mengambil story dari feed...", "wait");
                const tray = await this.ig.feed.reelsTray().items();
                print(`Menemukan ${tray.length} akun dengan story.`, "info");
                reportTask({ type: 'progress', current: 0, total: Math.min(tray.length, limit), success: 0 });

                for (const userTray of tray) {
                    // --- REM PAKEM (Anti-Bablas) ---
                    if (this.isStopped) break;
                    if (processedCount >= limit) {
                        print(`[REM] Limit total ${limit} target telah tercapai. Berhenti...`, "ok");
                        break;
                    }

                    if (userTray.user.pk == this.pk || userTray.user.username == this.username) continue;

                    let storyItems = userTray.items || [];
                    if (storyItems.length === 0) {
                        try {
                            const media = await this.ig.feed.reelsMedia({ userIds: [userTray.user.pk] }).items();
                            storyItems = media || [];
                        } catch (e) {
                            print(`  [SKIP] @${userTray.user.username}: ${e.message}`, "warn");
                            reportTask({ type: 'user-done', ok: false, skip: true, username: userTray.user.username });
                            processedCount++;
                            continue;
                        }
                    }

                    if (storyItems.length === 0) {
                        reportTask({ type: 'user-done', ok: false, skip: true, username: userTray.user.username });
                        processedCount++;
                        continue;
                    }

                    print(`Found ${storyItems.length} stories for @${userTray.user.username}. Watching...`, "wait");
                    let viewedInThisUser = 0;
                    let userSuccess = 0;

                    for (const item of storyItems) {
                        if (this.isStopped) break;
                        if (maxPerUser > 0 && viewedInThisUser >= maxPerUser) break;

                        try {
                            await this.ig.story.seen([item]);
                            if (doLike) {
                                await delay(Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin);
                                await this.ig.media.like({ mediaId: item.id, moduleInfo: { module_name: 'reel_feed_timeline' } });
                            }
                            successCount++;
                            userSuccess++;
                        } catch (err) {
                            print(`  [ERROR] Story ${item.id}: ${err.message}`, "err");
                        }

                        viewedInThisUser++;
                        await delay(Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin);
                    }

                    processedCount++;
                    reportTask({ type: 'user-done', ok: true, username: userTray.user.username, count: userSuccess });
                    reportTask({ type: 'progress', current: processedCount, total: Math.min(tray.length, limit), success: successCount });

                    if (processedCount >= limit) {
                        print(`[REM] Selesai memproses ${processedCount} target (Limit: ${limit}).`, "ok");
                        break;
                    }

                    if (processedCount % sleepAfter === 0 && processedCount < limit) {

                        print(`Istirahat sejenak (Cooldown) selama ${sleepDelay / 1000} detik...`, "warn");
                        await delay(sleepDelay);
                    }
                }
            } else {
                print("Mode: Target UUID", "info");
                const targets = (config.targetList || "").split('\n').map(t => t.trim()).filter(t => t.length > 0);
                const actualTotal = Math.min(targets.length, limit);
                print(`Total Target: ${targets.length}`, "info");
                reportTask({ type: 'progress', current: 0, total: actualTotal, success: 0 });

                for (let i = 0; i < targets.length; i++) {
                    if (this.isStopped) break;
                    if (processedCount >= limit) break;

                    let target = targets[i];
                    print(`Checking stories for target: ${target}...`, "wait");

                    try {
                        let targetId = target;
                        if (isNaN(target)) {
                            targetId = await this.ig.user.getIdByUsername(target);
                        }

                        const storyItems = await this.ig.feed.reelsMedia({ userIds: [targetId] }).items();
                        if (!storyItems || storyItems.length === 0) {
                            print(`  [SKIP] @${target} tidak punya story saat ini.`, "warn");
                            processedCount++;
                            reportTask({ type: 'user-done', ok: false, skip: true, username: target });
                            reportTask({ type: 'progress', current: processedCount, total: actualTotal, success: successCount });
                            continue;
                        }

                        print(`Found ${storyItems.length} stories for target @${target}. Watching...`, "wait");
                        let viewedInThisUser = 0;
                        let userSuccess = 0;

                        for (const item of storyItems) {
                            if (this.isStopped) break;
                            if (maxPerUser > 0 && viewedInThisUser >= maxPerUser) break;

                            try {
                                await this.ig.story.seen([item]);
                                if (doLike) {
                                    await delay(Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin);
                                    await this.ig.media.like({ mediaId: item.id, moduleInfo: { module_name: 'reel_profile' } });
                                }
                                successCount++;
                                userSuccess++;
                            } catch (err) {
                                print(`  [ERROR] Story ${item.id}: ${err.message}`, "err");
                            }
                            viewedInThisUser++;
                            await delay(Math.floor(Math.random() * (delayMax - delayMin + 1)) + delayMin);
                        }

                        processedCount++;
                        reportTask({ type: 'user-done', ok: true, username: target, count: userSuccess });
                        reportTask({ type: 'progress', current: processedCount, total: actualTotal, success: successCount });

                        if (processedCount % sleepAfter === 0 && processedCount < actualTotal) {
                            print(`Istirahat sejenak (Cooldown) selama ${sleepDelay / 1000} detik...`, "warn");
                            await delay(sleepDelay);
                        }
                    } catch (err) {
                        print(`  [ERROR] Target ${target}: ${err.message}`, "err");
                        processedCount++;
                        reportTask({ type: 'user-done', ok: false, skip: false, username: target });
                        reportTask({ type: 'progress', current: processedCount, total: actualTotal, success: successCount });
                    }
                }
            }
            if (this.isStopped) {
                print("TUGAS VIEW STORY DIHENTIKAN!", "warn");
                reportTask({ type: 'done', message: `Tugas dihentikan oleh pengguna.`, success: successCount });
                return { processedCount, successCount };
            }

            print("VIEW STORY SELESAI!", "ok");
            reportTask({ type: 'done', message: `Selesai memproses ${processedCount} target.`, success: successCount });
            return { processedCount, successCount };
        } catch (err) {
            print(`CRITICAL ERROR: ${err.message}`, "err");
            reportTask({ type: 'error', message: err.message });
            throw err;
        }
    }

    async runAutoSetup(config = {}) {
        try {
            // Unwrapping if passed as string/nested
            if (typeof config === 'string') {
                try { config = JSON.parse(config); } catch (e) { }
            }
            if (config.AUTO_SETUP_CONFIG && typeof config.AUTO_SETUP_CONFIG === 'string') {
                try { config = JSON.parse(config.AUTO_SETUP_CONFIG); } catch (e) { }
            }

            print("Memulai proses Auto Setup (Perfection Mode)...", "info");

            const username = this.username || "unknown";
            const progress = loadProgress(username);
            let lastStoryId = null;

            // PHASE 1: FEED
            if (config.feed && config.feed.enabled) {
                const folder = config.feed.folder;
                const count = parseInt(config.feed.count) || 1;
                const delayTime = (parseInt(config.feed.delayMin) || parseInt(config.feed.delay) || 5) * 1000;

                print(`Fase 1: Post Feed (${count} posts)...`, "info");

                if (fs.existsSync(folder)) {
                    const allFiles = fs.readdirSync(folder).filter(f =>
                        ['.jpg', '.jpeg', '.png'].includes(path.extname(f).toLowerCase())
                    );

                    print(`Menemukan ${allFiles.length} gambar yang valid untuk Feed.`, "info");

                    const availableFiles = allFiles.filter(f => !progress.postedMedia.includes(f)).sort(() => Math.random() - 0.5);

                    if (availableFiles.length === 0) {
                        print("Semua media di folder ini sudah diposting. Lewati...", "warn");
                    } else {
                        const toPost = availableFiles.slice(0, count);
                        for (let i = 0; i < toPost.length; i++) {
                            if (this.isStopped) break;
                            const filename = toPost[i];
                            const mediaPath = path.join(folder, filename);

                            const captionIndex = progress.postedMedia.length;
                            const caption = getSequentialFromFile(config.feed.captionFile, captionIndex) || "";

                            try {
                                print(`Memproses Feed (${i + 1}/${toPost.length}): ${filename}`, "wait");
                                reportTask({ phase: "feed", current: i + 1, total: toPost.length, message: `Posting: ${filename}` });

                                print(`Posting Feed Photo: ${filename}`, "wait");
                                await this.publishPhoto(mediaPath, caption);

                                progress.postedMedia.push(filename);
                                saveProgress(username, progress);
                                print(`Sukses Posting Feed ${i + 1}/${toPost.length}`, "ok");

                            } catch (itemErr) {
                                print(`❌ Gagal posting ${filename}: ${itemErr.message}`, "err");
                                reportTask({ phase: "feed", current: i + 1, total: toPost.length, message: `Skipped: ${filename}` });
                            }

                            if (i < toPost.length - 1) {
                                print(`Menunggu delay feed ${delayTime / 1000} detik...`, "info");
                                await delay(delayTime);
                            }
                        }
                    }
                }
            }

            // PHASE 2: PROFILE
            if (this.isStopped) return false;
            if (config.profile && config.profile.enabled) {
                try {
                    print("Fase 2: Update Profile...", "info");
                    reportTask({ phase: "profile", message: "Updating Photo & Bio..." });

                    let avatarDir = config.profile.avatarFolder;
                    const autoProfileDir = path.join(config.feed.folder || avatarDir, 'profile');
                    const autoAvatarDir = path.join(config.feed.folder || avatarDir, 'avatar');

                    if (fs.existsSync(autoProfileDir)) {
                        avatarDir = autoProfileDir;
                    } else if (fs.existsSync(autoAvatarDir)) {
                        avatarDir = autoAvatarDir;
                    }

                    if (avatarDir && fs.existsSync(avatarDir)) {
                        const files = fs.readdirSync(avatarDir).filter(f =>
                            ['.jpg', '.jpeg', '.png'].includes(path.extname(f).toLowerCase())
                        );
                        if (files.length > 0) {
                            const avatarPath = path.join(avatarDir, files[Math.floor(Math.random() * files.length)]);
                            print(`Uploading Profil Photo: ${path.basename(avatarPath)}`, "wait");
                            await this.setProfilePicture(avatarPath);
                            await delay(2000);
                        }
                    }

                    const bio = getRandomFromFile(config.profile.bioFile);

                    // Ambil link dari linkFile jika ada
                    let profileLink = null;
                    if (config.profile.linkFile) {
                        const lPath = path.isAbsolute(config.profile.linkFile) ? config.profile.linkFile : path.join(process.cwd(), config.profile.linkFile);
                        if (fs.existsSync(lPath)) profileLink = getRandomFromFile(lPath);
                    } else if (config.profile.linkUrl) {
                        profileLink = config.profile.linkUrl;
                    } else {
                        const defLinkFile = path.join(process.cwd(), 'setup', 'link', 'link.txt');
                        if (fs.existsSync(defLinkFile)) profileLink = getRandomFromFile(defLinkFile);
                    }

                    print(`Setting Gender: Perempuan, Update Bio & Bio Link...`, "wait");
                    await this.updateProfile({
                        biography: bio || undefined,
                        gender: 2,
                        externalUrl: profileLink || undefined,
                        linkTitle: config.profile.linkTitle || undefined
                    });

                    print("Profil Berhasil Diperbarui", "ok");
                    await delay(2000);
                } catch (pErr) {
                    print(`⚠️ Gagal update profil: ${pErr.message}`, "warn");
                }
            }

            // PHASE 3: STORIES
            if (this.isStopped) return false;
            if (config.story && config.story.enabled) {
                let folder = config.story.folder;
                const count = parseInt(config.story.count) || 1;
                const autoSubfolder = path.join(config.feed.folder || folder, 'story');
                if (fs.existsSync(autoSubfolder)) folder = autoSubfolder;

                print(`Fase 3: Post Stories (${count} stories)...`, "info");

                if (fs.existsSync(folder)) {
                    const mediaType = config.story.mediaType || 'mix';
                    const allFiles = fs.readdirSync(folder).filter(f => {
                        const ext = path.extname(f).toLowerCase();
                        const isPhoto = ['.jpg', '.jpeg', '.png'].includes(ext);
                        const isVideo = ['.mp4'].includes(ext);
                        if (mediaType === 'photo') return isPhoto;
                        if (mediaType === 'video') return isVideo;
                        return isPhoto || isVideo;
                    });
                    const files = allFiles.sort(() => Math.random() - 0.5);

                    if (files.length > 0) {
                        const toPost = files.slice(0, count);
                        for (let i = 0; i < toPost.length; i++) {
                            const mediaPath = path.join(folder, toPost[i]);
                            const isVideo = path.extname(mediaPath).toLowerCase() === '.mp4';
                            let linkUrl = "";
                            const targetType = config.story.targetUrlType;

                            let shortlinkUrls = { imo: "https://imo.im", clickdealer: "https://clickdealer.com", trafee: "https://trafee.com" };
                            const shortUrlsPath = path.join(__dirname, '..', 'shortlink_urls.json');
                            if (fs.existsSync(shortUrlsPath)) {
                                try { shortlinkUrls = JSON.parse(fs.readFileSync(shortUrlsPath, 'utf8')); } catch (e) { }
                            }

                            if (targetType === 'imo') linkUrl = shortlinkUrls.imo;
                            else if (targetType === 'clickdealer') linkUrl = shortlinkUrls.clickdealer;
                            else if (targetType === 'trafee') linkUrl = shortlinkUrls.trafee;
                            else if (targetType === 'setuplink') linkUrl = getRandomFromFile(path.join(process.cwd(), 'setup', 'link', 'link.txt'));

                            else if (targetType === 'custom' && config.story.customUrlValue) linkUrl = config.story.customUrlValue;
                            else linkUrl = getRandomFromFile(config.story.urlListFile) || shortlinkUrls.imo || "https://imo.im";

                            // Tambahkan random param hanya untuk target selain setuplink
                            if (linkUrl && targetType !== 'setuplink') {
                                const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
                                const randStr = (len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
                                const v = randStr(5 + Math.floor(Math.random() * 3));
                                const token = randStr(7 + Math.floor(Math.random() * 4));
                                const hash = randStr(6 + Math.floor(Math.random() * 4));
                                const base = linkUrl.replace(/\/+$/, '').includes('?') ? linkUrl : linkUrl.replace(/\/+$/, '') + '/';
                                const sep = base.includes('?') ? '&' : '?';
                                linkUrl = `${base}${sep}v=${v}&token=${token}&hash=${hash}`;
                            }

                            const linkTitle = getRandomFromFile(config.story.stickerTextFile) || "Tap Here";
                            const shortProv = config.story.shortlinkProvider;
                            if (linkUrl && shortProv && shortProv !== 'none' && targetType !== 'setuplink') {
                                try {
                                    const port = process.env.PORT || 7500;
                                    const shortRes = await axios.post(`http://127.0.0.1:${port}/api/extension/shortlink`, {
                                        provider: shortProv,
                                        longUrl: linkUrl,
                                        apiKey: config.story.shortlinkApiKey || ''
                                    }, { timeout: 10000 }).catch(() => null);
                                    if (shortRes && shortRes.data && shortRes.data.ok && shortRes.data.shortUrl) linkUrl = shortRes.data.shortUrl;
                                } catch (e) { }
                            }


                            try {
                                print(`Posting Story (${i + 1}/${toPost.length}): ${toPost[i]}`, "wait");
                                reportTask({ phase: "story", current: i + 1, total: toPost.length, message: `Posting Story: ${toPost[i]}` });

                                const storyOptions = {
                                    linkUrl: linkUrl,
                                    linkTitle: linkTitle,
                                    showIcon: true,
                                    blur: config.story.blur === true || config.story.blur === 'true',
                                    blurValue: parseInt(config.story.blurAmount) || 20,
                                    mute: config.story.mute === true || config.story.mute === 'true',
                                    x: config.story.x !== undefined ? parseFloat(config.story.x) : 0.5,
                                    y: config.story.y !== undefined ? parseFloat(config.story.y) : 0.75,
                                    scale: config.story.scale !== undefined ? parseFloat(config.story.scale) : 1.0,
                                    rotation: config.story.rotation !== undefined ? parseFloat(config.story.rotation) : 0,
                                    color: config.story.color || '#ffffff',
                                    textColor: config.story.textColor || '#0095f6',
                                    radius: config.story.radius !== undefined ? parseInt(config.story.radius) : 15,
                                    fontSize: config.story.fontSize !== undefined ? parseFloat(config.story.fontSize) : 16.5,
                                    iconScale: config.story.iconScale !== undefined ? parseFloat(config.story.iconScale) : 0.8,
                                    fontFile: config.story.fontFile || ''
                                };

                                const res = await this.publishStory(mediaPath, isVideo ? "video" : "photo", storyOptions);
                                lastStoryId = res.media_id || (res.media && (res.media.id || res.media.pk)) || res.id || res.pk || (res.status === 'ok' ? res.upload_id : null);
                                if (lastStoryId && lastStoryId.includes('_')) lastStoryId = lastStoryId.split('_')[0];
                                print(`Sukses Posting Story ${i + 1}/${toPost.length}`, "ok");
                            } catch (sErr) {
                                print(`❌ Gagal posting story ${toPost[i]}: ${sErr.message}`, "err");
                            }
                            if (i < toPost.length - 1) await delay(5000);
                        }
                    }
                }
            }

            // PHASE 4: HIGHLIGHTS
            if (this.isStopped) return false;
            if (config.highlight && config.highlight.enabled && lastStoryId) {
                try {
                    print("Fase 4: Create Highlight...", "info");
                    const title = getRandomFromFile(config.highlight.titlesFile);
                    if (title) {
                        await this.ensureHighlight(lastStoryId, title);
                        print(`Selesai memproses Highlight: ${title}`, "ok");
                    }
                } catch (hErr) {
                    print(`⚠️ Gagal buat Highlight: ${hErr.message}`, "warn");
                }
            }

            if (this.isStopped) {
                print("PROSES AUTO SETUP DIHENTIKAN!", "warn");
                reportTask({ phase: "stopped", message: "Auto Setup dihentikan oleh pengguna." });
                return false;
            }
            reportTask({ phase: "done", message: "Auto Setup Selesai!" });
            print("SEMUA TUGAS AUTO SETUP SELESAI!", "ok");
            return true;
        } catch (e) {
            print(`AUTO SETUP ERROR: ${e.message}`, "err");
            throw e;
        }
    }
}

const reportTask = (data) => {
    const msg = `[@TASK_UPDATE@]${JSON.stringify(data)}`;
    const activeUser = userStorage.getStore();
    const logger = (activeUser && global.activeLoggers) ? global.activeLoggers.get(activeUser) : global.activeLogger;

    if (logger) {
        logger('info', msg);
    } else {
        console.log(msg);
    }
};

const print = (msg, type = 'info') => {
    const icons = { info: "⊙", ok: "√", err: "×", wait: "⋈", warn: "!" };
    const color = { info: "cyan", ok: "green", err: "red", wait: "yellow", warn: "magenta" }[type] || "white";
    const formatted = chalk`{${color} ${icons[type] || "⊙"}} ${msg}`;

    const activeUser = userStorage.getStore();
    const logger = (activeUser && global.activeLoggers) ? global.activeLoggers.get(activeUser) : global.activeLogger;

    if (logger) {
        logger(type, msg);
    } else {
        console.log(formatted);
    }
};
const IG_ERRORS = {
    CHECKPOINT: 'checkpoint_required',
    TWO_FACTOR: 'two_factor_required',
    LOGIN_REQUIRED: 'login_required'
};
const categorizeError = (err) => {
    const msg = err.message || String(err);
    if (msg.includes('checkpoint')) return IG_ERRORS.CHECKPOINT;
    if (msg.includes('two_factor')) return IG_ERRORS.TWO_FACTOR;
    if (msg.includes('login_required')) return IG_ERRORS.LOGIN_REQUIRED;
    return 'unknown';
};

// Wrap all run* and publish* prototype methods automatically to inject the AsyncLocalStorage context
for (const key of Object.getOwnPropertyNames(instagram.prototype)) {
    const isMethod = typeof instagram.prototype[key] === 'function';
    const isTarget = key.startsWith('run') || key.startsWith('publish');
    if (isMethod && isTarget) {
        const originalMethod = instagram.prototype[key];
        instagram.prototype[key] = function (...args) {
            const uKey = (this.username || 'unknown').toLowerCase();
            return userStorage.run(uKey, () => {
                return originalMethod.apply(this, args);
            });
        };
    }
}

module.exports = {
    instagram,
    chalk,
    fs,
    path,
    axios,
    Jimp,
    delay: (ms) => {
        const jitter = 0.2; // 20% jitter
        const min = ms * (1 - jitter);
        const max = ms * (1 + jitter);
        const finalMs = Math.floor(Math.random() * (max - min + 1) + min);
        return new Promise(r => setTimeout(r, finalMs));
    },
    resolvePath,
    print,
    reportTask,
    categorizeError,
    IG_ERRORS
};
