const express = require('express');
const axios = require('axios');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const sharp = require('sharp');

const app = express();
const PORT = Number(process.env.PORT || 12003);
const INVITE_CODE = String(process.env.INVITE_CODE || 'CHANGE_ME_INVITE_CODE');
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || 'admin');
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || 'change-me-now');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const RESULTS_DIR = process.env.RESULTS_DIR || path.join(__dirname, 'results');
const ARCHIVE_BASE = process.env.ARCHIVE_BASE || path.join(__dirname, 'archive');
const APP_PUBLIC_BASE = String(process.env.APP_PUBLIC_BASE || `http://localhost:${PORT}`);

// ===== File Logger =====
const LOG_FILE = path.join(LOG_DIR, 'requests.log');
const API_LOG_FILE = path.join(LOG_DIR, 'api-responses.log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

// Convert Date to Beijing time string (GMT+8)
function bjTime(d) {
  const dt = d || new Date();
  const h = dt.getUTCHours() + 8;
  dt.setUTCHours(h);
  return dt.toISOString().replace('.000Z', '');
}
// Beijing time date string (yyyy-MM-dd)
function bjDate(d) {
  const dt = new Date(d || Date.now());
  const h = dt.getUTCHours() + 8;
  dt.setUTCHours(h);
  return dt.toISOString().slice(0, 10);
}

function isSameBjDate(value, dateStr) {
  if (!value) return false;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return false;
  return bjDate(dt) === dateStr;
}

function logToFile(msg) {
  const line = `[${bjTime()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch(e) {}
  // Also print to console
  console.log(msg);
}

function logError(msg) {
  const line = `[${bjTime()}] ERROR: ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line, 'utf8'); } catch(e) {}
  console.error(msg);
}

// API Response Logger (persistent, includes request ID + full response)
function logApiResponse(entry) {
  // Truncate rawResponse to avoid "Invalid string length" errors
  if (entry.rawResponse && entry.rawResponse.length > 5000) {
    entry.rawResponse = entry.rawResponse.substring(0, 5000) + '... [truncated]';
  }
  const line = JSON.stringify({ ts: bjTime(), ...entry }) + '\n';
  try { fs.appendFileSync(API_LOG_FILE, line, 'utf8'); } catch(e) {}
}

function isSub2StatsEntry(entry) {
  const model = String(entry?.model || '');
  return model === 'gpt-image-2-sub2'
    || model.startsWith('gpt-image-2-sub2-');
}

function isFeaturePageTask(entry) {
  const meta = entry?.archiveMeta || {};
  const model = String(entry?.model || '');
  const featureKey = entry?.featureKey || meta.featureKey;
  return meta.archiveType === 'detail-replicate'
    || meta.archiveType === 'buyer-show'
    || ['detail_replicate', 'buyer_show', 'buyer_show_extend'].includes(featureKey)
    || model.startsWith('gpt-image-2-sub2-detail-replicate')
    || model.startsWith('gpt-image-2-sub2-buyer-show');
}

function countImageList(list) {
  if (!Array.isArray(list)) return 0;
  return new Set(list.filter(Boolean).map(item => String(item))).size;
}

function getOutputImageCount(entry) {
  return Math.max(
    countImageList(entry?.resultUrls),
    countImageList(entry?.archiveUrls),
    countImageList(entry?.archiveMeta?.savedResults)
  );
}

function getRawResponseJson(entry) {
  const raw = String(entry?.rawResponse || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function getUpstreamRequestedImageCount(entry) {
  const data = getRawResponseJson(entry);
  const task = data?.sub2Task || data;
  const directCount = Number(task?.count || 0);
  if (Number.isFinite(directCount) && directCount > 0) return directCount;
  if (Array.isArray(task?.images) && task.images.length > 0) return task.images.length;
  if (Array.isArray(task?.data) && task.data.length > 0) return task.data.length;
  if (Array.isArray(task?.data?.data) && task.data.data.length > 0) return task.data.data.length;
  return 0;
}

function getExpectedOutputCount(entry) {
  const upstreamCount = getUpstreamRequestedImageCount(entry);
  if (upstreamCount > 0) return upstreamCount;
  const explicitCount = Number(entry?.expectedCount || entry?.count || 0);
  if (Number.isFinite(explicitCount) && explicitCount > 0) return explicitCount;
  if (Array.isArray(entry?.archiveMeta?.itemNames) && entry.archiveMeta.itemNames.length > 0) {
    return entry.archiveMeta.itemNames.length;
  }
  const imageCount = Number(entry?.imageCount || 0);
  const model = String(entry?.model || '');
  const id = String(entry?.id || '');
  if (Number.isFinite(imageCount) && imageCount > 0 && (
    model.includes('multi-angle')
    || model.includes('buyer-show')
    || model.includes('detail-replicate')
    || id.startsWith('multi_')
    || id.startsWith('bsbatch_')
  )) return imageCount;
  return 1;
}

function getStatsImageCount(entry) {
  if (entry?.queueParentId) return 0;
  return Math.max(1, getExpectedOutputCount(entry));
}

function getStatsSuccessfulImageCount(entry) {
  if (!entry) return 0;
  return Math.min(getStatsImageCount(entry), getOutputImageCount(entry));
}

function getEntryCompletedTimeMs(entry) {
  const ts = new Date(entry?.completedAt || entry?.submittedAt || 0).getTime();
  return Number.isFinite(ts) ? ts : 0;
}

function getImageSlotSuccess(item) {
  if (item == null) return null;
  if (typeof item === 'string') return true;
  const status = String(item.status || item.stage || '').trim().toLowerCase();
  if (status) {
    if (['failed', 'fail', 'error', 'cancelled', 'canceled'].includes(status)) return false;
    if (['completed', 'complete', 'success', 'succeeded', 'ready', 'done'].includes(status)) return true;
  }
  if (item.error) return false;
  if (item.url || item.image_url || item.preview_image_url || item.b64_json) return true;
  return null;
}

function getImageOutcomeSlots(entry) {
  if (entry?.queueParentId) return [];
  const data = getRawResponseJson(entry);
  const task = data?.sub2Task || data;
  const arrays = [
    Array.isArray(task?.images) ? task.images : null,
    Array.isArray(task?.ready_images) ? task.ready_images : null,
    Array.isArray(data?.images) ? data.images : null,
    Array.isArray(data?.ready_images) ? data.ready_images : null,
    Array.isArray(data?.data) ? data.data : null,
  ].filter(Boolean);

  for (const arr of arrays) {
    const slots = arr.map((item, index) => ({
      success: getImageSlotSuccess(item),
      index,
    }));
    if (slots.some(slot => slot.success !== null)) {
      return slots.map(slot => ({
        success: slot.success !== false,
        completedAt: getEntryCompletedTimeMs(entry),
        index: slot.index,
      }));
    }
  }

  const requested = Math.max(1, getExpectedOutputCount(entry));
  if (!requested) return [];
  const status = String(entry?.status || '').trim().toLowerCase();
  if (!['success', 'error', 'failed'].includes(status)) return [];
  const successCount = Math.min(requested, getOutputImageCount(entry));
  return Array.from({ length: requested }, (_, index) => ({
    success: index < successCount,
    completedAt: getEntryCompletedTimeMs(entry),
    index,
  }));
}

function getRecentImageSuccessStats(entries, limit = 10) {
  const sorted = (Array.isArray(entries) ? entries : [])
    .filter(e => e && e.status !== 'pending')
    .slice()
    .sort((a, b) => getEntryCompletedTimeMs(b) - getEntryCompletedTimeMs(a));

  const slots = [];
  for (const entry of sorted) {
    const entrySlots = getImageOutcomeSlots(entry);
    for (const slot of entrySlots) {
      slots.push(slot);
      if (slots.length >= limit) break;
    }
    if (slots.length >= limit) break;
  }

  const window = slots.slice(0, Math.max(1, limit));
  const total = window.length;
  const success = window.filter(slot => slot.success).length;

  return {
    total,
    success,
    rate: total > 0 ? Math.round((success / total) * 100) : 0,
  };
}

function extractUpstreamDurationMs(entry) {
  const raw = String(entry?.rawResponse || '').trim();
  if (!raw) return 0;
  try {
    const data = JSON.parse(raw);
    const imageDurations = Array.isArray(data?.images)
      ? data.images
          .map(item => Number(item?.duration_ms || 0))
          .filter(value => Number.isFinite(value) && value > 0)
      : [];
    if (imageDurations.length > 0) {
      return imageDurations.reduce((sum, value) => sum + value, 0);
    }
    const readyDurations = Array.isArray(data?.ready_images)
      ? data.ready_images
          .map(item => Number(item?.duration_ms || 0))
          .filter(value => Number.isFinite(value) && value > 0)
      : [];
    if (readyDurations.length > 0) {
      return readyDurations.reduce((sum, value) => sum + value, 0);
    }
  } catch (e) {}
  return 0;
}

function finalizeTaskRefund(entry, price) {
  if (!entry || entry._refundApplied) return false;
  refundGeneration(entry.user, price);
  entry._refundApplied = true;
  return true;
}

function refundGenerateEntryOnce(localId, username, price) {
  const log = loadGenerateLog();
  const entry = log.find(e => e.id === localId);
  if (entry && entry._refundApplied) return false;
  refundGeneration(username, price || getPrice(entry?.model || 'gpt-image-2-sub2'));
  if (entry) {
    entry._refundApplied = true;
    saveGenerateLog(log);
  }
  return true;
}

// ===== Today Stats API =====
app.get('/api/stats/today', auth, (req, res) => {
  const today = bjDate();
  const model = req.query.model;
  const logs = loadGenerateLog();
  let modelLogs = logs;
  if (model) {
    modelLogs = modelLogs.filter(e => model === 'gpt-image-2-sub2' ? isSub2StatsEntry(e) : e.model === model);
  }
  const todayLogs = modelLogs.filter(e => isSameBjDate(e.submittedAt, today));

  // Overall stats
  const totalCount = todayLogs.reduce((sum, e) => sum + getStatsImageCount(e), 0);
  const successCount = todayLogs.reduce((sum, e) => sum + getStatsSuccessfulImageCount(e), 0);
  const isPendingStatus = e => e.status === 'pending';
  const failCount = todayLogs.filter(e => !isPendingStatus(e)).reduce((sum, e) => sum + Math.max(0, getStatsImageCount(e) - getStatsSuccessfulImageCount(e)), 0);
  const pendingCount = todayLogs.filter(e => e.status === 'pending').reduce((sum, e) => sum + getStatsImageCount(e), 0);
  let queuedCount = todayLogs.filter(e => e.status === 'pending' && e.queueStatus === 'queued').reduce((sum, e) => sum + getStatsImageCount(e), 0);
  let runningCount = todayLogs.filter(e => e.status === 'pending' && e.queueStatus !== 'queued').reduce((sum, e) => sum + getStatsImageCount(e), 0);
  if (model === 'gpt-image-2-sub2') {
    const queueStatus = getSub2QueueStatus();
    queuedCount = queueStatus.queued || 0;
    runningCount = queueStatus.running || 0;
  }
  const completedCount = successCount + failCount;
  const todaySuccessRate = totalCount > 0 ? ((successCount / totalCount) * 100).toFixed(1) : '0.0';
  const recentImageStats = getRecentImageSuccessStats(modelLogs, 10);
  const recentTotalCount = recentImageStats.total;
  const recentSuccessCount = recentImageStats.success;
  const recentSuccessRate = recentImageStats.rate.toFixed ? recentImageStats.rate.toFixed(1) : String(recentImageStats.rate);

  // Average duration weighted by generated image count.
  const durations = todayLogs
    .filter(e => e.status === 'success')
    .map(e => {
      const upstreamDuration = extractUpstreamDurationMs(e);
      const fallbackDuration = e.submittedAt && e.completedAt
        ? (new Date(e.completedAt).getTime() - new Date(e.submittedAt).getTime())
        : 0;
      return { duration: upstreamDuration || fallbackDuration, count: getStatsImageCount(e) };
    })
    .filter(d => d.duration > 0 && d.count > 0);
  const durationTotalCount = durations.reduce((sum, d) => sum + d.count, 0);
  const avgDuration = durationTotalCount > 0 ? (durations.reduce((sum, d) => sum + d.duration * d.count, 0) / durationTotalCount / 1000).toFixed(1) : '0';

  res.json({
    totalCount,
    successCount,
    failCount,
    pendingCount,
    queuedCount,
    runningCount,
    completedCount,
    successRate: parseFloat(todaySuccessRate),
    completedSuccessRate: parseFloat(recentSuccessRate),
    avgDuration: parseFloat(avgDuration),
  });
});

// ===== Two-stage Generate Log (with submit + complete timestamps) =====
const GENERATE_LOG_FILE = path.join(LOG_DIR, 'generate-log.json');

function loadGenerateLog() {
  if (!fs.existsSync(GENERATE_LOG_FILE)) {
    fs.writeFileSync(GENERATE_LOG_FILE, '[]');
    return [];
  }
  return readJsonFileSafe(GENERATE_LOG_FILE, []);
}

function saveGenerateLog(log) {
  fs.writeFileSync(GENERATE_LOG_FILE, JSON.stringify(log, null, 2));
}

// Stage 1: Create entry when user clicks generate
function createGenerateEntry(entry) {
  if (!entry.archiveMeta) entry.archiveMeta = null;
  const log = loadGenerateLog();
  log.push(entry);
  saveGenerateLog(log);
}

// Stage 2: Update entry when API returns
function updateGenerateEntry(localId, updates) {
  const log = loadGenerateLog();
  const entry = log.find(e => e.id === localId);
  if (entry) {
    Object.assign(entry, updates);
    saveGenerateLog(log);
  }
}

function formatSub2TaskError(taskData, fallbackMessage) {
  const root = taskData && typeof taskData === 'object' ? taskData : {};
  const taskError = root.error && typeof root.error === 'object' ? root.error : null;
  const failed = Array.isArray(root.images) ? root.images.find(x => x && x.status === 'failed') : null;
  const failedError = failed && typeof failed.error === 'object' ? failed.error : null;

  const directMessage = [
    taskError?.message,
    failedError?.message,
    typeof root.error === 'string' ? root.error : '',
  ].map(v => String(v || '').trim()).find(Boolean);
  if (directMessage) return directMessage;

  const errorType = String(taskError?.type || failedError?.type || '').trim();
  const errorStatus = taskError?.status ?? failedError?.status ?? null;
  const status = String(root.status || root.stage || failed?.status || '').trim();
  const failedCount = Number(root.failed_count || 0);
  const completedCount = Number(root.completed_count || 0);
  const readyCount = Number(root.ready_count || 0);
  const countParts = [];

  if (failedCount > 0) countParts.push(`failed=${failedCount}`);
  if (completedCount > 0) countParts.push(`completed=${completedCount}`);
  if (readyCount > 0) countParts.push(`ready=${readyCount}`);

  const parts = [];
  if (status) parts.push(`任务状态: ${status}`);
  if (errorType) parts.push(`错误类型: ${errorType}`);
  if (errorStatus !== null && errorStatus !== undefined && errorStatus !== '') {
    parts.push(`状态码: ${errorStatus}`);
  }
  if (countParts.length > 0) parts.push(countParts.join(', '));

  if (parts.length > 0) return `Sub2 任务失败（${parts.join(' | ')}）`;
  return fallbackMessage || 'Sub2 task failed';
}

// Extract request ID from API error message or response body
function extractRequestId(err) {
  // 1. Check headers
  if (err.response?.headers) {
    const h = err.response.headers;
    const hdrId = h['x-request-id'] || h['x-banana-request-id'] || h['request-id'];
    if (hdrId) return hdrId;
  }
  // 2. Check error message body: "image is required (request id: 20260509063725905930298268d9d6ujmlsrR)"
  const msg = err.response?.data?.error?.message || err.message || '';
  const match = msg.match(/request id:\s*([a-zA-Z0-9]+)/);
  if (match) return match[1];
  // 3. Check raw response data for request_id field
  if (err.response?.data?.request_id) return err.response.data.request_id;
  return null;
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Request logging middleware (compact - no bodies unless error)
app.use((req, res, next) => {
  const start = Date.now();
  const origJson = res.json.bind(res);
  res.json = (body) => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const method = req.method;
    const p = req.path;
    const user = req.username || '-';
    let detail = '';
    if (status >= 400 && body?.error) {
      detail = ` | error: ${body.error.substring(0, 200)}`;
    }
    logToFile(`${method} ${p} ${status} ${duration}ms | user=${user}${detail}`);
    return origJson(body);
  };
  next();
});

// Directories
[
  path.join(__dirname, 'public'),
  RESULTS_DIR,
  DATA_DIR,
  UPLOADS_DIR,
  ARCHIVE_BASE
].forEach(p => {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// Static
app.use(express.static(path.join(__dirname, 'public')));
app.use('/results', express.static(RESULTS_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/archive', express.static(ARCHIVE_BASE));

// Multer storage for uploaded images
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    const name = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    cb(null, name);
  }
});
const upload = multer({ storage, limits: { fileSize: 80 * 1024 * 1024 } });

const UPLOAD_MAX_SIDE = 3000;
const UPLOAD_REENCODE_BYTES = 8 * 1024 * 1024;

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '0B';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

async function compressUploadedImage(file, label = '') {
  const result = {
    compressed: false,
    originalSize: file.size,
    compressedSize: file.size,
    originalMaxSide: null,
    finalMaxSide: null,
    filename: file.filename,
  };
  try {
    const meta = await sharp(file.path).metadata();
    const width = Number(meta.width || 0);
    const height = Number(meta.height || 0);
    const maxSide = Math.max(width, height);
    result.originalMaxSide = maxSide || null;
    result.finalMaxSide = maxSide || null;
    const shouldResize = maxSide > UPLOAD_MAX_SIDE;
    const shouldReencode = Number(file.size || 0) > UPLOAD_REENCODE_BYTES;
    if (!maxSide || (!shouldResize && !shouldReencode)) return result;

    const ext = path.extname(file.filename).toLowerCase();
    const keepAlpha = !!meta.hasAlpha;
    const nextExt = keepAlpha ? (ext === '.webp' ? '.webp' : '.png') : '.jpg';
    const base = path.basename(file.filename, ext);
    const nextFilename = `${base}${nextExt}`;
    const tmpPath = path.join(path.dirname(file.path), `${base}.tmp${nextExt}`);
    const nextPath = path.join(path.dirname(file.path), nextFilename);
    let pipeline = sharp(file.path).rotate();
    if (shouldResize) {
      pipeline = pipeline.resize({
        width: UPLOAD_MAX_SIDE,
        height: UPLOAD_MAX_SIDE,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    if (nextExt === '.png') {
      pipeline = pipeline.png({ compressionLevel: 9, adaptiveFiltering: true });
    } else if (nextExt === '.webp') {
      pipeline = pipeline.webp({ quality: 86 });
    } else {
      pipeline = pipeline.jpeg({ quality: 86, mozjpeg: true });
    }
    await pipeline.toFile(tmpPath);
    const st = fs.statSync(tmpPath);
    if (nextPath === file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    fs.renameSync(tmpPath, nextPath);
    if (nextPath !== file.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    file.path = nextPath;
    file.filename = nextFilename;
    file.size = st.size;
    file.mimetype = nextExt === '.png' ? 'image/png' : nextExt === '.webp' ? 'image/webp' : 'image/jpeg';
    const nextMeta = await sharp(nextPath).metadata().catch(() => ({}));
    result.compressed = true;
    result.compressedSize = st.size;
    result.finalMaxSide = Math.max(Number(nextMeta.width || 0), Number(nextMeta.height || 0)) || UPLOAD_MAX_SIDE;
    result.filename = nextFilename;
    logToFile(`upload compressed | ${label || file.originalname || file.filename} | ${formatBytes(result.originalSize)} -> ${formatBytes(result.compressedSize)} | side ${result.originalMaxSide} -> ${result.finalMaxSide} | ${nextFilename}`);
    return result;
  } catch (err) {
    logError(`Upload image compression skipped: ${file.filename} - ${err.message}`);
    return result;
  }
}

// Upload image endpoint
app.post('/api/upload', auth, upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: '未选择文件' });
  const compression = await compressUploadedImage(req.file, req.username || req.file.originalname);
  const url = `/uploads/${req.file.filename}`;
  res.json({ success: true, url, filename: req.file.filename, size: req.file.size, compression });
});

// Proxy download endpoint - fetches external image URL and returns as downloadable file
app.get('/api/proxy-download', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });
  try {
    const imgRes = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 50 * 1024 * 1024,
    });
    const contentType = imgRes.headers['content-type'] || 'image/png';
    const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg' : contentType.includes('png') ? 'png' : 'bin';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="image_${Date.now()}.${ext}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(imgRes.data);
  } catch (err) {
    logError(`Proxy download failed: ${url} - ${err.message}`);
    res.status(502).json({ error: 'Failed to download image', details: err.message });
  }
});

const ZIP_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = ZIP_CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function zipDateTime(d) {
  const dt = d || new Date();
  const time = (dt.getHours() << 11) | (dt.getMinutes() << 5) | Math.floor(dt.getSeconds() / 2);
  const date = ((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
  return { time, date };
}

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const now = zipDateTime();
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.buffer) ? entry.buffer : Buffer.from(entry.buffer);
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(now.time, 12);
    cd.writeUInt16LE(now.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralSize = central.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, end]);
}

function imageExtFromMime(mime, fallbackName) {
  const ext = path.extname(String(fallbackName || '')).replace('.', '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'webp'].includes(ext)) return ext === 'jpeg' ? 'jpg' : ext;
  if (String(mime || '').includes('webp')) return 'webp';
  if (String(mime || '').includes('png')) return 'png';
  return 'jpg';
}

function uniqueZipName(name, used) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let candidate = name;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${n}${ext}`;
    n++;
  }
  used.add(candidate);
  return candidate;
}

// Data files
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const API_KEY_FILE = path.join(DATA_DIR, 'apikey.txt');
const ZHENZHEN_API_KEY_FILE = path.join(DATA_DIR, 'zhenzhen_apikey.txt');
const MANXIAOBAI_API_KEY_FILE = path.join(DATA_DIR, 'manxiaobai_apikey.txt');
const SUB2_API_KEY_FILE = path.join(DATA_DIR, 'sub2_apikey.txt');
const SUB2_QUEUE_CONFIG_FILE = path.join(DATA_DIR, 'sub2_queue_config.json');
const AGNES_API_KEY_FILE = path.join(DATA_DIR, 'agnes_apikey.txt');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const PROMPTS_FILE = path.join(DATA_DIR, 'prompts.json');
const BALANCE_FILE = path.join(DATA_DIR, 'balances.json');
const RECHARGE_LOGS_FILE = path.join(DATA_DIR, 'recharge_logs.json');
const PDD_DETAIL_TEMPLATES_FILE = path.join(DATA_DIR, 'pdd-detail-templates.json');
const VIDEO_TASKS_FILE = path.join(LOG_DIR, 'video-tasks.json');

function loadRechargeLogs() {
  if (!fs.existsSync(RECHARGE_LOGS_FILE)) {
    fs.writeFileSync(RECHARGE_LOGS_FILE, JSON.stringify([]));
    return [];
  }
  return readJsonFileSafe(RECHARGE_LOGS_FILE, []);
}
function saveRechargeLogs(logs) { fs.writeFileSync(RECHARGE_LOGS_FILE, JSON.stringify(logs, null, 2)); }

function loadVideoTasks() {
  if (!fs.existsSync(VIDEO_TASKS_FILE)) {
    fs.writeFileSync(VIDEO_TASKS_FILE, '[]');
    return [];
  }
  return readJsonFileSafe(VIDEO_TASKS_FILE, []);
}

function saveVideoTasks(tasks) {
  fs.writeFileSync(VIDEO_TASKS_FILE, JSON.stringify(tasks, null, 2));
}

function upsertVideoTask(task) {
  const tasks = loadVideoTasks();
  const idx = tasks.findIndex(t => t.localId === task.localId);
  if (idx >= 0) tasks[idx] = { ...tasks[idx], ...task };
  else tasks.push(task);
  saveVideoTasks(tasks.slice(-500));
  return idx >= 0 ? tasks[idx] : task;
}

function updateVideoTask(localId, updates) {
  const tasks = loadVideoTasks();
  const task = tasks.find(t => t.localId === localId);
  if (!task) return null;
  Object.assign(task, updates);
  saveVideoTasks(tasks);
  return task;
}

function findVideoTask({ localId, taskId, videoId }, username) {
  const tasks = loadVideoTasks();
  return tasks.find(t =>
    (!username || t.user === username) &&
    ((localId && t.localId === localId) ||
      (taskId && (t.task_id === taskId || t.id === taskId)) ||
      (videoId && t.video_id === videoId))
  ) || null;
}

function hashAgnesKey(key) {
  return crypto.createHash('sha256').update(String(key || '')).digest('hex');
}

function findAgnesKeyByHash(hash) {
  const keys = getAgnesApiKeys();
  if (!hash) return keys[0] || '';
  return keys.find(key => hashAgnesKey(key) === hash) || keys[0] || '';
}

function extractVideoUrl(data) {
  if (!data || typeof data !== 'object') return '';
  const directKeys = ['remixed_from_video_id', 'video_url', 'url', 'output_url'];
  for (const key of directKeys) {
    if (typeof data[key] === 'string' && /^https?:\/\//i.test(data[key])) return data[key];
  }
  if (Array.isArray(data.data)) {
    for (const item of data.data) {
      const url = extractVideoUrl(item);
      if (url) return url;
    }
  }
  if (data.result && typeof data.result === 'object') {
    const url = extractVideoUrl(data.result);
    if (url) return url;
  }
  return '';
}

function normalizeVideoMode(mode) {
  return ['text', 'image', 'multi', 'keyframes'].includes(mode) ? mode : 'text';
}

function normalizeVideoFrameCount(numFrames) {
  const n = Number(numFrames || 121);
  if ([81, 121, 241, 441].includes(n)) return n;
  const clamped = Math.max(9, Math.min(441, Math.round(n)));
  return clamped - ((clamped - 1) % 8);
}

function isSupportedVideoImageInput(value) {
  const raw = String(value || '').trim();
  return /^https?:\/\//i.test(raw)
    || /^data:image\/[a-z0-9.+-]+;base64,/i.test(raw)
    || raw.startsWith('/uploads/')
    || raw.startsWith('/results/')
    || raw.startsWith('/archive/');
}

function summarizeVideoImageInput(value) {
  const raw = String(value || '');
  const match = raw.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
  if (match) return `data:${match[1]};base64,length=${raw.length}`;
  return raw;
}

function normalizeDataUriBase64(raw) {
  const text = String(raw || '').trim();
  const match = text.match(/^data:([^;]+);base64,(.+)$/is);
  if (!match) return '';
  const mime = match[1];
  const cleaned = match[2].replace(/\s+/g, '');
  const pad = cleaned.length % 4;
  const padded = pad ? cleaned + '='.repeat(4 - pad) : cleaned;
  try {
    const buffer = Buffer.from(padded, 'base64');
    if (!buffer.length) return '';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (error) {
    return '';
  }
}

async function prepareVideoImageInputs(inputs) {
  const list = [];
  for (const input of inputs || []) {
    const raw = String(input || '').trim();
    if (!raw) continue;
    if (/^https?:\/\//i.test(raw)) {
      list.push(raw);
      continue;
    }
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(raw)) {
      const normalized = normalizeDataUriBase64(raw);
      const match = normalized.match(/^data:([^;]+);base64,(.+)$/i);
      if (match) list.push({ mime: match[1], data: match[2], sourceType: 'base64' });
      continue;
    }
    const resolved = await resolveImage(raw);
    if (resolved) list.push({ mime: resolved.mime, data: resolved.buffer.toString('base64'), sourceType: 'base64' });
  }
  return list;
}

// Pricing per generation (CNY)
const PRICING = {
  'gpt-image-2-flatfee': 0.035,
  'gpt-image-2-vip': 0.05,
  'gpt-image-2': 0.054,
  'gpt-image-2-manxiaobai': 0.066,
  'gpt-image-2-sub2': 0.025,
  'agnes-image-2.1-flash': 0.01,
};

const MANXIAOBAI_PRICING = {
  'gpt-image-2-1k': 0.055,
  'gpt-image-2-2k': 0.066,
  'gpt-image-2-4k': 0.077,
};

function getPrice(model) {
  return PRICING[model] || PRICING['gpt-image-2-sub2'];
}

function normalizeImageModel(model) {
  const allowed = ['gpt-image-2-flatfee', 'gpt-image-2', 'gpt-image-2-sub2', 'gpt-image-2-manxiaobai', 'agnes-image-2.1-flash'];
  return allowed.includes(model) ? model : 'gpt-image-2-sub2';
}

function resolveImageModelConfig(modelName) {
  const model = normalizeImageModel(modelName);
  if (model === 'gpt-image-2') {
    return { model, apiKey: getZhenzhenApiKey(), apiBase: 'https://ai.t8star.org', keyLabel: '贞贞令牌' };
  }
  if (model === 'gpt-image-2-manxiaobai') {
    return { model, apiKey: getManxiaobaiApiKey(), apiBase: 'https://api.manxiaobai.online', keyLabel: '漫小白令牌' };
  }
  if (model === 'gpt-image-2-sub2') {
    return { model, apiKey: getSub2ApiKey(), apiBase: 'https://img.94576354.xyz', keyLabel: 'Sub2令牌' };
  }
  if (model === 'agnes-image-2.1-flash') {
    return { model, apiKey: getAgnesApiKey(), apiBase: 'https://apihub.agnes-ai.com', keyLabel: 'Agnes令牌', keyPool: 'agnes' };
  }
  return { model: 'gpt-image-2-sub2', apiKey: getApiKey(), apiBase: 'https://img.94576354.xyz', keyLabel: 'Sub2令牌' };
}

function resolveManxiaobaiModel(size) {
  const match = String(size || '').match(/^(\d+)x(\d+)$/);
  if (!match) return 'gpt-image-2-2k';
  const width = Number(match[1]);
  const height = Number(match[2]);
  const maxSide = Math.max(width, height);
  if (maxSide <= 1024) return 'gpt-image-2-1k';
  if (maxSide <= 2048) return 'gpt-image-2-2k';
  return 'gpt-image-2-4k';
}

function resolveManxiaobaiPrice(size) {
  return MANXIAOBAI_PRICING[resolveManxiaobaiModel(size)] || MANXIAOBAI_PRICING['gpt-image-2-2k'];
}

function resolveAgnesSize(size) {
  const raw = String(size || '').trim();
  return /^\d+x\d+$/.test(raw) ? raw : '2048x2048';
}

function hasCjkText(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(String(text || ''));
}

function cleanupAgnesTranslatedPrompt(text) {
  return String(text || '')
    .replace(/^```(?:text|txt|english)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim();
}

async function prepareAgnesPrompt(prompt, apiKey, label) {
  const originalPrompt = String(prompt || '');
  if (!hasCjkText(originalPrompt)) {
    return { prompt: originalPrompt, translatedPrompt: null };
  }

  try {
    const response = await axiosWithRetry({
      method: 'post',
      url: 'https://apihub.agnes-ai.com/v1/chat/completions',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      data: {
        model: 'agnes-2.0-flash',
        messages: [
          {
            role: 'system',
            content: [
              'Translate and optimize the user prompt into fluent English for Agnes image generation.',
              'Preserve all concrete product details, scene/environment, material, lighting, color, composition, camera angle, style, text/layout requirements, and negative constraints.',
              'Do not add unrelated objects or change the product identity.',
              'Return only the final English prompt, with no explanation.',
            ].join(' '),
          },
          { role: 'user', content: originalPrompt },
        ],
        temperature: 0,
        max_tokens: 1200,
      },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }, `Agnes prompt translation ${label || ''}`, 2);

    const translated = cleanupAgnesTranslatedPrompt(response.data?.choices?.[0]?.message?.content);
    if (!translated) throw new Error('empty translated prompt');
    logToFile(`[Agnes prompt translated] ${label || '-'} | zhLen=${originalPrompt.length} | enLen=${translated.length} | en=${translated.substring(0, 180)}`);
    return { prompt: translated, translatedPrompt: translated };
  } catch (error) {
    const detail = error.response?.data?.error?.message || error.response?.data?.message || error.message;
    logError(`Agnes prompt translation failed (${label || '-'}), fallback to original prompt: ${detail}`);
    return { prompt: originalPrompt, translatedPrompt: null };
  }
}

function resolveZhenzhenSize(size) {
  const raw = String(size || '').trim();
  const match = raw.match(/^(\d+)x(\d+)$/);
  if (!match) return { upstreamSize: undefined, promptSize: undefined };
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width === height) {
    return { upstreamSize: '1024x1024', promptSize: raw };
  }
  return {
    upstreamSize: width > height ? '1536x1024' : '1024x1536',
    promptSize: raw,
  };
}

function readJsonFileSafe(filePath, fallbackValue) {
  if (!fs.existsSync(filePath)) return fallbackValue;
  try {
    const raw = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
    if (!raw) return fallbackValue;
    return JSON.parse(raw);
  } catch (error) {
    logError(`Failed to read JSON file ${filePath}: ${error.message}`);
    return fallbackValue;
  }
}

function readTextFileSafe(filePath, fallbackValue = '') {
  if (!fs.existsSync(filePath)) return fallbackValue;
  try {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '').trim();
  } catch (error) {
    logError(`Failed to read text file ${filePath}: ${error.message}`);
    return fallbackValue;
  }
}

function loadPddDetailTemplates() {
  const data = readJsonFileSafe(PDD_DETAIL_TEMPLATES_FILE, { templates: [] });
  return Array.isArray(data.templates) ? data.templates : [];
}

function getPddDetailTemplateByCode(code, username) {
  const rawCode = String(code || '').trim();
  if (!rawCode) return null;
  const found = loadPddDetailTemplates().find(t => t && t.enabled !== false && String(t.code || '') === rawCode);
  if (!found) return null;
  const allowed = Array.isArray(found.allowedUsers) ? found.allowedUsers.filter(Boolean) : [];
  if (allowed.length > 0 && !allowed.includes(username)) return null;
  return found;
}

function getPddDetailTemplateById(id, username) {
  const rawId = String(id || '').trim();
  if (!rawId) return null;
  const found = loadPddDetailTemplates().find(t => t && t.enabled !== false && String(t.id || '') === rawId);
  if (!found) return null;
  const allowed = Array.isArray(found.allowedUsers) ? found.allowedUsers.filter(Boolean) : [];
  if (allowed.length > 0 && !allowed.includes(username)) return null;
  return found;
}

function publicPddTemplatePayload(t) {
  const imageBase = String(t.imageBase || '');
  const screens = Array.isArray(t.screens) ? t.screens.map((s, index) => ({
    index: index + 1,
    name: s.name || `第${index + 1}屏`,
    type: s.type || '拼多多套版',
    intent: s.intent || '',
    imageUrl: imageBase + String(s.file || '')
  })).filter(s => s.imageUrl) : [];
  return {
    id: t.id,
    name: t.name,
    category: t.category || '',
    platform: t.platform || 'pdd',
    ratio: t.ratio || '',
    screenCount: screens.length,
    screens
  };
}

function loadBalances() {
  if (!fs.existsSync(BALANCE_FILE)) {
    fs.writeFileSync(BALANCE_FILE, JSON.stringify({}));
    return {};
  }
  return readJsonFileSafe(BALANCE_FILE, {});
}
function saveBalances(b) { fs.writeFileSync(BALANCE_FILE, JSON.stringify(b, null, 2)); }

const DEFAULT_PROMPTS = [
  { name: '产品图优化', mode: 'dual', prompt: 'Enhance this product image with professional lighting, clean white background, and subtle shadows for e-commerce.' },
  { name: '背景替换', mode: 'dual', prompt: 'Replace the background with a clean, minimal studio setting. Keep the product exactly as-is.' },
  { name: '场景合成', mode: 'dual', prompt: 'Place the product in a realistic lifestyle scene that matches its use case. Natural lighting and composition.' },
  { name: '海报设计', mode: 'single', prompt: 'Create a visually striking promotional poster with bold typography, vibrant colors, and modern layout.' },
  { name: 'Logo 设计', mode: 'single', prompt: 'Design a minimalist, modern logo with clean lines and a professional color palette.' },
  { name: 'Banner 设计', mode: 'single', prompt: 'Design a wide banner with gradient background, centered text area, and subtle decorative elements.' },
];

function loadPrompts() {
  if (!fs.existsSync(PROMPTS_FILE)) {
    fs.writeFileSync(PROMPTS_FILE, JSON.stringify(DEFAULT_PROMPTS, null, 2));
    return [...DEFAULT_PROMPTS];
  }
  return readJsonFileSafe(PROMPTS_FILE, [...DEFAULT_PROMPTS]);
}

function savePrompts(prompts) {
  fs.writeFileSync(PROMPTS_FILE, JSON.stringify(prompts, null, 2));
}

function loadUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    // Create admin user
    const adminHash = crypto.createHash('md5').update(ADMIN_PASSWORD).digest('hex');
    const users = {
      [ADMIN_USERNAME]: { username: ADMIN_USERNAME, password: adminHash, role: 'admin', createdAt: new Date().toISOString() }
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    return users;
  }
  return readJsonFileSafe(USERS_FILE, {});
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

function loadStats() {
  if (!fs.existsSync(STATS_FILE)) {
    fs.writeFileSync(STATS_FILE, JSON.stringify({}, null, 2));
    return {};
  }
  return readJsonFileSafe(STATS_FILE, {});
}

function saveStats(stats) {
  fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
}

function chargeGeneration(username, price) {
  const balances = loadBalances();
  if (!balances[username]) balances[username] = { balance: 0, enabled: false };
  const bal = balances[username];
  if (!bal.enabled) {
    const err = new Error('账户已禁用,请联系管理员');
    err.statusCode = 403;
    throw err;
  }
  if (bal.balance < price) {
    const err = new Error(`余额不足(当前 ¥${Number(bal.balance || 0).toFixed(2)},本次 ¥${Number(price || 0).toFixed(3)}),请联系管理员充值`);
    err.statusCode = 402;
    throw err;
  }
  balances[username].balance = Math.round((Number(balances[username].balance || 0) - price) * 100) / 100;
  saveBalances(balances);

  const stats = loadStats();
  if (!stats[username]) stats[username] = { totalCalls: 0, successCalls: 0, lastCall: null, history: [], featureMetrics: {} };
  if (!stats[username].featureMetrics) stats[username].featureMetrics = {};
  stats[username].totalCalls++;
  stats[username].lastCall = new Date().toISOString();
  saveStats(stats);
}


function refundGeneration(username, price) {
  const balances = loadBalances();
  if (!balances[username]) balances[username] = { balance: 0, enabled: false };
  balances[username].balance = Math.round((Number(balances[username].balance || 0) + price) * 100) / 100;
  saveBalances(balances);
}

function markGenerationSuccess(username, localId) {
  const stats = loadStats();
  if (!stats[username]) stats[username] = { totalCalls: 0, successCalls: 0, lastCall: null, history: [], featureMetrics: {} };
  stats[username].successCalls++;
  if (stats[username].history && stats[username].history.length > 0) {
    stats[username].history[stats[username].history.length - 1].status = 'success';
  }
  saveStats(stats);
  const log = loadGenerateLog();
  const entry = log.find(e => e.id === localId);
  if (entry) {
    const durationMs = entry.submittedAt && entry.completedAt ? (new Date(entry.completedAt).getTime() - new Date(entry.submittedAt).getTime()) : 0;
    recordGenerationMetric(username, { ...entry.archiveMeta, kind: 'success', durationMs });
  }
}

function loadHistory() {
  if (!fs.existsSync(HISTORY_FILE)) { fs.writeFileSync(HISTORY_FILE, '{}'); return {}; }
  return readJsonFileSafe(HISTORY_FILE, {});
}
function saveHistory(h) { fs.writeFileSync(HISTORY_FILE, JSON.stringify(h)); }

function getApiKey() {
  return readTextFileSafe(API_KEY_FILE, '');
}

function saveApiKey(key) {
  fs.writeFileSync(API_KEY_FILE, key.trim());
}

function getZhenzhenApiKey() {
  return readTextFileSafe(ZHENZHEN_API_KEY_FILE, '');
}

function saveZhenzhenApiKey(key) {
  fs.writeFileSync(ZHENZHEN_API_KEY_FILE, key.trim());
}

function getManxiaobaiApiKey() {
  return readTextFileSafe(MANXIAOBAI_API_KEY_FILE, '');
}

function saveManxiaobaiApiKey(key) {
  fs.writeFileSync(MANXIAOBAI_API_KEY_FILE, key.trim());
}

function getSub2ApiKey() {
  return readTextFileSafe(SUB2_API_KEY_FILE, '');
}

function saveSub2ApiKey(key) {
  fs.writeFileSync(SUB2_API_KEY_FILE, key.trim());
}

function loadSub2QueueConfig() {
  const defaults = { maxConcurrent: 3, runningTimeoutMs: 3 * 60 * 1000 };
  if (!fs.existsSync(SUB2_QUEUE_CONFIG_FILE)) {
    fs.writeFileSync(SUB2_QUEUE_CONFIG_FILE, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  const saved = readJsonFileSafe(SUB2_QUEUE_CONFIG_FILE, {});
  const maxConcurrent = Number(saved.maxConcurrent);
  const runningTimeoutMs = Number(saved.runningTimeoutMs || (Number(saved.timeoutSeconds) * 1000));
  return {
    maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.min(20, Math.floor(maxConcurrent)) : defaults.maxConcurrent,
    runningTimeoutMs: Number.isFinite(runningTimeoutMs) && runningTimeoutMs >= 30 * 1000 ? Math.min(3600 * 1000, Math.floor(runningTimeoutMs)) : defaults.runningTimeoutMs,
  };
}

function saveSub2QueueConfig(config) {
  const current = loadSub2QueueConfig();
  const maxConcurrent = Number(config?.maxConcurrent);
  const timeoutSeconds = Number(config?.timeoutSeconds);
  const next = {
    maxConcurrent: Number.isFinite(maxConcurrent) && maxConcurrent > 0 ? Math.min(20, Math.floor(maxConcurrent)) : current.maxConcurrent,
    runningTimeoutMs: Number.isFinite(timeoutSeconds) && timeoutSeconds >= 30 ? Math.min(3600, Math.floor(timeoutSeconds)) * 1000 : current.runningTimeoutMs,
  };
  fs.writeFileSync(SUB2_QUEUE_CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

function getAgnesApiKey() {
  const keys = getAgnesApiKeys();
  return keys[0] || '';
}

function saveAgnesApiKey(key) {
  fs.writeFileSync(AGNES_API_KEY_FILE, key.trim());
}

function getAgnesApiKeys() {
  return readTextFileSafe(AGNES_API_KEY_FILE, '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

const AGNES_KEY_RPM_LIMIT = 18;
const AGNES_KEY_WINDOW_MS = 60000;
const agnesKeyUsage = new Map();

function maskKeyLabel(key) {
  const raw = String(key || '');
  if (raw.length <= 10) return `key:${raw.length}`;
  return `${raw.slice(0, 6)}...${raw.slice(-4)}`;
}

function cleanupAgnesKeyUsage(now = Date.now()) {
  for (const [key, stamps] of agnesKeyUsage.entries()) {
    const active = (stamps || []).filter(ts => now - ts < AGNES_KEY_WINDOW_MS);
    if (active.length) agnesKeyUsage.set(key, active);
    else agnesKeyUsage.delete(key);
  }
}

async function acquireAgnesApiKey(label) {
  const keys = getAgnesApiKeys();
  if (!keys.length) return '';

  while (true) {
    const now = Date.now();
    cleanupAgnesKeyUsage(now);
    let best = null;
    for (const key of keys) {
      const stamps = agnesKeyUsage.get(key) || [];
      if (stamps.length >= AGNES_KEY_RPM_LIMIT) continue;
      if (!best || stamps.length < best.count) best = { key, count: stamps.length };
    }
    if (best) {
      const stamps = agnesKeyUsage.get(best.key) || [];
      stamps.push(now);
      agnesKeyUsage.set(best.key, stamps);
      logToFile(`[Agnes key] ${label || '-'} use ${maskKeyLabel(best.key)} rpm=${stamps.length}/${AGNES_KEY_RPM_LIMIT}`);
      return best.key;
    }

    let oldest = now;
    for (const key of keys) {
      const stamps = agnesKeyUsage.get(key) || [];
      if (stamps.length && stamps[0] < oldest) oldest = stamps[0];
    }
    const waitMs = Math.max(500, Math.min(10000, AGNES_KEY_WINDOW_MS - (now - oldest) + 100));
    logToFile(`[Agnes key] ${label || '-'} all keys busy, wait ${waitMs}ms`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

function getAgnesErrorMessage(err) {
  return err?.response?.data?.error?.message
    || err?.response?.data?.message
    || err?.message
    || String(err || '');
}

async function postAgnesImageGenerationWithRetry({ apiBase, body, localId, label, maxRetries = 2 }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const apiKey = await acquireAgnesApiKey(`${label || 'agnes'}:${localId}:try${attempt + 1}`);
    try {
      if (attempt > 0) logToFile(`[Agnes retry] ${label || '-'} ${localId} retry ${attempt}/${maxRetries}`);
      const res = await axios.post(`${apiBase}/v1/images/generations`, body, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 600000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      if (attempt > 0) logToFile(`[Agnes retry] ${label || '-'} ${localId} success on attempt ${attempt + 1}`);
      return res;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status || 0;
      logError(`[Agnes retry] ${label || '-'} ${localId} attempt ${attempt + 1}/${maxRetries + 1} failed: ${status || '-'} ${getAgnesErrorMessage(err)}`);
      if (attempt >= maxRetries) break;
      const delay = Math.min(10000, 1500 * Math.pow(2, attempt));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

function hashPw(pw) { return crypto.createHash('md5').update(pw).digest('hex'); }
function genToken() { return crypto.randomBytes(32).toString('hex'); }

// Token store (in-memory for simplicity, persists via file)
const TOKENS_FILE = path.join(DATA_DIR, 'tokens.json');
function loadTokens() {
  if (!fs.existsSync(TOKENS_FILE)) { fs.writeFileSync(TOKENS_FILE, '{}'); return {}; }
  return readJsonFileSafe(TOKENS_FILE, {});
}
function saveTokens(t) { fs.writeFileSync(TOKENS_FILE, JSON.stringify(t)); }
let tokens = loadTokens();

// Auth middleware
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !tokens[token]) return res.status(401).json({ error: '未登录' });
  const user = tokens[token];
  const users = loadUsers();
  if (!users[user]) return res.status(401).json({ error: '用户不存在' });
  req.username = user;
  req.user = users[user];
  next();
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
    next();
  });
}

// ===== API Routes =====

// Register
app.post('/api/register', (req, res) => {
  const { username, password, inviteCode } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度2-20个字符' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少4个字符' });
  if (inviteCode !== INVITE_CODE) return res.status(400).json({ error: '邀请码错误' });

  const users = loadUsers();
  if (users[username]) return res.status(400).json({ error: '用户名已存在' });

  users[username] = {
    username,
    password: hashPw(password),
    role: 'user',
    enabled: false,
    createdAt: new Date().toISOString()
  };
  saveUsers(users);

  // Init balance
  const balances = loadBalances();
  balances[username] = { balance: 0, enabled: false };
  saveBalances(balances);

  // Init stats
  const stats = loadStats();
  stats[username] = { totalCalls: 0, successCalls: 0, lastCall: null, history: [] };
  saveStats(stats);

  const token = genToken();
  tokens[token] = username;
  saveTokens(tokens);

  res.json({ token, username, role: 'user' });
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const users = loadUsers();
  if (!users[username] || users[username].password !== hashPw(password)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = genToken();
  tokens[token] = username;
  saveTokens(tokens);
  res.json({ token, username, role: users[username].role });
});

// Get current user info
app.get('/api/me', auth, (req, res) => {
  const stats = loadStats();
  const balances = loadBalances();
  const bal = balances[req.username] || { balance: 0, enabled: false };
  const userStats = stats[req.username] || { totalCalls: 0, successCalls: 0 };
  res.json({ username: req.username, role: req.user.role, balance: bal.balance, enabled: bal.enabled, ...userStats });
});

app.post('/api/check-balance', auth, (req, res) => {
  const count = Math.max(1, Math.min(100, parseInt(req.body?.count, 10) || 1));
  const unitPrice = Number(req.body?.unitPrice || 0.025);
  const required = Math.round(count * unitPrice * 1000) / 1000;
  const balances = loadBalances();
  const bal = balances[req.username] || { balance: 0, enabled: false };
  if (!bal.enabled) return res.status(403).json({ ok: false, error: '账户已禁用，请联系管理员', balance: Number(bal.balance || 0), required });
  if (Number(bal.balance || 0) < required) {
    return res.status(402).json({
      ok: false,
      error: `余额不足(当前 ¥${Number(bal.balance || 0).toFixed(2)},本次 ¥${required.toFixed(3)}),请联系管理员充值`,
      balance: Number(bal.balance || 0),
      required,
    });
  }
  res.json({ ok: true, balance: Number(bal.balance || 0), required, remaining: Math.round((Number(bal.balance || 0) - required) * 1000) / 1000 });
});

// Logout
app.post('/api/logout', auth, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) { delete tokens[token]; saveTokens(tokens); }
  res.json({ success: true });
});

// Admin: set API key
app.post('/api/admin/apikey', adminAuth, (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'API Key 不能为空' });
  saveApiKey(apiKey);
  res.json({ success: true });
});

// Admin: set Zhenzhen API key
app.post('/api/admin/zhenzhen-apikey', adminAuth, (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: '贞贞令牌 不能为空' });
  saveZhenzhenApiKey(apiKey);
  res.json({ success: true });
});

// Admin: set Manxiaobai API key
app.post('/api/admin/manxiaobai-apikey', adminAuth, (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: '漫小白令牌 不能为空' });
  saveManxiaobaiApiKey(apiKey);
  res.json({ success: true });
});

// Admin: set Sub2 API key
app.post('/api/admin/sub2-apikey', adminAuth, (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'Sub2令牌 不能为空' });
  saveSub2ApiKey(apiKey);
  res.json({ success: true });
});

app.get('/api/admin/sub2-queue-config', adminAuth, (req, res) => {
  res.json({ success: true, config: loadSub2QueueConfig(), status: getSub2QueueStatus() });
});

app.post('/api/admin/sub2-queue-config', adminAuth, (req, res) => {
  const maxConcurrent = Number(req.body?.maxConcurrent);
  const timeoutSeconds = Number(req.body?.timeoutSeconds);
  if (!Number.isFinite(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 20) {
    return res.status(400).json({ error: '并发数请输入 1-20 之间的整数' });
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 3600) {
    return res.status(400).json({ error: '超时时间请输入 30-3600 秒之间的整数' });
  }
  const config = saveSub2QueueConfig({ maxConcurrent, timeoutSeconds });
  scheduleSub2QueueDrain();
  res.json({ success: true, config, status: getSub2QueueStatus() });
});

// Admin: set Agnes API key
app.post('/api/admin/agnes-apikey', adminAuth, (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'Agnes令牌 不能为空' });
  saveAgnesApiKey(apiKey);
  res.json({ success: true });
});

// Calculate totalSpent per user from generate-log.json
function calcTotalSpent() {
  const GENERATE_LOG_FILE = path.join(__dirname, 'logs', 'generate-log.json');
  if (!fs.existsSync(GENERATE_LOG_FILE)) return {};
  try {
    const log = JSON.parse(fs.readFileSync(GENERATE_LOG_FILE, 'utf8'));
    const spent = {};
    log.forEach(e => {
      if (e.status !== 'success' || !e.user) return;
      const m = e.model || 'gpt-image-2-sub2';
      const price = PRICING[m] || PRICING['gpt-image-2-sub2'];
      spent[e.user] = (spent[e.user] || 0) + price;
    });
    // Round to 3 decimals
    Object.keys(spent).forEach(k => { spent[k] = Math.round(spent[k] * 1000) / 1000; });
    return spent;
  } catch(e) { return {}; }
}

// Admin: get users and stats
app.get('/api/admin/users', adminAuth, (req, res) => {
  const users = loadUsers();
  const stats = loadStats();
  const balances = loadBalances();
  const totalSpent = calcTotalSpent();
  const list = Object.values(users).map(u => {
    const bal = balances[u.username] || { balance: 0, enabled: false };
    return {
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      balance: bal.balance,
      enabled: bal.enabled,
      totalCalls: stats[u.username]?.totalCalls || 0,
      successCalls: stats[u.username]?.successCalls || 0,
      lastCall: stats[u.username]?.lastCall || null,
      totalSpent: totalSpent[u.username] || 0,
    };
  });
  res.json({ users: list });
});

// Admin: create user
app.post('/api/admin/users', adminAuth, (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: '用户名和密码不能为空' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: '用户名长度2-20个字符' });
  if (password.length < 4) return res.status(400).json({ error: '密码至少4个字符' });

  const users = loadUsers();
  if (users[username]) return res.status(400).json({ error: '用户名已存在' });

  users[username] = {
    username,
    password: hashPw(password),
    role: 'user',
    enabled: false,
    createdAt: new Date().toISOString()
  };
  saveUsers(users);

  const balances = loadBalances();
  balances[username] = { balance: 0, enabled: false };
  saveBalances(balances);

  const stats = loadStats();
  stats[username] = { totalCalls: 0, successCalls: 0, lastCall: null, history: [] };
  saveStats(stats);

  res.json({ success: true, username });
});

// Admin: recharge user (positive=充值, negative=扣款)
app.post('/api/admin/users/:username/recharge', adminAuth, (req, res) => {
  const { amount } = req.body;
  const num = parseFloat(amount);
  if (isNaN(num) || num === 0) return res.status(400).json({ error: '充值金额无效' });

  const { username } = req.params;
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ error: '用户不存在' });

  const balances = loadBalances();
  if (!balances[username]) balances[username] = { balance: 0, enabled: false };
  const oldBalance = balances[username].balance;
  balances[username].balance = Math.round((balances[username].balance + num) * 100) / 100;
  saveBalances(balances);

  // Log recharge
  const logs = loadRechargeLogs();
  logs.unshift({
    id: 'rc_' + Date.now(),
    username,
    operator: req.username,
    amount: num,
    oldBalance,
    newBalance: balances[username].balance,
    createdAt: new Date().toISOString()
  });
  // Keep last 500
  if (logs.length > 500) logs.length = 500;
  saveRechargeLogs(logs);

  res.json({ success: true, balance: balances[username].balance });
});

// Admin: toggle user enable/disable
app.post('/api/admin/users/:username/toggle', adminAuth, (req, res) => {
  const { username } = req.params;
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ error: '用户不存在' });

  const balances = loadBalances();
  if (!balances[username]) balances[username] = { balance: 0, enabled: false };
  balances[username].enabled = !balances[username].enabled;
  saveBalances(balances);

  res.json({ success: true, enabled: balances[username].enabled });
});

// Admin: get user generation logs
app.get('/api/admin/users/:username/logs', adminAuth, (req, res) => {
  const { username } = req.params;
  const history = loadHistory();
  const rechargeLogs = loadRechargeLogs().filter(l => l.username === username);
  res.json({ history: history[username] || [], rechargeLogs });
});

// Admin: get all recharge logs
app.get('/api/admin/recharge-logs', adminAuth, (req, res) => {
  const logs = loadRechargeLogs();
  res.json({ logs });
});

// Admin: delete user
app.delete('/api/admin/users/:username', adminAuth, (req, res) => {
  const { username } = req.params;
  if (username === ADMIN_USERNAME) return res.status(400).json({ error: '不能删除管理员' });
  const users = loadUsers();
  if (!users[username]) return res.status(404).json({ error: '用户不存在' });
  delete users[username];
  saveUsers(users);
  // Remove tokens
  Object.keys(tokens).forEach(k => { if (tokens[k] === username) delete tokens[k]; });
  saveTokens(tokens);
  res.json({ success: true });
});

// Admin: reset user stats
app.post('/api/admin/users/:username/reset-stats', adminAuth, (req, res) => {
  const { username } = req.params;
  const stats = loadStats();
  if (stats[username]) {
    stats[username] = { totalCalls: 0, successCalls: 0, lastCall: null, history: [] };
    saveStats(stats);
  }
  res.json({ success: true });
});

// ===== Prompt Templates =====
app.get('/api/prompts', auth, (req, res) => {
  const prompts = loadPrompts();
  res.json({ prompts });
});

app.get('/api/admin/prompts', adminAuth, (req, res) => {
  const prompts = loadPrompts();
  res.json({ prompts });
});

app.post('/api/admin/prompts', adminAuth, (req, res) => {
  const { prompts } = req.body;
  if (!Array.isArray(prompts) || prompts.length === 0) {
    // Reset to defaults
    savePrompts(DEFAULT_PROMPTS);
    return res.json({ success: true, prompts: DEFAULT_PROMPTS });
  }
  savePrompts(prompts);
  res.json({ success: true, prompts });
});

// Chat (for conversation)
app.post('/api/chat', auth, async (req, res) => {
  const { messages, model } = req.body;
  const apiKey = getApiKey();
  if (!apiKey) return res.status(500).json({ error: '管理员尚未配置 API Key' });

  try {
    const response = await axios.post('https://www.6789api.top/v1/chat/completions', {
      model: model || 'gpt-4o',
      messages: [...messages],
      max_tokens: 4096,
      temperature: 0.7,
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 120000,
    });
    res.json(response.data);
  } catch (err) {
    logError(`Chat failed: ${err.response?.data?.error?.message || err.message}`);
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Resolve image source to { buffer, filename, mime }
async function resolveImage(img) {
  if (img && (img.startsWith('/uploads/') || img.startsWith('/results/'))) {
    const filePath = path.join(__dirname, img);
    if (fs.existsSync(filePath)) {
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return { buffer: buf, filename: path.basename(filePath), mime };
    }
  }
  if (img && img.startsWith('/archive/')) {
    const filePath = resolveArchiveImagePath(img);
    if (filePath && fs.existsSync(filePath)) {
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      return { buffer: buf, filename: path.basename(filePath), mime };
    }
  }
  // external URL
  if (img && (img.startsWith('http://') || img.startsWith('https://'))) {
    const resp = await axios.get(img, { responseType: 'arraybuffer' });
    const fname = img.split('/').pop().split('?')[0] || 'image.jpg';
    const mime = resp.headers['content-type'] || 'image/jpeg';
    return { buffer: Buffer.from(resp.data), filename: fname, mime };
  }
  // base64 data URI
  if (img && img.startsWith('data:')) {
    const match = img.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      const mime = match[1];
      const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg';
      return { buffer: Buffer.from(match[2], 'base64'), filename: `ref${ext}`, mime };
    }
  }
  return null;
}

// ===== 图片归档 =====

function resolveArchiveImagePath(img) {
  const rawPath = String(img || '').split('?')[0].split('#')[0];
  if (!rawPath.startsWith('/archive/')) return null;

  let parts;
  try {
    parts = rawPath.slice('/archive/'.length).split('/').filter(Boolean).map(decodeURIComponent);
  } catch (error) {
    return null;
  }

  if (!parts.length || parts.some(part => part === '.' || part === '..' || part.includes('/') || part.includes('\\'))) {
    return null;
  }

  const base = path.resolve(ARCHIVE_BASE);
  const filePath = path.resolve(ARCHIVE_BASE, ...parts);
  if (filePath === base || !filePath.startsWith(base + path.sep)) return null;
  return filePath;
}

function sanitizePathSegment(name) {
  return String(name || 'unknown').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'unknown';
}

function getArchiveDateStr(d) {
  return bjDate(d).replace(/-/g, '');
}

function buildArchiveDir(username, dateStr, category, batchId) {
  const parts = [ARCHIVE_BASE, sanitizePathSegment(username), sanitizePathSegment(dateStr)];
  if (category) parts.push(sanitizePathSegment(category));
  if (batchId) parts.push(sanitizePathSegment(batchId));
  return path.join(...parts);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getUniqueArchiveFilename(dir, filename) {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  let candidate = filename;
  let n = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base}-${n}${ext}`;
    n++;
  }
  return candidate;
}

function extFromBuffer(buf) {
  return buf[0] === 0xFF && buf[1] === 0xD8 ? 'jpg' : buf[0] === 0x89 ? 'png' : buf[0] === 0x52 ? 'webp' : 'png';
}

function formatDetailFileName(meta, index, ext) {
  const screenNo = meta?.screenNo || (index + 1);
  const title = sanitizePathSegment((meta?.screenName || `第${screenNo}屏`).replace(/^第\d+屏[_-]?/, '')) || '详情页';
  return `第${screenNo}屏_${title}.${ext}`;
}

function formatBuyerFileName(meta, index, ext) {
  const isExtend = meta?.archiveSubType === 'buyer-show-extend';
  const prefix = isExtend ? '拓展视角' : '买家秀';
  const no = meta?.itemNo || (index + 1);
  const itemName = Array.isArray(meta?.itemNames) ? meta.itemNames[index] : meta?.itemName;
  const title = itemName ? sanitizePathSegment(itemName) : '';
  if (isExtend) {
    const sourceNameRaw = Array.isArray(meta?.sourceNames) ? meta.sourceNames[index] : meta?.sourceName;
    const sourceName = sourceNameRaw ? sanitizePathSegment(sourceNameRaw) : '';
    const baseName = `${sourceName ? sourceName + '_' : ''}拓展视角${no}`;
    const safeTitle = /^拓展视角\d*$/.test(title) ? '' : title;
    return safeTitle ? `${baseName}_${safeTitle}.${ext}` : `${baseName}.${ext}`;
  }
  const safeTitle = title || `${prefix}${no}`;
  return `${prefix}${no}_${safeTitle}.${ext}`;
}

function getArchiveMeta(localId) {
  const log = loadGenerateLog();
  const entry = log.find(e => e.id === localId);
  return entry?.archiveMeta || null;
}

function getArchiveTarget(username, localId, index, buf, fallbackModelTag) {
  const meta = getArchiveMeta(localId) || {};
  const dateStr = getArchiveDateStr();
  const ext = extFromBuffer(buf);
  let dir;
  let filename;
  if (meta.archiveType === 'detail-replicate') {
    dir = buildArchiveDir(username, dateStr, '详情页生成', meta.batchId || localId);
    filename = formatDetailFileName(meta, index, ext);
  } else if (meta.archiveType === 'buyer-show') {
    dir = buildArchiveDir(username, dateStr, '买家秀生成', meta.batchId || localId);
    filename = formatBuyerFileName(meta, index, ext);
  } else {
    const modelTag = getModelShortName(fallbackModelTag || '');
    dir = buildArchiveDir(username, dateStr);
    filename = `${username}_${modelTag}_${Date.now()}${index ? '_' + index : ''}.${ext}`;
  }
  ensureDir(dir);
  if (meta.archiveType === 'detail-replicate' || meta.archiveType === 'buyer-show') {
    filename = getUniqueArchiveFilename(dir, filename);
  }
  return { dir, filename, dateStr };
}

function getArchiveCategory(meta) {
  if (!meta?.archiveType) return null;
  return meta.archiveType === 'detail-replicate' ? '详情页生成' : '买家秀生成';
}

function getArchiveBaseUrl(meta, username, dateStr, localId) {
  const base = '/archive/' + sanitizePathSegment(username) + '/' + sanitizePathSegment(dateStr);
  const category = getArchiveCategory(meta);
  const batchFolder = sanitizePathSegment(meta?.batchId || localId);
  if (!category) return base;
  return base + '/' + sanitizePathSegment(category) + '/' + batchFolder;
}

async function persistArchiveInputs(localId, username, prompt, images) {
  const meta = getArchiveMeta(localId) || {};
  if (meta.archiveType !== 'detail-replicate') return null;

  const dateStr = getArchiveDateStr();
  const dir = buildArchiveDir(username, dateStr, getArchiveCategory(meta), meta.batchId || localId);
  ensureDir(dir);

  const screenNo = meta.screenNo || 1;
  const title = sanitizePathSegment((meta.screenName || `第${screenNo}屏`).replace(/^第\d+屏[_-]?/, '')) || '详情页';
  const baseName = `第${screenNo}屏_${title}`;

  fs.writeFileSync(path.join(dir, `${baseName}_prompt.txt`), String(prompt || ''), 'utf8');

  const manifest = {
    localId,
    username,
    archiveType: meta.archiveType,
    batchId: meta.batchId || localId,
    screenNo,
    screenName: meta.screenName || `第${screenNo}屏`,
    savedAt: new Date().toISOString(),
    prompt: String(prompt || ''),
    inputs: [],
  };

  for (let i = 0; i < (images || []).length; i++) {
    const resolved = await resolveImage(images[i]);
    if (!resolved) continue;
    const ext = (path.extname(resolved.filename || '').replace(/^\./, '')) || extFromBuffer(resolved.buffer);
    const filename = `${baseName}_输入图${i + 1}.${ext}`;
    fs.writeFileSync(path.join(dir, filename), resolved.buffer);
    manifest.inputs.push({
      index: i + 1,
      source: images[i],
      savedAs: filename,
      originalName: resolved.filename || null,
      mime: resolved.mime || null,
    });
  }

  fs.writeFileSync(path.join(dir, `${baseName}_manifest.json`), JSON.stringify(manifest, null, 2), 'utf8');
  return manifest;
}

function recordGenerationMetric(username, meta) {
  const stats = loadStats();
  if (!stats[username]) stats[username] = { totalCalls: 0, successCalls: 0, lastCall: null, history: [], featureMetrics: {} };
  if (!stats[username].featureMetrics) stats[username].featureMetrics = {};
  const key = meta?.featureKey || 'default';
  if (!stats[username].featureMetrics[key]) {
    stats[username].featureMetrics[key] = { featureLabel: meta?.featureLabel || key, total: 0, success: 0, error: 0, totalDurationMs: 0, avgDurationMs: 0 };
  }
  const item = stats[username].featureMetrics[key];
  if (meta?.kind === 'submit') item.total++;
  if (meta?.kind === 'success') {
    item.success++;
    if (meta.durationMs > 0) {
      item.totalDurationMs += meta.durationMs;
      item.avgDurationMs = Math.round(item.totalDurationMs / item.success);
    }
  }
  if (meta?.kind === 'error') item.error++;
  saveStats(stats);
}

function getModelShortName(model) {
  const map = {
    'gpt-image-2': '贞贞接口',
    'gpt-image-2-flatfee': '6789接口',
    'gpt-image-2-manxiaobai': '漫小白接口',
    'gpt-image-2-1k': '漫小白接口',
    'gpt-image-2-2k': '漫小白接口',
    'gpt-image-2-4k': '漫小白接口',
    'gpt-image-2-sub2': 'Sub2接口',
    'agnes-image-2.1-flash': 'Agnes接口',
  };
  return map[model] || 'unknown';
}

// 根据 b64 前缀检测实际图片格式
function detectImageExt(b64) {
  const header = b64.substring(0, 8);
  if (header.startsWith('/9j/') || header.startsWith('iVBORw0K')) return 'png'; // JPEG starts with /9j/, but many APIs return as base64
  if (b64.substring(0, 4) === 'iVBO') return 'png';
  if (b64.substring(0, 4) === '/9j/') return 'jpg';
  if (b64.substring(0, 4) === 'UklG') return 'webp';
  return 'jpg'; // default
}

// 检测 b64 实际格式,返回扩展名
function getImageExtFromB64(b64) {
  try {
    const firstBytes = Buffer.from(b64.substring(0, 12), 'base64');
    if (firstBytes[0] === 0xFF && firstBytes[1] === 0xD8) return 'jpg';
    if (firstBytes[0] === 0x89 && firstBytes[1] === 0x50 && firstBytes[2] === 0x4E) return 'png';
    if (firstBytes[0] === 0x52 && firstBytes[1] === 0x49 && firstBytes[2] === 0x46) return 'webp';
  } catch(e) {}
  return 'jpg'; // default
}

async function downloadAndArchiveImage(url, username, model) {
  try {
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const modelTag = getModelShortName(model || '');
    const dir = path.join(ARCHIVE_BASE, username, dateStr);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const resp = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    const buf = Buffer.from(resp.data);
    const ext = buf[0] === 0xFF && buf[1] === 0xD8 ? 'jpg' : buf[0] === 0x89 ? 'png' : buf[0] === 0x52 ? 'webp' : 'jpg';
    const filename = `${username}_${modelTag}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(dir, filename), buf);
    logToFile(`  📦 Downloaded & archived → ${dir}/${filename}`);
    return `/archive/${username}/${dateStr}/${filename}`;
  } catch (e) {
    logError(`  Archive download failed for ${url}: ${e.message}`);
    return url; // fallback to original URL
  }
}

async function archiveResponseImages(responseData, username, model, options = {}) {
  if (!Array.isArray(responseData?.data)) return;
  for (let i = 0; i < responseData.data.length; i++) {
    const d = responseData.data[i];
    if (d.b64_json) {
      // 上游返回 base64 → 保存到本地归档,前端用本地路径
      const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const modelTag = getModelShortName(model || '');
      const buf = Buffer.from(d.b64_json, 'base64');
      const ext = buf[0] === 0xFF && buf[1] === 0xD8 ? 'jpg' : buf[0] === 0x89 ? 'png' : buf[0] === 0x52 ? 'webp' : 'jpg';
      let dir = path.join(ARCHIVE_BASE, username, dateStr);
      let filename = `${username}_${modelTag}_${Date.now()}${i ? '_' + i : ''}.${ext}`;
        let targetDateStr = dateStr;
        if (options.localId && getArchiveMeta(options.localId)?.archiveType) {
          const target = getArchiveTarget(username, options.localId, i, buf, model);
          dir = target.dir;
          filename = target.filename;
          targetDateStr = target.dateStr;
        } else {
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          filename = getUniqueArchiveFilename(dir, filename);
        }
        fs.writeFileSync(path.join(dir, filename), buf);
        const meta = options.localId ? getArchiveMeta(options.localId) : null;
        d.url = meta?.archiveType ? buildArchiveUrl(meta, username, targetDateStr, filename, options.localId) : `/archive/${username}/${dateStr}/${filename}`;
      delete d.b64_json;
      logToFile(`  💾 Saved b64_json → ${dir}/${filename}`);
    } else if (d.url && d.url.startsWith('http')) {
      // 上游返回 URL → 也下载到本地归档(备份),但前端仍用原始 URL
      try {
        const dateStr2 = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const modelTag2 = getModelShortName(model || '');
        const resp = await axios.get(d.url, { responseType: 'arraybuffer', timeout: 120000 });
        const buf = Buffer.from(resp.data);
        const ext = buf[0] === 0xFF && buf[1] === 0xD8 ? 'jpg' : buf[0] === 0x89 ? 'png' : buf[0] === 0x52 ? 'webp' : 'jpg';
        let dir2 = path.join(ARCHIVE_BASE, username, dateStr2);
        let filename = `${username}_${modelTag2}_${Date.now()}${i ? '_' + i : ''}.${ext}`;
        let targetDateStr2 = dateStr2;
        if (options.localId && getArchiveMeta(options.localId)?.archiveType) {
          const target = getArchiveTarget(username, options.localId, i, buf, model);
          dir2 = target.dir;
          filename = target.filename;
          targetDateStr2 = target.dateStr;
        } else {
          if (!fs.existsSync(dir2)) fs.mkdirSync(dir2, { recursive: true });
          filename = getUniqueArchiveFilename(dir2, filename);
        }
        fs.writeFileSync(path.join(dir2, filename), buf);
        const meta = options.localId ? getArchiveMeta(options.localId) : null;
        if (options.preferLocalUrl) d.url = meta?.archiveType ? buildArchiveUrl(meta, username, targetDateStr2, filename, options.localId) : `/archive/${username}/${dateStr2}/${filename}`;
        logToFile(`  📦 Archived URL → ${dir2}/${filename} (前端仍用原始URL)`);
      } catch (e) {
        logError(`  Archive download failed for ${d.url}: ${e.message}`);
      }
      // d.url 保持不变,前端用原始上游 URL
    }
  }
}

function stringifyCompactResponse(data, maxLen = 3000) {
  try {
    return JSON.stringify(data, (key, value) => {
      if (key === 'b64_json' && typeof value === 'string') return `[base64 omitted ${value.length} chars]`;
      return value;
    }).substring(0, maxLen);
  } catch (e) {
    return String(data || '').substring(0, maxLen);
  }
}

function extractDirectImageUrlCandidates(item) {
  if (!item || typeof item !== 'object') return [];
  return ['url', 'image_url', 'preview_image_url']
    .map(key => item[key])
    .filter(value => typeof value === 'string' && value.trim());
}

function extractImageResponseUrls(responseData) {
  const urls = new Set();
  const addFromList = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      for (const url of extractDirectImageUrlCandidates(item)) urls.add(url);
    }
  };

  addFromList(responseData?.data);
  addFromList(responseData?.result?.data);

  for (const url of extractDirectImageUrlCandidates(responseData)) urls.add(url);
  for (const url of extractDirectImageUrlCandidates(responseData?.result)) urls.add(url);

  return Array.from(urls);
}

function extractStoredImageUrls(responseData) {
  const urls = new Set();
  for (const url of extractImageResponseUrls(responseData)) urls.add(url);
  if (Array.isArray(responseData?.archiveUrls)) {
    for (const url of responseData.archiveUrls) if (url) urls.add(url);
  }
  if (Array.isArray(responseData?.archiveMeta?.savedResults)) {
    for (const url of responseData.archiveMeta.savedResults) if (url) urls.add(url);
  }
  return Array.from(urls);
}

function normalizeImageResponseUrls(responseData, baseUrl) {
  const normalizeObject = (item) => {
    if (!item || typeof item !== 'object') return;
    for (const key of ['url', 'image_url', 'preview_image_url']) {
      if (typeof item[key] === 'string' && item[key].startsWith('/')) {
        item[key] = baseUrl + item[key];
      }
    }
  };

  normalizeObject(responseData);
  normalizeObject(responseData?.result);

  if (Array.isArray(responseData?.data)) {
    for (const item of responseData.data) normalizeObject(item);
  }
  if (Array.isArray(responseData?.result?.data)) {
    for (const item of responseData.result.data) normalizeObject(item);
  }
}

function describeSub2ImageResponse(responseData) {
  const topLevelKeys = responseData && typeof responseData === 'object'
    ? Object.keys(responseData).slice(0, 20)
    : [];
  const dataKeys = Array.isArray(responseData?.data) && responseData.data[0] && typeof responseData.data[0] === 'object'
    ? Object.keys(responseData.data[0]).slice(0, 12)
    : [];
  const resultKeys = responseData?.result && typeof responseData.result === 'object'
    ? Object.keys(responseData.result).slice(0, 12)
    : [];
  const resultDataKeys = Array.isArray(responseData?.result?.data) && responseData.result.data[0] && typeof responseData.result.data[0] === 'object'
    ? Object.keys(responseData.result.data[0]).slice(0, 12)
    : [];
  const discoveredUrls = extractImageResponseUrls(responseData).slice(0, 8);
  return {
    topLevelKeys,
    hasDataArray: Array.isArray(responseData?.data),
    dataLength: Array.isArray(responseData?.data) ? responseData.data.length : 0,
    dataKeys,
    resultKeys,
    hasResultDataArray: Array.isArray(responseData?.result?.data),
    resultDataLength: Array.isArray(responseData?.result?.data) ? responseData.result.data.length : 0,
    resultDataKeys,
    discoveredUrls,
  };
}

function createSub2ImageResponseError(message, responseData, statusCode) {
  const err = new Error(message);
  err.sub2RawResponse = stringifyCompactResponse(responseData);
  err.sub2ResponseSummary = describeSub2ImageResponse(responseData);
  err.sub2StatusCode = statusCode || 0;
  return err;
}

async function runSub2SingleImageTask({ endpoint, prompt, images = [], size, quality, outputFormat, apiKey, username, localId, price, modelLabel }) {
  const SUB2_BASE = 'https://img.94576354.xyz';
  const isEdit = endpoint === 'edits';
  const FormData = require('form-data');

  createGenerateEntry({
    id: localId,
    user: username,
    model: modelLabel || 'gpt-image-2-sub2',
    prompt: prompt.substring(0, 300),
    imageCount: images.length,
    imagePaths: images,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: localId,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: null,
    taskType: 'sub2-single',
  });
  taskQueue.set(localId, { localId, provider: 'sub2-single', submittedAt: Date.now() });

  const finishWithError = (err) => {
    const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    logError(`Sub2 ${isEdit ? 'images/edits' : 'images/generations'} failed: ${errorMsg}`);
    const rawResponse = err.sub2RawResponse
      || (err.response?.data ? stringifyCompactResponse(err.response.data) : '');
    const responseSummary = err.sub2ResponseSummary || null;
    const statusCode = err.sub2StatusCode || err.response?.status || 0;
    updateGenerateEntry(localId, {
      status: 'error',
      completedAt: new Date().toISOString(),
      statusCode,
      error: errorMsg,
      rawResponse,
      responseSummary,
    });
    logApiResponse({
      id: localId,
      apiRequestId: localId,
      user: username,
      model: modelLabel || 'gpt-image-2-sub2',
      prompt: prompt.substring(0, 300),
      imageCount: images.length,
      imagePaths: images,
      status: 'error',
      statusCode,
      error: errorMsg,
      rawResponse,
      responseSummary,
    });
    taskQueue.delete(localId);
    refundGeneration(username, price || 0);
  };

  setImmediate(async () => {
    try {
      const sizeStr = size && size !== 'auto' ? size : '1024x1024';
      const finalQuality = quality && quality !== 'auto' ? quality : 'high';
      const format = outputFormat || 'png';
      let responseData;
      let statusCode;

      if (isEdit) {
        const form = new FormData();
        form.append('model', 'gpt-image-2');
        form.append('prompt', prompt);
        form.append('size', sizeStr);
        form.append('quality', finalQuality);
        form.append('output_format', format);
        form.append('n', '1');

        let resolvedImageCount = 0;
        for (const img of images) {
          const resolved = await resolveImage(img);
          if (resolved) {
            form.append('image', resolved.buffer, { filename: resolved.filename, contentType: resolved.mime });
            resolvedImageCount++;
          }
        }
        if (images.length > 0 && resolvedImageCount === 0) {
          throw new Error('参考图读取失败，请刷新页面后重试或重新上传图片');
        }

        logToFile(`Sub2 /v1/images/edits | user: ${username} | size: ${sizeStr} | images: ${images.length} | resolved: ${resolvedImageCount} | prompt: ${prompt.substring(0, 150)}`);
        const imgRes = await axiosWithRetry({
          method: 'post',
          url: `${SUB2_BASE}/v1/images/edits`,
          data: form,
          headers: { 'Authorization': `Bearer ${apiKey}`, ...form.getHeaders() },
          timeout: 600000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }, 'Sub2 images edits');
        responseData = imgRes.data;
        statusCode = imgRes.status;
      } else {
        const body = {
          model: 'gpt-image-2',
          prompt,
          size: sizeStr,
          quality: finalQuality,
          output_format: format,
          n: 1,
        };
        logToFile(`Sub2 /v1/images/generations | user: ${username} | size: ${sizeStr} | format: ${format} | prompt: ${prompt.substring(0, 150)}`);
        const imgRes = await axiosWithRetry({
          method: 'post',
          url: `${SUB2_BASE}/v1/images/generations`,
          data: body,
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 600000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        }, 'Sub2 images generations');
        responseData = imgRes.data;
        statusCode = imgRes.status;
      }

      normalizeImageResponseUrls(responseData, SUB2_BASE);
      await archiveResponseImages(responseData, username, modelLabel || 'gpt-image-2-sub2', { preferLocalUrl: true });
      const resultUrls = extractStoredImageUrls(responseData);
      if (!resultUrls.length) {
        const summary = describeSub2ImageResponse(responseData);
        const locationParts = [];
        if (summary.dataKeys.length) locationParts.push(`data keys: ${summary.dataKeys.join(', ')}`);
        if (summary.resultKeys.length) locationParts.push(`result keys: ${summary.resultKeys.join(', ')}`);
        if (summary.resultDataKeys.length) locationParts.push(`result.data keys: ${summary.resultDataKeys.join(', ')}`);
        if (!locationParts.length) locationParts.push(`top-level keys: ${summary.topLevelKeys.join(', ') || 'none'}`);
        throw createSub2ImageResponseError(
          `Sub2 已返回结果，但没有可用图片 URL (expected url/image_url/preview_image_url, ${locationParts.join('; ')})`,
          responseData,
          statusCode
        );
      }

      logApiResponse({
        id: localId,
        apiRequestId: localId,
        user: username,
        model: modelLabel || 'gpt-image-2-sub2',
        prompt: prompt.substring(0, 300),
        imageCount: images.length,
        imagePaths: images,
        status: 'success',
        statusCode,
        resultUrls,
        usage: responseData?.usage || null,
        rawResponse: stringifyCompactResponse(responseData),
      });

      updateGenerateEntry(localId, {
        status: 'success',
        completedAt: new Date().toISOString(),
        statusCode,
        resultUrls,
        archiveUrls: resultUrls,
        usage: responseData?.usage || null,
        rawResponse: stringifyCompactResponse(responseData),
      });
      markGenerationSuccess(username, localId);
      taskQueue.delete(localId);
      logToFile(`Sub2 single image completed | localId=${localId} | url=${resultUrls[0]}`);
    } catch (err) {
      finishWithError(err);
    }
  });

  return { taskId: localId, localId };
}

async function submitZhenzhenFeatureTask({ prompt, images, size, quality, apiKey, username, localId, archiveMeta }) {
  const imageArray = [];
  for (const img of images) {
    if (img.startsWith('data:') || img.startsWith('http')) {
      imageArray.push(img);
    } else {
      const resolved = await resolveImage(img);
      if (resolved) imageArray.push(`data:${resolved.mime};base64,${resolved.buffer.toString('base64')}`);
    }
  }

  const zhenzhenSize = resolveZhenzhenSize(size);
  const sizeStr = zhenzhenSize.upstreamSize;
  const promptSize = zhenzhenSize.promptSize;
  const body = {
    model: 'gpt-image-2',
    prompt: promptSize ? `${prompt} (Output size: ${promptSize})` : prompt,
    image: imageArray,
  };
  if (sizeStr) body.size = sizeStr;
  if (quality && quality !== 'auto') body.quality = quality;

  logToFile(`🖼️  贞贞 gpt-image-2 (异步特性) | user: ${username} | requested size: ${size || 'auto'} | upstream size: ${sizeStr || 'auto'} | quality: ${quality || 'auto'} | images: ${imageArray.length}`);

  const submitRes = await axios.post('https://ai.t8star.org/v1/images/generations?async=true', body, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
  const taskId = submitRes.data.data || submitRes.data.task_id;
  if (!taskId) throw new Error('未获取到 task_id: ' + JSON.stringify(submitRes.data).substring(0, 500));

  createGenerateEntry({
    id: localId,
    user: username,
    model: 'gpt-image-2',
    prompt: prompt.substring(0, 300),
    imageCount: images.length,
    imagePaths: images,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: taskId,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: JSON.stringify(submitRes.data).substring(0, 3000),
    archiveMeta: archiveMeta || null,
  });

  taskQueue.set(taskId, { taskId, username, apiKey, localId, startTime: Date.now() });
  pollZhenzhenTask(taskId, username, apiKey, localId).catch(err => {
    logError(`Background poll error for ${taskId}: ${err.message}`);
  });
  return { taskId, localId };
}

async function runOpenAICompatFeatureTask({ prompt, images, size, quality, apiKey, apiBase, modelName, username, localId, price, archiveMeta, multipart }) {
  createGenerateEntry({
    id: localId,
    user: username,
    model: modelName,
    prompt: prompt.substring(0, 300),
    imageCount: images.length,
    imagePaths: images,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: localId,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: null,
    archiveMeta: archiveMeta || null,
  });
  taskQueue.set(localId, { localId, provider: modelName, submittedAt: Date.now() });

  setImmediate(async () => {
    let upstreamPromptForLog = prompt;
    try {
      let imgRes;
      if (multipart) {
        const FormData = require('form-data');
        const form = new FormData();
        form.append('model', resolveManxiaobaiModel(size));
        form.append('prompt', prompt);
        if (size && size !== 'auto') form.append('size', size);
        if (quality && quality !== 'auto') form.append('quality', quality);
        const imageField = images.length > 1 ? 'image[]' : 'image';
        for (const img of images) {
          const resolved = await resolveImage(img);
          if (resolved) form.append(imageField, resolved.buffer, { filename: resolved.filename, contentType: resolved.mime });
        }
        imgRes = await axios.post(`${apiBase}/v1/images/edits`, form, {
          headers: { 'Authorization': `Bearer ${apiKey}`, ...form.getHeaders() },
          timeout: 300000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        });
      } else {
        const imageArray = [];
        for (const img of images) {
          if (img.startsWith('data:') || img.startsWith('http')) {
            imageArray.push(img);
          } else {
            const resolved = await resolveImage(img);
            if (resolved) imageArray.push(`data:${resolved.mime};base64,${resolved.buffer.toString('base64')}`);
          }
        }
        const isAgnes = modelName === 'agnes-image-2.1-flash';
        const sizeStr = isAgnes ? resolveAgnesSize(size) : (size && size !== 'auto' ? size : undefined);
        const body = {
          model: modelName,
          prompt: isAgnes ? prompt : (sizeStr ? `${prompt} (Output size: ${sizeStr})` : prompt),
        };
        upstreamPromptForLog = body.prompt;
        if (!isAgnes) body.image = imageArray;
        if (sizeStr) body.size = sizeStr;
        if (isAgnes) {
          body.extra_body = { image: imageArray, response_format: 'url' };
        }
        else if (quality && quality !== 'auto') body.quality = quality;
        if (isAgnes) {
          const first = imageArray[0] || '';
          logToFile(`  [Agnes img2img request] keys=${Object.keys(body).join(',')} size=${body.size} extraBodyImageArray=${imageArray.length} firstImage=${first.substring(0, 32)}... len=${first.length} response_format=${body.extra_body?.response_format}`);
        }
        imgRes = isAgnes
          ? await postAgnesImageGenerationWithRetry({ apiBase, body, localId, label: 'feature-img2img' })
          : await axios.post(`${apiBase}/v1/images/generations`, body, {
              headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
              timeout: 600000,
              maxContentLength: Infinity,
              maxBodyLength: Infinity,
            });
      }

      const responseData = imgRes.data;
      await archiveResponseImages(responseData, username, modelName, { preferLocalUrl: true, localId });
      const resultUrls = extractStoredImageUrls(responseData);
      if (!resultUrls.length) throw new Error(`${getModelShortName(modelName)} 已返回结果，但没有可用图片 URL`);

      logApiResponse({
        id: localId,
        apiRequestId: localId,
        user: username,
        model: modelName,
        prompt: prompt.substring(0, 300),
        upstreamPrompt: modelName === 'agnes-image-2.1-flash' ? upstreamPromptForLog.substring(0, 600) : undefined,
        imageCount: images.length,
        imagePaths: images,
        status: 'success',
        statusCode: imgRes.status,
        resultUrls,
        usage: responseData?.usage || null,
        rawResponse: stringifyCompactResponse(responseData),
      });
      updateGenerateEntry(localId, {
        status: 'success',
        completedAt: new Date().toISOString(),
        statusCode: imgRes.status,
        resultUrls,
        archiveUrls: resultUrls,
        archiveMeta: { ...(getArchiveMeta(localId) || archiveMeta || {}), savedResults: resultUrls },
        usage: responseData?.usage || null,
        rawResponse: stringifyCompactResponse(responseData),
      });
      markGenerationSuccess(username, localId);
      taskQueue.delete(localId);
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      logError(`${modelName} feature generate failed: ${errorMsg}`);
      logApiResponse({
        id: localId,
        apiRequestId: localId,
        user: username,
        model: modelName,
        prompt: prompt.substring(0, 300),
        upstreamPrompt: modelName === 'agnes-image-2.1-flash' ? upstreamPromptForLog.substring(0, 600) : undefined,
        imageCount: images?.length || 0,
        imagePaths: images || [],
        status: 'error',
        statusCode: err.response?.status || 0,
        error: errorMsg,
        rawResponse: err.response?.data ? stringifyCompactResponse(err.response.data) : '',
      });
      updateGenerateEntry(localId, {
        status: 'error',
        completedAt: new Date().toISOString(),
        statusCode: err.response?.status || 0,
        error: errorMsg,
        rawResponse: err.response?.data ? stringifyCompactResponse(err.response.data) : '',
      });
      refundGeneration(username, price || 0);
      taskQueue.delete(localId);
    }
  });

  return { taskId: localId, localId };
}

async function submitFeatureImageTask({ prompt, images, size, quality, username, localId, modelName, archiveMeta }) {
  const config = resolveImageModelConfig(modelName);
  if (!config.apiKey) {
    const err = new Error(`管理员尚未配置 ${config.keyLabel}`);
    err.statusCode = 500;
    throw err;
  }
  const price = config.model === 'gpt-image-2-manxiaobai' ? resolveManxiaobaiPrice(size) : getPrice(config.model);
  chargeGeneration(username, price);

  try {
    if (config.model === 'gpt-image-2-sub2') {
      return await submitSub2BatchTask({
        prompt,
        images,
        size,
        quality,
        apiKey: config.apiKey,
        username,
        localId,
        price,
        modelLabel: config.model,
        archiveMeta,
      });
    }
    if (config.model === 'gpt-image-2') {
      return await submitZhenzhenFeatureTask({ prompt, images, size, quality, apiKey: config.apiKey, username, localId, archiveMeta });
    }
    return await runOpenAICompatFeatureTask({
      prompt,
      images,
      size,
      quality,
      apiKey: config.apiKey,
      apiBase: config.apiBase,
      modelName: config.model,
      username,
      localId,
      price,
      archiveMeta,
      multipart: config.model === 'gpt-image-2-manxiaobai',
    });
  } catch (error) {
    refundGeneration(username, price);
    throw error;
  }
}

async function submitZhenzhenTextImageTask({ prompt, size, quality, apiKey, username, localId }) {
  const zhenzhenSize = resolveZhenzhenSize(size);
  const sizeStr = zhenzhenSize.upstreamSize;
  const promptSize = zhenzhenSize.promptSize;
  const body = {
    model: 'gpt-image-2',
    prompt: promptSize ? `${prompt} (Output size: ${promptSize})` : prompt,
  };
  if (sizeStr) body.size = sizeStr;
  if (quality && quality !== 'auto') body.quality = quality;

  logToFile(`🖼️  贞贞 gpt-image-2 (异步文生图) | user: ${username} | requested size: ${size || 'auto'} | upstream size: ${sizeStr || 'auto'} | quality: ${quality || 'auto'}`);

  const submitRes = await axios.post('https://ai.t8star.org/v1/images/generations?async=true', body, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: 30000,
  });
  const taskId = submitRes.data.data || submitRes.data.task_id;
  if (!taskId) throw new Error('未获取到 task_id: ' + JSON.stringify(submitRes.data).substring(0, 500));

  createGenerateEntry({
    id: localId,
    user: username,
    model: 'gpt-image-2',
    prompt: prompt.substring(0, 300),
    imageCount: 0,
    imagePaths: [],
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: taskId,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: JSON.stringify(submitRes.data).substring(0, 3000),
  });

  taskQueue.set(taskId, { taskId, username, apiKey, localId, startTime: Date.now() });
  pollZhenzhenTask(taskId, username, apiKey, localId).catch(err => {
    logError(`Background poll error for ${taskId}: ${err.message}`);
  });
  return { taskId, localId };
}

async function runOpenAICompatTextImageTask({ prompt, size, quality, apiKey, apiBase, modelName, username, localId, price, outputFormat }) {
  createGenerateEntry({
    id: localId,
    user: username,
    model: modelName,
    prompt: prompt.substring(0, 300),
    imageCount: 0,
    imagePaths: [],
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: localId,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: null,
  });
  taskQueue.set(localId, { localId, provider: modelName, submittedAt: Date.now() });

  setImmediate(async () => {
    let upstreamPromptForLog = prompt;
    try {
      const upstreamModel = modelName === 'gpt-image-2-manxiaobai' ? resolveManxiaobaiModel(size) : modelName;
      const isAgnes = modelName === 'agnes-image-2.1-flash';
      const body = {
        model: upstreamModel,
        prompt,
      };
      upstreamPromptForLog = body.prompt;
      if (isAgnes) {
        body.size = resolveAgnesSize(size);
        body.extra_body = { response_format: 'url' };
      } else {
        if (size && size !== 'auto') body.size = size;
        if (quality && quality !== 'auto') body.quality = quality;
        if (outputFormat) body.output_format = outputFormat;
      }

      logToFile(`🖼️  文生图 ${modelName} | user: ${username} | size: ${size || 'auto'}${isAgnes ? ' | upstream size: ' + body.size : ''} | prompt: ${prompt.substring(0, 150)}`);
      const imgRes = isAgnes
        ? await postAgnesImageGenerationWithRetry({ apiBase, body, localId, label: 'txt2img' })
        : await axios.post(`${apiBase}/v1/images/generations`, body, {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 600000,
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
          });

      const responseData = imgRes.data;
      await archiveResponseImages(responseData, username, modelName, { preferLocalUrl: true, localId });
      const resultUrls = extractStoredImageUrls(responseData);
      if (!resultUrls.length) throw new Error(`${getModelShortName(modelName)} 文生图已返回结果，但没有可用图片 URL`);

      logApiResponse({
        id: localId,
        apiRequestId: localId,
        user: username,
        model: modelName,
        prompt: prompt.substring(0, 300),
        upstreamPrompt: isAgnes ? upstreamPromptForLog.substring(0, 600) : undefined,
        imageCount: 0,
        imagePaths: [],
        status: 'success',
        statusCode: imgRes.status,
        resultUrls,
        usage: responseData?.usage || null,
        rawResponse: stringifyCompactResponse(responseData),
      });
      updateGenerateEntry(localId, {
        status: 'success',
        completedAt: new Date().toISOString(),
        statusCode: imgRes.status,
        resultUrls,
        archiveUrls: resultUrls,
        usage: responseData?.usage || null,
        rawResponse: stringifyCompactResponse(responseData),
      });
      markGenerationSuccess(username, localId);
      taskQueue.delete(localId);
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      logError(`${modelName} txt2img failed: ${errorMsg}`);
      logApiResponse({
        id: localId,
        apiRequestId: localId,
        user: username,
        model: modelName,
        prompt: prompt.substring(0, 300),
        upstreamPrompt: modelName === 'agnes-image-2.1-flash' ? upstreamPromptForLog.substring(0, 600) : undefined,
        imageCount: 0,
        imagePaths: [],
        status: 'error',
        statusCode: err.response?.status || 0,
        error: errorMsg,
        rawResponse: err.response?.data ? stringifyCompactResponse(err.response.data) : '',
      });
      updateGenerateEntry(localId, {
        status: 'error',
        completedAt: new Date().toISOString(),
        statusCode: err.response?.status || 0,
        error: errorMsg,
        rawResponse: err.response?.data ? stringifyCompactResponse(err.response.data) : '',
      });
      refundGeneration(username, price || 0);
      taskQueue.delete(localId);
    }
  });

  return { taskId: localId, localId };
}

async function submitAgnesImageTask({ prompt, images, size, apiKey, apiBase, username, localId, price }) {
  createGenerateEntry({
    id: localId,
    user: username,
    model: 'agnes-image-2.1-flash',
    prompt: prompt.substring(0, 300),
    imageCount: images.length,
    imagePaths: images,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: localId,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: null,
  });
  taskQueue.set(localId, { localId, provider: 'agnes-image-2.1-flash', submittedAt: Date.now() });

  setImmediate(async () => {
    let upstreamPromptForLog = prompt;
    try {
      const imageArray = [];
      for (const img of images) {
        if (img.startsWith('data:') || img.startsWith('http')) {
          imageArray.push(img);
        } else {
          const resolved = await resolveImage(img);
          if (resolved) imageArray.push(`data:${resolved.mime};base64,${resolved.buffer.toString('base64')}`);
        }
      }

      const sizeStr = resolveAgnesSize(size);
      const body = {
        model: 'agnes-image-2.1-flash',
        prompt,
        size: sizeStr,
        extra_body: { image: imageArray, response_format: 'url' },
      };
      upstreamPromptForLog = body.prompt;

      logToFile(`🖼️  Agnes agnes-image-2.1-flash (async JSON) | user: ${username} | size: ${size || 'auto'} | upstream size: ${sizeStr} | imageArray: ${imageArray.length} | prompt: ${prompt.substring(0, 150)}`);
      const first = imageArray[0] || '';
      logToFile(`  [Agnes img2img request] keys=${Object.keys(body).join(',')} size=${body.size} extraBodyImageArray=${imageArray.length} firstImage=${first.substring(0, 32)}... len=${first.length} response_format=${body.extra_body?.response_format}`);

      const imgRes = await postAgnesImageGenerationWithRetry({ apiBase, body, localId, label: 'img2img' });

      const responseData = imgRes.data;
      await archiveResponseImages(responseData, username, 'agnes-image-2.1-flash', { preferLocalUrl: true, localId });
      const resultUrls = extractStoredImageUrls(responseData);
      if (!resultUrls.length) throw new Error('Agnes接口 已返回结果，但没有可用图片 URL');

      logApiResponse({
        id: localId,
        apiRequestId: localId,
        user: username,
        model: 'agnes-image-2.1-flash',
        prompt: prompt.substring(0, 300),
        upstreamPrompt: upstreamPromptForLog.substring(0, 600),
        imageCount: images.length,
        imagePaths: images,
        status: 'success',
        statusCode: imgRes.status,
        resultUrls,
        usage: responseData?.usage || null,
        rawResponse: stringifyCompactResponse(responseData),
      });
      updateGenerateEntry(localId, {
        status: 'success',
        completedAt: new Date().toISOString(),
        statusCode: imgRes.status,
        resultUrls,
        archiveUrls: resultUrls,
        usage: responseData?.usage || null,
        rawResponse: stringifyCompactResponse(responseData),
      });
      markGenerationSuccess(username, localId);
      taskQueue.delete(localId);
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      logError(`Agnes async generate failed: ${errorMsg}`);
      logApiResponse({
        id: localId,
        apiRequestId: localId,
        user: username,
        model: 'agnes-image-2.1-flash',
        prompt: prompt.substring(0, 300),
        upstreamPrompt: upstreamPromptForLog.substring(0, 600),
        imageCount: images?.length || 0,
        imagePaths: images || [],
        status: 'error',
        statusCode: err.response?.status || 0,
        error: errorMsg,
        rawResponse: err.response?.data ? stringifyCompactResponse(err.response.data) : '',
      });
      updateGenerateEntry(localId, {
        status: 'error',
        completedAt: new Date().toISOString(),
        statusCode: err.response?.status || 0,
        error: errorMsg,
        rawResponse: err.response?.data ? stringifyCompactResponse(err.response.data) : '',
      });
      refundGeneration(username, price || 0);
      taskQueue.delete(localId);
    }
  });

  return { taskId: localId, localId };
}

async function submitTextImageTask({ prompt, size, quality, outputFormat, username, localId, modelName }) {
  const config = resolveImageModelConfig(modelName);
  if (!config.apiKey) {
    const err = new Error(`管理员尚未配置 ${config.keyLabel}`);
    err.statusCode = 500;
    throw err;
  }
  const price = config.model === 'gpt-image-2-manxiaobai' ? resolveManxiaobaiPrice(size) : getPrice(config.model);
  chargeGeneration(username, price);

  try {
    if (config.model === 'gpt-image-2-sub2') {
      return await submitSub2BatchTask({
        prompt,
        images: [],
        size,
        quality,
        apiKey: config.apiKey,
        username,
        localId,
        price,
        modelLabel: config.model,
      });
    }
    if (config.model === 'gpt-image-2') {
      return await submitZhenzhenTextImageTask({ prompt, size, quality, apiKey: config.apiKey, username, localId });
    }
    return await runOpenAICompatTextImageTask({
      prompt,
      size,
      quality,
      outputFormat,
      apiKey: config.apiKey,
      apiBase: config.apiBase,
      modelName: config.model,
      username,
      localId,
      price,
    });
  } catch (error) {
    refundGeneration(username, price);
    throw error;
  }
}

// Task queue for async polling (in-memory, resets on restart)
const taskQueue = new Map();
// Sub2 task queue
const sub2TaskQueue = new Map();
const intentTaskQueue = new Map();
const sub2BackgroundPollers = new Map();
const sub2SubmitQueue = [];
const sub2QueueJobs = new Map();
const sub2AggregateTasks = new Map();
const sub2QueueState = { running: 0, draining: false, processing: false };

function getSub2QueueLimit() {
  return loadSub2QueueConfig().maxConcurrent || 3;
}

function getSub2QueueStatus() {
  const runningJobs = Array.from(sub2QueueJobs.values()).filter(job => job.status === 'running').length;
  const queuedJobs = sub2SubmitQueue.filter(job => job.status === 'queued').length;
  return {
    maxConcurrent: getSub2QueueLimit(),
    running: Math.max(sub2QueueState.running, runningJobs),
    queued: queuedJobs,
    activeTasks: sub2TaskQueue.size,
    aggregateTasks: sub2AggregateTasks.size,
    timeoutSeconds: Math.round(loadSub2QueueConfig().runningTimeoutMs / 1000),
  };
}

function scheduleSub2QueueDrain() {
  if (sub2QueueState.draining) return;
  sub2QueueState.draining = true;
  setImmediate(() => {
    sub2QueueState.draining = false;
    drainSub2Queue();
  });
}

function enqueueSub2Job(job) {
  job.status = 'queued';
  job.enqueuedAt = Date.now();
  sub2QueueJobs.set(job.localId, job);
  sub2SubmitQueue.push(job);
  updateGenerateEntry(job.localId, {
    status: 'pending',
    queueStatus: 'queued',
    queuePosition: sub2SubmitQueue.filter(x => x.status === 'queued').length,
  });
  logToFile(`Sub2 queued | localId=${job.localId} | user=${job.username} | queued=${sub2SubmitQueue.length} | running=${sub2QueueState.running}/${getSub2QueueLimit()}`);
  scheduleSub2QueueDrain();
  return { taskId: job.localId, localId: job.localId };
}

function drainSub2Queue() {
  if (sub2QueueState.processing) return;
  sub2QueueState.processing = true;
  const limit = getSub2QueueLimit();
  try {
    while (sub2QueueState.running < limit) {
      const job = sub2SubmitQueue.shift();
      if (!job) break;
      if (job.status !== 'queued') continue;
      job.status = 'running';
      job.startedAt = Date.now();
      sub2QueueState.running++;
      updateGenerateEntry(job.localId, { queueStatus: 'running', queueStartedAt: new Date().toISOString() });
      processQueuedSub2Job(job).catch(err => {
        const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
        failSub2LocalTask(job.localId, job, errorMsg, err.response?.data ? JSON.stringify(err.response.data).substring(0, 3000) : '');
        releaseSub2QueueSlot(job.localId);
      });
    }
  } finally {
    sub2QueueState.processing = false;
  }
}

function releaseSub2QueueSlot(localId) {
  const job = sub2QueueJobs.get(localId);
  if (!job || job._slotReleased) return;
  job._slotReleased = true;
  sub2QueueJobs.delete(localId);
  if (sub2QueueState.running > 0) sub2QueueState.running--;
  scheduleSub2QueueDrain();
}

function failSub2LocalTask(localId, taskInfo, errorMsg, rawResponse) {
  updateGenerateEntry(localId, {
    status: 'error',
    completedAt: new Date().toISOString(),
    queueStatus: 'done',
    error: errorMsg || 'Sub2 任务失败',
    rawResponse: rawResponse || '',
  });
  if (taskInfo && !taskInfo._refunded) {
    refundGenerateEntryOnce(localId, taskInfo.username, taskInfo.price || 0);
    taskInfo._refunded = true;
  }
  updateSub2AggregateTask(taskInfo?.queueParentId);
}

function markSub2TaskTerminal(taskId, taskInfo) {
  if (taskId) sub2TaskQueue.delete(taskId);
  releaseSub2QueueSlot(taskInfo?.localId);
  updateSub2AggregateTask(taskInfo?.queueParentId);
}

function markStalePendingSub2Entries() {
  const log = loadGenerateLog();
  const timeoutMs = loadSub2QueueConfig().runningTimeoutMs;
  const now = Date.now();
  let changed = false;
  for (const entry of log) {
    if (!entry || entry.status !== 'pending' || !isSub2StatsEntry(entry)) continue;
    if (Array.isArray(entry.childTaskIds) && entry.childTaskIds.length > 0) continue;
    if (getOutputImageCount(entry) > 0) continue;
    const started = new Date(entry.queueStartedAt || entry.submittedAt || 0).getTime();
    if (!started || !Number.isFinite(started) || now - started <= timeoutMs) continue;
    entry.status = 'error';
    entry.completedAt = new Date(now).toISOString();
    entry.queueStatus = 'done';
    entry.error = `Sub2 任务超过 ${Math.round(timeoutMs / 60000)} 分钟未返回图片，已自动标记失败`;
    if (!entry._refundApplied) {
      finalizeTaskRefund(entry, getPrice(entry.model || 'gpt-image-2-sub2'));
    }
    changed = true;
  }
  if (changed) saveGenerateLog(log);
  return changed;
}

async function processQueuedSub2Job(job) {
  const SUB2_BASE = 'https://img.94576354.xyz';
  const FormData = require('form-data');
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', job.prompt);
  if (job.size && job.size !== 'auto') form.append('size', job.size);
  if (job.quality && job.quality !== 'auto') form.append('quality', job.quality);
  form.append('output_format', 'png');
  form.append('count', '1');
  form.append('batch_concurrency', '1');

  let resolvedImageCount = 0;
  for (const img of (job.images || [])) {
    const resolved = await resolveImage(img);
    if (resolved) {
      form.append('image', resolved.buffer, { filename: resolved.filename, contentType: resolved.mime });
      resolvedImageCount++;
    }
  }
  if ((job.images || []).length > 0 && resolvedImageCount === 0) {
    throw new Error('参考图读取失败，请刷新页面后重试或重新上传图片');
  }

  const idempotencyKey = job.idempotencyKey || ('img2img-' + job.localId);
  logToFile('Sub2 queued submit batch-image-tasks | user: ' + job.username + ' | localId=' + job.localId + ' | size: ' + (job.size || 'auto') + ' | images: ' + (job.images || []).length + ' | resolved: ' + resolvedImageCount + ' | idem: ' + idempotencyKey + ' | prompt: ' + job.prompt.substring(0, 150));
  const submitRes = await axiosWithRetry({
    method: 'post',
    url: SUB2_BASE + '/batch-image-tasks',
    data: form,
    headers: {
      'Authorization': 'Bearer ' + job.apiKey,
      'Idempotency-Key': idempotencyKey,
      ...form.getHeaders(),
    },
    timeout: 120000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  }, 'Sub2 queued batch submit');

  const taskData = submitRes.data;
  const taskId = taskData.task_id;
  if (!taskId) throw new Error('未获取到 task_id: ' + JSON.stringify(taskData).substring(0, 500));

  updateGenerateEntry(job.localId, { apiRequestId: taskId, queueStatus: 'running', rawResponse: JSON.stringify(taskData).substring(0, 3000) });
  sub2TaskQueue.set(taskId, {
    localId: job.localId,
    username: job.username,
    prompt: job.prompt,
    images: job.images,
    size: job.size,
    quality: job.quality,
    apiKey: job.apiKey,
    price: job.price,
    modelLabel: job.modelLabel,
    archiveMeta: job.archiveMeta || null,
    submittedAt: Date.now(),
    queueParentId: job.queueParentId || null,
    expectedCount: 1,
  });
  logToFile('  [Sub2 queued] task submitted, localId=' + job.localId + ', task_id=' + taskId);
  scheduleSub2BackgroundPoll(taskId);
}

function isRetryableNetworkError(err) {
  const code = err && (err.code || err.cause?.code);
  const status = err?.response?.status;
  return ['EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED'].includes(code) || status === 429 || (status >= 500 && status < 600);
}

async function axiosWithRetry(config, label, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await axios(config);
    } catch (err) {
      lastErr = err;
      if (!isRetryableNetworkError(err) || i === attempts - 1) break;
      const delay = Math.min(30000, 1200 * Math.pow(2, i));
      logToFile(`[retry] ${label || config.url} failed (${err.code || err.response?.status || err.message}), retry ${i + 1}/${attempts - 1} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

// ===== 异步任务轮询器:轮询贞贞 API 任务状态 =====
async function pollZhenzhenTask(taskId, username, apiKey, localId) {
  const MAX_POLLING_ATTEMPTS = 60; // 5 minutes (5s * 60 = 300s)
  const POLL_INTERVAL = 5000;

  for (let attempt = 0; attempt < MAX_POLLING_ATTEMPTS; attempt++) {
    try {
      const taskRes = await axios.get(`https://ai.t8star.org/v1/images/tasks/${taskId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeout: 30000,
      });

      const taskData = taskRes.data;
      // 响应格式:{ code, message, data: { status, fail_reason, data: { data: [...] } } }
      // 注意:FAILURE 时 data 为 null,需要从外层提取状态
      const inner = (typeof taskData === 'object' && taskData.data) ? taskData.data : taskData;
      const status = inner.status || taskData.status || 'UNKNOWN';
      const failReason = inner.fail_reason || taskData.fail_reason || '';
      logToFile(`👀 polling ${taskId} attempt ${attempt + 1}: status=${status}, progress=${inner.progress || '-'}${failReason ? ' | fail: ' + failReason.substring(0, 100) : ''}`);

      const resultUrls = Array.isArray(inner.data?.data)
        ? inner.data.data.map(d => d.url).filter(Boolean)
        : [];

      // Update generate-log entry with latest status
      updateGenerateEntry(localId, {
        apiRequestId: taskId,
        status: status === 'SUCCESS' ? 'success' : (status === 'FAILURE' ? 'error' : 'pending'),
        statusCode: taskRes.status,
        usage: inner.data?.usage || null,
        rawResponse: JSON.stringify(taskData).substring(0, 3000),
        resultUrls,
      });

      if (status === 'SUCCESS') {
        // Task completed successfully
        // Download and archive images
        if (resultUrls.length > 0 && inner.data) {
          await archiveResponseImages(inner.data, username, 'gpt-image-2', { preferLocalUrl: true, localId });
        }
        const storedUrls = extractStoredImageUrls(inner.data || {});

        logApiResponse({
          id: localId,
          user: username,
          model: 'gpt-image-2',
          prompt: '',
          imageCount: resultUrls.length,
          imagePaths: [],
          status: 'success',
          statusCode: taskRes.status,
          resultUrls: storedUrls.length ? storedUrls : resultUrls,
          usage: inner.data?.usage || null,
          rawResponse: JSON.stringify(taskData).substring(0, 3000),
        });

        updateGenerateEntry(localId, {
          status: 'success',
          completedAt: new Date().toISOString(),
          resultUrls: storedUrls.length ? storedUrls : resultUrls,
          archiveUrls: storedUrls.length ? storedUrls : resultUrls,
          archiveMeta: { ...(getArchiveMeta(localId) || {}), savedResults: storedUrls.length ? storedUrls : resultUrls },
        });

        markGenerationSuccess(username, localId);

        taskQueue.delete(taskId);
        return { success: true, resultUrls: storedUrls.length ? storedUrls : resultUrls };
      } else if (status === 'FAILURE') {
        const errorMsg = inner.fail_reason || 'Task failed';
        logError(`异步任务失败 ${taskId}: ${errorMsg}`);

        logApiResponse({
          id: localId,
          user: username,
          model: 'gpt-image-2',
          prompt: '',
          imageCount: 0,
          imagePaths: [],
          status: 'error',
          error: errorMsg,
          statusCode: 200,
          rawResponse: JSON.stringify(taskData).substring(0, 3000),
        });

        updateGenerateEntry(localId, {
          status: 'error',
          completedAt: new Date().toISOString(),
          error: errorMsg,
        });
        refundGenerateEntryOnce(localId, username, getPrice('gpt-image-2'));

        taskQueue.delete(taskId);
        return { success: false, error: errorMsg };
      } else {
        // Still pending/running (IN_PROGRESS), wait and retry
        if (attempt < MAX_POLLING_ATTEMPTS - 1) {
          await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
        }
      }
    } catch (err) {
      logError(`Polling ${taskId} failed at attempt ${attempt + 1}: ${err.message}`);
      updateGenerateEntry(localId, {
        status: 'error',
        error: `轮询失败: ${err.message}`,
      });
      refundGenerateEntryOnce(localId, username, getPrice('gpt-image-2'));
      taskQueue.delete(taskId);
      return { success: false, error: err.message };
    }
  }

  // Max polling attempts exceeded
  logError(`Polling timeout for ${taskId}`);
  updateGenerateEntry(localId, {
    status: 'error',
    error: '任务超时,请重试',
  });
  refundGenerateEntryOnce(localId, username, getPrice('gpt-image-2'));
  taskQueue.delete(taskId);
  return { success: false, error: '超时' };
}

// Legacy Sub2 /image-tasks poller kept only for old pending tasks.
async function pollSub2Task(taskId, apiKey, username, localId) {
  const SUB2_BASE = 'https://img.94576354.xyz';
  const MAX_ATTEMPTS = 120; // 10 minutes
  const POLL_INTERVAL = 5000;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const pollRes = await axios.get(`${SUB2_BASE}/image-tasks/${taskId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` },
        timeout: 10000,
      });

      const pollData = pollRes.data;
      const status = pollData.status;
      logToFile(`  [Sub2] poll ${attempt + 1}: status=${status}`);

      if (status === 'completed') {
        const imageUrl = pollData.image_url || pollData.preview_image_url;
        if (imageUrl && !imageUrl.startsWith('http')) {
          return { success: true, imageUrl: `${SUB2_BASE}${imageUrl}` };
        } else if (imageUrl) {
          return { success: true, imageUrl };
        }
        throw new Error('completed but no image_url');
      } else if (status === 'failed') {
        const errorMsg = pollData.error?.message || 'Sub2 task failed';
        throw new Error(errorMsg);
      }

      // status === 'queued' 或 'processing', 继续轮询
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
      }
    } catch (err) {
      logError(`Poll Sub2 task ${taskId} failed: ${err.message}`);
      throw err;
    }
  }

  throw new Error('Sub2 任务超时');
}
async function handleSub2Generate(req, res, opts) {
  const { prompt, images, size, quality, apiKey, username, localId, price } = opts;
  const SUB2_BASE = 'https://img.94576354.xyz';
  const FormData = require('form-data');

  createGenerateEntry({
    id: localId,
    user: username,
    model: 'gpt-image-2-sub2',
    prompt: prompt.substring(0, 300),
    imageCount: images.length,
    imagePaths: images,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: null,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: null,
    archiveMeta: archiveMeta || null,
  });

  try {
    const form = new FormData();
    form.append('model', 'gpt-image-2');
    form.append('prompt', prompt);
    if (size && size !== 'auto') form.append('size', size);
    if (quality && quality !== 'auto') form.append('quality', quality);
    form.append('output_format', 'png');
    form.append('count', '1');
    form.append('batch_concurrency', '1');

    for (const img of images) {
      const resolved = await resolveImage(img);
      if (resolved) {
        form.append('image', resolved.buffer, { filename: resolved.filename, contentType: resolved.mime });
      }
    }

    const idempotencyKey = 'img2img-' + localId;
    logToFile('Sub2 gpt-image-2 (batch-image-tasks) | user: ' + username + ' | size: ' + (size || 'auto') + ' | images: ' + images.length + ' | idem: ' + idempotencyKey + ' | prompt: ' + prompt.substring(0, 150));

    const submitRes = await axiosWithRetry({
      method: 'post',
      url: SUB2_BASE + '/batch-image-tasks',
      data: form,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Idempotency-Key': idempotencyKey,
        ...form.getHeaders(),
      },
      timeout: 120000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }, 'Sub2 batch submit');

    const taskData = submitRes.data;
    const taskId = taskData.task_id;
    if (!taskId) throw new Error('未获取到 task_id: ' + JSON.stringify(taskData).substring(0, 500));

    updateGenerateEntry(localId, { apiRequestId: taskId, rawResponse: JSON.stringify(taskData).substring(0, 3000) });
    logToFile('  [Sub2 batch] task submitted, task_id: ' + taskId);

    const MAX_ATTEMPTS = 180;
    const POLL_INTERVAL = 5000;
    let finalTaskData = null;
    let readyImages = [];

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

      const pollRes = await axiosWithRetry({
        method: 'get',
        url: SUB2_BASE + '/batch-image-tasks/' + taskId,
        headers: { 'Authorization': 'Bearer ' + apiKey },
        timeout: 120000,
      }, 'Sub2 batch poll');

      finalTaskData = pollRes.data;
      const status = finalTaskData.status || '-';
      const readyCount = finalTaskData.ready_count || 0;
      const completedCount = finalTaskData.completed_count || 0;
      const failedCount = finalTaskData.failed_count || 0;
      logToFile('  [Sub2 batch] poll ' + (attempt + 1) + ': status=' + status + ', ready=' + readyCount + ', completed=' + completedCount + ', failed=' + failedCount);

      if (Array.isArray(finalTaskData.ready_images) && finalTaskData.ready_images.length > 0) {
        readyImages = finalTaskData.ready_images;
        break;
      }
      if (finalTaskData.image_url || finalTaskData.preview_image_url) {
        readyImages = [{ image_url: finalTaskData.image_url || finalTaskData.preview_image_url }];
        break;
      }
      if ((status === 'failed' || status === 'error') || (failedCount > 0 && completedCount === 0 && readyCount === 0)) {
        const errorMsg = formatSub2TaskError(finalTaskData, 'Sub2 batch task failed');
        throw new Error(errorMsg);
      }
    }

    if (!readyImages.length) throw new Error('Sub2 任务超时未完成');

    const archiveUrls = [];
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const modelTag = getModelShortName('gpt-image-2-sub2');
    const dir = path.join(ARCHIVE_BASE, username, dateStr);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    for (let i = 0; i < readyImages.length; i++) {
      let imageUrl = readyImages[i].image_url || readyImages[i].url || readyImages[i].preview_image_url;
      if (!imageUrl) continue;
      if (imageUrl.startsWith('/')) imageUrl = SUB2_BASE + imageUrl;

      const dlRes = await axiosWithRetry({ method: 'get', url: imageUrl, responseType: 'arraybuffer', timeout: 120000 }, 'Sub2 image download');
      const imgBuffer = Buffer.from(dlRes.data);
      const { dir, filename, dateStr } = getArchiveTarget(username, taskInfo.localId, i, imgBuffer, 'gpt-image-2-sub2');
      fs.writeFileSync(path.join(dir, filename), imgBuffer);
      const archiveUrl = '/archive/' + sanitizePathSegment(username) + '/' + dateStr + '/' + ((getArchiveMeta(taskInfo.localId)?.archiveType ? sanitizePathSegment(getArchiveMeta(taskInfo.localId).archiveType === 'detail-replicate' ? '详情页生成' : '买家秀生成') + '/' + sanitizePathSegment(getArchiveMeta(taskInfo.localId).batchId || taskInfo.localId) + '/' : '')) + filename;
      archiveUrls.push(archiveUrl);
      logToFile('  Saved Sub2 batch -> ' + dir + '/' + filename + ' -> ' + archiveUrl);
    }

    if (!archiveUrls.length) throw new Error('Sub2 已完成但没有可下载图片');

    const responseData = { created: Date.now(), data: archiveUrls.map(url => ({ url })), sub2Task: finalTaskData };

    logApiResponse({
      id: localId,
      apiRequestId: taskId,
      user: username,
      model: 'gpt-image-2-sub2',
      prompt: prompt.substring(0, 300),
      imageCount: images.length,
      imagePaths: images,
      status: 'success',
      statusCode: 200,
      resultUrls: archiveUrls,
      archiveUrls,
      rawResponse: JSON.stringify(responseData).substring(0, 3000),
    });

    updateGenerateEntry(localId, {
      status: 'success',
      completedAt: new Date().toISOString(),
      statusCode: 200,
      resultUrls: archiveUrls,
      archiveUrls,
      rawResponse: JSON.stringify(responseData).substring(0, 3000),
    });

    const stats = loadStats();
    stats[username].successCalls++;
    if (stats[username].history.length > 0) stats[username].history[stats[username].history.length - 1].status = 'success';
    saveStats(stats);

    res.json({ created: Date.now(), data: archiveUrls.map(url => ({ url })), localId, task_id: localId });
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    logError('Sub2 batch generate failed: ' + errorMsg);
    logApiResponse({
      id: localId,
      user: username,
      model: 'gpt-image-2-sub2',
      prompt: prompt.substring(0, 300),
      imageCount: images?.length || 0,
      imagePaths: images,
      status: 'error',
      statusCode: err.response?.status || 0,
      error: errorMsg,
      rawResponse: err.response?.data ? JSON.stringify(err.response.data).substring(0, 3000) : '',
    });
    updateGenerateEntry(localId, {
      status: 'error',
      completedAt: new Date().toISOString(),
      statusCode: err.response?.status || 0,
      error: errorMsg,
      rawResponse: err.response?.data ? JSON.stringify(err.response.data).substring(0, 3000) : '',
    });
    const b2 = loadBalances();
    if (b2[username]) {
      b2[username].balance = Math.round((b2[username].balance + price) * 100) / 100;
      saveBalances(b2);
    }
    res.status(500).json({ error: errorMsg });
  }
}

async function submitSub2BatchTask({ prompt, images = [], size, quality, apiKey, username, localId, price, modelLabel, archiveMeta, queueParentId, queueIndex }) {
  createGenerateEntry({
    id: localId,
    user: username,
    model: modelLabel || 'gpt-image-2-sub2',
    prompt: prompt.substring(0, 300),
    imageCount: images.length,
    imagePaths: images,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: null,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: null,
    archiveMeta: archiveMeta || null,
    queueParentId: queueParentId || null,
    queueIndex: Number.isFinite(queueIndex) ? queueIndex : null,
    queueStatus: 'queued',
  });

  return enqueueSub2Job({
    localId,
    username,
    prompt,
    images,
    size,
    quality,
    apiKey,
    price,
    modelLabel,
    archiveMeta: archiveMeta || null,
    queueParentId: queueParentId || null,
    queueIndex: Number.isFinite(queueIndex) ? queueIndex : null,
    idempotencyKey: queueParentId ? `${queueParentId}-${queueIndex + 1}` : `img2img-${localId}`,
  });
}

async function submitSub2MultiPromptTask({ prompts, images, size, quality, apiKey, username, localId, price, modelLabel, archiveMeta }) {
  prompts = (prompts || []).slice(0, 20).map(p => { var str = String(p || '').trim(); if (/^\[.*\]$/.test(str)) { try { var parsed = JSON.parse(str); str = Array.isArray(parsed) ? parsed[0] : String(parsed); } catch(e) { str = str.replace(/^\[|\]$/g,''); } } return str; }).filter(Boolean);
  if (!prompts.length) throw new Error('缺少批量生成提示词');

  const itemNames = Array.isArray(archiveMeta?.itemNames) ? archiveMeta.itemNames : [];
  createGenerateEntry({
    id: localId,
    user: username,
    model: modelLabel || 'gpt-image-2-sub2-multi',
    prompt: prompts.map((p, i) => '[' + (i + 1) + '] ' + p).join('\n').substring(0, 1000),
    imageCount: prompts.length,
    imagePaths: images,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: null,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: null,
    expectedCount: prompts.length,
    queueStatus: 'queued',
    archiveMeta: archiveMeta || null,
  });
  const childTaskIds = prompts.map((_, index) => `${localId}_img${index + 1}`);
  sub2AggregateTasks.set(localId, { localId, username, childTaskIds, expectedCount: prompts.length, price, modelLabel, archiveMeta: archiveMeta || null, submittedAt: Date.now() });
  updateGenerateEntry(localId, {
    archiveMeta: { ...(archiveMeta || {}), childTaskIds },
    childTaskIds,
  });

  for (let i = 0; i < prompts.length; i++) {
    const childMeta = {
      ...(archiveMeta || {}),
      itemNo: i + 1,
      itemName: itemNames[i] || ((archiveMeta?.archiveSubType === 'buyer-show-extend' ? '拓展视角' : '买家秀') + (i + 1)),
      itemNames: undefined,
      childOf: localId,
    };
    await submitSub2BatchTask({
      prompt: prompts[i],
      images,
      size,
      quality,
      apiKey,
      username,
      localId: childTaskIds[i],
      price: price / prompts.length,
      modelLabel,
      archiveMeta: childMeta,
      queueParentId: localId,
      queueIndex: i,
    });
  }
  updateSub2AggregateTask(localId);
  return { taskId: localId, localId };
}

function collectSub2AggregateTaskStatus(localId) {
  const aggregate = sub2AggregateTasks.get(localId);
  const log = loadGenerateLog();
  const parent = log.find(e => e.id === localId);
  const childTaskIds = aggregate?.childTaskIds || parent?.childTaskIds || parent?.archiveMeta?.childTaskIds || [];
  if (!childTaskIds.length) return null;
  const children = childTaskIds.map(id => log.find(e => e.id === id)).filter(Boolean);
  const resultUrls = childTaskIds.map(id => {
    const child = log.find(e => e.id === id);
    return child?.resultUrls?.[0] || child?.archiveUrls?.[0] || child?.archiveMeta?.savedResults?.[0] || '';
  });
  const successCount = resultUrls.filter(Boolean).length;
  const terminalCount = children.filter(e => e.status === 'success' || e.status === 'error').length;
  const expectedCount = aggregate?.expectedCount || childTaskIds.length;
  const allDone = terminalCount >= expectedCount;
  const hasError = children.some(e => e.status === 'error');
  const errors = children.filter(e => e.status === 'error' && e.error).map(e => e.error);

  return {
    task_id: localId,
    status: allDone ? (successCount > 0 ? 'success' : 'error') : (successCount > 0 ? 'partial' : 'pending'),
    resultUrls,
    error: allDone && successCount === 0 ? (errors[0] || '批量生成失败') : (hasError ? errors[0] : null),
    localId,
    completed: terminalCount,
    successCount,
    expectedCount,
  };
}

function updateSub2AggregateTask(localId) {
  if (!localId) return;
  const status = collectSub2AggregateTaskStatus(localId);
  if (!status) return;
  const parentMeta = getArchiveMeta(localId) || {};
  updateGenerateEntry(localId, {
    status: status.status === 'success' || status.status === 'error' ? status.status : 'pending',
    completedAt: status.status === 'success' || status.status === 'error' ? new Date().toISOString() : null,
    statusCode: status.status === 'error' ? 0 : 200,
    queueStatus: status.status === 'success' || status.status === 'error' ? 'done' : 'running',
    resultUrls: status.resultUrls.filter(Boolean),
    archiveUrls: status.resultUrls.filter(Boolean),
    error: status.status === 'error' ? status.error : null,
    archiveMeta: { ...parentMeta, savedResults: status.resultUrls.filter(Boolean) },
  });
  if (status.status === 'success' || status.status === 'error') {
    sub2AggregateTasks.delete(localId);
  }
}

function buildArchiveUrl(meta, username, dateStr, filename, localId) {
  return getArchiveBaseUrl(meta, username, dateStr, localId) + '/' + filename;
}

async function pollAndArchiveSub2BatchTask(taskId, taskInfo) {
  const SUB2_BASE = 'https://img.94576354.xyz';
  const timeoutMs = loadSub2QueueConfig().runningTimeoutMs;
  const pollRes = await axiosWithRetry({
    method: 'get',
    url: SUB2_BASE + '/batch-image-tasks/' + taskId,
    headers: { 'Authorization': 'Bearer ' + taskInfo.apiKey },
    timeout: 120000,
  }, 'Sub2 submit-only batch poll');
  const finalTaskData = pollRes.data;
  const status = finalTaskData.status || '-';
  const readyImages = Array.isArray(finalTaskData.ready_images) ? finalTaskData.ready_images : [];
  const readyCount = finalTaskData.ready_count || readyImages.length || 0;
  const completedCount = finalTaskData.completed_count || 0;
  const failedCount = finalTaskData.failed_count || 0;
  const existing = getArchiveMeta(taskInfo.localId)?.savedResults || [];
  const archiveUrls = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(archiveUrls);

  if (readyCount > 0 && readyImages.length > 0) {
    const username = taskInfo.username;
    for (let i = 0; i < readyImages.length; i++) {
      let imageUrl = readyImages[i].image_url || readyImages[i].url || readyImages[i].preview_image_url;
      if (!imageUrl) continue;
      if (imageUrl.startsWith('/')) imageUrl = SUB2_BASE + imageUrl;
      const already = archiveUrls[i];
      if (already) continue;
      const dlRes = await axiosWithRetry({ method: 'get', url: imageUrl, responseType: 'arraybuffer', timeout: 120000 }, 'Sub2 submit-only image download');
      const imgBuffer = Buffer.from(dlRes.data);
      const meta = getArchiveMeta(taskInfo.localId) || taskInfo.archiveMeta || {};
      const target = getArchiveTarget(username, taskInfo.localId, i, imgBuffer, 'gpt-image-2-sub2');
      const archiveUrl = buildArchiveUrl(meta, username, target.dateStr, target.filename, taskInfo.localId);
      if (!seen.has(archiveUrl)) {
        fs.writeFileSync(path.join(target.dir, target.filename), imgBuffer);
        archiveUrls[i] = archiveUrl;
        seen.add(archiveUrl);
        logToFile('  Saved Sub2 submit-only batch -> ' + target.dir + '/' + target.filename + ' -> ' + archiveUrl);
      }
    }

    const cleaned = archiveUrls.filter(Boolean);
    if (cleaned.length) {
      const expectedCount = taskInfo.expectedCount || 1;
      const done = status === 'completed' || completedCount >= expectedCount || cleaned.length >= expectedCount;
      updateGenerateEntry(taskInfo.localId, {
        status: done ? 'success' : 'pending',
        completedAt: done ? new Date().toISOString() : null,
        statusCode: 200,
        resultUrls: cleaned,
        archiveUrls: cleaned,
        archiveMeta: { ...(getArchiveMeta(taskInfo.localId) || taskInfo.archiveMeta || {}), savedResults: cleaned },
        rawResponse: JSON.stringify(finalTaskData).substring(0, 3000),
      });
      if (done) {
        if (!taskInfo._successMarked) {
          markGenerationSuccess(taskInfo.username, taskInfo.localId);
          taskInfo._successMarked = true;
        }
        markSub2TaskTerminal(taskId, taskInfo);
      }
      return { task_id: taskId, status: done ? 'success' : 'partial', resultUrls: cleaned, localId: taskInfo.localId };
    }
  }

  if ((status === 'failed' || status === 'error') || (failedCount > 0 && completedCount === 0 && readyCount === 0)) {
    if (archiveUrls.filter(Boolean).length > 0) {
      updateGenerateEntry(taskInfo.localId, {
        status: 'success',
        completedAt: new Date().toISOString(),
        statusCode: 200,
        resultUrls: archiveUrls.filter(Boolean),
        archiveUrls: archiveUrls.filter(Boolean),
        error: null,
        archiveMeta: { ...(getArchiveMeta(taskInfo.localId) || taskInfo.archiveMeta || {}), savedResults: archiveUrls.filter(Boolean) },
        rawResponse: JSON.stringify(finalTaskData).substring(0, 3000),
      });
      if (!taskInfo._successMarked) {
        markGenerationSuccess(taskInfo.username, taskInfo.localId);
        taskInfo._successMarked = true;
      }
      markSub2TaskTerminal(taskId, taskInfo);
      return { task_id: taskId, status: 'success', resultUrls: archiveUrls.filter(Boolean), localId: taskInfo.localId };
    }
    const errorMsg = formatSub2TaskError(finalTaskData, 'Sub2 batch task failed');
    updateGenerateEntry(taskInfo.localId, { status: 'error', completedAt: new Date().toISOString(), error: errorMsg, rawResponse: JSON.stringify(finalTaskData).substring(0, 3000) });
    if (!taskInfo._refunded) { refundGeneration(taskInfo.username, taskInfo.price || 0); taskInfo._refunded = true; }
    markSub2TaskTerminal(taskId, taskInfo);
    return { task_id: taskId, status: 'error', error: errorMsg, localId: taskInfo.localId };
  }

  if (taskInfo.submittedAt && Date.now() - taskInfo.submittedAt > timeoutMs) {
    const errorMsg = `Sub2 任务超过 ${Math.round(timeoutMs / 60000)} 分钟未返回图片，已自动标记失败`;
    updateGenerateEntry(taskInfo.localId, {
      status: 'error',
      completedAt: new Date().toISOString(),
      queueStatus: 'done',
      error: errorMsg,
      rawResponse: JSON.stringify(finalTaskData).substring(0, 3000),
    });
    if (!taskInfo._refunded) { refundGenerateEntryOnce(taskInfo.localId, taskInfo.username, taskInfo.price || 0); taskInfo._refunded = true; }
    markSub2TaskTerminal(taskId, taskInfo);
    return { task_id: taskId, status: 'error', error: errorMsg, localId: taskInfo.localId };
  }

  return { task_id: taskId, status: 'pending', message: '任务正在后台生成中...', localId: taskInfo.localId };
}

function scheduleSub2BackgroundPoll(taskId) {
  if (!taskId || sub2BackgroundPollers.has(taskId)) return;
  const runner = setTimeout(async () => {
    sub2BackgroundPollers.delete(taskId);
    const taskInfo = sub2TaskQueue.get(taskId);
    if (!taskInfo) return;
    if (taskInfo._polling) {
      scheduleSub2BackgroundPoll(taskId);
      return;
    }
    taskInfo._polling = true;
    try {
      const result = await pollAndArchiveSub2BatchTask(taskId, taskInfo);
      if (result?.status === 'pending' || result?.status === 'partial') {
        scheduleSub2BackgroundPoll(taskId);
      }
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      updateGenerateEntry(taskInfo.localId, {
        status: 'error',
        completedAt: new Date().toISOString(),
        error: errorMsg,
        rawResponse: err.response?.data ? JSON.stringify(err.response.data).substring(0, 3000) : '',
      });
      if (!taskInfo._refunded) {
        refundGenerateEntryOnce(taskInfo.localId, taskInfo.username, taskInfo.price || 0);
        taskInfo._refunded = true;
      }
      markSub2TaskTerminal(taskId, taskInfo);
      logError(`Sub2 background poll failed | taskId=${taskId} | ${errorMsg}`);
    } finally {
      if (sub2TaskQueue.has(taskId)) {
        const latest = sub2TaskQueue.get(taskId);
        if (latest) latest._polling = false;
      }
    }
  }, 5000);
  sub2BackgroundPollers.set(taskId, runner);
}

async function submitIntentImageTask({ prompt, images, size, count, apiKey, username, localId, modelLabel }) {
  const SUB2_BASE = 'https://img.94576354.xyz';
  const files = [];
  for (const img of (images || []).slice(0, 8)) {
    const resolved = await resolveImage(img);
    if (resolved) files.push({ field: 'image', filename: resolved.filename, content_type: resolved.mime, b64: resolved.buffer.toString('base64') });
  }
  createGenerateEntry({ id: localId, user: username, model: modelLabel || 'gpt-image-2-sub2-intent', prompt: prompt.substring(0,300), imageCount: files.length, imagePaths: images || [], status: 'pending', submittedAt: new Date().toISOString(), completedAt: null, apiRequestId: null, resultUrls: [], usage: null, error: null, statusCode: null, rawResponse: null });
  const submitRes = await axios.post(SUB2_BASE + '/intent-image-tasks', {
    api_key: apiKey,
    prompt,
    size: size || '2048x2048',
    quality: 'high',
    output_format: 'png',
    count: Math.min(Math.max(parseInt(count || 4, 10), 1), 15),
    batch_concurrency: 1,
    files
  }, { headers: { 'Content-Type': 'application/json' }, timeout: 120000, maxContentLength: Infinity, maxBodyLength: Infinity });
  const taskId = submitRes.data.task_id;
  if (!taskId) throw new Error('未获取到 intent task_id: ' + JSON.stringify(submitRes.data).substring(0, 500));
  updateGenerateEntry(localId, { apiRequestId: taskId, rawResponse: JSON.stringify(submitRes.data).substring(0, 3000) });
  intentTaskQueue.set(taskId, { localId, username, prompt, images, size, count, apiKey, archiveMeta: null, submittedAt: Date.now() });
  logToFile('Sub2 intent-image-tasks submitted | task_id=' + taskId + ' | count=' + count);
  return { taskId, localId };
}

async function pollAndArchiveIntentTask(taskId, taskInfo) {
  const SUB2_BASE = 'https://img.94576354.xyz';
  const pollRes = await axios.get(SUB2_BASE + '/intent-image-tasks/' + taskId, { headers: { 'Authorization': 'Bearer ' + taskInfo.apiKey }, timeout: 120000 });
  const data = pollRes.data;
  const readyImages = Array.isArray(data.ready_images) ? data.ready_images : [];
  const readyCount = data.ready_count || readyImages.length || 0;
  const failedCount = data.failed_count || 0;
  const completedCount = data.completed_count || 0;
  const existing = getArchiveMeta(taskInfo.localId)?.savedResults || [];
  const archiveUrls = Array.isArray(existing) ? existing.slice() : [];
  const seen = new Set(archiveUrls);
  if (readyImages.length) {
    const username = taskInfo.username;
    for (let i=0;i<readyImages.length;i++) {
      let imageUrl = readyImages[i].image_url || readyImages[i].url || readyImages[i].preview_image_url;
      if (!imageUrl) continue;
      if (imageUrl.startsWith('/')) imageUrl = SUB2_BASE + imageUrl;
      const already = archiveUrls[i];
      if (already) continue;
      const dlRes = await axiosWithRetry({ method: 'get', url: imageUrl, responseType:'arraybuffer', timeout:120000 }, 'Sub2 intent image download');
      const buf = Buffer.from(dlRes.data);
      const meta = getArchiveMeta(taskInfo.localId) || taskInfo.archiveMeta || {};
      const target = getArchiveTarget(username, taskInfo.localId, i, buf, 'gpt-image-2-sub2');
      const archiveUrl = buildArchiveUrl(meta, username, target.dateStr, target.filename, taskInfo.localId);
      if (!seen.has(archiveUrl)) {
        fs.writeFileSync(path.join(target.dir, target.filename), buf);
        archiveUrls[i] = archiveUrl;
        seen.add(archiveUrl);
      }
    }
    const cleaned = archiveUrls.filter(Boolean);
    const done = data.status === 'completed' || (completedCount >= (taskInfo.count || cleaned.length));
    updateGenerateEntry(taskInfo.localId, { status: done ? 'success' : 'pending', completedAt: done ? new Date().toISOString() : null, statusCode: 200, resultUrls: cleaned, archiveUrls: cleaned, archiveMeta: { ...(getArchiveMeta(taskInfo.localId) || taskInfo.archiveMeta || {}), savedResults: cleaned }, rawResponse: JSON.stringify(data).substring(0,3000) });
    if (done) markGenerationSuccess(taskInfo.username, taskInfo.localId);
    if (done) intentTaskQueue.delete(taskId);
    return { task_id: taskId, status: done ? 'success' : 'partial', resultUrls: cleaned, localId: taskInfo.localId };
  }
  if ((data.status === 'failed' || data.status === 'error') || (failedCount > 0 && completedCount === 0 && readyCount === 0)) {
    const errorMsg = formatSub2TaskError(data, 'intent-image-tasks failed');
    updateGenerateEntry(taskInfo.localId, { status:'error', completedAt:new Date().toISOString(), error:errorMsg, rawResponse: JSON.stringify(data).substring(0,3000) });
    intentTaskQueue.delete(taskId);
    return { task_id: taskId, status:'error', error:errorMsg, localId: taskInfo.localId };
  }
  return { task_id: taskId, status:'pending', localId: taskInfo.localId };
}

function buildRecoveredSub2TaskInfo(entry) {
  if (!entry || entry.status !== 'pending' || !entry.apiRequestId || !isSub2StatsEntry(entry)) return null;
  const apiKey = getSub2ApiKey();
  if (!apiKey) return null;
  const expectedCount = entry.taskType === 'sub2-single' ? 1 : getExpectedOutputCount(entry);
  return {
    localId: entry.id,
    username: entry.user,
    prompt: entry.prompt || '',
    images: entry.imagePaths || [],
    size: entry.size || null,
    quality: entry.quality || 'high',
    apiKey,
    price: 0.025 * expectedCount,
    modelLabel: entry.model,
    archiveMeta: entry.archiveMeta || null,
    queueParentId: entry.queueParentId || null,
    submittedAt: entry.queueStartedAt ? new Date(entry.queueStartedAt).getTime() : (entry.submittedAt ? new Date(entry.submittedAt).getTime() : Date.now()),
    expectedCount,
    count: expectedCount,
    recovered: true,
    taskType: entry.taskType || 'sub2-batch',
  };
}

function recoverPendingSub2Tasks() {
  markStalePendingSub2Entries();
  const log = loadGenerateLog();
  for (const entry of log) {
    if (entry?.status !== 'pending') continue;
    if (entry?.status === 'pending' && entry.childTaskIds?.length) {
      sub2AggregateTasks.set(entry.id, {
        localId: entry.id,
        username: entry.user,
        childTaskIds: entry.childTaskIds,
        expectedCount: entry.childTaskIds.length,
        price: getPrice(entry.model || 'gpt-image-2-sub2') * entry.childTaskIds.length,
        modelLabel: entry.model,
        archiveMeta: entry.archiveMeta || null,
        submittedAt: entry.submittedAt ? new Date(entry.submittedAt).getTime() : Date.now(),
      });
      updateSub2AggregateTask(entry.id);
      continue;
    }
    const recovered = buildRecoveredSub2TaskInfo(entry);
    if (recovered) {
      const taskId = entry.apiRequestId;
      if (!taskId) continue;
      if (!sub2TaskQueue.has(taskId)) {
        sub2TaskQueue.set(taskId, recovered);
        if (!sub2QueueJobs.has(entry.id)) {
          sub2QueueJobs.set(entry.id, { ...recovered, status: 'running', _recoveredRunning: true });
          sub2QueueState.running = Math.min(getSub2QueueLimit(), sub2QueueState.running + 1);
        }
      }
      scheduleSub2BackgroundPoll(taskId);
      continue;
    }
    if (!entry || entry.status !== 'pending' || entry.apiRequestId || !isSub2StatsEntry(entry) || entry.childTaskIds?.length) continue;
    const apiKey = getSub2ApiKey();
    if (!apiKey) continue;
    enqueueSub2Job({
      localId: entry.id,
      username: entry.user,
      prompt: entry.prompt || '',
      images: entry.imagePaths || [],
      size: entry.size || null,
      quality: entry.quality || 'high',
      apiKey,
      price: getPrice(entry.model || 'gpt-image-2-sub2'),
      modelLabel: entry.model,
      archiveMeta: entry.archiveMeta || null,
      queueParentId: entry.queueParentId || null,
      idempotencyKey: `recovered-${entry.id}`,
    });
  }
}

function finalizeStaleLegacySub2Singles() {
  const log = loadGenerateLog();
  const now = Date.now();
  let changed = false;
  for (const entry of log) {
    if (!entry || entry.status !== 'pending' || entry.taskType !== 'sub2-single') continue;
    const submittedAt = entry.submittedAt ? new Date(entry.submittedAt).getTime() : 0;
    if (!submittedAt || Number.isNaN(submittedAt)) continue;
    if (now - submittedAt < 2 * 60 * 1000) continue;
    entry.status = 'error';
    entry.completedAt = new Date().toISOString();
    entry.error = '任务在旧版单图流程中因服务重启中断，请重新生成';
    changed = true;
    finalizeTaskRefund(entry, getPrice(entry.model || 'gpt-image-2-sub2'));
    logToFile(`Recovered stale legacy Sub2 single task as error | localId=${entry.id} | taskId=${entry.apiRequestId || '-'} `);
  }
  if (changed) saveGenerateLog(log);
}

async function pollRecoveredSub2Task(entry) {
  const taskId = entry.apiRequestId;
  const recovered = buildRecoveredSub2TaskInfo(entry);
  if (!recovered) return null;
  if (String(entry.model || '').includes('intent')) {
    return await pollAndArchiveIntentTask(taskId, recovered);
  }
  if (recovered.taskType === 'sub2-single') {
    return await pollAndArchiveSub2BatchTask(taskId, recovered);
  }
  return await pollAndArchiveSub2BatchTask(taskId, recovered);
}

async function handleManxiaobaiGenerate(req, res, opts) {
  const { prompt, images, size, quality, apiKey, apiBase, modelName, username, localId, price } = opts;
  const FormData = require('form-data');

  // 漫小白上游统一使用 gpt-image-2，尺寸只作为 size 参数传递。
  const upstreamModel = resolveManxiaobaiModel(size);

  createGenerateEntry({
    id: localId,
    user: username,
    model: modelName,
    prompt: prompt.substring(0, 300),
    imageCount: images.length,
    imagePaths: images,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: null,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: null,
  });

  try {
    const form = new FormData();
    form.append('model', upstreamModel);
    form.append('prompt', prompt);
    if (size && size !== 'auto') form.append('size', size);
    if (quality && quality !== 'auto') form.append('quality', quality);

    // Upload images as files
    const imageField = images.length > 1 ? 'image[]' : 'image';
    for (const img of images) {
      if (img.startsWith('data:')) {
        const match = img.match(/^data:([^;]+);base64,(.+)$/);
        if (match) {
          const mime = match[1];
          const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg';
          form.append(imageField, Buffer.from(match[2], 'base64'), { filename: `ref${ext}`, contentType: mime });
        }
      } else if (img.startsWith('http')) {
        const resolved = await resolveImage(img);
        if (resolved) {
          form.append(imageField, resolved.buffer, { filename: resolved.filename, contentType: resolved.mime });
        }
      } else {
        const resolved = await resolveImage(img);
        if (resolved) {
          form.append(imageField, resolved.buffer, { filename: resolved.filename, contentType: resolved.mime });
        }
      }
    }

    logToFile(`🖼️  漫小白 ${upstreamModel} (multipart) | user: ${username} | size: ${size || 'auto'} | images: ${images.length} | prompt: ${prompt.substring(0, 150)}`);

    const imgRes = await axios.post(`${apiBase}/v1/images/edits`, form, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      timeout: 300000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const responseData = imgRes.data;
    await archiveResponseImages(responseData, username, upstreamModel);
    const resultUrls = Array.isArray(responseData?.data)
      ? responseData.data.map(d => d.url).filter(Boolean)
      : [];

    logApiResponse({
      id: localId,
      user: username,
      model: modelName,
      prompt: prompt.substring(0, 300),
      imageCount: images.length,
      imagePaths: images,
      status: 'success',
      statusCode: imgRes.status,
      resultUrls,
      usage: responseData?.usage || null,
      rawResponse: JSON.stringify(responseData).substring(0, 3000),
    });

    updateGenerateEntry(localId, {
      status: 'success',
      completedAt: new Date().toISOString(),
      statusCode: imgRes.status,
      resultUrls,
      usage: responseData?.usage || null,
      rawResponse: JSON.stringify(responseData).substring(0, 3000),
    });

    // Update stats
    const stats = loadStats();
    stats[username].successCalls++;
    if (stats[username].history.length > 0) {
      stats[username].history[stats[username].history.length - 1].status = 'success';
    }
    saveStats(stats);

    // Strip b64_json from response to avoid huge payload issues
    const cleanResponseData = { ...responseData };
    if (Array.isArray(cleanResponseData.data)) {
      cleanResponseData.data = cleanResponseData.data.map(item => {
        const { b64_json, ...rest } = item;
        return rest;
      });
    }
    const respData = { ...cleanResponseData };
    respData.localId = localId;
    res.json(respData);
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    logError(`${modelName} generate failed: ${errorMsg}`);
    logApiResponse({
      id: localId,
      user: username,
      model: modelName,
      prompt: prompt.substring(0, 300),
      imageCount: images?.length || 0,
      imagePaths: images,
      status: 'error',
      statusCode: err.response?.status || 0,
      error: errorMsg,
      rawResponse: err.response?.data ? JSON.stringify(err.response.data).substring(0, 3000) : '',
    });
    updateGenerateEntry(localId, {
      status: 'error',
      completedAt: new Date().toISOString(),
      statusCode: err.response?.status || 0,
      error: errorMsg,
      rawResponse: err.response?.data ? JSON.stringify(err.response.data).substring(0, 3000) : '',
    });

    // Refund
    const b2 = loadBalances();
    if (b2[username]) {
      b2[username].balance = Math.round((b2[username].balance + price) * 100) / 100;
      saveBalances(b2);
    }
    res.status(500).json({ error: errorMsg });
  }
}

// ===== Universal OpenAI-format image generation handler (JSON POST) =====
async function handleOpenAIImageGenerate(req, res, opts) {
  const { prompt, images, size, quality, apiKey, apiBase, modelName, username, localId, price } = opts;

  createGenerateEntry({
    id: localId,
    user: username,
    model: modelName,
    prompt: prompt.substring(0, 300),
    imageCount: images.length,
    imagePaths: images,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: null,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: null,
  });

  try {
    // Convert images to base64 strings for the image array
    const imageArray = [];
    for (const img of images) {
      if (img.startsWith('data:')) {
        imageArray.push(img);
      } else if (img.startsWith('http')) {
        imageArray.push(img);
      } else {
        const resolved = await resolveImage(img);
        if (resolved) {
          const b64 = resolved.buffer.toString('base64');
          imageArray.push(`data:${resolved.mime};base64,${b64}`);
        }
      }
    }

    const sizeStr = size && size !== 'auto' ? size : undefined;

    const body = {
      model: modelName,
      prompt: sizeStr ? `${prompt} (Output size: ${sizeStr})` : prompt,
      image: imageArray,
    };
    if (sizeStr) body.size = sizeStr;
    if (quality && quality !== 'auto') body.quality = quality;

    logToFile(`🖼️  ${modelName} | user: ${username} | model: ${modelName} | size: ${size || 'auto'} | images: ${images.length} | prompt: ${prompt.substring(0, 150)}`);
    // Debug: log image sizes sent to API
    imageArray.forEach((img, i) => {
      logToFile(`  [debug] image[${i}] type: ${img.startsWith('data:') ? 'data_uri' : img.startsWith('http') ? 'url' : 'unknown'}, length: ${img.length}`);
    });
    logToFile(`  [debug] total body size: ${JSON.stringify(body).length} bytes, model: ${modelName}`);

    const imgRes = await axios.post(`${apiBase}/v1/images/generations`, body, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 300000,
    });

    const responseData = imgRes.data;
    // 归档所有图片到本地 /vol2/@team/AI作图图片/{date}/{user}/
    await archiveResponseImages(responseData, username, modelName);
    const resultUrls = Array.isArray(responseData?.data)
      ? responseData.data.map(d => d.url).filter(Boolean)
      : [];

    logApiResponse({
      id: localId,
      user: username,
      model: modelName,
      prompt: prompt.substring(0, 300),
      imageCount: images.length,
      imagePaths: images,
      status: 'success',
      statusCode: imgRes.status,
      resultUrls,
      usage: responseData?.usage || null,
      rawResponse: JSON.stringify(responseData).substring(0, 3000),
    });

    updateGenerateEntry(localId, {
      status: 'success',
      completedAt: new Date().toISOString(),
      statusCode: imgRes.status,
      resultUrls,
      usage: responseData?.usage || null,
      rawResponse: JSON.stringify(responseData).substring(0, 3000),
    });

    // Update stats
    const stats = loadStats();
    stats[username].successCalls++;
    if (stats[username].history.length > 0) {
      stats[username].history[stats[username].history.length - 1].status = 'success';
    }
    saveStats(stats);

    // Strip b64_json from response to avoid huge payload issues
    const cleanResponseData = { ...responseData };
    if (Array.isArray(cleanResponseData.data)) {
      cleanResponseData.data = cleanResponseData.data.map(item => {
        const { b64_json, ...rest } = item;
        return rest;
      });
    }
    const respData = { ...cleanResponseData };
    respData.localId = localId;
    res.json(respData);
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.message;
    logError(`${modelName} generate failed: ${errorMsg}`);
    logApiResponse({
      id: localId,
      user: username,
      model: modelName,
      prompt: prompt.substring(0, 300),
      imageCount: images?.length || 0,
      imagePaths: images,
      status: 'error',
      statusCode: err.response?.status || 0,
      error: errorMsg,
      rawResponse: err.response?.data ? JSON.stringify(err.response.data).substring(0, 3000) : '',
    });
    updateGenerateEntry(localId, {
      status: 'error',
      completedAt: new Date().toISOString(),
      statusCode: err.response?.status || 0,
      error: errorMsg,
      rawResponse: err.response?.data ? JSON.stringify(err.response.data).substring(0, 3000) : '',
    });

    // Refund
    const b2 = loadBalances();
    if (b2[username]) {
      b2[username].balance = Math.round((b2[username].balance + price) * 100) / 100;
      saveBalances(b2);
    }
    res.status(500).json({ error: errorMsg });
  }
}

// Image generation
app.post('/api/generate', auth, async (req, res) => {
  const { prompt, model, images, size, quality } = req.body;
  const modelName = normalizeImageModel(model || 'gpt-image-2-sub2');

  // Route to different API providers
  let apiKey, apiBase, keyLabel;
  if (modelName === 'gpt-image-2') {
    apiKey = getZhenzhenApiKey();
    apiBase = 'https://ai.t8star.org';
    keyLabel = '贞贞令牌';
  } else if (modelName === 'gpt-image-2-manxiaobai') {
    apiKey = getManxiaobaiApiKey();
    apiBase = 'https://api.manxiaobai.online';
    keyLabel = '漫小白令牌';
  } else if (modelName === 'gpt-image-2-sub2') {
    apiKey = getSub2ApiKey();
    apiBase = 'https://img.94576354.xyz';
    keyLabel = 'Sub2令牌';
  } else if (modelName === 'agnes-image-2.1-flash') {
    apiKey = getAgnesApiKey();
    apiBase = 'https://apihub.agnes-ai.com';
    keyLabel = 'Agnes令牌';
  } else {
    apiKey = getApiKey();
    apiBase = 'https://www.6789api.top';
    keyLabel = 'API Key';
  }
  if (!apiKey) return res.status(500).json({ error: `管理员尚未配置 ${keyLabel}` });

  const username = req.username;
  const localId = `req_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  // Check enabled
  const balances = loadBalances();
  const bal = balances[username] || { balance: 0, enabled: false };
  if (!bal.enabled) return res.status(403).json({ error: '账户已禁用,请联系管理员' });
  // 漫小白统一按接口单价计费，尺寸只影响上游输出尺寸。
  const price = modelName === 'gpt-image-2-manxiaobai' ? resolveManxiaobaiPrice(size) : getPrice(modelName);
  if (bal.balance < price) return res.status(402).json({ error: `余额不足(当前 ¥${bal.balance.toFixed(2)},本次 ¥${price.toFixed(3)}),请联系管理员充值` });

  // 记录总调用次数
  const stats = loadStats();
  if (!stats[username]) stats[username] = { totalCalls: 0, successCalls: 0, lastCall: null, history: [] };
  stats[username].totalCalls++;
  stats[username].lastCall = new Date().toISOString();
  saveStats(stats);

  // 扣费:生成前先扣除费用(失败后退还)
  balances[username].balance = Math.round((balances[username].balance - price) * 100) / 100;
  saveBalances(balances);

  const hasImages = images && images.length > 0;
  if (!hasImages) {
    // 仅支持图生图,拒绝纯文本请求(退还费用)
    balances[username].balance = Math.round((balances[username].balance + price) * 100) / 100;
    saveBalances(balances);
    return res.status(400).json({ error: '本服务仅支持图生图,请至少上传一张参考图后再试' });
  }

  // 漫小白模型:使用 multipart/form-data
  if (modelName === 'gpt-image-2-manxiaobai') {
    await handleManxiaobaiGenerate(req, res, {
      prompt, images, size, quality, apiKey, apiBase, modelName, username, localId, price,
    });
    return;
  }

  // Sub2 模型:统一走 batch-image-tasks + 后端持续轮询，避免容器重启导致任务丢失
  if (modelName === 'gpt-image-2-sub2') {
    try {
      const ret = await submitSub2BatchTask({
        prompt,
        images,
        size,
        quality,
        apiKey,
        username,
        localId,
        price,
        modelLabel: 'gpt-image-2-sub2',
      });
      return res.json({ success: true, localId: ret.localId, task_id: ret.taskId, status: 'pending', message: '任务已提交,正在后台生成中...' });
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      logError('Sub2 submit failed: ' + errorMsg);
      updateGenerateEntry(localId, { status: 'error', completedAt: new Date().toISOString(), statusCode: err.response?.status || 0, error: errorMsg, rawResponse: err.response?.data ? JSON.stringify(err.response.data).substring(0, 3000) : '' });
      const b2 = loadBalances();
      if (b2[username]) {
        b2[username].balance = Math.round((b2[username].balance + price) * 100) / 100;
        saveBalances(b2);
      }
      return res.status(500).json({ error: errorMsg });
    }
  }

  // Agnes 模型:后端后台等待，前端刷新后仍可通过 task-status / 历史记录拿结果
  if (modelName === 'agnes-image-2.1-flash') {
    try {
      const ret = await submitAgnesImageTask({
        prompt,
        images,
        size,
        apiKey,
        apiBase,
        username,
        localId,
        price,
      });
      return res.json({ success: true, localId: ret.localId, task_id: ret.taskId, status: 'pending', message: '任务已提交,正在后台生成中...' });
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      logError('Agnes submit failed: ' + errorMsg);
      updateGenerateEntry(localId, { status: 'error', completedAt: new Date().toISOString(), statusCode: err.response?.status || 0, error: errorMsg, rawResponse: err.response?.data ? stringifyCompactResponse(err.response.data) : '' });
      const b2 = loadBalances();
      if (b2[username]) {
        b2[username].balance = Math.round((b2[username].balance + price) * 100) / 100;
        saveBalances(b2);
      }
      return res.status(500).json({ error: errorMsg });
    }
  }

  // 贞贞模型:使用异步提交 + 后台轮询
  if (modelName === 'gpt-image-2') {
    // 提交异步任务
    try {
      const imageArray = [];
      for (const img of images) {
        if (img.startsWith('data:')) {
          imageArray.push(img);
        } else if (img.startsWith('http')) {
          imageArray.push(img);
        } else {
          const resolved = await resolveImage(img);
          if (resolved) {
            const b64 = resolved.buffer.toString('base64');
            imageArray.push(`data:${resolved.mime};base64,${b64}`);
          }
        }
      }

      const zhenzhenSize = resolveZhenzhenSize(size);
      const sizeStr = zhenzhenSize.upstreamSize;
      const promptSize = zhenzhenSize.promptSize;
      const body = {
        model: modelName,
        prompt: promptSize ? `${prompt} (Output size: ${promptSize})` : prompt,
        image: imageArray,
      };
      if (sizeStr) body.size = sizeStr;
      if (quality && quality !== 'auto') body.quality = quality;

      logToFile(`🖼️  贞贞 gpt-image-2 (异步) | user: ${username} | requested size: ${size || 'auto'} | upstream size: ${sizeStr || 'auto'} | quality: ${quality || 'auto'} | images: ${imageArray.length} | prompt: ${prompt.substring(0, 150)}`);

      const submitRes = await axios.post(`https://ai.t8star.org/v1/images/generations?async=true`, body, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });

      // 异步提交返回格式:{ code, message, data: "task_id字符串" }
      const taskId = submitRes.data.data || submitRes.data.task_id;
      if (!taskId) {
        throw new Error('未获取到 task_id: ' + JSON.stringify(submitRes.data).substring(0, 500));
      }
      logToFile(`  ✅ 提交异步任务成功,task_id: ${taskId}`);

      // 创建 generate-log 初始记录(供 poller 后续更新)
      createGenerateEntry({
        id: localId,
        user: username,
        model: 'gpt-image-2',
        prompt: prompt.substring(0, 300),
        imageCount: images.length,
        imagePaths: images,
        status: 'pending',
        submittedAt: new Date().toISOString(),
        completedAt: null,
        apiRequestId: taskId,
        resultUrls: [],
        usage: null,
        error: null,
        statusCode: null,
        rawResponse: null,
      });

      // 保存任务到队列,开始后台轮询
      taskQueue.set(taskId, {
        taskId,
        username,
        apiKey,
        localId,
        startTime: Date.now(),
      });

      // 启动后台轮询(不阻塞响应)
      pollZhenzhenTask(taskId, username, apiKey, localId).catch(err => {
        logError(`Background poll error for ${taskId}: ${err.message}`);
      });

      // 立即返回 task_id 给前端,前端可以轮询状态
      res.json({
        success: true,
        task_id: taskId,
        message: '任务已提交,正在后台生成中...',
        status: 'pending',
        localId,
      });
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.message;
      logError(`贞贞异步提交失败: ${errorMsg}`);

      logApiResponse({
        id: localId,
        user: username,
        model: 'gpt-image-2',
        prompt: prompt.substring(0, 300),
        imageCount: images?.length || 0,
        imagePaths: images,
        status: 'error',
        statusCode: err.response?.status || 0,
        error: errorMsg,
        rawResponse: err.response?.data ? JSON.stringify(err.response.data).substring(0, 3000) : '',
      });

      updateGenerateEntry(localId, {
        status: 'error',
        completedAt: new Date().toISOString(),
        error: errorMsg,
      });

      // Refund on failure
      const b2 = loadBalances();
      if (b2[username]) {
        b2[username].balance = Math.round((b2[username].balance + price) * 100) / 100;
        saveBalances(b2);
      }
      res.status(500).json({ error: errorMsg });
    }
    return;
  }

  // Stage 1: Create pending entry
  createGenerateEntry({
    id: localId,
    user: username,
    model: modelName,
    prompt: prompt.substring(0, 300),
    imageCount: images.length,
    imagePaths: images,
    status: 'pending',
    submittedAt: new Date().toISOString(),
    completedAt: null,
    apiRequestId: null,
    resultUrls: [],
    usage: null,
    error: null,
    statusCode: null,
    rawResponse: null,
  });

  try {
    // ===== 6789 图生图 → JSON POST with base64 images =====
    // Convert images to base64 data URIs
    const imageArray = [];
    for (const img of images) {
      if (img.startsWith('data:')) {
        imageArray.push(img);
      } else if (img.startsWith('http')) {
        imageArray.push(img);
      } else {
        const resolved = await resolveImage(img);
        if (resolved) {
          const b64 = resolved.buffer.toString('base64');
          imageArray.push(`data:${resolved.mime};base64,${b64}`);
        }
      }
    }

    const isAgnes = modelName === 'agnes-image-2.1-flash';
    const sizeStr = isAgnes ? resolveAgnesSize(size) : (size && size !== 'auto' ? size : undefined);
    const body = {
      model: modelName,
      prompt: isAgnes ? prompt : (sizeStr ? `${prompt} (Output size: ${sizeStr})` : prompt),
    };
    if (!isAgnes) body.image = imageArray;
    if (sizeStr) body.size = sizeStr;
    if (isAgnes) {
      body.extra_body = { image: imageArray, response_format: 'url' };
    }
    else if (quality && quality !== 'auto') body.quality = quality;

    logToFile(`🖼️  ${isAgnes ? 'Agnes' : '6789'} ${modelName || 'gpt-image-2-flatfee'} (JSON) | user: ${username} | model: ${modelName || 'gpt-image-2-flatfee'} | size: ${size || 'auto'}${isAgnes ? ' | upstream size: ' + sizeStr + ' | imageArray: ' + imageArray.length : ''} | images: ${images.length} | prompt: ${prompt.substring(0, 150)}`);
    if (isAgnes) {
      const first = imageArray[0] || '';
      logToFile(`  [Agnes img2img request] keys=${Object.keys(body).join(',')} size=${body.size} extraBodyImageArray=${imageArray.length} firstImage=${first.substring(0, 32)}... len=${first.length} response_format=${body.extra_body?.response_format}`);
    }

    const imgRes = isAgnes
      ? await postAgnesImageGenerationWithRetry({ apiBase, body, localId, label: 'generate-sync-fallback' })
      : await axios.post(`${apiBase}/v1/images/generations`, body, {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 600000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        });

    // Count success
    const stats = loadStats();
    stats[username].successCalls++;
    if (stats[username].history.length > 0) {
      stats[username].history[stats[username].history.length - 1].status = 'success';
    }
    if (stats[username].history.length > 50) stats[username].history = stats[username].history.slice(-50);
    saveStats(stats);

    // Log API response with local ID and extracted API request ID
    const responseData = imgRes.data;
    // 归档所有图片到本地 /vol2/@team/AI作图图片/{date}/{user}/
    await archiveResponseImages(responseData, username, modelName, { preferLocalUrl: isAgnes, localId });
    const resultUrls = extractStoredImageUrls(responseData);
    if (!resultUrls.length) throw new Error(`${getModelShortName(modelName)} 已返回结果，但没有可用图片 URL`);
    logApiResponse({
      id: localId,
      user: username,
      model: modelName,
      prompt: prompt.substring(0, 300),
      upstreamPrompt: isAgnes ? body.prompt.substring(0, 600) : undefined,
      imageCount: images.length,
      imagePaths: images,
      status: 'success',
      statusCode: imgRes.status,
      resultUrls: resultUrls,
      usage: responseData?.usage || null,
      rawResponse: stringifyCompactResponse(responseData),
    });

    // Stage 2: Update entry with result
    updateGenerateEntry(localId, {
      status: 'success',
      completedAt: new Date().toISOString(),
      statusCode: imgRes.status,
      resultUrls: resultUrls,
      usage: responseData?.usage || null,
      rawResponse: stringifyCompactResponse(responseData),
    });

    // Return localId to client for tracking
    const respData = imgRes.data;
    respData.localId = localId;
    res.json(respData);
  } catch (err) {
    // 捕获实际响应内容(可能是 HTML 错误页)
    let rawResp = '';
    if (err.response?.data) {
      rawResp = typeof err.response.data === 'string' ? err.response.data.substring(0, 3000) : JSON.stringify(err.response.data).substring(0, 3000);
    }
    const errorMsg = err.response?.data?.error?.message || err.message;
    // 从错误消息正文中提取 API 请求 ID
    const reqIdMatch = errorMsg.match(/request id:\s*([a-zA-Z0-9]+)/);
    const apiReqId = err.response?.headers?.['x-request-id'] || err.response?.headers?.['request-id'] || err.response?.data?.request_id || (reqIdMatch ? reqIdMatch[1] : null);
    logError(`Generate failed: ${errorMsg}${apiReqId ? ' (request id: ' + apiReqId + ')' : ''}`);
    if (rawResp && rawResp !== errorMsg && rawResp.length > 0) {
      logError(`  Raw response (first 500 chars): ${rawResp.substring(0, 500)}`);
    }
    // Log API error response with both local ID and API request ID
    logApiResponse({
      id: localId,
      apiRequestId: apiReqId,
      user: username,
      model: modelName,
      prompt: prompt.substring(0, 300),
      upstreamPrompt: modelName === 'agnes-image-2.1-flash' ? (typeof body !== 'undefined' ? body.prompt.substring(0, 600) : undefined) : undefined,
      imageCount: images?.length || 0,
      imagePaths: images,
      status: 'error',
      statusCode: err.response?.status || 0,
      error: errorMsg,
      rawResponse: rawResp,
    });

    // Stage 2: Update entry with error
    updateGenerateEntry(localId, {
      status: 'error',
      completedAt: new Date().toISOString(),
      apiRequestId: apiReqId,
      statusCode: err.response?.status || 0,
      error: errorMsg,
      rawResponse: rawResp,
    });
    const stats = loadStats();
    if (stats[username]?.history?.length > 0) {
      stats[username].history[stats[username].history.length - 1].status = 'failed';
    }
    saveStats(stats);
    // Refund balance on failure
    const b2 = loadBalances();
    if (b2[username]) {
      b2[username].balance = Math.round((b2[username].balance + price) * 100) / 100;
      saveBalances(b2);
    }
    res.status(500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Proxy download: bypass CORS by downloading image through server
app.get('/api/download-image', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: '缺少 url 参数' });
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
    const contentType = response.headers['content-type'] || 'image/png';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'attachment; filename="image.png"');
    res.send(response.data);
  } catch (err) {
    logError('Proxy download failed: ' + err.message);
    res.status(500).json({ error: '下载失败: ' + err.message });
  }
});

// Save image
app.post('/api/save-image', auth, async (req, res) => {
  const { imageUrl, filename } = req.body;
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const savePath = path.join(RESULTS_DIR, filename || `${req.username}_${Date.now()}.png`);
    fs.writeFileSync(savePath, response.data);
    res.json({ success: true, path: `/results/${path.basename(savePath)}` });
  } catch (err) {
    logError('Save image failed: ' + err.message);
    res.status(500).json({ error: '保存失败: ' + err.message });
  }
});

// Upload image from URL (download & save)
app.post('/api/upload-url', auth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: '缺少 URL' });
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer' });
    const ext = url.includes('.png') ? '.png' : url.includes('.webp') ? '.webp' : '.jpg';
    const name = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
    const savePath = path.join(UPLOADS_DIR, name);
    fs.writeFileSync(savePath, response.data);
    const file = { path: savePath, filename: name, size: response.data.length, mimetype: response.headers['content-type'] || 'image/jpeg', originalname: url };
    const compression = await compressUploadedImage(file, req.username || 'upload-url');
    res.json({ success: true, url: `/uploads/${file.filename}`, filename: file.filename, size: file.size, compression });
  } catch (err) {
    logError('Upload from URL failed: ' + err.message);
    res.status(500).json({ error: '下载失败: ' + err.message });
  }
});

// Get user's saved images
app.get('/api/my-images', auth, (req, res) => {
  const resultsDir = RESULTS_DIR;
  if (!fs.existsSync(resultsDir)) return res.json([]);
  const files = fs.readdirSync(resultsDir)
    .filter(f => f.startsWith(req.username + '_') && /\.(png|jpg|jpeg|webp)$/i.test(f))
    .map(f => ({ filename: f, path: `/results/${f}`, created: fs.statSync(path.join(resultsDir, f)).mtime }))
    .sort((a, b) => b.created - a.created);
  res.json(files);
});

// ===== 文生图 =====
app.post('/api/generate-txt2img', auth, async (req, res) => {
  const { prompt, model, size, quality, outputFormat } = req.body;
  if (!prompt) return res.status(400).json({ error: '描述不能为空' });

  const username = req.username;
  const localId = `req_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

  try {
    const ret = await submitTextImageTask({
      prompt,
      size,
      quality,
      outputFormat,
      username,
      localId,
      modelName: model,
    });
    return res.json({ success: true, task_id: ret.taskId, status: 'pending', message: '任务已提交，正在后台生成中...', localId: ret.localId });
  } catch (err) {
    const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
    logError(`文生图 submit failed: ${errorMsg}`);
    if (err.statusCode) return res.status(err.statusCode).json({ error: errorMsg });
    return res.status(500).json({ error: errorMsg });
  }
});

// Check async task status
app.get('/api/task-status', auth, async (req, res) => {
  const { task_id } = req.query;
  if (!task_id) return res.status(400).json({ error: '缺少 task_id 参数' });

  // 1. 先查 generate-log(按 apiRequestId 或 id 查找)
  const log = loadGenerateLog();
  const entry = log.find(e => e.apiRequestId === task_id || e.id === task_id);
  if (entry && (entry.status === 'success' || entry.status === 'error')) {
    return res.json({
      task_id,
      status: entry.status,
      resultUrls: entry.resultUrls || [],
      error: entry.error || null,
      completedAt: entry.completedAt,
      localId: entry.id,
    });
  }

  // 2. 再查 in-memory queue(仍在轮询中)
  const taskInfo = taskQueue.get(task_id);
  if (taskInfo) {
    return res.json({
      task_id,
      status: 'pending',
      message: '任务正在后台生成中...',
      localId: taskInfo.localId,
    });
  }

  // 3. 查 Sub2 task queue，并实时轮询 /batch-image-tasks/{task_id}
  const aggregateStatus = collectSub2AggregateTaskStatus(task_id);
  if (aggregateStatus) return res.json(aggregateStatus);

  const queuedSub2Job = sub2QueueJobs.get(task_id);
  if (queuedSub2Job && queuedSub2Job.status === 'queued') {
    return res.json({
      task_id,
      status: 'pending',
      message: '任务正在排队中...',
      localId: queuedSub2Job.localId,
      queue: getSub2QueueStatus(),
    });
  }

  const sub2Info = sub2TaskQueue.get(task_id) || Array.from(sub2TaskQueue.values()).find(info => info.localId === task_id);
  if (sub2Info) {
    const upstreamTaskId = sub2Info.localId === task_id
      ? (loadGenerateLog().find(e => e.id === task_id)?.apiRequestId || task_id)
      : task_id;
    try {
      return res.json(await pollAndArchiveSub2BatchTask(upstreamTaskId, sub2Info));
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      updateGenerateEntry(sub2Info.localId, { status: 'error', completedAt: new Date().toISOString(), error: errorMsg });
      if (!sub2Info._refunded) { refundGenerateEntryOnce(sub2Info.localId, sub2Info.username, sub2Info.price || 0); sub2Info._refunded = true; }
      markSub2TaskTerminal(upstreamTaskId, sub2Info);
      return res.json({ task_id: upstreamTaskId, status: 'error', error: errorMsg, localId: sub2Info.localId });
    }
  }

  // 4. 查 intent-image-tasks queue，并实时轮询 /intent-image-tasks/{task_id}
  const intentInfo = intentTaskQueue.get(task_id);
  if (intentInfo) {
    try {
      return res.json(await pollAndArchiveIntentTask(task_id, intentInfo));
    } catch (err) {
      const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      updateGenerateEntry(intentInfo.localId, { status: 'error', completedAt: new Date().toISOString(), error: errorMsg });
      intentTaskQueue.delete(task_id);
      return res.json({ task_id, status: 'error', error: errorMsg, localId: intentInfo.localId });
    }
  }

  // 5. 查 generate-log 中 pending 的条目(Sub2/6789 等同步模式,apiRequestId 为 null)
  if (entry) {
    const recoveredSub2 = buildRecoveredSub2TaskInfo(entry);
    if (recoveredSub2) {
      try {
        return res.json(await pollRecoveredSub2Task(entry));
      } catch (err) {
        const errorMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
        updateGenerateEntry(entry.id, { status: 'error', completedAt: new Date().toISOString(), error: errorMsg });
        refundGeneration(recoveredSub2.username, recoveredSub2.price || 0);
        return res.json({ task_id, status: 'error', error: errorMsg, localId: entry.id });
      }
    }
    return res.json({
      task_id,
      status: entry.status || 'pending',
      resultUrls: entry.resultUrls || [],
      error: entry.error || null,
      localId: entry.id,
    });
  }

  res.json({ task_id, status: 'not_found', error: '任务不存在或已过期' });
});

// Get generate-log (for page refresh recovery)
app.get('/api/generate-log', auth, (req, res) => {
  const log = loadGenerateLog();
  // Return only pending tasks for this user from the last 24 hours
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const pendingTasks = log.filter(e =>
    e.user === req.username &&
    e.status === 'pending' &&
    !isFeaturePageTask(e) &&
    e.submittedAt &&
    new Date(e.submittedAt).getTime() > oneDayAgo
  );
  res.json({ pendingTasks });
});

async function queryAgnesVideoTask(task) {
  if (task.status === 'submitting' || !task.video_id || !task.task_id || task.task_id === task.localId) {
    return task;
  }
  const apiKey = findAgnesKeyByHash(task.keyHash);
  if (!apiKey) {
    const err = new Error('管理员尚未配置 Agnes令牌');
    err.statusCode = 500;
    throw err;
  }

  const videoId = task.video_id || task.videoId;
  const taskId = task.task_id || task.id;
  const url = videoId
    ? `https://apihub.agnes-ai.com/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=agnes-video-v2.0`
    : `https://apihub.agnes-ai.com/v1/videos/${encodeURIComponent(taskId)}`;

  const response = await axiosWithRetry({
    method: 'get',
    url,
    headers: { 'Authorization': `Bearer ${apiKey}` },
    timeout: 60000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  }, `Agnes video query ${videoId || taskId}`, 3);

  const data = response.data || {};
  const status = String(data.status || task.status || '').toLowerCase();
  const videoUrl = extractVideoUrl(data);
  const progress = data.progress ?? task.progress ?? 0;
  const completed = status === 'completed' || Boolean(videoUrl);
  const failed = status === 'failed';
  const errorMsg = typeof data.error === 'string'
    ? data.error
    : (data.error?.message || data.message || task.error || '');

  const updates = {
    status: completed ? 'completed' : (failed ? 'failed' : (status || 'queued')),
    progress,
    rawResponse: stringifyCompactResponse(data),
    updatedAt: new Date().toISOString(),
  };
  if (videoUrl) {
    updates.videoUrl = videoUrl;
    updates.completedAt = new Date().toISOString();
    updates.progress = 100;
  }
  if (failed) {
    updates.error = errorMsg || '视频生成失败';
    updates.completedAt = new Date().toISOString();
  }

  const saved = updateVideoTask(task.localId, updates) || { ...task, ...updates };
  return saved;
}

async function submitAgnesVideoTaskInBackground({ task, body, imageCount, imagePaths }) {
  const localId = task.localId;
  try {
    const apiKey = await acquireAgnesApiKey(`video-create:${localId}`);
    if (!apiKey) throw new Error('管理员尚未配置 Agnes令牌');

    const submitRes = await axiosWithRetry({
      method: 'post',
      url: 'https://apihub.agnes-ai.com/v1/videos',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      data: body,
      timeout: 300000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    }, `Agnes video create ${localId}`, 2);

    const data = submitRes.data || {};
    const updates = {
      task_id: data.task_id || data.id || localId,
      id: data.id || data.task_id || localId,
      video_id: data.video_id || '',
      status: String(data.status || 'queued').toLowerCase(),
      progress: data.progress ?? 0,
      keyHash: hashAgnesKey(apiKey),
      seconds: data.seconds || task.seconds,
      rawResponse: stringifyCompactResponse(data),
      updatedAt: new Date().toISOString(),
    };
    const updatedTask = updateVideoTask(localId, updates) || { ...task, ...updates };
    logApiResponse({
      id: localId,
      apiRequestId: updatedTask.video_id || updatedTask.task_id,
      user: task.user,
      model: 'agnes-video-v2.0',
      prompt: task.prompt.substring(0, 300),
      imageCount,
      imagePaths,
      status: 'pending',
      statusCode: submitRes.status,
      rawResponse: stringifyCompactResponse(data),
    });
    logToFile(`🎬 Agnes 视频任务已提交 | user=${task.user} | mode=${task.mode} | ${task.width}x${task.height} | frames=${task.num_frames} | video_id=${updatedTask.video_id || '-'}`);
  } catch (error) {
    const errorMsg = getAgnesErrorMessage(error);
    updateVideoTask(localId, {
      status: 'failed',
      progress: 0,
      error: errorMsg || '视频任务提交失败',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rawResponse: error.response?.data ? stringifyCompactResponse(error.response.data) : '',
    });
    logError(`Agnes video create failed: ${errorMsg}`);
    logApiResponse({
      id: localId,
      apiRequestId: localId,
      user: task.user,
      model: 'agnes-video-v2.0',
      status: 'error',
      statusCode: error.response?.status || 0,
      error: errorMsg,
      rawResponse: error.response?.data ? stringifyCompactResponse(error.response.data) : '',
    });
  }
}

app.post('/api/video-generate/create', auth, async (req, res) => {
  const username = req.username;
  const localId = 'vid_' + Date.now() + '_' + crypto.randomBytes(3).toString('hex');
  try {
    const prompt = String(req.body.prompt || '').trim();
    const mode = normalizeVideoMode(req.body.mode);
    const imageUrls = Array.isArray(req.body.imageUrls)
      ? req.body.imageUrls.map(v => String(v || '').trim()).filter(Boolean)
      : [];
    const width = Number(req.body.width || 1152);
    const height = Number(req.body.height || 768);
    const numFrames = normalizeVideoFrameCount(req.body.num_frames || req.body.numFrames);
    const frameRate = Math.max(1, Math.min(30, Number(req.body.frame_rate || req.body.frameRate || 24)));
    const negativePrompt = String(req.body.negative_prompt || req.body.negativePrompt || '').trim();
    const seed = req.body.seed === '' || req.body.seed === undefined || req.body.seed === null ? null : Number(req.body.seed);

    if (!prompt) return res.status(400).json({ error: '请填写视频提示词' });
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 256 || height < 256) {
      return res.status(400).json({ error: '视频尺寸不正确' });
    }
    if (mode !== 'text') {
      if (!imageUrls.length) return res.status(400).json({ error: '当前模式需要提供参考图片' });
      const invalid = imageUrls.find(url => !isSupportedVideoImageInput(url));
      if (invalid) return res.status(400).json({ error: '参考图片需要是 http/https、Data URI Base64，或本地已上传图片路径' });
    }

    let upstreamPrompt = prompt;
    if (mode === 'multi') {
      upstreamPrompt = [
        prompt,
        '',
        '多图视频规则：这些图片是同一个视频的主体/场景/风格参考，不要把它们当作首尾关键帧，不要做从第一张到最后一张的变形转场。',
        '以第一张图片作为主要主体或起始视觉，其余图片只作为人物、场景、服装、光影、构图和风格参考，生成一个连续自然的视频镜头。'
      ].join('\n');
    }

    const body = {
      model: 'agnes-video-v2.0',
      prompt: upstreamPrompt,
      width,
      height,
      num_frames: numFrames,
      frame_rate: frameRate,
    };
    if (negativePrompt) body.negative_prompt = negativePrompt;
    if (Number.isFinite(seed)) body.seed = seed;
    const preparedImages = mode === 'text' ? [] : await prepareVideoImageInputs(imageUrls);
    if (mode !== 'text' && !preparedImages.length) return res.status(400).json({ error: '参考图片读取失败，请重新上传或检查图片地址' });
    const upstreamImages = preparedImages.map(item => item && typeof item === 'object' ? item.data : item).filter(Boolean);

    if (mode === 'image') {
      body.image = upstreamImages[0];
      body.mode = 'ti2vid';
    }
    if (mode === 'multi') {
      // The Agnes video gateway only accepts a string at top-level image.
      // Multi mode should receive a single composed reference board from the frontend.
      body.image = upstreamImages[0];
      body.mode = 'ti2vid';
    }
    if (mode === 'keyframes') {
      body.extra_body = { image: upstreamImages };
      body.extra_body.mode = 'keyframes';
    }

    if (preparedImages.length) {
      const imageSummary = preparedImages.map(item => {
        if (item && typeof item === 'object') return `${item.mime || 'image'}:${String(item.data || '').length}`;
        const raw = String(item || '');
        return raw.substring(0, 80);
      }).join(', ');
      logToFile(`[Agnes video image input] ${localId} mode=${mode} images=${preparedImages.length} pureBase64=${upstreamImages.length} ${imageSummary}`);
    }

    const submittedAt = new Date().toISOString();
    const task = {
      localId,
      user: username,
      model: 'agnes-video-v2.0',
      mode,
      prompt: prompt.substring(0, 1000),
      imageUrls: imageUrls.map(summarizeVideoImageInput),
      width,
      height,
      num_frames: numFrames,
      frame_rate: frameRate,
      seconds: String((numFrames / frameRate).toFixed(1)),
      task_id: localId,
      id: localId,
      video_id: '',
      status: 'submitting',
      progress: 0,
      keyHash: '',
      submittedAt,
      updatedAt: submittedAt,
      completedAt: null,
      videoUrl: '',
      error: null,
      rawResponse: '',
    };
    upsertVideoTask(task);
    logToFile(`🎬 Agnes 视频本地任务已创建，后台提交中 | user=${username} | mode=${mode} | ${width}x${height} | frames=${numFrames} | localId=${localId}`);
    setImmediate(() => {
      submitAgnesVideoTaskInBackground({
        task,
        body,
        imageCount: preparedImages.length,
        imagePaths: imageUrls.map(summarizeVideoImageInput),
      }).catch(err => logError(`Agnes video background submit wrapper failed: ${err.message}`));
    });
    res.json({ success: true, task });
  } catch (error) {
    const errorMsg = getAgnesErrorMessage(error);
    logError(`Agnes video create failed: ${errorMsg}`);
    logApiResponse({
      id: localId,
      apiRequestId: localId,
      user: username,
      model: 'agnes-video-v2.0',
      status: 'error',
      statusCode: error.response?.status || 0,
      error: errorMsg,
      rawResponse: error.response?.data ? stringifyCompactResponse(error.response.data) : '',
    });
    if (error.statusCode) return res.status(error.statusCode).json({ error: errorMsg });
    res.status(500).json({ error: errorMsg || '视频任务提交失败' });
  }
});

app.get('/api/video-generate/status', auth, async (req, res) => {
  try {
    const task = findVideoTask({
      localId: req.query.localId,
      taskId: req.query.task_id,
      videoId: req.query.video_id,
    }, req.username);
    if (!task) return res.status(404).json({ error: '视频任务不存在或已过期' });
    if (task.status === 'completed' || task.status === 'failed') {
      return res.json({ success: true, task });
    }
    const updated = await queryAgnesVideoTask(task);
    res.json({ success: true, task: updated });
  } catch (error) {
    const errorMsg = getAgnesErrorMessage(error);
    logError(`Agnes video status failed: ${errorMsg}`);
    if (error.statusCode) return res.status(error.statusCode).json({ error: errorMsg });
    res.status(500).json({ error: errorMsg || '查询视频任务失败' });
  }
});

app.get('/api/video-generate/tasks', auth, (req, res) => {
  const tasks = loadVideoTasks()
    .filter(t => t.user === req.username)
    .sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0))
    .slice(0, 100);
  res.json({ success: true, tasks });
});

// ===== Detail Replicate & Buyer Show AI Analysis =====
const aiTaskStore = new Map(); // In-memory store for AI analysis tasks

// Clean up old aiTaskStore entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [taskId, task] of aiTaskStore.entries()) {
    if (now - task.submittedAt > 30 * 60 * 1000) { // 30 minutes
      aiTaskStore.delete(taskId);
    }
  }
}, 5 * 60 * 1000);

finalizeStaleLegacySub2Singles();
recoverPendingSub2Tasks();

// Helper: convert uploaded/external image URL to GPT-5.5 input_image data URL
async function toInputImage(imageUrl, opts = {}) {
  const resolved = await resolveImage(imageUrl);
  if (!resolved) return null;
  const maxBytes = Number(opts.maxBytes || 0);
  if (maxBytes > 0 && resolved.buffer.length > maxBytes) {
    const limitMb = (maxBytes / 1024 / 1024).toFixed(0);
    const actualMb = (resolved.buffer.length / 1024 / 1024).toFixed(1);
    const err = new Error(`图片过大(${actualMb}MB)，请压缩到 ${limitMb}MB 以内后再让 GPT-5.5 分析`);
    err.statusCode = 413;
    logToFile(`[analysis] reject large image ${resolved.filename || ''}: ${resolved.buffer.length} bytes > ${maxBytes}`);
    throw err;
  }
  return { type: 'input_image', image_url: 'data:' + resolved.mime + ';base64,' + resolved.buffer.toString('base64') };
}

async function toChatImageUrl(imageUrl, opts = {}) {
  const resolved = await resolveImage(imageUrl);
  if (!resolved) return null;
  const maxBytes = Number(opts.maxBytes || 0);
  if (maxBytes > 0 && resolved.buffer.length > maxBytes) {
    const limitMb = (maxBytes / 1024 / 1024).toFixed(0);
    const actualMb = (resolved.buffer.length / 1024 / 1024).toFixed(1);
    const err = new Error(`图片过大(${actualMb}MB)，请压缩到 ${limitMb}MB 以内后再分析`);
    err.statusCode = 413;
    logToFile(`[analysis] reject large image ${resolved.filename || ''}: ${resolved.buffer.length} bytes > ${maxBytes}`);
    throw err;
  }
  return { type: 'image_url', image_url: { url: 'data:' + resolved.mime + ';base64,' + resolved.buffer.toString('base64') } };
}

function extractJsonText(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) return fenced[1].trim();
  const firstObj = raw.indexOf('{');
  const lastObj = raw.lastIndexOf('}');
  if (firstObj >= 0 && lastObj > firstObj) return raw.slice(firstObj, lastObj + 1);
  return raw;
}

function extractTextFromContentParts(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (!part) return '';
    if (typeof part === 'string') return part;
    if (typeof part.content === 'string') return part.content;
    if (typeof part.text === 'string') return part.text;
    if (typeof part.output_text === 'string') return part.output_text;
    if (typeof part.delta === 'string') return part.delta;
    return '';
  }).filter(Boolean).join('\n').trim();
}

function extractTextFromGpt55Object(data) {
  const choices = data?.choices || [];
  for (const choice of choices) {
    const text = extractTextFromContentParts(choice?.message?.content);
    if (text) return text;
  }

  if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const text = extractTextFromContentParts(item?.content);
    if (text) return text;
    if (typeof item?.text === 'string' && item.text.trim()) return item.text.trim();
  }

  const responseText = data?.response ? extractTextFromGpt55Object(data.response) : '';
  if (responseText) return responseText;

  const itemText = extractTextFromContentParts(data?.item?.content);
  if (itemText) return itemText;

  const partText = typeof data?.part?.text === 'string' ? data.part.text.trim() : '';
  if (partText) return partText;

  return '';
}

function extractTextFromGpt55Response(data) {
  if (typeof data === 'string') {
    const raw = data.trim();
    if (!raw) return '';
    if (!raw.includes('\ndata:') && !raw.startsWith('data:')) return raw;

    let deltaText = '';
    let doneText = '';
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const event = JSON.parse(payload);
        const eventText = extractTextFromGpt55Object(event);
        if (eventText && event.type !== 'response.output_text.delta') doneText = eventText;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          deltaText += event.delta;
        }
        if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
          doneText = event.text;
        }
      } catch (e) {
        // Some upstream SSE lines are keepalive/status-only events.
      }
    }
    return (doneText || deltaText || '').trim();
  }

  return extractTextFromGpt55Object(data);
}

async function callGpt54ForAnalysis(prompt, apiKey, imageUrls, opts = {}) {
  const API_BASE = 'https://www.6789api.top/v1';
  const chatImages = [];
  for (const img of (imageUrls || []).slice(0, 15)) {
    try {
      const inputImage = await toChatImageUrl(img, opts);
      if (inputImage) chatImages.push(inputImage);
    } catch (e) {
      if (e.statusCode) throw e;
      logError('GPT-5.4 image resolve failed: ' + e.message);
    }
  }

  const response = await axios.post(`${API_BASE}/chat/completions`, {
    model: 'gpt-5.4',
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...chatImages] }],
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.7,
    max_tokens: opts.maxTokens || 4096,
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 180000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  const text = extractTextFromGpt55Response(response.data);
  if (text) return text;
  const rawPreview = typeof response.data === 'string'
    ? response.data.substring(0, 1000)
    : JSON.stringify(response.data || {}).substring(0, 1000);
  logError(`GPT-5.4 empty text response (${opts.label || 'analysis'}): ${rawPreview}`);
  throw new Error('GPT-5.4 response format invalid');
}

// Helper: Call Sub2 GPT-5.5 main API for text/image understanding
async function callGpt55ForAnalysis(prompt, apiKey, imageUrls, opts = {}) {
  const API_BASE = 'https://api.94576354.xyz/v1';
  const inputImages = [];
  for (const img of (imageUrls || []).slice(0, 15)) {
    try {
      const inputImage = await toInputImage(img, opts);
      if (inputImage) inputImages.push(inputImage);
    } catch (e) {
      if (e.statusCode) throw e;
      logError('GPT-5.5 image resolve failed: ' + e.message);
    }
  }

  {
    const requestBody = {
      model: 'gpt-5.5',
      reasoning: { effort: opts.reasoningEffort || 'high' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, ...inputImages] }],
      stream: true,
    };
    if (opts.serviceTier) {
      requestBody.service_tier = opts.serviceTier;
    }
    const response = await axios.post(`${API_BASE}/responses`, requestBody, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 180000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      responseType: 'text',
      transformResponse: [data => data],
    });

    const text = extractTextFromGpt55Response(response.data);
    if (text) return text;

    const rawPreview = typeof response.data === 'string'
      ? response.data.substring(0, 1000)
      : JSON.stringify(response.data || {}).substring(0, 1000);
    logError(`GPT-5.5 empty text response (${opts.label || 'analysis'}): ${rawPreview}`);
    throw new Error('GPT-5.5 response format invalid');
  }

  // Compatibility path for Sub2 GPT-5.5 deployments that still expose
  // multimodal text through chat/completions during the responses rollout.
  const chatContent = [
    { type: 'text', text: prompt },
    ...inputImages.map(img => ({ type: 'image_url', image_url: { url: img.image_url } })),
  ];

  let response = null;
  let responseError = null;
  try {
    response = await axios.post(`${API_BASE}/responses`, {
      model: 'gpt-5.5',
      reasoning: { effort: 'high' },
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }, ...inputImages] }],
      stream: false,
    }, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 180000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    const text = extractTextFromGpt55Response(response.data);
    if (text) return text;
  } catch (e) {
    responseError = e;
    logError(`GPT-5.5 responses failed (${opts.label || 'analysis'}): ${e.response?.status || ''} ${e.response?.data?.error?.message || e.message}`);
  }

  const chatResponse = await axios.post(`${API_BASE}/chat/completions`, {
    model: 'gpt-5.5',
    messages: [{ role: 'user', content: chatContent }],
  }, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    timeout: 180000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  const chatText = extractTextFromGpt55Response(chatResponse.data);
  if (chatText) return chatText;

  const rawPreview = responseError
    ? (responseError.response?.data ? JSON.stringify(responseError.response.data).substring(0, 500) : responseError.message)
    : (typeof response?.data === 'string'
      ? response.data.substring(0, 500)
      : JSON.stringify(response?.data || {}).substring(0, 500));
  const chatPreview = typeof chatResponse.data === 'string'
    ? chatResponse.data.substring(0, 500)
    : JSON.stringify(chatResponse.data || {}).substring(0, 500);
  logError(`GPT-5.5 empty text response (${opts.label || 'analysis'}): responses=${rawPreview} chat=${chatPreview}`);
  throw new Error('GPT-5.5 返回格式异常');
}

function buildFallbackBuyerShowScenes(extraDesc) {
  const note = extraDesc ? `，结合用户补充：${extraDesc}` : '';
  return [
    {
      title: '真实客厅晚间开灯',
      prompt: `真实家庭客厅买家秀${note}，灯具已经安装并点亮，手机随手拍视角，暖色生活氛围，有沙发、茶几和少量生活杂物，画面自然不过度精修，不要棚拍，不要广告海报，不要水印文字。`
    },
    {
      title: '卧室床头温馨氛围',
      prompt: `真实卧室买家秀${note}，灯具在床头或房间主视觉区域点亮，柔和暖光照亮床品和墙面，像用户晚上回家随手拍的照片，构图轻微倾斜也可以，保留生活感，不要品牌logo，不要文字水印。`
    },
    {
      title: '餐厅餐桌生活场景',
      prompt: `真实餐厅或开放式厨房买家秀${note}，灯具悬挂或摆放在餐桌附近并自然发光，桌面有杯子、餐盘或绿植等真实生活物件，手机拍摄质感，光线自然，避免商业摄影棚效果，不要广告海报。`
    }
  ];
}

function buildLightingDetailRuleSummary(opts = {}) {
  const hasRefs = !!opts.hasRefs;
  const screenCount = Number(opts.screenCount || 0) || 1;
  return [
    '你擅长灯饰照明类目详情页策划，重点服务吊灯、吸顶灯、壁灯、落地灯、风扇灯、魔豆灯、水晶灯、新中式灯等产品。',
    '你的目标不是泛化美图，而是生成更像成熟电商详情页的高转化分屏提示词。',
    `优先按“吸引定调 → 信任建立 → 场景向往 → 卖点拆解 → 工艺证明 → 光效演示 → 规格参数 → 安装/服务收尾”的叙事逻辑组织${screenCount}屏内容。若参考图屏序明显不同，以参考图屏序为主，但仍要让每屏承担清晰销售任务。`,
    '每屏提示词都必须同时覆盖：主题、核心卖点文案、构图方式、场景氛围、材质细节、发光效果、文字排版位置与信息层级。',
    '必须保持灯具真实结构、材质、颜色、比例、安装逻辑、发光方向和色温，不要替换灯型，不要虚构品牌logo，不要加水印，不要把灯改成别的款式。',
    '每屏都要明确属于哪种详情页职责：首屏海报、品牌定位、认证信任、卖点提炼、场景展示、材质细节、工艺结构、光效演示、规格参数、安装说明或服务保障。',
    '详情页核心必覆盖：首屏定调、真实场景、材质细节、亮灯光效、规格参数、服务保障；屏数较多时再加入品牌灵感、认证背书、工艺拆解、安装适配和对比说明。',
    '参考 12 屏节奏：1首屏海报，2品牌/设计灵感，3认证/荣誉/专利，4核心卖点，5主场景，6第二场景，7材质细节，8工艺结构，9光效演示，10规格参数，11安装说明，12服务保障。按用户屏数裁剪组合，不要机械凑满。',
    '灯具类画面优先考虑：尺度参照、灯体材质反光、金属/玻璃/亚克力/云石/木纹等真实纹理、上发光与下发光的区别、真实家庭或商业空间安装关系。',
    '生活场景要避免廉价感和纯棚拍感，优先使用真实室内空间、自然杂物、暖光氛围、可落地的家居搭配；如果产品更偏高端，画面要留白克制、信息层级清晰。',
    '场景必须匹配品类：客厅吊灯用客厅沙发区，卧室吸顶灯用主卧床头区，餐厅吊灯用餐桌正上方，新中式灯用茶室/实木/水墨空间，线性灯用餐厨或现代空间，台灯/落地灯用局部生活角落。',
    '光线要写具体，不要只写氛围感：产品自发光2700K-3000K暖光、自然窗光、天花板光斑、玻璃/水晶折射、磨砂灯罩透光、柔和光池、上发光/下发光方向。',
    '参数/规格屏要强调尺寸、安装高度、适配桌长或空间关系、控制方式、功率/色温等信息，构图更偏白底参数图或工程说明图，不要全部都做成生活场景。',
    '工艺/技术屏要强调显色性、无频闪、防眩、灯罩纹理、金属工艺、结构细节、光学效果等“能建立品质信任”的可视化信息，必要时可加入芯片/光谱/承重/工艺步骤等证据化表达。',
    '功能屏可以优先考虑高转化灯具卖点：三色变光、无极调光调色、智能控制（遥控器/APP/米家/天猫精灵/壁控）、高显色、护眼、防频闪、上下发光、全光谱、安装适配。',
    '如果某一屏适合做对比，请优先使用可视化对比而不是纯说明文字，例如：Ra97 vs 低显色、亮度/材质/尺寸对比、开灯 vs 关灯、冷光 vs 暖光、不同规格适配不同空间。',
    '信任建立屏除了品牌感，还可以使用证书、专利、质保、榜单/认证、服务承诺、线下门店、原创设计、工艺标准、真实实测等“证据型元素”，但避免低端促销堆砌。',
    '排版上优先使用成熟电商详情页常见结构：大标题+副标题、图标卖点网格、左右对比栏、底部参数条、白底参数表、局部放大标注线、开关灯双图、手机实拍小证据图。',
    '文字要短而像电商文案，主标题尽量8字以内，可用四字短语组合；不要生成大段说明文字，不要让文字压住灯具主体。',
    '普通商品不要默认加入618、政府补贴、价格促销、排行榜等活动信息，除非用户补充说明明确要求。需要信任元素时可以写证书/专利/质保/服务承诺的视觉区域，不要虚构编号和品牌logo。',
    '根据产品风格自动匹配视觉语言：法式中古偏奶油白/灰驼/焦糖棕/石膏线/油画/亚麻窗帘；新中式偏宣纸白/墨绿/朱砂红/实木茶台/水墨画/云纹；现代轻奢偏暖金/哑光黑/水晶/大理石/落地窗/天花光斑；法式奶油偏拱形画框/花卉油画/莫兰迪色；设计师极简偏浅灰白/大留白/少文字/线条感；科技轻奢偏深色背景/金色参数/智能图标/非对称网格；品牌信任偏深蓝或黑金/证书/奖杯/服务矩阵。',
    hasRefs
      ? '有参考图时：每一屏先判断该参考图更像信任屏、场景屏、功能屏、工艺屏、参数屏还是收尾屏，再生成更适合当前灯具商品的提示词；可以借鉴版式与构图，但不要逐字逐元素照搬。'
      : '无参考图时：请主动给出合理屏序，不要每屏都只换一个场景；至少要兼顾场景展示、卖点说明、工艺细节和规格说明。',
    '输出的 prompt 必须能直接用于生图，文字具体、画面可执行，不要空泛形容词堆砌。'
  ].join('\n');
}

function buildLightingMainImageRuleSummary(opts = {}) {
  const mainImageCount = Number(opts.mainImageCount || 0) || 1;
  const mainImageRatio = String(opts.mainImageRatio || '2048x2048');
  const platform = String(opts.mainImagePlatform || opts.platform || 'taobao') === 'pdd' ? 'pdd' : 'taobao';
  if (platform === 'pdd') {
    const slots = Array.from({ length: mainImageCount }, (_, i) => {
      const n = i + 1;
      if (n === 1) return '拼多多主图1：最强搜索首图。真实家居场景里灯具主体最大最清晰，占比约55%-70%，场景简洁但可见空间关系，核心卖点和比价利益点在底部或侧边短标签呈现。';
      if (n === 2) return '拼多多主图2：换角度场景首图。仍以灯具主视觉为核心，占比约50%-65%，用不同真实空间角度展示结构和点亮效果，文字只保留1-3个高转化卖点。';
      if (n === 3) return '拼多多主图3：亮灯场景首图。灯具主体依然最大，在真实室内场景中突出暖光、天花光斑、透光材质或上下发光效果，背景弱化但必须是场景图。';
      if (n === 4) return '拼多多主图4：材质卖点场景首图。在真实场景中用近景或局部特写突出金属、玻璃、水晶、亚克力、云石、木纹等质感，搭配短标签说明核心优势。';
      if (n === 5) return '拼多多主图5：规格/适配场景首图。灯具主体大，真实空间里辅以简短尺寸、适用空间、灯头数量或安装关系信息，像搜索页里能快速比较的主视觉。';
      return `拼多多主图${n}：继续按搜索页场景主图标准输出，灯具主体占比保持50%以上，从真实空间角度、光效、材质、卖点标签或场景类型中拉开差异，但每张都必须能单独当首图。`;
    });
    return [
      `额外生成${mainImageCount}张拼多多电商主图提示词，主图比例固定为${mainImageRatio}。拼多多每张主图都可能出现在搜索页，所以每张都要能单独承担首图点击转化，不按淘宝轮播“职责递进”来写。`,
      '拼多多主图核心是“灯具主视觉 + 快速比价/卖点识别”，每张都要让用户在搜索页小图里一眼看清商品、款式、亮点和购买理由。',
      '每张主图都必须是场景图，不能使用纯色背景、白底、浅灰棚拍或单纯产品抠图。场景可以是客厅、餐厅、卧室、茶室、书房、餐厨等真实或轻场景，但必须服务灯具主体。',
      '每张主图都必须以灯具主体为绝对核心，主体占画面建议50%-70%；场景背景要简洁、弱化、可感知空间关系，不能让完整家居场景抢走注意力。',
      '每张都可以有短标题、卖点标签、利益点或比价信息区域，但文字必须短、粗、醒目，优先写“同款比价感、核心材质、包安装/质保/护眼/高显色/尺寸适配”等，不要长篇参数。',
      '不要默认写具体价格、618、政府补贴、排行榜或虚假认证，除非用户补充说明明确提供；可以写“价格优势区/活动标签区/服务标签区”的视觉区域。',
      '主图之间可以换真实空间、换角度、换光效、换卖点标签、换景别，但不能变成详情页分屏，也不能只有氛围没有商品。',
      '必须保持商品真实结构、材质、颜色、灯头数量、金属与灯罩细节、发光方向和安装逻辑，不能为了转化改款式。',
      '灯具发光写具体：2700K-3000K暖光、天花板光斑、玻璃/水晶折射、磨砂灯罩透光、柔和光池、上发光/下发光方向。',
      '每张 prompt 必须明确写出：画幅比例、拼多多搜索页场景主图、主体占比、灯具角度、点亮状态、具体场景类型、场景弱化方式、卖点标签位置、文字控制程度、镜头和光线。',
      '请按下面顺序生成，但每张都必须能单独作为搜索页首图展示：',
      ...slots
    ].join('\n');
  }
  const slots = Array.from({ length: mainImageCount }, (_, i) => {
    const n = i + 1;
    if (n === 1) return '主图1：核心转化主图。主体完整清晰，产品占比约40%-55%，画面干净，适合作为商品首图；优先真实轻场景或高级浅背景。';
    if (n === 2) return '主图2：场景氛围主图。真实家居空间，灯具点亮，产品占比约30%-45%，突出家的温暖、空间代入感和安装关系。';
    if (n === 3) return '主图3：亮灯光效主图。突出2700K-3000K暖光、天花板光斑、光晕、上/下发光方向、空间照明效果。';
    if (n === 4) return '主图4：材质工艺主图。近景或特写，突出黄铜、水晶、玻璃、亚克力、云石、木纹、灯罩纹理、金属反光。';
    if (n === 5) return '主图5：结构/规格卖点主图。展示灯体层次、灯头数量、尺寸比例、组合形态、安装关系或适配空间，文字仍保持克制。';
    return `主图${n}需要在前面主图基础上继续拉开差异，可从角度、背景、光效、景别、卖点重心中至少变化两项，避免重复出图。`;
  });
  return [
    `额外生成${mainImageCount}张电商主图提示词，主图比例固定为${mainImageRatio}，定位是用于商品首页首图，不是详情页长图。`,
    '主图的首要目标是突出灯具主体本身，构图要更聚焦，主体识别要更强，不要做成长详情页信息流。',
    '主图之间必须做出清晰区分，不要只是换背景或轻微改角度，要让每一张承担不同销售职责。',
    '每张主图都要明确写出：画幅比例、主图类型、主体角度、景别、点亮状态、背景风格、主体占画面比例、核心卖点、文案留白位置、镜头感和光线。',
    '主图可以有极少量高级感文案或卖点标签，但必须克制，不要密集参数，不要做成详情页分屏，也不要堆满小字。',
    '主图必须保持商品真实结构、材质、颜色、灯头数量、金属与灯罩细节、发光方向和安装逻辑，不能为了好看改款式。',
    '灯具主图优先使用实景场景，真实客厅、卧室、餐厅、茶室、书房等空间比纯白底更有转化感；高端极简产品可以使用浅灰白留白棚拍。',
    '如果做白底或浅灰白主图，要有高级布光、真实阴影、清晰边缘和材质反光；如果做轻场景主图，背景必须简洁，不能喧宾夺主。',
    '对灯具类主图，优先强调产品轮廓识别度、层次结构、发光质感、材质反光与安装逻辑，不要引入无关人物或复杂摆件分散注意力。',
    '灯具发光建议写具体：2700K-3000K暖光、天花板光斑、玻璃/水晶折射、磨砂灯罩透光、柔和光池、上发光/下发光方向。',
    '场景要匹配品类：客厅吊灯用客厅沙发区，卧室吸顶灯用主卧床头区，餐厅吊灯用餐桌正上方，新中式灯用茶室/实木/水墨空间，线性灯用餐厨或现代空间，台灯/落地灯用局部生活角落。',
    '文案只能作为点缀，优先使用短标题、短卖点、角标或小标签，且需要明确文字区域留白，避免压住灯具主体；普通商品不要默认写618、政府补贴、价格促销，除非用户补充说明明确要求。',
    '主图提示词要具体到材质、空间、光线、构图、镜头，不要写“高级感、好看、氛围感”这种空词。',
    '请按下面的主图角色顺序分别生成，不要省略，不要互相混淆：',
    ...slots
  ].join('\n');
}

function normalizeDetailReplicateAnalysisResult(rawJson, opts = {}) {
  const hasRefs = !!opts.hasRefs;
  const detailCount = Math.min(Math.max(parseInt(opts.screenCount || 1, 10), 1), 20);
  const mainImageCount = Math.min(Math.max(parseInt(opts.mainImageCount || 5, 10), 1), 10);
  const detailRatio = String(opts.ratio || '1152x2048');
  const mainImageRatio = String(opts.mainImageRatio || '2048x2048');
  const productImages = Array.isArray(opts.productImages) ? opts.productImages : [];
  const refImages = Array.isArray(opts.refImages) ? opts.refImages : [];
  const refNames = Array.isArray(opts.refNames) ? opts.refNames : [];
  const detailSource = Array.isArray(rawJson?.detailScreens) ? rawJson.detailScreens : (Array.isArray(rawJson?.screens) ? rawJson.screens : []);
  const mainSource = Array.isArray(rawJson?.mainImages) ? rawJson.mainImages
    : (Array.isArray(rawJson?.mainImageScreens) ? rawJson.mainImageScreens
    : (Array.isArray(rawJson?.covers) ? rawJson.covers : []));

  const detailScreens = Array.from({ length: detailCount }, (_, i) => {
    const s = detailSource[i] || {};
    const imgUrls = hasRefs ? [...productImages.slice(0, 1), refImages[i]].filter(Boolean) : productImages.slice(0, 3);
    return {
      name: s.name || `第${i + 1}屏`,
      type: s.type || (hasRefs ? (refNames[i] || `参考图${i + 1}`) : `第${i + 1}屏`),
      prompt: s.prompt || '',
      status: '',
      confirmed: false,
      _imgUrls: imgUrls,
      refName: hasRefs ? (refNames[i] || '') : '',
      group: 'detail',
      ratio: detailRatio
    };
  });

  const mainImages = Array.from({ length: mainImageCount }, (_, i) => {
    const s = mainSource[i] || {};
    return {
      name: s.name || `主图${i + 1}`,
      type: s.type || '主图',
      prompt: s.prompt || '',
      status: '',
      confirmed: false,
      _imgUrls: productImages.slice(0, 3),
      refName: '',
      group: 'main',
      ratio: mainImageRatio
    };
  });

  return {
    screens: [...mainImages, ...detailScreens],
    detailScreens,
    mainImages
  };
}

async function runDetailReplicateAnalysis(body, username) {
  const {
    productImages,
    refImages,
    refNames,
    screenCount,
    ratio,
    extraDesc,
    mainImageCount,
    mainImageRatio,
    mainImagePlatform,
    pddTemplateId,
    analysisModel
  } = body || {};
  const apiKey = getSub2ApiKey();
  if (!apiKey) throw new Error('Sub2 API Key is not configured');
  const pddTemplate = getPddDetailTemplateById(pddTemplateId, username);
  const templateScreens = pddTemplate && Array.isArray(pddTemplate.screens) ? pddTemplate.screens : [];
  const templateImageBase = pddTemplate ? String(pddTemplate.imageBase || '') : '';
  const effectiveRefImages = pddTemplate
    ? templateScreens.map(s => templateImageBase + String(s.file || '')).filter(Boolean)
    : (Array.isArray(refImages) ? refImages : []);
  const effectiveRefNames = pddTemplate
    ? templateScreens.map((s, i) => s.name || `拼多多套版第${i + 1}屏`)
    : refNames;
  const hasRefs = effectiveRefImages.length > 0;
  const detailCount = Math.min(Math.max(parseInt(hasRefs ? effectiveRefImages.length : (screenCount || 1), 10), 1), 20);
  const parsedMainCount = mainImageCount === undefined || mainImageCount === null || mainImageCount === ''
    ? 5
    : parseInt(mainImageCount, 10);
  const mainCount = hasRefs ? 0 : Math.min(Math.max(Number.isFinite(parsedMainCount) ? parsedMainCount : 5, 0), 10);
  const detailRatio = String(ratio || '1152x2048');
  const coverRatio = String(mainImageRatio || '2048x2048');
  const mainPlatform = String(mainImagePlatform || 'taobao') === 'pdd' ? 'pdd' : 'taobao';
  const lightingRules = buildLightingDetailRuleSummary({ hasRefs, screenCount: detailCount });
  const mainImageRules = buildLightingMainImageRuleSummary({ mainImageCount: mainCount, mainImageRatio: coverRatio, mainImagePlatform: mainPlatform });
  let prompt = '';
  let images = [];

  if (hasRefs) {
    if (pddTemplate) {
      prompt = `你是拼多多灯具详情页套版专家。现在有产品图和一套固定拼多多详情页模板图。请生成${detailCount}屏详情页生图提示词，不生成主图。\n`;
      prompt += `套版名称：${pddTemplate.name || pddTemplate.id}。模板品类：${pddTemplate.category || '灯具'}。\n`;
      prompt += `图片输入顺序：前${(productImages || []).length}张是用户当前灯具产品图；后${effectiveRefImages.length}张是固定拼多多详情页模板图，第1张模板图对应第1屏，第2张模板图对应第2屏，以此类推。\n`;
      prompt += `套版总规则：${pddTemplate.analysisRule || '严格按模板套版，只替换商品和文案。'}\n`;
      prompt += `每屏模板用途：\n`;
      templateScreens.slice(0, detailCount).forEach((s, i) => {
        prompt += `${i + 1}. ${s.name || `第${i + 1}屏`}｜${s.type || '套版屏'}｜${s.intent || '按模板套版'}\n`;
      });
      prompt += `核心目标：保留每张模板图的版式结构、黑金轻奢视觉、分区比例、标题层级、卖点卡片、参数标注线、底部对比模块和拼多多高转化信息密度；只把旧灯具替换成用户产品图中的灯具，并按当前灯具重写中文文案。\n`;
      prompt += `强约束：不要改变模板大结构；不要保留模板旧产品、旧品牌、旧型号、旧价格；不要生成另一套全新设计；不要丢失优势总览、安装规格、实拍展示、细节拼图、参数表等核心模块；参数不确定时使用“约/可按规格定制/请以实物参数为准”等安全表述。\n`;
    } else {
      prompt = `你是电商详情页复刻与改版专家。现在有产品图和按顺序上传的参考详情页图片。请生成${detailCount}屏详情页生图提示词${mainCount > 0 ? `，并额外生成${mainCount}张主图生图提示词` : ''}。\n`;
      prompt += `图片输入顺序：前${(productImages || []).length}张是产品图；后${effectiveRefImages.length}张是参考详情页，第1张参考图对应第1屏，第2张参考图对应第2屏，以此类推。\n`;
      prompt += `核心目标：使用产品图中的商品，参考对应参考图的版式结构、构图节奏、信息层级、文字排版、场景氛围、色彩关系和视觉表达，生成“类似布局但不是抄袭”的详情页画面提示词。\n`;
    }
    prompt += `灯具详情页分析规则：\n${lightingRules}\n`;
    if (mainCount > 0) prompt += `灯具主图分析规则：\n${mainImageRules}\n`;
    prompt += `每屏详情页提示词必须明确：产品图为主商品来源，参考图为当前屏布局/场景/排版参考；保留商品真实结构、材质、颜色和卖点，不要虚构品牌logo，不要水印。\n`;
    prompt += `详情页图片比例：${detailRatio}。${mainCount > 0 ? `主图图片比例：${coverRatio}。主图平台：${mainPlatform === 'pdd' ? '拼多多主图' : '淘宝主图'}。` : ''}补充说明：${extraDesc || '无'}。\n`;
    prompt += `输出要求：detailScreens 必须按屏序返回。${mainCount > 0 ? 'mainImages 按顺序对应主图1、主图2、主图3... 的角色槽位逐一返回。' : 'mainImages 必须返回空数组。'}\n`;
    prompt += `只返回严格JSON：{"detailScreens":[{"name":"第1屏","type":"参考图文件名或屏类型","prompt":"详细生图提示词"}],"mainImages":[{"name":"主图1","type":"主图","prompt":"详细生图提示词"}]}。detailScreens必须返回${detailCount}屏，mainImages必须返回${mainCount}张。`;
    images = [...(productImages || []), ...effectiveRefImages];
  } else {
    prompt = `你是一个电商详情页专家。只根据产品图片和用户补充说明，生成${detailCount}屏详情页方案，并额外生成${mainCount}张主图方案。\n`;
    prompt += `灯具详情页分析规则：\n${lightingRules}\n`;
    prompt += `灯具主图分析规则：\n${mainImageRules}\n`;
    prompt += `产品类型/补充说明：${extraDesc || '未指定'}\n`;
    prompt += `详情页图片比例：${detailRatio}\n`;
    prompt += `主图图片比例：${coverRatio}\n`;
    prompt += `主图平台：${mainPlatform === 'pdd' ? '拼多多主图' : '淘宝主图'}\n`;
    prompt += `要求：详情页每屏都要有明确主题、卖点文案、构图、场景、材质细节、光影和排版说明；主图要更聚焦商品主体和首页点击转化，不要依赖参考图。mainImages 必须按主图1、主图2、主图3... 的角色槽位顺序输出。只返回严格JSON：{"detailScreens":[{"name":"屏名称","type":"屏类型","prompt":"详细提示词"}],"mainImages":[{"name":"主图1","type":"主图","prompt":"详细提示词"}]}。detailScreens必须返回${detailCount}屏，mainImages必须返回${mainCount}张。`;
    images = productImages || [];
  }

  const useGpt54 = String(analysisModel || '').toLowerCase() === 'gpt-5.4';
  const analysisResult = useGpt54
    ? await callGpt54ForAnalysis(prompt, apiKey, images, { label: 'detail-replicate analyze', temperature: 0.7, maxTokens: 4096 })
    : await callGpt55ForAnalysis(prompt, apiKey, images, { label: 'detail-replicate analyze' });
  const screensJson = JSON.parse(extractJsonText(analysisResult));
  return normalizeDetailReplicateAnalysisResult(screensJson, {
    hasRefs,
    screenCount: detailCount,
    ratio: detailRatio,
    mainImageCount: mainCount,
    mainImageRatio: coverRatio,
    productImages,
    refImages: effectiveRefImages,
    refNames: effectiveRefNames
  });
}

// POST /api/detail-replicate/analyze
app.post('/api/detail-replicate/analyze', auth, async (req, res) => {
  const { autoByRefs } = req.body;
  const apiKey = getSub2ApiKey();
  if (!apiKey) return res.status(500).json({ error: '管理员尚未配置 Sub2 API Key' });
  try {
    const result = await runDetailReplicateAnalysis(req.body || {}, req.username);
    res.json(result);
  } catch (error) {
    console.error('Detail replicate analyze error:', error);
    res.status(500).json({ error: error.message || '分析失败' });
  }
});

// POST /api/detail-replicate/analyze-async
app.post('/api/detail-replicate/analyze-async', auth, async (req, res) => {
  const taskId = String(req.body?.taskId || ('detail_ai_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8))).replace(/[^a-zA-Z0-9_-]/g, '');
  const existing = aiTaskStore.get(taskId);
  if (existing && existing.user === req.username) {
    return res.json({ task_id: taskId, status: existing.status });
  }
  aiTaskStore.set(taskId, {
    type: 'detail-replicate-analyze',
    user: req.username,
    status: 'pending',
    submittedAt: Date.now(),
    result: null,
    error: null
  });
  (async () => {
    try {
      const result = await runDetailReplicateAnalysis(req.body || {}, req.username);
      const task = aiTaskStore.get(taskId);
      if (task) {
        task.status = 'success';
        task.result = result;
        task.completedAt = Date.now();
      }
    } catch (error) {
      console.error('Detail replicate async analyze error:', error);
      const task = aiTaskStore.get(taskId);
      if (task) {
        task.status = 'error';
        task.error = error.message || 'analyze failed';
        task.completedAt = Date.now();
      }
    }
  })();
  res.json({ task_id: taskId, status: 'pending' });
});

// POST /api/detail-replicate/pdd-template/unlock
app.post('/api/detail-replicate/pdd-template/unlock', auth, (req, res) => {
  const template = getPddDetailTemplateByCode(req.body?.code, req.username);
  if (!template) return res.status(403).json({ error: '套餐码无效或当前用户无权限' });
  res.json({ template: publicPddTemplatePayload(template) });
});

// GET /api/detail-replicate/analyze-status
app.get('/api/detail-replicate/analyze-status', auth, (req, res) => {
  const taskId = String(req.query.task_id || '');
  const task = aiTaskStore.get(taskId);
  if (!task || task.type !== 'detail-replicate-analyze') {
    return res.status(404).json({ error: 'analysis task not found' });
  }
  if (task.user !== req.username) return res.status(403).json({ error: 'forbidden' });
  res.json({
    task_id: taskId,
    status: task.status,
    screens: task.result?.screens || [],
    error: task.error || null,
    submittedAt: task.submittedAt,
    completedAt: task.completedAt || null
  });
});

// POST /api/buyer-show/suggest-scenes
app.post('/api/buyer-show/suggest-scenes', auth, async (req, res) => {
  const { productImages, extraDesc } = req.body;
  const apiKey = getSub2ApiKey();
  if (!apiKey) return res.status(500).json({ error: '管理员尚未配置 Sub2 API Key' });
  const prompt = `你是电商买家秀场景策划专家。根据上传的灯具图片和用户补充，写3个真实买家秀场景提示词。要求真实手机拍摄感，不要棚拍，不要广告海报，不要水印文字。用户补充：${extraDesc || '无'}。只返回JSON：{"scenes":[{"title":"场景标题","prompt":"可直接用于生成图片的详细中文提示词"}]}`;
  try {
    const text = await callGpt55ForAnalysis(prompt, apiKey, productImages || [], {
      maxBytes: 10 * 1024 * 1024,
      label: 'buyer-show suggest-scenes',
    });
    const data = JSON.parse(extractJsonText(text));
    const scenes = data.scenes || [];
    return res.json({ scenes });
  } catch (error) {
    logError('Buyer show suggest failed: ' + (error.response?.data?.error?.message || error.message));
    return res.status(error.statusCode || 500).json({ error: error.response?.data?.error?.message || error.message || '生成场景失败' });
  }
});

// Legacy suggest-scenes implementation kept for source diff context only.
if (false) app.post('/api/buyer-show/suggest-scenes', auth, async (req, res) => {
  const { productImages, extraDesc } = req.body;
  const apiKey = getSub2ApiKey();
  if (!apiKey) return res.status(500).json({ error: '管理员尚未配置 Sub2 API Key' });
  try {
    const prompt = `你是电商买家秀场景策划专家。根据上传的灯具图片，写3个真实买家秀场景提示词。要求真实手机拍摄感，不要棚拍，不要广告海报，不要水印文字。用户补充：${extraDesc || '无'}。只返回3个场景。返回JSON：{"scenes":[{"title":"场景标题","prompt":"可直接用于生成图片的详细中文提示词"}]}`;
    const text = await callGpt55ForAnalysis(prompt, apiKey, productImages || [], {
      maxBytes: 10 * 1024 * 1024,
      label: 'buyer-show suggest-scenes',
    });
    const data = JSON.parse(extractJsonText(text));
    const scenes = data.scenes || [];
    res.json({ scenes });
  } catch (error) {
    console.error('Buyer show suggest error:', error);
    res.status(500).json({ error: error.message || '生成场景失败' });
  }
});

// POST /api/buyer-show/analyze
app.post('/api/buyer-show/analyze', auth, async (req, res) => {
  const { productImages, scenePrompt, count, ratio } = req.body;
  const apiKey = getSub2ApiKey();
  if (!apiKey) return res.status(500).json({ error: '管理员尚未配置 Sub2 API Key' });
  try {
    const n = Math.min(Math.max(parseInt(count || 4, 10), 1), 15);
    let prompt = `你是一个真实买家秀摄影导演。根据灯具产品图片和用户场景要求，拆解生成${n}张真实买家秀照片的不同提示词。\n`;
    prompt += `用户场景要求：${scenePrompt || '真实家庭买家秀'}\n`;
    prompt += `输出比例：${ratio || '1536x2048'}，画质2K。\n`;
    prompt += `要求：真实手机拍摄感、生活化、有轻微自然杂物、保留灯具主体结构/材质/色温/安装逻辑、不要棚拍、不要广告海报、不要水印文字、不要虚假品牌logo。每张要有不同构图/人物动作/空间细节。返回严格JSON：{"photos":[{"scene":"照片标题","prompt":"详细生图提示词"}]}`;
    const text = await callGpt55ForAnalysis(prompt, apiKey, productImages || []);
    const data = JSON.parse(extractJsonText(text));
    const photos = (data.photos || data.scenarios || []).slice(0, n).map((p, i) => ({ scene: p.scene || p.name || `买家秀${i+1}`, prompt: p.prompt || '' }));
    res.json({ photos });
  } catch (error) {
    console.error('Buyer show analyze error:', error);
    res.status(500).json({ error: error.message || '分析失败' });
  }
});

// POST /api/buyer-show/extend-analyze
app.post('/api/buyer-show/extend-analyze', auth, async (req, res) => {
  const { sourceImage, productImages, scenePrompt, count, ratio, sourceType } = req.body;
  const apiKey = getSub2ApiKey();
  if (!apiKey) return res.status(500).json({ error: '管理员尚未配置 Sub2 API Key' });
  if (!sourceImage) return res.status(400).json({ error: '缺少用于拓展的场景图或买家秀照片' });
  try {
    const n = Math.min(Math.max(parseInt(count || 4, 10), 1), 15);
    let prompt = `你是电商真实买家秀摄影导演。请先认真分析参考图1（${sourceType === 'uploaded-scene' ? '用户直接上传的场景图' : '已选中的买家秀照片'}）。\n`;
    prompt += `目标：基于同一张参考买家秀，只输出${n}个“更换拍摄视角”的简短提示词。\n`;
    prompt += `核心要求：必须还是同一个房间、同一盏灯、同一装修、同一生活氛围、同一手机随手拍质感，只允许改变拍摄机位/远近/高低/横竖构图/局部取景。绝对不要换灯具，不要改房间，不要改家具关系，不要重做场景。\n`;
    prompt += `用户当前场景提示词：${scenePrompt || '真实家庭买家秀'}\n`;
    prompt += `每条只要输出简洁、直接可生图的提示词，尽量短，不要写成长篇大论。返回严格JSON：{"views":[{"scene":"视角标题","prompt":"简短提示词"}]}`;
    const images = [sourceImage];
    const text = await callGpt55ForAnalysis(prompt, apiKey, images);
    const data = JSON.parse(extractJsonText(text));
    const views = (data.views || data.photos || data.scenarios || []).slice(0, n).map((p, i) => ({ scene: p.scene || p.name || p.title || `拓展视角${i+1}`, prompt: p.prompt || '' }));
    res.json({ views });
  } catch (error) {
    console.error('Buyer show extend analyze error:', error);
    res.status(500).json({ error: error.message || '拓展视角分析失败' });
  }
});

// Save task history
app.post('/api/task-history', auth, (req, res) => {
  const { imageUrl, prompt, model, size, quality, duration, status } = req.body;
  const history = loadHistory();
  if (!history[req.username]) history[req.username] = [];
  history[req.username].unshift({
    id: 'hist_' + Date.now(),
    imageUrl,
    prompt,
    model,
    size,
    quality,
    duration,
    status,
    createdAt: new Date().toISOString()
  });
  // Keep last 200
  if (history[req.username].length > 200) history[req.username] = history[req.username].slice(0, 200);
  saveHistory(history);
  res.json({ success: true });
});

// Get task history
app.get('/api/task-history', auth, (req, res) => {
  const history = loadHistory();
  res.json({ history: history[req.username] || [] });
});

// Delete task history entry
app.delete('/api/task-history/:id', auth, (req, res) => {
  const history = loadHistory();
  if (history[req.username]) {
    history[req.username] = history[req.username].filter(h => h.id !== req.params.id);
    saveHistory(history);
  }
  res.json({ success: true });
});

app.post('/api/buyer-show/download-zip', auth, async (req, res) => {
  try {
    const { sourceImage, images, filename } = req.body || {};
    const items = [];
    if (sourceImage) items.push({ url: sourceImage, label: '选中的买家秀图片' });
    (Array.isArray(images) ? images : []).forEach((img, i) => {
      if (img && img.url) items.push({ url: img.url, label: img.label || `拓展视角${i + 1}` });
    });
    if (!items.length) return res.status(400).json({ error: '没有可打包下载的图片' });

    const used = new Set();
    const entries = [];
    for (let i = 0; i < items.length; i++) {
      const resolved = await resolveImage(items[i].url);
      if (!resolved) continue;
      const safeLabel = sanitizePathSegment(items[i].label || `图片${i + 1}`);
      const ext = imageExtFromMime(resolved.mime, resolved.filename);
      const name = uniqueZipName(`${String(i + 1).padStart(2, '0')}_${safeLabel}.${ext}`, used);
      entries.push({ name, buffer: resolved.buffer });
    }

    if (!entries.length) return res.status(404).json({ error: '图片读取失败，无法打包下载' });
    const zip = buildZip(entries);
    const zipName = sanitizePathSegment(filename || `买家秀拓展视角_${Date.now()}`) + '.zip';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    res.setHeader('Cache-Control', 'no-cache');
    res.send(zip);
  } catch (error) {
    console.error('Buyer show zip download error:', error);
    res.status(500).json({ error: error.message || '打包下载失败' });
  }
});

// POST /api/detail-replicate/generate
app.post('/api/detail-replicate/generate', auth, async (req, res) => {
  const { prompt, images, ratio, model } = req.body;
  const username = req.username;
  const localId = 'dr_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

  try {
    if (!prompt) return res.status(400).json({ error: '缺少生成提示词' });
    if (!Array.isArray(images) || images.length === 0) return res.status(400).json({ error: '请至少提供一张参考图' });

    const ret = await submitFeatureImageTask({
      prompt,
      images: images || [],
      size: ratio || '1152x2048',
      quality: 'high',
      username,
      localId,
      modelName: model,
      archiveMeta: { archiveType: 'detail-replicate', featureKey: 'detail_replicate', featureLabel: '详情页生成', batchId: req.body.batchId || localId, screenNo: req.body.screenNo || 1, screenName: req.body.screenName || '详情页' }
    });
    res.json({ success: true, localId: ret.localId, task_id: ret.taskId, status: 'pending', message: '任务已提交，正在后台生成中...' });
  } catch (error) {
    console.error('Detail replicate generate error:', error);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    res.status(500).json({ error: error.message || '生成失败' });
  }
});

// POST /api/buyer-show/generate
app.post('/api/buyer-show/generate', auth, async (req, res) => {
  const { prompt, images, ratio, model } = req.body;
  const username = req.username;
  const localId = 'bs_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

  try {
    if (!prompt) return res.status(400).json({ error: '缺少生成提示词' });
    if (!Array.isArray(images) || images.length === 0) return res.status(400).json({ error: '请至少上传一张灯具图' });

    const ret = await submitFeatureImageTask({
      prompt,
      images: images || [],
      size: ratio || '1536x2048',
      quality: 'high',
      username,
      localId,
      modelName: model,
      archiveMeta: { archiveType: 'buyer-show', archiveSubType: 'buyer-show-initial', featureKey: 'buyer_show', featureLabel: '买家秀生成', batchId: req.body.batchId || localId, itemNo: req.body.itemNo || 1, itemName: req.body.itemName || '买家秀' }
    });
    res.json({ success: true, localId: ret.localId, task_id: ret.taskId, status: 'pending', message: '任务已提交，正在后台生成中...' });
  } catch (error) {
    console.error('Buyer show generate error:', error);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    res.status(500).json({ error: error.message || '生成失败' });
  }
});

// POST /api/buyer-show/extend-views
app.post('/api/buyer-show/extend-views', auth, async (req, res) => {
  const { prompt, sourceImage, productImages, ratio, model } = req.body;
  const username = req.username;
  const localId = 'bse_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  try {
    if (!sourceImage) return res.status(400).json({ error: '缺少用于拓展的场景图或买家秀照片' });
    if (!prompt) return res.status(400).json({ error: '缺少拓展视角提示词' });
    const strictPrompt = '【强一致性约束】只以参考图1为唯一参考。必须保持参考图1里的同一盏灯、同一房间、同一装修、同一家具关系、同一光线氛围。只允许改变拍摄视角、远近、高低、横竖构图，不允许替换灯具或重做场景。提示词尽量简短，按参考图原样延展。\n' + prompt;
    const images = [sourceImage];
    const ret = await submitFeatureImageTask({
      prompt: strictPrompt,
      images,
      size: ratio || '1536x2048',
      quality: 'high',
      username,
      localId,
      modelName: model,
      archiveMeta: { archiveType: 'buyer-show', archiveSubType: 'buyer-show-extend', featureKey: 'buyer_show_extend', featureLabel: '买家秀拓展视角', batchId: req.body.batchId || localId, itemNo: req.body.itemNo || 1, itemName: req.body.itemName || '拓展视角', sourceName: req.body.sourceName || '' }
    });
    res.json({ success: true, localId: ret.localId, task_id: ret.taskId, status: 'pending', message: '拓展视角单张任务已提交' });
  } catch (error) {
    console.error('Buyer show extend error:', error);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    res.status(500).json({ error: error.message || '拓展失败' });
  }
});

// POST /api/buyer-show/batch-generate
app.post('/api/buyer-show/batch-generate', auth, async (req, res) => {
  const { prompts, sourceImage, images, ratio, mode, model } = req.body;
  const username = req.username;
  const localId = 'bsbatch_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  let charged = false;
  let price = 0;
  try {
    const config = resolveImageModelConfig(model);
    if (config.model !== 'gpt-image-2-sub2') return res.status(400).json({ error: '当前模型不支持批量任务，请使用逐张生成' });
    const apiKey = config.apiKey;
    if (!apiKey) return res.status(500).json({ error: `管理员尚未配置 ${config.keyLabel}` });
    const list = (prompts || []).slice(0, 20).map(p => String(p || '').trim()).filter(Boolean);
    if (!list.length) return res.status(400).json({ error: '缺少批量生成提示词' });
    price = getPrice(config.model) * list.length;
    chargeGeneration(username, price);
    charged = true;
    const isExtend = mode === 'extend';
    const refImages = isExtend && sourceImage ? [sourceImage] : (sourceImage ? [sourceImage, ...((images || []))] : (images || []));
    const finalPrompts = isExtend ? list.map(p => '【强一致性约束】只以参考图1为唯一参考。必须保持参考图1里的同一盏灯、同一房间、同一装修、同一家具关系、同一光线氛围。只允许改变拍摄视角、远近、高低、横竖构图，不允许替换灯具或重做场景。提示词尽量简短，按参考图原样延展。\n' + p) : list;
    const ret = await submitSub2MultiPromptTask({
      prompts: finalPrompts,
      images: refImages,
      size: ratio || '1536x2048',
      quality: 'high',
      apiKey,
      username,
      localId,
      price,
      modelLabel: config.model,
      archiveMeta: { archiveType: 'buyer-show', archiveSubType: isExtend ? 'buyer-show-extend' : 'buyer-show-initial', featureKey: isExtend ? 'buyer_show_extend' : 'buyer_show', featureLabel: isExtend ? '买家秀拓展视角' : '买家秀生成', batchId: req.body.batchId || localId, itemNames: list.map((_,i)=> (isExtend ? '拓展视角' : '买家秀') + (i+1)) }
    });
    res.json({ success: true, localId: ret.localId, task_id: ret.taskId, status: 'pending', count: list.length, message: '批量任务已提交' });
  } catch (error) {
    if (charged) refundGeneration(username, price);
    console.error('Buyer show batch generate error:', error);
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    res.status(500).json({ error: error.message || '批量生成失败' });
  }
});

// Page routes
// SPA fallback
app.use((req, res) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/results')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not Found' });
  }
});

// View logs (admin only)
app.get('/api/admin/logs', adminAuth, (req, res) => {
  if (!fs.existsSync(LOG_FILE)) return res.json({ logs: '' });
  const lines = fs.readFileSync(LOG_FILE, 'utf8');
  // Return last 200 lines
  const allLines = lines.split('\n').filter(l => l.trim());
  const recent = allLines.slice(-200).join('\n');
  res.json({ logs: recent, total: allLines.length });
});

// Clear logs (admin only)
app.post('/api/admin/logs/clear', adminAuth, (req, res) => {
  if (fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '');
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 AI 图片优化平台: http://localhost:${PORT}`);
  console.log(`   对外地址: ${APP_PUBLIC_BASE}`);
  console.log(`   管理员: ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}`);
  console.log(`   邀请码: ${INVITE_CODE}`);
  console.log(`   日志文件: logs/requests.log`);
  logToFile('🚀 Server started');
});
