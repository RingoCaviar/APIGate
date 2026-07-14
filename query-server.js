/**
 * 作图平台 API 请求日志查询服务
 * 运行: node query-server.js
 * 访问: http://localhost:12004
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

// ===== 数据目录配置 =====
const LOG_DIR = process.env.IO_LOG_DIR || process.env.LOG_DIR || path.join(__dirname, 'logs');
const API_LOG = path.join(LOG_DIR, 'api-responses.log');
const GENERATE_LOG = path.join(LOG_DIR, 'generate-log.json');
const PENDING_TIMEOUT_MS = 10 * 60 * 1000;
const PENDING_TIMEOUT_ERROR = '生成超过10分钟未返回结果，已自动标记失败';

// 12003 服务的数据目录（用户/Token 信息）
const DATA_DIR = process.env.IO_DATA_DIR || process.env.DATA_DIR || path.join(__dirname, 'data');
const APP_12003_BASE_URL = String(process.env.APP_12003_BASE_URL || 'http://localhost:12003').replace(/\/+$/, '');

let generateLogCache = { mtimeMs: 0, size: 0, data: [] };
let apiLogCache = { mtimeMs: 0, size: 0, data: [] };

function getFileSig(file) {
  if (!fs.existsSync(file)) return { mtimeMs: 0, size: 0 };
  const stat = fs.statSync(file);
  return { mtimeMs: stat.mtimeMs, size: stat.size };
}

function uniqueUrls(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const url = item ? String(item) : '';
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function getAvailableResultUrls(log) {
  return uniqueUrls(log?.resultUrls, log?.archiveUrls, log?.archiveMeta?.savedResults);
}

function extractUpstreamDurationMs(log) {
  const parsed = parseRawTaskResponse(log?.rawResponse);
  if (!parsed) return 0;
  const imageDurations = Array.isArray(parsed?.images)
    ? parsed.images.map(item => Number(item?.duration_ms || 0)).filter(v => Number.isFinite(v) && v > 0)
    : [];
  if (imageDurations.length > 0) {
    return imageDurations.reduce((sum, value) => sum + value, 0);
  }
  const readyDurations = Array.isArray(parsed?.ready_images)
    ? parsed.ready_images.map(item => Number(item?.duration_ms || 0)).filter(v => Number.isFinite(v) && v > 0)
    : [];
  if (readyDurations.length > 0) {
    return readyDurations.reduce((sum, value) => sum + value, 0);
  }
  return 0;
}

function parseRawTaskResponse(rawResponse) {
  if (!rawResponse || typeof rawResponse !== 'string') return null;
  try {
    return JSON.parse(rawResponse);
  } catch (e) {
    return null;
  }
}

function summarizeTaskFailure(taskData, fallbackMessage) {
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

  if (parts.length > 0) return `上游任务失败（${parts.join(' | ')}）`;
  return fallbackMessage || '上游任务失败';
}

function getReadableLogError(log) {
  if (log?.error && String(log.error).trim()) return String(log.error).trim();
  const parsed = parseRawTaskResponse(log?.rawResponse);
  if (!parsed) return '';
  if (parsed.status === 'failed' || parsed.stage === 'failed' || Number(parsed.failed_count || 0) > 0) {
    return summarizeTaskFailure(parsed, '上游任务失败');
  }
  return '';
}

function getStatusDisplay(log) {
  const rawStatus = String(log?.status || '-').trim();
  const statusCode = log?.statusCode;
  if (statusCode !== null && statusCode !== undefined && statusCode !== '' && Number(statusCode) !== 0) {
    return `${rawStatus} (${statusCode})`;
  }
  const parsed = parseRawTaskResponse(log?.rawResponse);
  if (parsed && (parsed.status === 'failed' || parsed.stage === 'failed' || Number(parsed.failed_count || 0) > 0)) {
    const taskState = String(parsed.status || parsed.stage || 'failed').trim();
    return `${rawStatus} (task:${taskState})`;
  }
  return `${rawStatus} (-)`;
}

// ===== 12005 详情页生成服务日志同步 =====
const SYNC_12005_URL = String(process.env.SYNC_12005_URL || '').trim();
let sync12005Logs = [];  // 缓存的 12005 日志
let sync12005LastTime = 0;
const SYNC_12005_INTERVAL = 60000; // 每 60 秒同步一次

let sync12005LastNotice = '';
let sync12005LastNoticeAt = 0;
function report12005SyncNotice(message) {
  const now = Date.now();
  if (message !== sync12005LastNotice || (now - sync12005LastNoticeAt) > 30 * 60 * 1000) {
    console.log(message);
    sync12005LastNotice = message;
    sync12005LastNoticeAt = now;
  }
}
function sync12005LogsFromRemote() {
  return new Promise((resolve) => {
    if (!SYNC_12005_URL) {
      resolve();
      return;
    }
    try {
      const urlObj = new URL(SYNC_12005_URL);
      const client = urlObj.protocol === 'https:' ? https : http;
      const req = client.get(SYNC_12005_URL, { timeout: 10000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.success && Array.isArray(parsed.logs)) {
              sync12005Logs = parsed.logs;
              sync12005LastTime = Date.now();
              console.log(`✅ 12005 日志同步成功: ${parsed.logs.length} 条`);
            }
          } catch(e) { console.error('⚠️ 12005 日志解析失败:', e.message); }
          resolve();
        });
      });
      req.on('error', (e) => {
        console.log('⚠️ 12005 日志同步失败 (可能 12005 未启动):', e.message);
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        console.log('⚠️ 12005 日志同步超时');
        resolve();
      });
    } catch(e) {
      console.log('⚠️ 12005 日志同步配置错误:', e.message);
      resolve();
    }
    if (l.status === 'error') {
      l.error = getReadableLogError(l) || l.error || null;
    }
  });
}

// ===== 用户认证系统 =====
function loadUsers() {
  if (!fs.existsSync(DATA_DIR)) return {};
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'users.json'), 'utf8')); }
  catch(e) { return {}; }
}

function loadTokens() {
  if (!fs.existsSync(DATA_DIR)) return {};
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'tokens.json'), 'utf8')); }
  catch(e) { return {}; }
}

function formatModel(model) {
  const labels = {
    'gpt-image-2': 'gpt-image-2-贞贞接口',
    'gpt-image-2-flatfee': 'gpt-image-2-6789接口',
    'gpt-image-2-flatfee-2k': 'gpt-image-2-6789接口(2K)',
    'gpt-image-2-vip': 'gpt-image-2-6789接口(VIP)',
    'gpt-image-2-all': 'gpt-image-2-智承接口',
    'gpt-image-2-manxiaobai': 'gpt-image-2-漫小白接口',
    'gpt-image-2-sub2': 'gpt-image-2-Sub2接口',
    'agnes-image-2.1-flash': 'agnes-image-2.1-flash-Agnes接口',
    'detail_replicate': '详情页生成',
    'buyer_show': '买家秀生成',
    'buyer_show_extend': '买家秀拓展视角',
  };
  const key = String(model || '');
  if (labels[key]) return labels[key];
  if (key.startsWith('gpt-image-2-sub2-detail-replicate')) return labels.detail_replicate;
  if (key.startsWith('gpt-image-2-sub2-buyer-show-extend')) return labels.buyer_show_extend;
  if (key.startsWith('gpt-image-2-sub2-buyer-show')) return labels.buyer_show;
  if (key.startsWith('gpt-image-2-sub2')) return labels['gpt-image-2-sub2'];
  return key || 'unknown';
}

function hashPw(pw) { return crypto.createHash('md5').update(pw).digest('hex'); }

// Auth middleware
function auth(req, res) {
  const token = req.headers['x-token'] || req.headers['authorization']?.replace('Bearer ', '');
  if (!token) return null;
  const tokens = loadTokens();
  const username = tokens[token];
  if (!username) return null;
  const users = loadUsers();
  const user = users[username];
  if (!user) return null;
  return { username, role: user.role || 'user' };
}

function requireAuth(req, res) {
  const user = auth(req, res);
  if (!user) {
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '未登录' }));
    return null;
  }
  return user;
}

// ===== 日志解析 =====
function loadGenerateLog() {
  if (!fs.existsSync(GENERATE_LOG)) return [];
  const sig = getFileSig(GENERATE_LOG);
  if (generateLogCache.mtimeMs === sig.mtimeMs && generateLogCache.size === sig.size) return generateLogCache.data;
  try {
    const data = JSON.parse(fs.readFileSync(GENERATE_LOG, 'utf8'));
    normalizeTimedOutPendingLogs(data);
    generateLogCache = { ...getFileSig(GENERATE_LOG), data };
    return generateLogCache.data;
  }
  catch(e) { return []; }
}

function getPendingStartedAt(log) {
  return log?.queueStartedAt || log?.startedAt || log?.submittedAt || log?.ts || null;
}

function normalizeTimedOutPendingLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0 || !fs.existsSync(GENERATE_LOG)) return;
  const now = Date.now();
  let changed = false;
  for (const log of logs) {
    if (!log || log.status !== 'pending') continue;
    if (String(log.queueStatus || '').trim().toLowerCase() === 'queued') continue;
    const startedAt = getPendingStartedAt(log);
    const startedMs = startedAt ? Date.parse(startedAt) : NaN;
    if (!Number.isFinite(startedMs) || now - startedMs <= PENDING_TIMEOUT_MS) continue;
    log.status = 'error';
    log.error = log.error || PENDING_TIMEOUT_ERROR;
    log.completedAt = log.completedAt || new Date(now).toISOString();
    if (!log.statusCode || Number(log.statusCode) === 0) log.statusCode = 'timeout';
    if (!log.queueStatus || log.queueStatus === 'queued' || log.queueStatus === 'running') {
      log.queueStatus = 'timeout';
    }
    changed = true;
  }
  if (!changed) return;
  try {
    fs.writeFileSync(GENERATE_LOG, JSON.stringify(logs, null, 2), 'utf8');
    generateLogCache = { ...getFileSig(GENERATE_LOG), data: logs };
    console.log(`⏱️ 已自动标记超时生成任务失败: ${logs.filter(l => l && l.status === 'error' && l.error === PENDING_TIMEOUT_ERROR).length} 条`);
  } catch (e) {
    console.error('⚠️ 回写超时任务失败状态失败:', e.message);
  }
}

function loadApiLog() {
  if (!fs.existsSync(API_LOG)) return [];
  const sig = getFileSig(API_LOG);
  if (apiLogCache.mtimeMs === sig.mtimeMs && apiLogCache.size === sig.size) return apiLogCache.data;
  const bytes = fs.readFileSync(API_LOG);
  const text = bytes.toString('utf8');
  const lines = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) {
      const line = text.substring(start, i);
      if (line.length > 0) lines.push(line);
      start = i + 1;
    }
  }
  apiLogCache = { ...sig, data: lines.map((l, idx) => {
    try {
      const entry = JSON.parse(l);
      let resultUrls = Array.isArray(entry.resultUrls) ? entry.resultUrls.slice() : [];
      let usage = entry.usage || null;
      const rawResp = entry.rawResponse || entry.fullResponse || null;
      if (rawResp && resultUrls.length === 0) {
        try {
          const parsed = JSON.parse(rawResp);
          if (parsed.data && Array.isArray(parsed.data)) {
            resultUrls = parsed.data.map(d => d.url).filter(Boolean);
          }
          if (parsed.usage) usage = parsed.usage;
        } catch(e) {}
      }
      resultUrls = uniqueUrls(resultUrls, entry.archiveUrls, entry.archiveMeta?.savedResults);
      return {
        id: entry.id || entry.localId || `legacy_${idx}`,
        apiRequestId: entry.apiRequestId || entry.requestId || null,
        ts: entry.ts,
        submittedAt: entry.ts,
        completedAt: entry.ts,
        user: entry.user,
        model: entry.model,
        prompt: entry.prompt,
        imageCount: entry.imageCount || (typeof entry.images === 'number' ? entry.images : (entry.images?.length || 0)),
        imagePaths: entry.imagePaths || [],
        status: entry.status,
        statusCode: entry.statusCode,
        resultUrls,
        archiveUrls: uniqueUrls(entry.archiveUrls, entry.archiveMeta?.savedResults),
        archiveMeta: entry.archiveMeta || null,
        featureKey: entry.featureKey || entry.archiveMeta?.featureKey || null,
        featureLabel: entry.featureLabel || entry.archiveMeta?.featureLabel || null,
        usage,
        error: entry.error || null,
        rawResponse: rawResp,
        _legacy: true,
      };
    } catch(e) { return null; }
  }).filter(Boolean) };
  return apiLogCache.data;
}

function loadLogs(filterUser, isAdmin) {
  let logs = [...loadGenerateLog(), ...loadApiLog()];

  // 合并 12005 日志
  if (sync12005Logs.length > 0) {
    logs = logs.concat(sync12005Logs);
  }

  const now = new Date().getTime();
  logs.forEach(l => {
    const availableUrls = getAvailableResultUrls(l);
    if (availableUrls.length > 0) {
      l.resultUrls = availableUrls;
      if (!Array.isArray(l.archiveUrls) || l.archiveUrls.length === 0) {
        l.archiveUrls = availableUrls.slice();
      }
    }
    if (l.status === 'error') {
      const parsed = parseRawTaskResponse(l.rawResponse);
      l.error = getReadableLogError(l) || l.error || null;
      if ((!l.statusCode || Number(l.statusCode) === 0) && parsed && (parsed.status === 'failed' || parsed.stage === 'failed' || Number(parsed.failed_count || 0) > 0)) {
        l.statusCode = `task:${String(parsed.status || parsed.stage || 'failed').trim()}`;
      }
    }
  });
  if (!isAdmin && filterUser) {
    logs = logs.filter(l => l.user === filterUser);
  }
  const seen = new Set();
  return logs.filter(l => {
    if (seen.has(l.id)) return false;
    seen.add(l.id);
    return true;
  });
}

function searchLogs(user, isAdmin, opts = {}) {
  let logs = loadLogs(user, isAdmin);
  if (opts.id) {
    const id = opts.id.toLowerCase();
    logs = logs.filter(l => {
      const lid = (l.id || '').toLowerCase();
      const rid = (l.apiRequestId || '').toLowerCase();
      return lid.includes(id) || rid.includes(id);
    });
  }
  if (isAdmin && opts.user) {
    logs = logs.filter(l => (l.user || '').includes(opts.user));
  }
  if (opts.status) logs = logs.filter(l => l.status === opts.status);
  if (opts.model) logs = logs.filter(l => l.model === opts.model);
  if (opts.prompt) logs = logs.filter(l => (l.prompt || '').includes(opts.prompt));
  if (opts.error) logs = logs.filter(l => (l.error || '').toLowerCase().includes(opts.error.toLowerCase()));
  logs.sort((a, b) => {
    const ta = a.submittedAt || a.ts || '';
    const tb = b.submittedAt || b.ts || '';
    return tb.localeCompare(ta);
  });
  const total = logs.length;
  const page = opts.page || 1;
  const pageSize = opts.pageSize || 20;
  const start = (page - 1) * pageSize;
  const paged = logs.slice(start, start + pageSize);
  return { logs: paged, total, page, pageSize, totalPages: Math.ceil(total / pageSize) };
}

function slimLog(l) {
  return {
    id: l.id,
    apiRequestId: l.apiRequestId || null,
    ts: l.ts || null,
    submittedAt: l.submittedAt || l.ts || null,
    queueStartedAt: l.queueStartedAt || null,
    completedAt: l.completedAt || null,
    user: l.user || null,
    model: l.model || null,
    prompt: l.prompt || '',
    imageCount: l.imageCount || 0,
    status: l.status || null,
    queueStatus: l.queueStatus || null,
    queuePosition: l.queuePosition || null,
    statusCode: l.statusCode || null,
    error: l.error || null,
    resultCount: getAvailableResultUrls(l).length,
  };
}

function getLogDetail(user, isAdmin, id) {
  const logs = loadLogs(user, isAdmin);
  return logs.find(l => l.id === id || l.apiRequestId === id) || null;
}

function getStats(user, isAdmin) {
  const logs = loadLogs(user, isAdmin);
  const getStatsCount = l => isSub2ConsumptionLog(l) ? getGeneratedImageCount(l) : 1;
  const total = logs.reduce((sum, l) => sum + getStatsCount(l), 0);
  const ok = logs.filter(l => l.status === 'success').reduce((sum, l) => sum + getStatsCount(l), 0);
  const err = logs.filter(l => l.status === 'error').reduce((sum, l) => sum + getStatsCount(l), 0);
  const pending = logs.filter(l => l.status === 'pending').reduce((sum, l) => sum + getStatsCount(l), 0);
  const queued = logs.filter(l => l.status === 'pending' && l.queueStatus === 'queued').reduce((sum, l) => sum + getStatsCount(l), 0);
  const running = logs.filter(l => l.status === 'pending' && l.queueStatus !== 'queued').reduce((sum, l) => sum + getStatsCount(l), 0);
  const users = {};
  const errors = {};
  // Per-model stats
  const byModel = {};
  logs.forEach(l => {
    users[l.user] = (users[l.user] || 0) + 1;
    if (l.status === 'error') {
      const msg = String(l.error || 'unknown').substring(0, 60);
      errors[msg] = (errors[msg] || 0) + 1;
    }
    const metricKey = l.featureKey || l.model || 'unknown';
    const metricLabel = l.featureLabel || formatModel(l.model) || metricKey;
    const metricCount = getStatsCount(l);
    if (!byModel[metricKey]) byModel[metricKey] = { total: 0, success: 0, error: 0, pending: 0, label: metricLabel, avgDurationMs: 0, avgDurationSec: 0, durationCount: 0, totalDurationMs: 0 };
    byModel[metricKey].total += metricCount;
    if (l.status === 'success') byModel[metricKey].success += metricCount;
    else if (l.status === 'error') byModel[metricKey].error += metricCount;
    else if (l.status === 'pending') byModel[metricKey].pending += metricCount;
    const start = l.submittedAt || l.ts;
    const end = l.completedAt;
    if (l.status === 'success' && (start || l.rawResponse)) {
      const ms = extractUpstreamDurationMs(l) || (start && end ? (new Date(end).getTime() - new Date(start).getTime()) : 0);
      if (ms > 0) {
        byModel[metricKey].durationCount += metricCount;
        byModel[metricKey].totalDurationMs += ms * metricCount;
        byModel[metricKey].avgDurationMs = Math.round(byModel[metricKey].totalDurationMs / byModel[metricKey].durationCount);
        byModel[metricKey].avgDurationSec = +(byModel[metricKey].avgDurationMs / 1000).toFixed(1);
      }
    }
  });
  // 过滤已废弃的接口
  const ACTIVE_MODELS = new Set([
    'gpt-image-2',
    'gpt-image-2-flatfee',
    'gpt-image-2-manxiaobai',
    'gpt-image-2-sub2',
    'agnes-image-2.1-flash',
    'detail_replicate',
    'buyer_show',
    'buyer_show_extend',
  ]);
  Object.keys(byModel).forEach(m => { if (!ACTIVE_MODELS.has(m)) delete byModel[m]; });
  Object.keys(byModel).forEach(m => {
    const item = byModel[m];
    item.successRate = item.total > 0 ? +((item.success / item.total) * 100).toFixed(1) : 0;
  });
  return { total, success: ok, error: err, pending, queued, running, users, errors: Object.entries(errors).map(([e, c]) => ({ error: e, count: c })), byModel };
}

// ===== 消耗统计 =====
function getModelCost(model) {
  if (!model) return 0;
  if (model === 'gpt-image-2') return 0.07;
  if (model === 'gpt-image-2-flatfee') return 0.035;
  if (model === 'gpt-image-2-flatfee-2k') return 0.002;
  if (model === 'gpt-image-2-vip') return 0.002;
  if (model === 'gpt-image-2-all') return 0.072;
  if (model === 'gpt-image-2-sub2') return 0.025;
  if (model === 'agnes-image-2.1-flash') return 0.01;
  return 0;
}

function isSub2ConsumptionLog(log) {
  const model = String(log?.model || '');
  const featureKey = log?.featureKey || log?.archiveMeta?.featureKey;
  return model === 'gpt-image-2-sub2'
    || model.startsWith('gpt-image-2-sub2-')
    || ['detail_replicate', 'buyer_show', 'buyer_show_extend'].includes(featureKey);
}

function countUniqueList(list) {
  if (!Array.isArray(list)) return 0;
  return new Set(list.filter(Boolean).map(item => String(item))).size;
}

function getGeneratedImageCount(log) {
  const saved = Math.max(
    countUniqueList(log?.resultUrls),
    countUniqueList(log?.archiveUrls),
    countUniqueList(log?.archiveMeta?.savedResults)
  );
  if (saved > 0) return saved;
  if (Array.isArray(log?.archiveMeta?.itemNames) && log.archiveMeta.itemNames.length > 0) return log.archiveMeta.itemNames.length;
  return 1;
}

function getLogConsumption(log) {
  if (isSub2ConsumptionLog(log)) return 0.025 * getGeneratedImageCount(log);
  return getModelCost(log?.model);
}

function loadStatsJSON() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stats.json'), 'utf8')); }
  catch(e) { return {}; }
}

function loadBalancesJSON() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'balances.json'), 'utf8')); }
  catch(e) { return {}; }
}

function loadRechargeLogs() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'recharge_logs.json'), 'utf8')); }
  catch(e) { return []; }
}

function computeConsumption(startDate, endDate) {
  // Compare by date string (YYYY-MM-DD) to avoid timezone issues
  // For endDate, we want to include the entire day, not just 00:00:00
  const startStr = startDate || '2000-01-01';
  const endStr = endDate || '2099-12-31';

  const allLogs = loadLogs(null, true);
  const statsJSON = loadStatsJSON();
  const balances = loadBalancesJSON();
  const rechargeLogs = loadRechargeLogs();

  const byDate = {};       // date -> { zhenzhen: cost, api6789: cost }
  const byUser = {};       // user -> { calls6789, success6789, callsZhenzhen, successZhenzhen, totalSpent, periodSpent, periodCalls, lastCall }
  let totalConsumption = 0;
  let totalCalls = 0;

  // Init users from balances
  for (const [username, bal] of Object.entries(balances)) {
    byUser[username] = {
      username,
      currentBalance: bal.balance || 0,
      totalRecharged: 0,
      periodRecharged: 0,
      consumed: 0,
      calls6789: 0, success6789: 0,
      callsZhenzhen: 0, successZhenzhen: 0,
      callsSub2: 0, successSub2: 0,
      lastCall: null
    };
  }

  // Process logs — compare by date string to avoid timezone issues
  for (const log of allLogs) {
    if (!log.submittedAt || !log.user) continue;
    const logDate = log.submittedAt.slice(0, 10);
    if (logDate < startStr || logDate > endStr) continue;
    // Skip pending/error logs for consumption
    if (log.status !== 'success') continue;

    const cost = getLogConsumption(log);
    const dateStr = log.submittedAt.slice(0, 10);

    // byDate
    if (!byDate[dateStr]) byDate[dateStr] = { zhenzhen: 0, api6789: 0, zcsdai: 0, sub2: 0 };
    if (log.model === 'gpt-image-2') {
      byDate[dateStr].zhenzhen += cost;
    } else if (log.model === 'gpt-image-2-all') {
      byDate[dateStr].zcsdai += cost;
    } else if (isSub2ConsumptionLog(log)) {
      byDate[dateStr].sub2 += cost;
    } else {
      byDate[dateStr].api6789 += cost;
    }

    // byUser
    if (!byUser[log.user]) {
      const bal = balances[log.user];
      byUser[log.user] = {
        username: log.user,
        currentBalance: bal ? bal.balance : 0,
        totalRecharged: 0, periodRecharged: 0, consumed: 0,
        calls6789: 0, success6789: 0, callsZhenzhen: 0, successZhenzhen: 0, callsZcsdai: 0, successZcsdai: 0, callsSub2: 0, successSub2: 0,
        lastCall: null
      };
    }

    const u = byUser[log.user];
    const imageCount = isSub2ConsumptionLog(log) ? getGeneratedImageCount(log) : 1;
    u.consumed += cost;
    totalConsumption += cost;
    totalCalls += imageCount;
    if (log.model === 'gpt-image-2') {
      u.callsZhenzhen++;
      if (log.status === 'success') u.successZhenzhen++;
    } else if (log.model === 'gpt-image-2-all') {
      u.callsZcsdai++;
      if (log.status === 'success') u.successZcsdai++;
    } else if (isSub2ConsumptionLog(log)) {
      u.callsSub2 += imageCount;
      if (log.status === 'success') u.successSub2 += imageCount;
    } else {
      u.calls6789++;
      if (log.status === 'success') u.success6789++;
    }
    if (!u.lastCall || log.submittedAt > u.lastCall) u.lastCall = log.submittedAt;
  }

  // Calculate totalRecharged from recharge logs (all time)
  // and periodRecharged from recharge logs within date range
  for (const rc of rechargeLogs) {
    if (byUser[rc.username]) {
      byUser[rc.username].totalRecharged += rc.amount;
      const rcDate = rc.createdAt.slice(0, 10);
      if (rcDate >= startStr && rcDate <= endStr) {
        byUser[rc.username].periodRecharged += rc.amount;
      }
    }
  }

  // Calculate historical total consumption (all time, all users)
  let historicalConsumption = 0;
  const allLogsAllTime = loadLogs(null, true);
  for (const log of allLogsAllTime) {
    if (log.user && log.status === 'success') {
      historicalConsumption += getLogConsumption(log);
    }
  }

  const sortedByDate = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0]));
  const totalRecharge = Object.values(byUser).reduce((s, u) => s + u.periodRecharged, 0);
  // User count: users with actual consumption in the selected range
  const userConsumption = Object.values(byUser)
    .filter(u => u.consumed > 0)
    .sort((a, b) => b.consumed - a.consumed);

  return {
    totalConsumption,
    historicalConsumption,
    totalRecharge,
    totalCalls,
    userCount: userConsumption.length,
    byDate: sortedByDate,
    userConsumption
  };
}

// ===== HTTP 服务器 =====
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Token, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // 登录
  if (pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { username, password } = JSON.parse(body);
        const users = loadUsers();
        if (!users[username] || users[username].password !== hashPw(password)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '用户名或密码错误' }));
          return;
        }
        const user = users[username];
        const token = crypto.randomBytes(32).toString('hex');
        const tokens = loadTokens();
        tokens[token] = username;
        fs.writeFileSync(path.join(DATA_DIR, 'tokens.json'), JSON.stringify(tokens));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ token, username, role: user.role || 'user' }));
      } catch(e) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '请求格式错误' }));
      }
    });
    return;
  }

  // 登出
  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = req.headers['x-token'] || req.headers['authorization']?.replace('Bearer ', '');
    if (token) {
      const tokens = loadTokens();
      delete tokens[token];
      try { fs.writeFileSync(path.join(DATA_DIR, 'tokens.json'), JSON.stringify(tokens)); } catch(e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 无需认证：图片下载代理
  if (pathname.startsWith('/api/download')) {
    // Parse URL from raw req.url to avoid URL object issues with nested query params
    const rawUrl = req.url.split('?')[0];
    const queryString = req.url.substring(rawUrl.length + 1);
    const params = new URLSearchParams(queryString);
    const targetUrl = params.get('url');
    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }
    try {
      let finalUrl = targetUrl;
      if (targetUrl.startsWith('/')) {
        finalUrl = APP_12003_BASE_URL + targetUrl;
      }
      const urlObj = new URL(finalUrl);
      const filename = path.basename(urlObj.pathname) || 'image.png';
      const client = urlObj.protocol === 'https:' ? https : http;
      client.get(finalUrl, { timeout: 30000 }, (proxyRes) => {
        // Handle non-200 responses (e.g. 404 expired images)
        if (proxyRes.statusCode !== 200) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          const msg = proxyRes.statusCode === 404
            ? '图片已过期或无法访问（404），旧 API 响应的图片链接通常会在数天后失效'
            : `图片请求失败 (HTTP ${proxyRes.statusCode})`;
          res.end(JSON.stringify({ error: msg, statusCode: proxyRes.statusCode }));
          return;
        }
        res.writeHead(200, {
          'Content-Type': proxyRes.headers['content-type'] || 'image/png',
          'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
          'Cache-Control': 'no-cache',
        });
        proxyRes.pipe(res);
      }).on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '图片下载失败: ' + e.message }));
      });
    } catch(e) {
      const debugUrl = targetUrl ? JSON.stringify(targetUrl.substring(0, 120)) : '(null)';
      console.error('[download] Invalid URL error:', e.message, '| received:', debugUrl);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '服务器错误: ' + e.message, receivedUrl: debugUrl }));
    }
    return;
  }

  // 需要认证的 API
  if (pathname.startsWith('/api/')) {
    const currentUser = requireAuth(req, res);
    if (!currentUser) return;

    if (pathname === '/api/logs') {
      const opts = {
        id: parsedUrl.searchParams.get('id') || undefined,
        user: parsedUrl.searchParams.get('user') || undefined,
        status: parsedUrl.searchParams.get('status') || undefined,
        model: parsedUrl.searchParams.get('model') || undefined,
        prompt: parsedUrl.searchParams.get('prompt') || undefined,
        error: parsedUrl.searchParams.get('error') || undefined,
        page: parseInt(parsedUrl.searchParams.get('page')) || 1,
        pageSize: parseInt(parsedUrl.searchParams.get('pageSize')) || 20,
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      const result = searchLogs(currentUser.username, currentUser.role === 'admin', opts);
      result.logs = result.logs.map(slimLog);
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === '/api/log-detail') {
      const id = parsedUrl.searchParams.get('id');
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '缺少 id 参数' }));
        return;
      }
      const log = getLogDetail(currentUser.username, currentUser.role === 'admin', id);
      if (!log) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '未找到记录' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ log }));
      return;
    }

    if (pathname === '/api/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(getStats(currentUser.username, currentUser.role === 'admin')));
      return;
    }

    if (pathname === '/api/me') {
      const users = loadUsers();
      const user = users[currentUser.username];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ username: currentUser.username, role: currentUser.role, createdAt: user?.createdAt || null }));
      return;
    }

    // 消耗统计 API
    if (pathname === '/api/consumption') {
      const startDate = parsedUrl.searchParams.get('startDate') || undefined;
      const endDate = parsedUrl.searchParams.get('endDate') || undefined;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(computeConsumption(startDate, endDate)));
      return;
    }
  }

  // 登录页面
  if (pathname === '/login') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_PAGE);
    return;
  }

  // 消耗统计页面 — 始终返回 HTML，由前端 JS 鉴权
  if (pathname === '/consumption') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(CONSUMPTION_PAGE);
    return;
  }

  // 根路径及其他 → 始终返回主页
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML_PAGE);
});

const PORT = 12004;
server.listen(PORT, () => {
  console.log(`📊 作图日志查询服务: http://localhost:${PORT}`);
  console.log(`   数据目录: ${DATA_DIR}`);
  console.log(`   日志目录: ${LOG_DIR}`);
  console.log(`   12005 同步: ${SYNC_12005_URL}`);
  if (SYNC_12005_URL) {
    // 启动时立即同步一次 12005 日志
    sync12005LogsFromRemote();
    // 定时同步 12005 日志
    setInterval(sync12005LogsFromRemote, SYNC_12005_INTERVAL);
  } else {
    report12005SyncNotice('12005 日志同步未配置，已跳过远程同步');
  }
});

// 登录页面 HTML
const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>作图日志查询 - 登录</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--bg2:#12121a;--bg3:#1a1a26;--border:#2a2a3a;--text:#e8e8f0;--text2:#8888a0;--accent:#6366f1;--danger:#ef4444}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;align-items:center;justify-content:center}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:16px;padding:40px;width:360px}
h1{text-align:center;font-size:22px;margin-bottom:6px;background:linear-gradient(135deg,#6366f1,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.sub{text-align:center;color:var(--text2);font-size:13px;margin-bottom:28px}
.field{margin-bottom:16px}
.field label{display:block;font-size:12px;color:var(--text2);margin-bottom:6px}
.field input{width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-size:14px;outline:none}
.field input:focus{border-color:var(--accent)}
.btn{width:100%;padding:12px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border:none;border-radius:8px;color:white;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px}
.btn:hover{opacity:0.9}
.btn:disabled{opacity:0.5;cursor:not-allowed}
.error{background:rgba(239,68,68,0.1);border:1px solid var(--danger);border-radius:8px;padding:10px;font-size:13px;color:#fca5a5;margin-bottom:16px;text-align:center;display:none}
</style></head>
<body>
<div class="card">
  <h1>🖼️ 作图日志查询</h1>
  <p class="sub">使用作图平台账号登录</p>
  <div class="error" id="err"></div>
  <div class="field"><label>用户名</label><input type="text" id="u" autofocus autocomplete="username"></div>
  <div class="field"><label>密码</label><input type="password" id="p" autocomplete="current-password"></div>
  <button class="btn" id="btn" onclick="login()">登录</button>
</div>
<script>
const err=document.getElementById('err');
function showErr(m){err.textContent=m;err.style.display='block';}
async function login(){
  const u=document.getElementById('u').value.trim();
  const p=document.getElementById('p').value;
  if(!u||!p){showErr('请输入用户名和密码');return;}
  const btn=document.getElementById('btn');btn.disabled=true;btn.textContent='登录中...';
  try{
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:u,password:p})});
    const d=await r.json();
    if(!r.ok){showErr(d.error||'登录失败');btn.disabled=false;btn.textContent='登录';return;}
    localStorage.setItem('token',d.token);
    localStorage.setItem('username',d.username);
    localStorage.setItem('role',d.role);
    window.location.href='/';
  }catch(e){showErr('网络错误: '+e.message);btn.disabled=false;btn.textContent='登录';}
}
document.addEventListener('keydown',e=>{if(e.key==='Enter')login();});
</script></body></html>`;

// 主页面 HTML
const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>作图 API 日志查询</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--bg2:#12121a;--bg3:#1a1a26;--border:#2a2a3a;--text:#e8e8f0;--text2:#8888a0;--accent:#6366f1;--success:#22c55e;--danger:#ef4444;--warn:#f59e0b}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.header{background:var(--bg2);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;gap:16px}
.header h1{font-size:18px;background:linear-gradient(135deg,#6366f1,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .badge{font-size:11px;background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:3px 10px;color:var(--text2)}
.header .uname{font-size:13px;color:var(--accent);margin-left:auto}
.logout-btn{padding:5px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text2);font-size:12px;cursor:pointer}
.logout-btn:hover{border-color:var(--danger);color:var(--danger)}
.stats-bar{background:var(--bg2);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;gap:24px;font-size:13px;flex-wrap:wrap}
.stats-bar .stat{display:flex;align-items:center;gap:6px}
.stats-bar .stat .num{font-weight:700;font-size:16px}
.stats-bar .stat.ok .num{color:var(--success)}
.stats-bar .stat.err .num{color:var(--danger)}
.stats-bar .stat.pending .num{color:var(--warn)}
.search-bar{background:var(--bg2);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.search-bar input,.search-bar select{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:8px 12px;color:var(--text);font-size:13px;outline:none}
.search-bar input:focus,.search-bar select:focus{border-color:var(--accent)}
.search-bar input[type="text"]{width:280px}
.search-btn{padding:8px 16px;background:var(--accent);border:none;border-radius:8px;color:white;font-size:13px;font-weight:600;cursor:pointer}
.search-btn:hover{opacity:0.9}
.clear-btn{padding:8px 16px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text2);font-size:13px;cursor:pointer}
.table-wrap{padding:16px 24px;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;border-bottom:2px solid var(--border);color:var(--text2);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}
td{padding:10px 12px;border-bottom:1px solid var(--border);vertical-align:top}
tr:hover td{background:var(--bg3)}
.status-ok{color:var(--success)}
.status-err{color:var(--danger)}
.status-pending{color:var(--warn)}
.id-cell{font-family:'Courier New',monospace;font-size:11px;color:var(--text2);max-width:200px;word-break:break-all}
.prompt-cell{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.detail-btn{padding:3px 8px;background:var(--bg3);border:1px solid var(--border);border-radius:4px;color:var(--text2);font-size:11px;cursor:pointer}
.detail-btn:hover{border-color:var(--accent);color:var(--accent)}
.modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:none;z-index:100;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{background:var(--bg2);border:1px solid var(--border);border-radius:12px;width:90%;max-width:900px;max-height:85vh;overflow-y:auto;padding:24px;position:relative}
.modal h2{font-size:16px;margin-bottom:16px;color:var(--accent)}
.modal .field{margin-bottom:12px}
.modal .field label{font-size:11px;color:var(--text2);text-transform:uppercase;display:block;margin-bottom:4px}
.modal .field .value{font-size:13px;line-height:1.6;word-break:break-all}
.modal .field .value.mono{font-family:'Courier New',monospace;font-size:11px;background:var(--bg3);padding:10px;border-radius:6px;max-height:300px;overflow:auto;white-space:pre-wrap}
.modal .close{position:absolute;top:16px;right:20px;background:none;border:none;color:var(--text2);font-size:20px;cursor:pointer}
.modal .close:hover{color:var(--text)}
.url-link{color:var(--accent);text-decoration:none;word-break:break-all}
.url-link:hover{text-decoration:underline}
.empty{text-align:center;padding:60px;color:var(--text2);font-size:14px}
.refresh-btn{padding:8px 16px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text2);font-size:13px;cursor:pointer;margin-left:auto}
.dl-btn{display:inline-flex;align-items:center;gap:4px;padding:6px 14px;background:var(--success);border:none;border-radius:6px;color:white;font-size:12px;font-weight:600;cursor:pointer;text-decoration:none}
.dl-btn:hover{opacity:0.85;text-decoration:none}
.time-delta{font-size:10px;color:var(--text2);margin-left:4px}
.pending-row td{animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.6}}
.pagination{display:flex;justify-content:center;align-items:center;gap:8px;padding:16px 24px;font-size:13px;color:var(--text2)}
.pagination button{padding:5px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);font-size:12px;cursor:pointer}
.pagination button:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.pagination button:disabled{opacity:0.4;cursor:not-allowed}
.pagination .page-info{min-width:120px;text-align:center}
.admin-filter{margin-left:auto}
</style>
</head>
<body>
<div class="header">
  <h1>🖼️ 作图 API 日志查询</h1>
  <span class="badge" id="totalBadge">加载中...</span>
  <span class="uname" id="userBadge"></span>
  <span id="adminConsumptionLink" style="display:none"><a href="/consumption" style="padding:5px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--warn);font-size:12px;cursor:pointer;text-decoration:none">💰 消耗统计</a></span>
  <button class="logout-btn" onclick="logout()">退出</button>
  <button class="refresh-btn" onclick="refresh()">🔄 刷新</button>
</div>
<div class="stats-bar" id="statsBar"></div>
<div class="search-bar">
  <input type="text" id="searchId" placeholder="搜索 ID (本地ID 或 API请求ID)">
  <input type="text" id="searchPrompt" placeholder="Prompt 关键词">
  <select id="searchStatus">
    <option value="">全部状态</option>
    <option value="success">✅ 成功</option>
    <option value="error">❌ 失败</option>
    <option value="pending">⏳ 生成中</option>
  </select>
  <select id="searchModel">
    <option value="">全部接口</option>
    <option value="gpt-image-2-flatfee">gpt-image-2-6789接口</option>
    <option value="gpt-image-2">gpt-image-2-贞贞接口</option>
    <option value="gpt-image-2-manxiaobai">gpt-image-2-漫小白接口</option>
    <option value="gpt-image-2-sub2">gpt-image-2-Sub2接口</option>
    <option value="agnes-image-2.1-flash">agnes-image-2.1-flash-Agnes接口</option>
  </select>
  <select id="searchUser" class="admin-filter" style="display:none">
    <option value="">全部用户</option>
  </select>
  <button class="search-btn" onclick="doSearch()">搜索</button>
  <button class="clear-btn" onclick="clearSearch()">清除</button>
</div>
<div class="table-wrap">
  <table>
    <thead><tr><th>提交时间</th><th>用户</th><th>模型</th><th>状态</th><th>ID</th><th>Prompt</th><th>操作</th></tr></thead>
    <tbody id="tableBody"><tr><td colspan="7" class="empty">加载中...</td></tr></tbody>
  </table>
</div>
<div class="pagination" id="pagination"></div>
<div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this)closeModal()">
  <div class="modal" id="modal">
    <button class="close" onclick="closeModal()">✕</button>
    <div id="modalContent"></div>
  </div>
</div>
<script>
let allStats = null;
let autoRefresh = null;
let currentPage = 1;
const PAGE_SIZE = 20;
let currentUser = null;

function getToken(){return localStorage.getItem('token')||'';}
function getUsername(){return localStorage.getItem('username')||'';}
function getRole(){return localStorage.getItem('role')||'user';}

async function checkAuth(){
  const token = getToken();
  if(!token){window.location.href='/login';return false;}
  try{
    const r=await fetch('/api/me',{headers:{'X-Token':token}});
    if(!r.ok){localStorage.clear();window.location.href='/login';return false;}
    currentUser=await r.json();
    localStorage.setItem('username',currentUser.username);
    localStorage.setItem('role',currentUser.role);
    // Admin: show consumption link
    if(currentUser.role==='admin'){document.getElementById('adminConsumptionLink').style.display='inline';}
    return true;
  }catch(e){localStorage.clear();window.location.href='/login';return false;}
}

async function loadStats(){
  try{const r=await fetch('/api/stats',{headers:{'X-Token':getToken()}});allStats=await r.json();renderStats();}catch(e){}
}

function renderStats(){
  if(!allStats)return;
  document.getElementById('totalBadge').textContent=allStats.total+' 条记录';
  document.getElementById('userBadge').textContent=(getRole()==='admin'?'👑 ':'') + getUsername();
  let html=\`<div class="stat"><span class="num">\${allStats.total}</span> 总请求</div>
    <div class="stat ok"><span class="num">\${allStats.success}</span> 成功</div>
    <div class="stat err"><span class="num">\${allStats.error}</span> 失败</div>\`;
  if(allStats.queued) html+=\`<div class="stat pending"><span class="num">\${allStats.queued}</span> 排队中</div>\`;
  if(allStats.running) html+=\`<div class="stat pending"><span class="num">\${allStats.running}</span> 生成中</div>\`;
  html+=\`<div class="stat">成功率: \${allStats.total?((allStats.success/(allStats.total-allStats.pending)*100)||0).toFixed(1):'0'}%</div>\`;
  // Per-model success rates
  if(allStats.byModel && Object.keys(allStats.byModel).length > 0) {
    html += '<div class="stat" style="font-size:11px;color:var(--text2)">📊 接口成功率：</div>';
    for (const [m, s] of Object.entries(allStats.byModel)) {
      const rate = s.total > 0 ? ((s.success / (s.total - s.pending)) * 100 || 0).toFixed(1) : '0';
      const label = formatModel(m);
      const cls = parseFloat(rate) >= 90 ? 'ok' : (parseFloat(rate) >= 50 ? 'pending' : 'err');
      html += \`<div class="stat \${cls}" style="font-size:11px"><span class="num" style="font-size:13px">\${rate}%</span> \${label}(\${s.total})</div>\`;
    }
  }
  document.getElementById('statsBar').innerHTML=html;

  if(getRole()==='admin' && allStats.users){
    const sel=document.getElementById('searchUser');
    sel.style.display='block';
    const current=sel.value;
    sel.innerHTML='<option value="">全部用户</option>';
    Object.keys(allStats.users).sort().forEach(u=>{
      sel.innerHTML+=\`<option value="\${u}" \${u===current?'selected':''}>\${u} (\${allStats.users[u]})</option>\`;
    });
  }
}

async function doSearch(page){
  if(page) currentPage=page;
  const token=getToken();
  const params=new URLSearchParams();
  const id=document.getElementById('searchId').value.trim();if(id)params.set('id',id);
  const user=document.getElementById('searchUser').value.trim();if(user)params.set('user',user);
  const status=document.getElementById('searchStatus').value;if(status)params.set('status',status);
  const model=document.getElementById('searchModel').value;if(model)params.set('model',model);
  const prompt=document.getElementById('searchPrompt').value.trim();if(prompt)params.set('prompt',prompt);
  params.set('page',currentPage);
  params.set('pageSize',PAGE_SIZE);
  try{
    const r=await fetch('/api/logs?'+params,{headers:{'X-Token':token}});
    if(!r.ok){alert('未授权，请重新登录');return;}
    const d=await r.json();renderTable(d.logs,d.total,d.page,d.totalPages);
  }catch(e){document.getElementById('tableBody').innerHTML='<tr><td colspan="7" class="empty">加载失败: '+e.message+'</td></tr>';}
}

function clearSearch(){
  currentPage=1;
  document.getElementById('searchId').value='';
  document.getElementById('searchUser').value='';
  document.getElementById('searchStatus').value='';
  document.getElementById('searchModel').value='';
  document.getElementById('searchPrompt').value='';
  refresh();
}

async function refresh(){await loadStats();currentPage=1;doSearch(1);}
function logout(){localStorage.clear();window.location.href='/login';}

function formatTime(ts){return new Date(ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});}
function timeDelta(submitAt, completeAt){
  if(!completeAt)return '';
  const ms=new Date(completeAt)-new Date(submitAt);
  if(ms<0)return '';
  const s=Math.floor(ms/1000);
  if(s<60) return s+'s';
  return Math.floor(s/60)+'m '+s%60+'s';
}

function renderTable(logs, total, page, totalPages){
  if(autoRefresh){clearInterval(autoRefresh);autoRefresh=null;}
  const hasPending=logs&&logs.some(l=>l.status==='pending');
  if(hasPending){autoRefresh=setInterval(()=>{refresh();},3000);}
  const tb=document.getElementById('tableBody');
  if(!logs||logs.length===0){tb.innerHTML='<tr><td colspan="7" class="empty">没有找到记录</td></tr>';document.getElementById('pagination').innerHTML='';return;}
  tb.innerHTML=logs.map(l=>{
    const rowCls=l.status==='pending'?'pending-row':'';
    const ts=formatTime(l.submittedAt||l.ts);
    const delta=l.completedAt?timeDelta(l.submittedAt||l.ts,l.completedAt):'';
    const isQueued=l.status==='pending'&&l.queueStatus==='queued';
    const statusCls=l.status==='error'?'status-err':l.status==='pending'?'status-pending':'status-ok';
    const statusLabel=l.status==='error'?'❌ 失败':isQueued?'⏳ 排队中':l.status==='pending'?'⚙️ 生成中':'✅ 成功';
    const displayId=l.apiRequestId||l.id||'-';
    const shortId=displayId.length>35?displayId.substring(0,35)+'…':displayId;
    const prompt=(l.prompt||'').substring(0,50);
    return \`<tr class="\${rowCls}">
      <td style="white-space:nowrap">\${ts}\${delta? '<span class="time-delta">('+delta+')</span>':''}</td>
      <td>\${l.user||'-'}</td>
      <td style="font-size:11px;white-space:nowrap">\${formatModel(l.model||'-')}</td>
      <td class="\${statusCls}">\${statusLabel}</td>
      <td class="id-cell" title="\${displayId}">\${shortId}</td>
      <td class="prompt-cell" title="\${(l.prompt||'').replace(/"/g,'&quot;')}">\${prompt}</td>
      <td><button class="detail-btn" onclick="showDetail('\${l.id}')">详情</button></td>
    </tr>\`;
  }).join('');
  renderPagination(total,page,totalPages);
}

function renderPagination(total,page,totalPages){
  const el=document.getElementById('pagination');
  if(totalPages<=1){el.innerHTML='';return;}
  const start=(page-1)*PAGE_SIZE+1;
  const end=Math.min(page*PAGE_SIZE,total);
  let html=\`<button \${page<=1?'disabled':''} onclick="doSearch(1)">首页</button>\`;
  html+=\`<button \${page<=1?'disabled':''} onclick="doSearch(\${page-1})">上一页</button>\`;
  html+=\`<span class="page-info">第 \${page}/\${totalPages} 页（\${start}-\${end}/\${total}）</span>\`;
  html+=\`<button \${page>=totalPages?'disabled':''} onclick="doSearch(\${page+1})">下一页</button>\`;
  html+=\`<button \${page>=totalPages?'disabled':''} onclick="doSearch(\${totalPages})">末页</button>\`;
  el.innerHTML=html;
}

async function showDetail(id){
  try{
    const r=await fetch('/api/log-detail?id='+encodeURIComponent(id),{headers:{'X-Token':getToken()}});
    const d=await r.json();
    if(!r.ok||!d.log){alert(d.error||'未找到记录');return;}
    const l=d.log;
    const submitted=formatTime(l.submittedAt||l.ts);
    const startedAt=l.queueStartedAt||l.startedAt||l.submittedAt||l.ts;
    const started=startedAt?formatTime(startedAt):'-';
    const completed=l.completedAt?formatTime(l.completedAt):'未完成';
    const delta=(startedAt&&l.completedAt)?timeDelta(startedAt,l.completedAt):'-';
    let html=\`<h2>请求详情</h2>
      <div class="field"><label>本地 ID</label><div class="value mono">\${l.id||'-'}</div></div>
      <div class="field"><label>API 请求 ID</label><div class="value mono">\${l.apiRequestId||'-'}</div></div>
      <div class="field"><label>提交时间</label><div class="value">\${submitted}</div></div>
      <div class="field"><label>开始时间</label><div class="value">\${started}</div></div>
      <div class="field"><label>完成时间</label><div class="value">\${completed}\${delta!=='-'?' <span class="time-delta">(计时 '+delta+')</span>':''}</div></div>
      <div class="field"><label>用户</label><div class="value">\${l.user||'-'}</div></div>
      <div class="field"><label>模型</label><div class="value">\${formatModel(l.model)||'-'}</div></div>
      <div class="field"><label>状态</label><div class="value">\${l.status} (\${l.statusCode||'-'})</div></div>
      <div class="field"><label>图片数</label><div class="value">\${l.imageCount||0}</div></div>
      <div class="field"><label>Prompt</label><div class="value mono">\${(l.prompt||'').replace(/</g,'&lt;')}</div></div>\`;
    if(l.error){html+=\`<div class="field"><label>错误</label><div class="value" style="color:var(--danger)">\${l.error}</div></div>\`;}
    if(l.resultUrls&&l.resultUrls.length>0){
      html+='<div class="field"><label>结果图片</label>';
      l.resultUrls.forEach((u,i)=>{
        const dlUrl='/api/download?url='+encodeURIComponent(u);
        const fname=u.split('/').pop().split('?')[0]||'image.png';
        html+=\`<div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px;margin-top:8px;display:flex;gap:12px;align-items:center">
          <img src="\${u}" style="width:80px;height:80px;object-fit:cover;border-radius:6px;border:1px solid var(--border)" onerror="this.style.display='none'">
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;color:var(--text2);margin-bottom:6px">图片 \${i+1}: \${fname}</div>
            <div style="font-size:11px;color:var(--text2);word-break:break-all;margin-bottom:8px">\${u}</div>
            <div style="display:flex;gap:6px">
              <a href="\${dlUrl}" class="dl-btn">⬇️ 下载图片</a>
              <a class="url-link" href="\${u}" target="_blank">🔗 新窗口打开</a>
            </div>
          </div>
        </div>\`;
      });
      html+='</div>';
    }
    if(l.usage){html+=\`<div class="field"><label>Token 消耗</label><div class="value">input: \${l.usage.input_tokens}, output: \${l.usage.output_tokens}, total: \${l.usage.total_tokens}</div></div>\`;}
    if(l.rawResponse){html+=\`<div class="field"><label>完整 API 响应</label><div class="value mono">\${escapeJson(l.rawResponse)}</div></div>\`;}
    document.getElementById('modalContent').innerHTML=html;
    document.getElementById('modalOverlay').classList.add('show');
  }catch(e){alert('加载失败: '+e.message);}
}

function closeModal(){document.getElementById('modalOverlay').classList.remove('show');}
function escapeJson(s){try{return JSON.stringify(JSON.parse(s),null,2);}catch(e){return s;}}
function formatModel(m){
  const map={'gpt-image-2':'gpt-image-2-贞贞接口','gpt-image-2-flatfee':'gpt-image-2-6789接口','gpt-image-2-flatfee-2k':'gpt-image-2-6789接口(2K)','gpt-image-2-vip':'gpt-image-2-6789接口(VIP)','gpt-image-2-all':'gpt-image-2-智承接口','gpt-image-2-manxiaobai':'gpt-image-2-漫小白接口','gpt-image-2-sub2':'gpt-image-2-Sub2接口','agnes-image-2.1-flash':'agnes-image-2.1-flash-Agnes接口'};
  return map[m]||m;
}

document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal();if(e.key==='Enter'&&document.activeElement.closest('.search-bar'))doSearch();});

(async()=>{
  if(await checkAuth()) refresh();
})();
</script>
</body>
</html>`;

// 消耗统计页面 HTML（仅管理员）
const CONSUMPTION_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>消耗统计 - 益菲AI作图</title>
<script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--bg2:#12121a;--bg3:#1a1a26;--border:#2a2a3a;--text:#e8e8f0;--text2:#8888a0;--accent:#6366f1;--success:#22c55e;--danger:#ef4444;--warn:#f59e0b}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.header{background:var(--bg2);border-bottom:1px solid var(--border);padding:16px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.header h1{font-size:18px;background:linear-gradient(135deg,#6366f1,#8b5cf6);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.header .badge{font-size:11px;background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:3px 10px;color:var(--text2)}
.header .uname{font-size:13px;color:var(--accent);margin-left:auto}
.logout-btn{padding:5px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text2);font-size:12px;cursor:pointer}
.logout-btn:hover{border-color:var(--danger);color:var(--danger)}
.nav{background:var(--bg2);border-bottom:1px solid var(--border);padding:0 24px;display:flex;gap:4px}
.nav a{padding:12px 20px;color:var(--text2);text-decoration:none;font-size:14px;border-bottom:2px solid transparent}
.nav a:hover{color:var(--text)}
.nav a.active{color:var(--accent);border-bottom-color:var(--accent)}
.container{max-width:1400px;margin:0 auto;padding:24px}
.filter-bar{background:var(--bg2);border-radius:12px;padding:20px;margin-bottom:20px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.filter-bar label{font-size:14px;color:var(--text2);font-weight:500}
.filter-bar input{padding:8px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:14px}
.filter-bar input:focus{border-color:var(--accent);outline:none}
.filter-bar button{padding:8px 20px;background:var(--accent);border:none;border-radius:8px;color:white;font-size:14px;font-weight:600;cursor:pointer}
.filter-bar button:hover{opacity:0.9}
.quick-btn{padding:6px 14px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;font-size:13px;cursor:pointer;color:var(--text2)}
.quick-btn.active{background:var(--accent);color:white;border-color:var(--accent)}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:20px}
.stat-card{background:var(--bg2);border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,0.08)}
.stat-card .label{font-size:13px;color:var(--text2);margin-bottom:8px}
.stat-card .value{font-size:28px;font-weight:700}
.stat-card .value.primary{color:var(--accent)}
.stat-card .value.success{color:var(--success)}
.stat-card .value.warn{color:var(--warn)}
.card{background:var(--bg2);border-radius:12px;padding:20px;margin-bottom:20px}
.card h3{font-size:16px;margin-bottom:16px;color:var(--text)}
.chart-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.chart-subtitle{font-size:12px;color:var(--text2)}
.chart-range{display:flex;gap:8px;flex-wrap:wrap}
.chart-range-btn{padding:6px 12px;background:var(--bg3);border:1px solid var(--border);border-radius:999px;font-size:12px;color:var(--text2);cursor:pointer;transition:all .2s ease}
.chart-range-btn:hover{border-color:var(--accent);color:var(--accent)}
.chart-range-btn.active{background:rgba(99,102,241,0.16);border-color:var(--accent);color:#c7d2fe}
.date-chart{display:flex;align-items:flex-end;gap:4px;height:140px;padding:10px 0}
.date-chart-grouped{display:flex;align-items:flex-end;gap:8px;height:176px;padding:18px 0 32px;overflow:hidden}
.date-bar-group{flex:1;display:flex;align-items:flex-end;gap:3px;min-width:28px;justify-content:center;position:relative}
.date-bar-zz{width:25%;background:linear-gradient(180deg,#f59e0b,#d97706);border-radius:4px 4px 0 0;position:relative;transition:opacity 0.2s;min-height:2px}
.date-bar-api{width:25%;background:linear-gradient(180deg,#6366f1,#8b5cf6);border-radius:4px 4px 0 0;position:relative;transition:opacity 0.2s;min-height:2px}
.date-bar-zc{width:25%;background:linear-gradient(180deg,#10b981,#059669);border-radius:4px 4px 0 0;position:relative;transition:opacity 0.2s;min-height:2px}
.date-bar-zz:hover,.date-bar-api:hover,.date-bar-zc:hover,.date-bar-sub2:hover{opacity:0.82;filter:brightness(1.05)}
.date-bar-sub2{width:25%;background:linear-gradient(180deg,#ec4899,#be185d);border-radius:4px 4px 0 0;position:relative;transition:opacity 0.2s;min-height:2px}
.bar-value-bar{position:absolute;top:-13px;left:50%;transform:translateX(-50%);font-size:9px;color:var(--accent);font-weight:600;white-space:nowrap}
.bar-label{position:absolute;bottom:-20px;left:50%;transform:translateX(-50%);font-size:10px;color:var(--text2);white-space:nowrap}
.bar-label-group{position:absolute;bottom:-22px;left:50%;transform:translateX(-50%);font-size:9px;color:var(--text2);white-space:nowrap}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:12px;border-bottom:2px solid var(--border);color:var(--text2);font-weight:500;font-size:12px}
td{padding:12px;border-bottom:1px solid var(--border)}
tr:hover td{background:var(--bg3)}
.empty{text-align:center;padding:40px;color:var(--text2)}
.balance-pos{color:var(--success)}
.balance-neg{color:var(--danger)}
.refresh-btn{position:fixed;bottom:24px;right:24px;width:48px;height:48px;border-radius:50%;background:var(--accent);color:white;border:none;font-size:20px;cursor:pointer;box-shadow:0 4px 12px rgba(102,126,234,0.4)}
.back-btn{padding:8px 16px;background:var(--bg3);border:1px solid var(--border);border-radius:8px;color:var(--text2);font-size:13px;cursor:pointer;text-decoration:none;display:inline-block}
.back-btn:hover{border-color:var(--accent);color:var(--accent)}
</style>
</head>
<body>
<div id="app">
  <div class="header">
    <h1>💰 消耗统计</h1>
    <span class="badge">用户数: {{ stats.userCount }}</span>
    <span class="uname">{{ username }}</span>
    <a href="/" class="back-btn">← 返回日志</a>
    <button class="logout-btn" @click="logout">退出</button>
  </div>

  <div class="nav">
    <a href="/" class="">📊 日志查询</a>
    <a href="/consumption" class="active">💰 消耗统计</a>
  </div>

  <div class="container">
    <div class="filter-bar">
      <label>日期范围:</label>
      <input type="date" v-model="startDate" />
      <span style="color:var(--text2)">至</span>
      <input type="date" v-model="endDate" />
      <button @click="fetchData">查询</button>
      <div style="margin-left:8px;display:flex;gap:6px">
        <span :class="['quick-btn', { active: quickRange === 'today' }]" @click="setQuick('today')">今天</span>
        <span :class="['quick-btn', { active: quickRange === 'week' }]" @click="setQuick('week')">近7天</span>
        <span :class="['quick-btn', { active: quickRange === 'month' }]" @click="setQuick('month')">近30天</span>
        <span :class="['quick-btn', { active: quickRange === 'all' }]" @click="setQuick('all')">全部</span>
      </div>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="label">累计消耗（当前筛选范围内）</div>
        <div class="value primary">{{ stats.totalConsumption.toFixed(2) }}</div>
      </div>
      <div class="stat-card">
        <div class="label">历史总消耗</div>
        <div class="value success">{{ (stats.historicalConsumption || 0).toFixed(2) }}</div>
      </div>
      <div class="stat-card">
        <div class="label">总调用次数</div>
        <div class="value">{{ stats.totalCalls }}</div>
      </div>
      <div class="stat-card">
        <div class="label">用户数</div>
        <div class="value">{{ stats.userCount }}</div>
      </div>
    </div>

    <div class="card" v-if="stats.byDate.length > 0">
      <h3>📊 每日消耗趋势</h3>
      <div class="chart-head">
        <div class="chart-subtitle">默认显示最近 14 天，悬浮柱子可查看精确金额</div>
        <div class="chart-range">
          <button type="button" :class="['chart-range-btn', { active: chartDays === 14 }]" @click="setChartDays(14)">近14天</button>
          <button type="button" :class="['chart-range-btn', { active: chartDays === 30 }]" @click="setChartDays(30)">近30天</button>
          <button type="button" :class="['chart-range-btn', { active: chartDays === 0 }]" @click="setChartDays(0)">全部</button>
        </div>
      </div>
      <div style="display:flex;gap:16px;margin-bottom:12px;font-size:13px">
        <span style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:12px;background:linear-gradient(180deg,#f59e0b,#d97706);border-radius:2px"></span> 贞贞接口 (gpt-image-2)</span>
        <span style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:12px;background:linear-gradient(180deg,#6366f1,#8b5cf6);border-radius:2px"></span> 6789接口 (flatfee/vip)</span>
        <span style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:12px;background:linear-gradient(180deg,#10b981,#059669);border-radius:2px"></span> 漫小白接口 (manxiaobai)</span>
        <span style="display:flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:12px;background:linear-gradient(180deg,#ec4899,#be185d);border-radius:2px"></span> Sub2接口 (sub2)</span>
      </div>
      <div class="date-chart-grouped">
        <div v-for="(d, idx) in visibleByDate" :key="idx" class="date-bar-group">
          <div class="date-bar-zz" :style="{ height: (d[1].zhenzhen / maxConsumption * maxConsumptionBarHeight) + 'px' }" :title="barTooltip(d[0], 'gpt-image-2', d[1].zhenzhen)" v-if="d[1].zhenzhen > 0">
            <span class="bar-value-bar">{{ d[1].zhenzhen.toFixed(2) }}</span>
          </div>
          <div class="date-bar-api" :style="{ height: (d[1].api6789 / maxConsumption * maxConsumptionBarHeight) + 'px' }" :title="barTooltip(d[0], '6789', d[1].api6789)" v-if="d[1].api6789 > 0">
            <span class="bar-value-bar">{{ d[1].api6789.toFixed(2) }}</span>
          </div>
          <div class="date-bar-zc" :style="{ height: (d[1].zcsdai / maxConsumption * maxConsumptionBarHeight) + 'px' }" :title="barTooltip(d[0], 'manxiaobai', d[1].zcsdai)" v-if="d[1].zcsdai > 0">
            <span class="bar-value-bar">{{ d[1].zcsdai.toFixed(2) }}</span>
          </div>
          <div class="date-bar-sub2" :style="{ height: (d[1].sub2 / maxConsumption * maxConsumptionBarHeight) + 'px' }" :title="barTooltip(d[0], 'sub2', d[1].sub2)" v-if="d[1].sub2 > 0">
            <span class="bar-value-bar">{{ d[1].sub2.toFixed(2) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <h3>👥 用户消耗明细</h3>
      <table>
        <thead>
          <tr>
            <th @click="sortBy('username')" style="cursor:pointer">用户 <span v-if="sortKey==='username'">{{ sortOrder===1?'↑':'↓' }}</span></th>
            <th @click="sortBy('totalRecharged')" style="cursor:pointer">累计充值 <span v-if="sortKey==='totalRecharged'">{{ sortOrder===1?'↑':'↓' }}</span></th>
            <th @click="sortBy('currentBalance')" style="cursor:pointer">当前余额 <span v-if="sortKey==='currentBalance'">{{ sortOrder===1?'↑':'↓' }}</span></th>
            <th @click="sortBy('consumed')" style="cursor:pointer">累计消耗 <span v-if="sortKey==='consumed'">{{ sortOrder===1?'↑':'↓' }}</span></th>
            <th @click="sortBy('periodRecharged')" style="cursor:pointer">期间充值 <span v-if="sortKey==='periodRecharged'">{{ sortOrder===1?'↑':'↓' }}</span></th>
            <th @click="sortBy('calls6789')" style="cursor:pointer">6789调用 <span v-if="sortKey==='calls6789'">{{ sortOrder===1?'↑':'↓' }}</span></th>
            <th @click="sortBy('callsZhenzhen')" style="cursor:pointer">贞贞调用 <span v-if="sortKey==='callsZhenzhen'">{{ sortOrder===1?'↑':'↓' }}</span></th>
            <th @click="sortBy('callsSub2')" style="cursor:pointer">Sub2调用 <span v-if="sortKey==='callsSub2'">{{ sortOrder===1?'↑':'↓' }}</span></th>
            <th @click="sortBy('lastCall')" style="cursor:pointer">最近调用 <span v-if="sortKey==='lastCall'">{{ sortOrder===1?'↑':'↓' }}</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in sortedUsers" :key="u.username">
            <td>{{ u.username }}</td>
            <td>{{ u.totalRecharged.toFixed(2) }}</td>
            <td :class="{ 'balance-pos': u.currentBalance > 0, 'balance-neg': u.currentBalance < 0 }">{{ u.currentBalance.toFixed(2) }}</td>
            <td :class="{ 'balance-pos': u.consumed > 0 }">{{ u.consumed.toFixed(2) }}</td>
            <td>{{ u.periodRecharged.toFixed(2) }}</td>
            <td>{{ u.calls6789 }} (成功{{ u.success6789 }})</td>
            <td>{{ u.callsZhenzhen }} (成功{{ u.successZhenzhen }})</td>
            <td>{{ u.callsSub2 }} (成功{{ u.successSub2 }})</td>
            <td>{{ u.lastCall ? formatTime(u.lastCall) : '-' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <button class="refresh-btn" @click="fetchData" title="刷新">🔄</button>
</div>

<script>
const { createApp } = Vue;

createApp({
  data() {
    return {
      stats: { totalConsumption: 0, historicalConsumption: 0, totalRecharge: 0, totalCalls: 0, userCount: 0, userConsumption: [], byDate: [] },
      startDate: '',
      endDate: '',
      quickRange: 'week',
      chartDays: 14,
      username: localStorage.getItem('username') || '',
      sortKey: 'consumed',
      sortOrder: -1
    };
  },
  computed: {
    visibleByDate() {
      const data = this.stats.byDate || [];
      const sliced = this.chartDays > 0 ? data.slice(-this.chartDays) : data.slice();
      return sliced.reverse();
    },
    maxConsumption() {
      const vals = this.visibleByDate.map(d => Math.max(
        d[1].zhenzhen || 0,
        d[1].api6789 || 0,
        d[1].zcsdai || 0,
        d[1].sub2 || 0
      ));
      return Math.max(...vals, 1);
    },
    maxConsumptionBarHeight() {
      return 118;
    },
    sortedUsers() {
      const arr = [...this.stats.userConsumption];
      if (!this.sortKey) return arr;
      arr.sort((a, b) => {
        let va = a[this.sortKey], vb = b[this.sortKey];
        if (typeof va === 'string') return va.localeCompare(vb || '') * this.sortOrder;
        return ((va || 0) - (vb || 0)) * this.sortOrder;
      });
      return arr;
    }
  },
  methods: {
    sortBy(key) {
      if (this.sortKey === key) { this.sortOrder *= -1; }
      else { this.sortKey = key; this.sortOrder = -1; }
    },
    setChartDays(days) {
      this.chartDays = days;
    },
    barTooltip(date, label, value) {
      return date + ' ' + label + ': ' + Number(value || 0).toFixed(2);
    },
    async fetchData() {
      try {
        const params = new URLSearchParams();
        if (this.startDate) params.set('startDate', this.startDate);
        if (this.endDate) params.set('endDate', this.endDate);
        const r = await fetch('/api/consumption?' + params.toString(), {
          headers: { 'X-Token': localStorage.getItem('token') || '' }
        });
        if (!r.ok) { alert('请重新登录'); window.location.href = '/login'; return; }
        this.stats = await r.json();
      } catch (e) { console.error(e); }
    },
    setQuick(range) {
      this.quickRange = range;
      const today = new Date().toISOString().slice(0, 10);
      if (range === 'today') {
        this.startDate = today;
        this.endDate = today;
      } else if (range === 'week') {
        const d = new Date(); d.setDate(d.getDate() - 6);
        this.startDate = d.toISOString().slice(0, 10);
        this.endDate = today;
      } else if (range === 'month') {
        const d = new Date(); d.setDate(d.getDate() - 29);
        this.startDate = d.toISOString().slice(0, 10);
        this.endDate = today;
      } else {
        this.startDate = '';
        this.endDate = '';
      }
      this.fetchData();
    },
    formatTime(ts) {
      if (!ts) return '-';
      return new Date(ts).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
    logout() {
      localStorage.clear();
      window.location.href = '/login';
    }
  },
  async mounted() {
    const token = localStorage.getItem('token');
    if (!token) { window.location.href = '/login'; return; }
    try {
      const r = await fetch('/api/me', { headers: { 'X-Token': token } });
      if (!r.ok) { localStorage.clear(); window.location.href = '/login'; return; }
      const u = await r.json();
      if (u.role !== 'admin') { window.location.href = '/'; return; }
    } catch(e) { localStorage.clear(); window.location.href = '/login'; return; }
    this.setQuick('week');
  }
}).mount('#app');
</script>
</body>
</html>`;
