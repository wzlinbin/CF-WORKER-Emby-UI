// ============================================
// Emby 反向代理 + 管理后台
// Cloudflare Worker 版本
// ============================================

// ==================== 配置区 ====================
// 管理员密码（建议通过环境变量设置：wrangler.toml 或 Cloudflare Dashboard）
const ADMIN_PASSWORD = "qq983303"; // 请修改为强密码！

// KV 命名空间绑定（需要在 wrangler.toml 中配置）
// [[kv_namespaces]]
// binding = "EMBY_KV"
// id = "你的KV命名空间ID"

// ==================== 默认后端配置 ====================
const DEFAULT_BACKENDS = {
    "8443": {
        name: "okemby",
        url: "https://link00.okemby.org:8443",
        enabled: true
    },
    "443": {
        name: "Lilyemby",
        url: "https://free.lilyemby.com:443",
        enabled: true
    }
};

// ==================== 工具函数 ====================

// 生成简单的会话token
function generateToken() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

// 内存中存储的token（用于无KV时的会话管理）
let memoryToken = null;

// 配置缓存（减少KV读取频率）
const CONFIG_CACHE_TTL = 60000;
let accessCache = {
    blacklist: [],
    whitelist: [],
    loadedAt: 0
};
let backendCache = {
    data: DEFAULT_BACKENDS,
    loadedAt: 0
};

// 内存中的统计缓存（减少KV写入频率）
let statsCache = {
    date: '',
    data: { total: 0, success: 0, error: 0, bytes: 0, duration: 0, ports: {} },
    lastSave: 0
};

// 统计写入间隔（毫秒）- 每30秒写入一次KV
const STATS_SAVE_INTERVAL = 30000;
const STATS_STREAM_FLUSH_BYTES = 8 * 1024 * 1024;
const STATS_STREAM_FLUSH_INTERVAL = 10000;
const STATS_OPEN_RANGE_COUNT_LIMIT = 16 * 1024 * 1024;
const PROXY_DEBUG_LOGS = false;

function getStatsDoStub(env) {
    if (!env || !env.STATS_DO) return null;
    return env.STATS_DO.get(env.STATS_DO.idFromName('global-stats'));
}

function proxyDebug(event, data = {}) {
    if (!PROXY_DEBUG_LOGS) return;
    console.log('[proxy-debug]', JSON.stringify({ event, ...data }));
}

// 验证管理员会话
async function verifySession(request, env) {
    const authHeader = request.headers.get('Authorization');
    let clientToken = null;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
        clientToken = authHeader.substring(7);
    } else {
        const cookie = request.headers.get('Cookie') || '';
        const match = cookie.match(/admin_token=([^;]+)/);
        if (match) {
            clientToken = match[1];
        }
    }
    
    if (!clientToken) return false;
    
    // 如果有KV，从KV验证
    if (env && env.EMBY_KV) {
        const storedToken = await env.EMBY_KV.get('session:admin');
        return clientToken === storedToken;
    }
    
    // 没有KV时，使用内存中的token验证
    return clientToken === memoryToken;
}

// 获取客户端IP
function getClientIP(request) {
    return request.headers.get('CF-Connecting-IP') || 
           request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() || 
           'unknown';
}

async function getAccessConfig(env, forceRefresh = false) {
    if (!env || !env.EMBY_KV) {
        return { blacklist: [], whitelist: [] };
    }

    const now = Date.now();
    if (!forceRefresh && accessCache.loadedAt && now - accessCache.loadedAt < CONFIG_CACHE_TTL) {
        return {
            blacklist: accessCache.blacklist,
            whitelist: accessCache.whitelist
        };
    }

    const blacklist = await env.EMBY_KV.get('config:blacklist', { type: 'json' }) || [];
    const whitelist = await env.EMBY_KV.get('config:whitelist', { type: 'json' }) || [];

    accessCache = {
        blacklist,
        whitelist,
        loadedAt: now
    };

    return { blacklist, whitelist };
}

function updateAccessCache(type, list) {
    if (type === 'blacklist') {
        accessCache.blacklist = list;
    } else {
        accessCache.whitelist = list;
    }
    accessCache.loadedAt = Date.now();
}

// 检查IP是否在黑名单/白名单中
async function checkIPAccess(clientIP, env) {
    if (!env || !env.EMBY_KV) return true;

    const { blacklist, whitelist } = await getAccessConfig(env);

    // 如果设置了白名单，只允许白名单IP
    if (whitelist.length > 0) {
        return whitelist.includes(clientIP);
    }

    // 否则检查黑名单
    return !blacklist.includes(clientIP);
}

// 获取后端配置
async function getBackendConfig(env, forceRefresh = false) {
    if (!env || !env.EMBY_KV) return DEFAULT_BACKENDS;

    const now = Date.now();
    if (!forceRefresh && backendCache.loadedAt && now - backendCache.loadedAt < CONFIG_CACHE_TTL) {
        return backendCache.data;
    }

    const config = await env.EMBY_KV.get('config:backends', { type: 'json' });
    backendCache = {
        data: config || DEFAULT_BACKENDS,
        loadedAt: now
    };
    return backendCache.data;
}

function updateBackendCache(config) {
    backendCache = {
        data: config,
        loadedAt: Date.now()
    };
}

// 保存后端配置
async function saveBackendConfig(env, config) {
    updateBackendCache(config);
    if (!env || !env.EMBY_KV) return;
    await env.EMBY_KV.put('config:backends', JSON.stringify(config));
}

function createEmptyStats() {
    return {
        total: 0,
        success: 0,
        error: 0,
        bytes: 0,
        duration: 0,
        ports: {},
        statusCodes: {},
        rangeRequests: 0,
        partialContentResponses: 0,
        mediaRequests: 0,
        mediaBytes: 0,
        apiBytes: 0,
        maxRequestBytes: 0,
        unmeteredMediaRequests: 0,
        unmeteredMediaBytesHint: 0
    };
}

function ensureStatsShape(stats) {
    const empty = createEmptyStats();
    for (const key in empty) {
        if (stats[key] === undefined) stats[key] = empty[key];
    }
    if (!stats.ports) stats.ports = {};
    if (!stats.statusCodes) stats.statusCodes = {};
    return stats;
}

function createEmptyPortStats() {
    return {
        total: 0,
        success: 0,
        error: 0,
        bytes: 0,
        duration: 0,
        statusCodes: {},
        rangeRequests: 0,
        partialContentResponses: 0,
        mediaRequests: 0,
        mediaBytes: 0,
        apiBytes: 0,
        maxRequestBytes: 0,
        unmeteredMediaRequests: 0,
        unmeteredMediaBytesHint: 0
    };
}

const EMPTY_PORT_STATS = createEmptyPortStats();

function ensurePortStatsShape(portStats) {
    for (const key in EMPTY_PORT_STATS) {
        if (portStats[key] === undefined) {
            portStats[key] = typeof EMPTY_PORT_STATS[key] === 'object' ? { ...EMPTY_PORT_STATS[key] } : EMPTY_PORT_STATS[key];
        }
    }
    if (!portStats.statusCodes) portStats.statusCodes = {};
    return portStats;
}

function parseJsonObject(value, fallback = {}) {
    if (!value) return fallback;
    if (typeof value === 'object') return value;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

function addStatusCodes(target, source) {
    for (const [code, count] of Object.entries(source || {})) {
        target[code] = (target[code] || 0) + (Number(count) || 0);
    }
}

function aggregateExtendedStatsFromPorts(stats) {
    ensureStatsShape(stats);
    const aggregate = {
        statusCodes: {},
        rangeRequests: 0,
        partialContentResponses: 0,
        mediaRequests: 0,
        mediaBytes: 0,
        apiBytes: 0,
        maxRequestBytes: 0,
        unmeteredMediaRequests: 0,
        unmeteredMediaBytesHint: 0
    };

    for (const portStats of Object.values(stats.ports || {})) {
        ensurePortStatsShape(portStats);
        addStatusCodes(aggregate.statusCodes, portStats.statusCodes);
        aggregate.rangeRequests += Number(portStats.rangeRequests) || 0;
        aggregate.partialContentResponses += Number(portStats.partialContentResponses) || 0;
        aggregate.mediaRequests += Number(portStats.mediaRequests) || 0;
        aggregate.mediaBytes += Number(portStats.mediaBytes) || 0;
        aggregate.apiBytes += Number(portStats.apiBytes) || 0;
        aggregate.maxRequestBytes = Math.max(aggregate.maxRequestBytes, Number(portStats.maxRequestBytes) || 0);
        aggregate.unmeteredMediaRequests += Number(portStats.unmeteredMediaRequests) || 0;
        aggregate.unmeteredMediaBytesHint += Number(portStats.unmeteredMediaBytesHint) || 0;
    }

    stats.statusCodes = aggregate.statusCodes;
    stats.rangeRequests = aggregate.rangeRequests;
    stats.partialContentResponses = aggregate.partialContentResponses;
    stats.mediaRequests = aggregate.mediaRequests;
    stats.mediaBytes = aggregate.mediaBytes;
    stats.apiBytes = aggregate.apiBytes;
    stats.maxRequestBytes = aggregate.maxRequestBytes;
    stats.unmeteredMediaRequests = aggregate.unmeteredMediaRequests;
    stats.unmeteredMediaBytesHint = aggregate.unmeteredMediaBytesHint;
    return stats;
}

function statsFromStorageRow(row) {
    if (!row) return createEmptyStats();

    const details = parseJsonObject(row.details, null);
    const stats = ensureStatsShape(details ? { ...details } : {});
    stats.total = Number(row.total) || 0;
    stats.success = Number(row.success) || 0;
    stats.error = Number(row.error) || 0;
    stats.bytes = Number(row.bytes) || 0;
    stats.duration = Number(row.duration) || 0;
    stats.ports = parseJsonObject(row.ports, stats.ports || {});

    if (!details) {
        aggregateExtendedStatsFromPorts(stats);
    }

    return ensureStatsShape(stats);
}

function applyStatsIncrement(stats, port, success, bytes, duration, countRequest = true, meta = {}) {
    ensureStatsShape(stats);
    if (countRequest) {
        stats.total++;
        if (success) stats.success++;
        else stats.error++;
        stats.duration += duration;
        if (meta.statusCode) {
            const code = String(meta.statusCode);
            stats.statusCodes[code] = (stats.statusCodes[code] || 0) + 1;
        }
        if (meta.hasRange) stats.rangeRequests++;
        if (meta.isPartialContent) stats.partialContentResponses++;
        if (meta.isMedia) stats.mediaRequests++;
        if (meta.isUnmeteredPassthrough) stats.unmeteredMediaRequests++;
    }
    stats.bytes += bytes;
    if (meta.isMedia) stats.mediaBytes += bytes;
    else stats.apiBytes += bytes;
    if (bytes > stats.maxRequestBytes) stats.maxRequestBytes = bytes;
    if (meta.isUnmeteredPassthrough) stats.unmeteredMediaBytesHint += Number(meta.unmeteredBytesHint) || 0;

    if (!stats.ports[port]) stats.ports[port] = createEmptyPortStats();
    const portStats = ensurePortStatsShape(stats.ports[port]);
    if (countRequest) {
        portStats.total++;
        if (success) portStats.success++;
        else portStats.error++;
        portStats.duration += duration;
        if (meta.statusCode) {
            const code = String(meta.statusCode);
            portStats.statusCodes[code] = (portStats.statusCodes[code] || 0) + 1;
        }
        if (meta.hasRange) portStats.rangeRequests++;
        if (meta.isPartialContent) portStats.partialContentResponses++;
        if (meta.isMedia) portStats.mediaRequests++;
        if (meta.isUnmeteredPassthrough) portStats.unmeteredMediaRequests++;
    }
    portStats.bytes += bytes;
    if (meta.isMedia) portStats.mediaBytes += bytes;
    else portStats.apiBytes += bytes;
    if (bytes > portStats.maxRequestBytes) portStats.maxRequestBytes = bytes;
    if (meta.isUnmeteredPassthrough) portStats.unmeteredMediaBytesHint += Number(meta.unmeteredBytesHint) || 0;
}

function isMediaResponse(path, contentType) {
    const lowerPath = path.toLowerCase();
    const lowerType = (contentType || '').toLowerCase();
    return lowerType.startsWith('video/') ||
        lowerType.startsWith('audio/') ||
        lowerPath.includes('/videos/') ||
        lowerPath.includes('/audio/') ||
        lowerPath.includes('/stream') ||
        lowerPath.includes('/download');
}

function parseContentLength(headers) {
    const value = Number(headers.get('Content-Length') || 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseContentRangeBytes(contentRange) {
    const match = String(contentRange || '').match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
    if (!match) return 0;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
    return end - start + 1;
}

function isBoundedSingleRange(rangeHeader) {
    const match = String(rangeHeader || '').match(/^bytes=(\d+)-(\d+)$/i);
    if (!match) return false;
    return Number(match[2]) >= Number(match[1]);
}

function isOpenEndedRange(rangeHeader) {
    return /^bytes=\d+-$/i.test(String(rangeHeader || ''));
}

function getPassthroughStatsBytes(rangeHeader, responseHeaders) {
    if (isBoundedSingleRange(rangeHeader)) {
        return parseContentRangeBytes(responseHeaders.get('Content-Range')) || parseContentLength(responseHeaders);
    }

    if (isOpenEndedRange(rangeHeader)) {
        const rangeBytes = parseContentRangeBytes(responseHeaders.get('Content-Range')) || parseContentLength(responseHeaders);
        return rangeBytes > 0 && rangeBytes <= STATS_OPEN_RANGE_COUNT_LIMIT ? rangeBytes : 0;
    }

    return 0;
}

function getPassthroughByteSource(rangeHeader, bytes) {
    if (bytes <= 0) return 'unmetered-passthrough';
    return isBoundedSingleRange(rangeHeader) ? 'bounded-range' : 'small-open-range';
}

function sanitizeLogUrl(urlValue) {
    try {
        const parsed = new URL(urlValue, 'https://proxy.local');
        return parsed.pathname + (parsed.search ? '?[已隐藏]' : '');
    } catch (e) {
        return String(urlValue || '').split('?')[0];
    }
}

async function recordStatsFallback(env, port, success, bytes, duration, countRequest = true, meta = {}) {
    if (!env || !env.EMBY_KV) return;

    const today = new Date().toISOString().split('T')[0];
    const now = Date.now();

    if (statsCache.date !== today) {
        statsCache.date = today;
        statsCache.data = createEmptyStats();
        statsCache.lastSave = 0;
    }

    applyStatsIncrement(statsCache.data, port, success, bytes, duration, countRequest, meta);

    if (now - statsCache.lastSave >= STATS_SAVE_INTERVAL || statsCache.lastSave === 0) {
        statsCache.lastSave = now;
        try {
            const key = `stats:${today}`;
            await env.EMBY_KV.put(key, JSON.stringify(statsCache.data), { expirationTtl: 86400 * 90 });
        } catch (e) {
            console.error('KV write error:', e.message);
        }
    }
}

async function recordStats(env, port, success, bytes, duration, countRequest = true, meta = {}) {
    if (!env) return;

    const stub = getStatsDoStub(env);
    if (stub) {
        try {
            await stub.fetch('https://stats.local/increment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ port, success, bytes, duration, countRequest, meta })
            });
            return;
        } catch (e) {
            console.error('Durable Object stats error:', e.message);
        }
    }

    await recordStatsFallback(env, port, success, bytes, duration, countRequest, meta);
}

// 错误日志缓存
const ERROR_LOGS_KEY = 'logs:errors';
let errorLogCache = [];
let lastErrorLogSave = 0;
const ERROR_LOG_SAVE_INTERVAL = 60000; // 每60秒写入一次

// 记录错误日志（使用缓存，减少KV写入）
async function logError(env, port, error, url, clientIP) {
    if (!env || !env.EMBY_KV) return;

    const now = Date.now();

    // 添加到缓存
    errorLogCache.push({
        time: new Date().toISOString(),
        port: port,
        error: error,
        url: url,
        clientIP: clientIP
    });

    // 只保留最近50条错误
    if (errorLogCache.length > 50) {
        errorLogCache = errorLogCache.slice(-50);
    }

    // 每60秒覆盖写入一次单个KV key
    if (now - lastErrorLogSave >= ERROR_LOG_SAVE_INTERVAL || lastErrorLogSave === 0) {
        lastErrorLogSave = now;
        try {
            await env.EMBY_KV.put(ERROR_LOGS_KEY, JSON.stringify(errorLogCache), { expirationTtl: 86400 * 7 });
        } catch (e) {
            console.error('KV write error:', e.message);
        }
    }
}

// 获取最近错误日志
async function getRecentErrors(env, limit = 50) {
    if (!env || !env.EMBY_KV) return [];
    const logs = await env.EMBY_KV.get(ERROR_LOGS_KEY, { type: 'json' }) || [];
    return logs.slice(-limit).sort((a, b) => new Date(b.time) - new Date(a.time));
}

// 获取统计数据
async function getStatsSummary(env, days = 7) {
    if (!env || !env.EMBY_KV) return [];
    const today = new Date();
    const reads = [];

    for (let i = 0; i < days; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        reads.push(
            env.EMBY_KV.get(`stats:${dateStr}`, { type: 'json' })
                .then(dayStats => dayStats ? { date: dateStr, ...dayStats } : null)
        );
    }

    return (await Promise.all(reads)).filter(Boolean);
}

// ==================== 管理面板 HTML ====================
function getAdminHTML() {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Emby 反代管理面板</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #eee; min-height: 100vh; }
        .container { max-width: 1400px; margin: 0 auto; padding: 20px; }
        
        .login-container { display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        .login-box { background: #16213e; padding: 40px; border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,0.3); width: 100%; max-width: 400px; }
        .login-box h1 { text-align: center; margin-bottom: 30px; color: #4ecca3; }
        .login-box input { width: 100%; padding: 15px; margin: 10px 0; border: none; border-radius: 5px; background: #1a1a2e; color: #fff; font-size: 16px; }
        .login-box button { width: 100%; padding: 15px; border: none; border-radius: 5px; background: #4ecca3; color: #1a1a2e; font-size: 16px; cursor: pointer; font-weight: bold; }
        .login-box button:hover { background: #3db892; }
        
        .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; padding-bottom: 20px; border-bottom: 1px solid #333; }
        .header h1 { color: #4ecca3; }
        .header button { padding: 10px 20px; border: none; border-radius: 5px; background: #e94560; color: #fff; cursor: pointer; }
        
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 15px; margin-bottom: 30px; }
        .stat-card { background: #16213e; padding: 20px; border-radius: 10px; text-align: center; }
        .stat-card h3 { color: #888; font-size: 13px; margin-bottom: 8px; }
        .stat-card .value { font-size: 28px; font-weight: bold; color: #4ecca3; }
        .stat-card.error .value { color: #e94560; }
        .stat-card.warning .value { color: #f0a500; }
        
        .tabs { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
        .tab { padding: 12px 24px; background: #16213e; border: none; border-radius: 5px; color: #888; cursor: pointer; font-size: 14px; }
        .tab.active { background: #4ecca3; color: #1a1a2e; font-weight: bold; }
        .tab:hover:not(.active) { background: #1f3460; }
        
        .panel { display: none; background: #16213e; border-radius: 10px; padding: 25px; }
        .panel.active { display: block; }
        
        .section { margin-bottom: 30px; }
        .section-title { font-size: 16px; color: #4ecca3; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 1px solid #333; }
        
        .chart-row { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
        @media (max-width: 900px) { .chart-row { grid-template-columns: 1fr; } }
        
        .chart-box { background: #1a1a2e; border-radius: 8px; padding: 20px; }
        .chart-box h4 { color: #888; font-size: 14px; margin-bottom: 15px; }
        
        .line-chart { height: 200px; position: relative; padding: 10px 0 40px 50px; }
        .line-chart svg { width: 100%; height: 100%; }
        .chart-line { fill: none; stroke: #4ecca3; stroke-width: 2; }
        .chart-area { fill: url(#gradient); opacity: 0.3; }
        .chart-label { font-size: 11px; fill: #888; }
        
        .pie-chart { display: flex; align-items: center; justify-content: center; gap: 20px; }
        .pie-chart svg { width: 120px; height: 120px; }
        .pie-legend { font-size: 12px; }
        .pie-legend-item { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .pie-legend-color { width: 12px; height: 12px; border-radius: 2px; }
        
        .analysis-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 15px; }
        .analysis-card { background: #1a1a2e; border-radius: 8px; padding: 15px; }
        .analysis-card h4 { color: #888; font-size: 12px; margin-bottom: 10px; text-transform: uppercase; }
        .analysis-item { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #333; }
        .analysis-item:last-child { border-bottom: none; }
        .analysis-label { color: #aaa; }
        .analysis-value { color: #4ecca3; font-weight: bold; }
        
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 12px; text-align: left; border-bottom: 1px solid #333; }
        th { color: #4ecca3; font-weight: 600; font-size: 13px; }
        tr:hover { background: rgba(78, 204, 163, 0.05); }
        
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; margin-bottom: 8px; color: #888; }
        .form-group input, .form-group select { width: 100%; padding: 12px; border: none; border-radius: 5px; background: #1a1a2e; color: #fff; font-size: 14px; }
        .form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; }
        
        .btn { padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; font-size: 14px; margin-right: 10px; margin-bottom: 5px; }
        .btn-primary { background: #4ecca3; color: #1a1a2e; }
        .btn-danger { background: #e94560; color: #fff; }
        .btn-secondary { background: #333; color: #fff; }
        .btn:hover { opacity: 0.9; }
        
        .status { display: inline-block; padding: 4px 12px; border-radius: 20px; font-size: 12px; }
        .status.online { background: #4ecca3; color: #1a1a2e; }
        .status.offline { background: #e94560; color: #fff; }
        
        .log-entry { padding: 12px; border-left: 3px solid #e94560; background: rgba(233, 69, 96, 0.1); margin-bottom: 10px; border-radius: 0 5px 5px 0; }
        .log-time { color: #888; font-size: 12px; }
        .log-error { color: #e94560; margin-top: 5px; word-break: break-all; }
        
        .ip-list { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 15px; }
        .ip-item { background: #1a1a2e; padding: 8px 15px; border-radius: 20px; display: flex; align-items: center; gap: 10px; }
        .ip-item button { background: none; border: none; color: #e94560; cursor: pointer; font-size: 18px; }
        
        .alert { padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .alert-warning { background: rgba(233, 69, 96, 0.2); border: 1px solid #e94560; color: #e94560; }
        .alert-info { background: rgba(78, 204, 163, 0.1); border: 1px solid #4ecca3; color: #4ecca3; }
        
        .progress-bar { height: 8px; background: #333; border-radius: 4px; overflow: hidden; margin-top: 5px; }
        .progress-fill { height: 100%; background: #4ecca3; border-radius: 4px; transition: width 0.3s; }
        
        /* 使用说明样式 */
        .guide-section { margin-bottom: 25px; }
        .guide-section h4 { color: #4ecca3; margin-bottom: 12px; font-size: 15px; }
        .guide-section p { color: #aaa; line-height: 1.8; margin-bottom: 10px; }
        .guide-section ul { color: #aaa; line-height: 1.8; margin-left: 20px; }
        .guide-section li { margin-bottom: 5px; }
        .guide-section code { background: #1a1a2e; padding: 2px 8px; border-radius: 4px; color: #4ecca3; font-family: 'Consolas', monospace; }
        .guide-section pre { background: #1a1a2e; padding: 15px; border-radius: 8px; overflow-x: auto; margin: 10px 0; }
        .guide-section pre code { background: none; padding: 0; }
        .guide-tip { background: rgba(78, 204, 163, 0.1); border-left: 3px solid #4ecca3; padding: 12px 15px; margin: 15px 0; border-radius: 0 5px 5px 0; }
        .guide-warning { background: rgba(233, 69, 96, 0.1); border-left: 3px solid #e94560; padding: 12px 15px; margin: 15px 0; border-radius: 0 5px 5px 0; }
        
        @media (max-width: 768px) {
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
            .form-row { grid-template-columns: 1fr; }
            table { font-size: 14px; }
            th, td { padding: 10px; }
        }
    </style>
</head>
<body>
    <div id="loginPage" class="login-container">
        <div class="login-box">
            <h1>🔐 管理登录</h1>
            <input type="password" id="password" placeholder="请输入管理员密码" onkeypress="if(event.key==='Enter')login()">
            <button onclick="login()">登 录</button>
            <p id="loginError" style="color: #e94560; text-align: center; margin-top: 15px;"></p>
        </div>
    </div>
    
    <div id="mainPage" class="container" style="display: none;">
        <div class="header">
            <h1>🎬 Emby 反代管理面板</h1>
            <button onclick="logout()">退出登录</button>
        </div>
        
        <div id="kvWarning" class="alert alert-warning" style="display: none;">
            ⚠️ KV 未配置，统计和管理功能不可用。请先创建 KV 命名空间并绑定到 Worker。
        </div>
        
        <div class="stats-grid">
            <div class="stat-card">
                <h3>今日请求</h3>
                <div class="value" id="todayTotal">-</div>
            </div>
            <div class="stat-card">
                <h3>成功率</h3>
                <div class="value" id="successRate">-</div>
            </div>
            <div class="stat-card">
                <h3>今日流量</h3>
                <div class="value" id="todayBytes">-</div>
            </div>
            <div class="stat-card error">
                <h3>今日错误</h3>
                <div class="value" id="todayErrors">-</div>
            </div>
            <div class="stat-card warning">
                <h3>平均响应</h3>
                <div class="value" id="avgDuration">-</div>
            </div>
            <div class="stat-card">
                <h3>峰值 QPS</h3>
                <div class="value" id="peakQps">-</div>
            </div>
        </div>
        
        <div class="tabs">
            <button class="tab active" onclick="showPanel('dashboard')">📊 仪表盘</button>
            <button class="tab" onclick="showPanel('backends')">🖥️ 后端管理</button>
            <button class="tab" onclick="showPanel('access')">🛡️ 访问控制</button>
            <button class="tab" onclick="showPanel('logs')">📋 错误日志</button>
            <button class="tab" onclick="showPanel('guide')">📖 使用说明</button>
        </div>
        
        <div id="dashboard" class="panel active">
            <div class="section">
                <h3 class="section-title">📈 近7天请求趋势</h3>
                <div class="chart-row">
                    <div class="chart-box">
                        <h4>请求量趋势</h4>
                        <div class="line-chart" id="lineChart"></div>
                    </div>
                    <div class="chart-box">
                        <h4>流量分布</h4>
                        <div class="pie-chart" id="pieChart"></div>
                    </div>
                </div>
            </div>
            
            <div class="section">
                <h3 class="section-title">📊 专业分析</h3>
                <div class="analysis-grid">
                    <div class="analysis-card">
                        <h4>请求分析</h4>
                        <div class="analysis-item">
                            <span class="analysis-label">7天总请求</span>
                            <span class="analysis-value" id="weekTotal">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">日均请求</span>
                            <span class="analysis-value" id="dailyAvg">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">7天成功率</span>
                            <span class="analysis-value" id="weekSuccessRate">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">请求趋势</span>
                            <span class="analysis-value" id="trend">-</span>
                        </div>
                    </div>
                    <div class="analysis-card">
                        <h4>流量分析</h4>
                        <div class="analysis-item">
                            <span class="analysis-label">7天总流量</span>
                            <span class="analysis-value" id="weekBytes">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">日均流量</span>
                            <span class="analysis-value" id="dailyBytesAvg">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">媒体流量</span>
                            <span class="analysis-value" id="mediaBytes">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">接口流量</span>
                            <span class="analysis-value" id="apiBytes">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">平均请求大小</span>
                            <span class="analysis-value" id="avgRequestSize">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">最大单次流量</span>
                            <span class="analysis-value" id="maxRequestBytes">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">峰值流量日</span>
                            <span class="analysis-value" id="peakDay">-</span>
                        </div>
                    </div>
                    <div class="analysis-card">
                        <h4>性能分析</h4>
                        <div class="analysis-item">
                            <span class="analysis-label">平均响应时间</span>
                            <span class="analysis-value" id="avgResponseTime">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">分段请求数</span>
                            <span class="analysis-value" id="rangeRequests">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">分段响应数</span>
                            <span class="analysis-value" id="partialResponses">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">媒体请求数</span>
                            <span class="analysis-value" id="mediaRequests">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">健康状态</span>
                            <span class="analysis-value" id="healthStatus">-</span>
                        </div>
                    </div>
                    <div class="analysis-card">
                        <h4>状态分析</h4>
                        <div class="analysis-item">
                            <span class="analysis-label">7天总错误</span>
                            <span class="analysis-value" id="weekErrors">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">错误率</span>
                            <span class="analysis-value" id="errorRate">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">状态码分布</span>
                            <span class="analysis-value" id="statusCodeSummary">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">统计来源</span>
                            <span class="analysis-value" id="statsSource">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">错误趋势</span>
                            <span class="analysis-value" id="errorTrend">-</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="section">
                <h3 class="section-title">🔌 各端口统计</h3>
                <table>
                    <thead>
                        <tr>
                            <th>端口</th>
                            <th>名称</th>
                            <th>今日请求</th>
                            <th>成功率</th>
                            <th>今日流量</th>
                            <th>媒体流量</th>
                            <th>分段响应</th>
                            <th>平均响应</th>
                            <th>状态</th>
                        </tr>
                    </thead>
                    <tbody id="portStats"></tbody>
                </table>
            </div>
        </div>
        
        <div id="backends" class="panel">
            <h3 style="margin-bottom: 20px;">后端服务器配置</h3>
            <table>
                <thead>
                    <tr>
                        <th>端口</th>
                        <th>名称</th>
                        <th>后端地址</th>
                        <th>状态</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody id="backendList"></tbody>
            </table>
            
            <h3 style="margin: 30px 0 20px;">添加/编辑后端</h3>
            <div class="form-row">
                <div class="form-group">
                    <label>端口</label>
                    <input type="text" id="backendPort" placeholder="如: 8443">
                </div>
                <div class="form-group">
                    <label>名称</label>
                    <input type="text" id="backendName" placeholder="如: Emby Server 1">
                </div>
                <div class="form-group">
                    <label>后端地址</label>
                    <input type="text" id="backendUrl" placeholder="https://example.com:port">
                </div>
            </div>
            <button class="btn btn-primary" onclick="saveBackend()">保存配置</button>
            <button class="btn btn-secondary" onclick="resetBackends()">恢复默认</button>
        </div>
        
        <div id="access" class="panel">
            <h3 style="margin-bottom: 20px;">访问控制</h3>
            
            <div class="form-group">
                <label>黑名单IP（禁止访问）</label>
                <div class="form-row">
                    <input type="text" id="blacklistIP" placeholder="输入IP地址" style="flex: 1;">
                    <button class="btn btn-danger" onclick="addBlacklist()">添加</button>
                </div>
                <div class="ip-list" id="blacklist"></div>
            </div>
            
            <div class="form-group" style="margin-top: 30px;">
                <label>白名单IP（仅允许这些IP访问，留空则允许所有）</label>
                <div class="form-row">
                    <input type="text" id="whitelistIP" placeholder="输入IP地址" style="flex: 1;">
                    <button class="btn btn-primary" onclick="addWhitelist()">添加</button>
                </div>
                <div class="ip-list" id="whitelist"></div>
            </div>
            
            <p style="color: #888; margin-top: 20px;">💡 提示：白名单优先级高于黑名单。设置白名单后，只有白名单中的IP可以访问。</p>
        </div>
        
        <div id="logs" class="panel">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h3>错误日志</h3>
                <div>
                    <button class="btn btn-secondary" onclick="refreshLogs()">刷新</button>
                    <button class="btn btn-danger" onclick="clearLogs()">清除全部</button>
                </div>
            </div>
            <div id="errorLogs"></div>
        </div>
        
        <div id="guide" class="panel">
            <h3 style="margin-bottom: 25px;">📖 使用说明</h3>
            
            <div class="guide-section">
                <h4>一、部署 Worker</h4>
                <p>1. 登录 <a href="https://dash.cloudflare.com" target="_blank" style="color: #4ecca3;">Cloudflare Dashboard</a></p>
                <p>2. 左侧菜单选择 <strong>Workers & Pages</strong></p>
                <p>3. 点击 <strong>Create Worker</strong> 创建新 Worker</p>
                <p>4. 将本代码完整复制到编辑器中</p>
                <p>5. 点击 <strong>Save and Deploy</strong> 部署</p>
                <div class="guide-tip">
                    💡 部署后会获得一个默认域名：<code>你的worker名.你的账户.workers.dev</code>
                </div>
            </div>
            
            <div class="guide-section">
                <h4>二、创建并绑定 KV</h4>
                <p>KV 用于存储统计数据、错误日志和配置信息。</p>
                <p><strong>步骤 1：创建 KV 命名空间</strong></p>
                <ul>
                    <li>左侧菜单 <strong>Workers & Pages</strong> → <strong>KV</strong></li>
                    <li>点击 <strong>Create a namespace</strong></li>
                    <li>输入名称：<code>EMBY_KV</code></li>
                    <li>点击 <strong>Add</strong></li>
                </ul>
                <p><strong>步骤 2：绑定 KV 到 Worker</strong></p>
                <ul>
                    <li>进入你的 Worker → <strong>Settings</strong> → <strong>Variables</strong></li>
                    <li>点击 <strong>Add variable</strong> → 选择 <strong>KV Namespace</strong></li>
                    <li>Variable name 填写：<code>EMBY_KV</code>（必须完全一致）</li>
                    <li>Value 选择刚创建的 KV 命名空间</li>
                    <li>点击 <strong>Save</strong></li>
                </ul>
                <div class="guide-warning">
                    ⚠️ 绑定 KV 后，必须重新部署 Worker 才能生效！
                </div>
            </div>
            
            <div class="guide-section">
                <h4>三、绑定自定义域名</h4>
                <p>使用自己的域名替代默认的 workers.dev 域名。</p>
                <p><strong>前提条件</strong>：域名已托管到 Cloudflare</p>
                <p><strong>步骤</strong>：</p>
                <ul>
                    <li>进入 Worker → <strong>Settings</strong> → <strong>Triggers</strong></li>
                    <li>点击 <strong>Add Custom Domain</strong></li>
                    <li>输入你的域名，如：<code>emby.你的域名.com</code></li>
                    <li>点击 <strong>Add Custom Domain</strong></li>
                </ul>
                <div class="guide-tip">
                    💡 Cloudflare 会自动配置 DNS 记录，无需手动添加。
                </div>
            </div>
            
            <div class="guide-section">
                <h4>四、添加优选域名 CNAME（推荐）</h4>
                <p>通过 CNAME 绑定优选域名，可以获得更好的访问速度。</p>
                <p><strong>以绑定 saas.sin.fan 为例</strong>：</p>
                <ul>
                    <li>进入 Cloudflare <strong>DNS</strong> 管理页面</li>
                    <li>点击 <strong>Add record</strong> 添加记录</li>
                    <li>配置如下：
                        <pre><code>类型：CNAME
名称：emby（或其他你想要的子域名）
目标：saas.sin.fan
代理状态：仅DNS（必须关闭橙色云朵）</code></pre>
                    </li>
                    <li>点击 <strong>Save</strong> 保存</li>
                </ul>
                <p><strong>然后在 Worker 中绑定该域名</strong>：</p>
                <ul>
                    <li>Worker → <strong>Settings</strong> → <strong>Triggers</strong></li>
                    <li><strong>Add Custom Domain</strong> → 输入 <code>emby.你的域名.com</code></li>
                </ul>
                <div class="guide-tip">
                    💡 这样用户访问 <code>emby.你的域名.com</code> 时，会通过 Cloudflare 优选节点访问，速度更快。
                </div>
            </div>
            
            <div class="guide-section">
                <h4>五、配置后端服务器</h4>
                <p>1. 访问管理面板：<code>https://你的域名/admin</code></p>
                <p>2. 默认密码：<code>admin123</code>（请及时修改代码中的 ADMIN_PASSWORD）</p>
                <p>3. 在「后端管理」中添加你的 Emby 服务器地址</p>
                <p>4. 点击「复制地址」获取反代地址，分享给用户使用</p>
            </div>
            
            <div class="guide-section">
                <h4>六、多端口说明</h4>
                <p>本系统支持根据访问端口自动路由到不同的后端服务器：</p>
                <table style="margin-top: 10px;">
                    <thead>
                        <tr>
                            <th>访问端口</th>
                            <th>说明</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td>默认（443）</td>
                            <td>使用 default 后端配置</td>
                        </tr>
                        <tr>
                            <td>8443</td>
                            <td>使用端口 8443 对应的后端</td>
                        </tr>
                        <tr>
                            <td>2053</td>
                            <td>使用端口 2053 对应的后端</td>
                        </tr>
                    </tbody>
                </table>
                <div class="guide-warning">
                    ⚠️ 使用非标准端口时，需要在 Cloudflare 中配置并开启该端口的 HTTPS 支持。<br>
                    Cloudflare 支持的 HTTPS 端口：443, 2053, 2083, 2087, 2096, 8443
                </div>
            </div>
            
            <div class="guide-section">
                <h4>七、常见问题</h4>
                <p><strong>Q: 为什么提示 "KV 未配置"？</strong></p>
                <p>A: 请确保已正确绑定 KV，并且变量名完全为 <code>EMBY_KV</code>，绑定后需重新部署。</p>
                
                <p><strong>Q: 为什么出现 429 错误？</strong></p>
                <p>A: KV 写入频率超限。免费版每天 1000 次写入，本系统已优化为每 30 秒写入一次。</p>
                
                <p><strong>Q: 如何修改管理员密码？</strong></p>
                <p>A: 修改代码第 9 行的 <code>ADMIN_PASSWORD</code> 值，然后重新部署。</p>
                
                <p><strong>Q: 为什么无法访问后端？</strong></p>
                <p>A: 检查后端地址是否正确，确保后端服务器可被 Cloudflare 访问（非内网地址）。</p>
            </div>
        </div>
    </div>

    <script>
        let token = localStorage.getItem('admin_token') || '';
        let kvAvailable = true;
        let statsData = null;
        
        async function init() {
            if (token) {
                document.getElementById('loginPage').style.display = 'none';
                document.getElementById('mainPage').style.display = 'block';
                await loadDashboard();
            }
        }
        
        async function login() {
            const password = document.getElementById('password').value;
            try {
                const res = await fetch('/admin/api/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password })
                });
                const data = await res.json();
                if (data.success) {
                    token = data.token;
                    localStorage.setItem('admin_token', token);
                    document.getElementById('loginPage').style.display = 'none';
                    document.getElementById('mainPage').style.display = 'block';
                    await loadDashboard();
                } else {
                    document.getElementById('loginError').textContent = data.error || '登录失败';
                }
            } catch (e) {
                document.getElementById('loginError').textContent = '网络错误';
            }
        }
        
        function logout() {
            token = '';
            localStorage.removeItem('admin_token');
            document.getElementById('loginPage').style.display = 'flex';
            document.getElementById('mainPage').style.display = 'none';
        }
        
        function showPanel(name) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById(name).classList.add('active');
            
            if (name === 'access') loadAccessControl();
            if (name === 'logs') refreshLogs();
        }
        
        async function loadDashboard() {
            try {
                const res = await fetch('/admin/api/stats', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const data = await res.json();
                statsData = data;
                
                if (data.kvWarning) {
                    kvAvailable = false;
                    document.getElementById('kvWarning').style.display = 'block';
                }
                
                if (data.today) {
                    document.getElementById('todayTotal').textContent = data.today.total.toLocaleString();
                    const rate = data.today.total > 0 ? ((data.today.success / data.today.total) * 100).toFixed(1) : 0;
                    document.getElementById('successRate').textContent = rate + '%';
                    document.getElementById('todayBytes').textContent = formatBytes(data.today.bytes);
                    document.getElementById('todayErrors').textContent = data.today.error;
                    
                    const avgDuration = data.today.total > 0 ? (data.today.duration / data.today.total).toFixed(0) : 0;
                    document.getElementById('avgDuration').textContent = avgDuration + 'ms';
                }
                
                renderLineChart(data.history || []);
                renderPieChart(data.today, data.backends);
                renderAnalysis(data.history || [], data.today, data.statsSource);
                renderPortStats(data.today, data.backends);
                renderBackendList(data.backends);
            } catch (e) {
                console.error('加载仪表盘失败', e);
            }
        }
        
        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
        
        function renderLineChart(history) {
            const container = document.getElementById('lineChart');
            if (!history.length) {
                container.innerHTML = '<p style="color: #888; text-align: center; padding: 50px;">暂无数据</p>';
                return;
            }
            
            const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
            const maxTotal = Math.max(...sorted.map(h => h.total), 1);
            const width = 100;
            const height = 80;
            const padding = 5;
            
            let points = '';
            let areaPoints = '';
            let labels = '';
            
            sorted.forEach((h, i) => {
                const x = padding + (i / (sorted.length - 1 || 1)) * (width - padding * 2);
                const y = height - padding - (h.total / maxTotal) * (height - padding * 2);
                points += (i === 0 ? 'M' : 'L') + x + ',' + y;
                areaPoints += (i === 0 ? 'M' : 'L') + x + ',' + y;
                if (i === sorted.length - 1) areaPoints += 'L' + x + ',' + (height - padding) + 'L' + padding + ',' + (height - padding) + 'Z';
                labels += '<text x="' + x + '" y="' + (height + 3) + '" class="chart-label" text-anchor="middle">' + h.date.slice(5) + '</text>';
            });
            
            container.innerHTML = '<svg viewBox="0 0 ' + width + ' ' + (height + 20) + '" preserveAspectRatio="xMidYMid meet">' +
                '<defs><linearGradient id="gradient" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#4ecca3"/><stop offset="100%" stop-color="#4ecca300"/></linearGradient></defs>' +
                '<path d="' + areaPoints + '" class="chart-area"/>' +
                '<path d="' + points + '" class="chart-line"/>' +
                labels +
            '</svg>';
        }
        
        function renderPieChart(today, backends) {
            const container = document.getElementById('pieChart');
            if (!today || !today.ports || Object.keys(today.ports).length === 0) {
                container.innerHTML = '<p style="color: #888;">暂无数据</p>';
                return;
            }
            
            const colors = ['#4ecca3', '#3db892', '#2ca58d', '#1b9178', '#0a7d63'];
            const ports = Object.entries(today.ports);
            const total = ports.reduce((sum, [, p]) => sum + p.bytes, 0);
            
            let cumulativePercent = 0;
            let paths = '';
            let legend = '';
            
            ports.forEach(([port, data], i) => {
                const percent = total > 0 ? (data.bytes / total) : 0;
                const startAngle = cumulativePercent * 2 * Math.PI;
                const endAngle = (cumulativePercent + percent) * 2 * Math.PI;
                
                if (percent > 0) {
                    const x1 = 50 + 40 * Math.sin(startAngle);
                    const y1 = 50 - 40 * Math.cos(startAngle);
                    const x2 = 50 + 40 * Math.sin(endAngle);
                    const y2 = 50 - 40 * Math.cos(endAngle);
                    const largeArc = percent > 0.5 ? 1 : 0;
                    
                    paths += '<path d="M50,50 L' + x1 + ',' + y1 + ' A40,40 0 ' + largeArc + ',1 ' + x2 + ',' + y2 + ' Z" fill="' + colors[i % colors.length] + '"/>';
                }
                
                cumulativePercent += percent;
                
                const backend = backends[port] || {};
                legend += '<div class="pie-legend-item">' +
                    '<div class="pie-legend-color" style="background:' + colors[i % colors.length] + '"></div>' +
                    '<span>' + (backend.name || port) + ': ' + formatBytes(data.bytes) + '</span>' +
                '</div>';
            });
            
            container.innerHTML = '<svg viewBox="0 0 100 100">' + paths + '</svg><div class="pie-legend">' + legend + '</div>';
        }
        
        function getStatusCodeSummary(statusCodes) {
            const entries = Object.entries(statusCodes || {}).sort((a, b) => Number(a[0]) - Number(b[0]));
            return entries.length ? entries.map(([code, count]) => code + '：' + count).join('，') : '-';
        }

        function getStatsSourceLabel(source) {
            if (source === 'durable_object') return '实时聚合';
            if (source === 'kv') return '缓存统计';
            if (source === 'durable_object_error') return '统计异常';
            return '-';
        }

        function renderAnalysis(history, today, statsSource) {
            today = today || {};
            if (!history.length) {
                document.getElementById('weekTotal').textContent = '-';
                document.getElementById('dailyAvg').textContent = '-';
                document.getElementById('weekSuccessRate').textContent = '-';
                document.getElementById('trend').textContent = '-';
                document.getElementById('weekBytes').textContent = '-';
                document.getElementById('dailyBytesAvg').textContent = '-';
                document.getElementById('avgRequestSize').textContent = '-';
                document.getElementById('mediaBytes').textContent = formatBytes(today.mediaBytes || 0);
                document.getElementById('apiBytes').textContent = formatBytes(today.apiBytes || 0);
                document.getElementById('maxRequestBytes').textContent = formatBytes(today.maxRequestBytes || 0);
                document.getElementById('rangeRequests').textContent = (today.rangeRequests || 0).toLocaleString();
                document.getElementById('partialResponses').textContent = (today.partialContentResponses || 0).toLocaleString();
                document.getElementById('mediaRequests').textContent = (today.mediaRequests || 0).toLocaleString();
                document.getElementById('statusCodeSummary').textContent = getStatusCodeSummary(today.statusCodes);
                document.getElementById('statsSource').textContent = getStatsSourceLabel(statsSource);
                document.getElementById('peakDay').textContent = '-';
                return;
            }
            
            const weekTotal = history.reduce((sum, h) => sum + h.total, 0);
            const weekSuccess = history.reduce((sum, h) => sum + h.success, 0);
            const weekErrors = history.reduce((sum, h) => sum + h.error, 0);
            const weekBytes = history.reduce((sum, h) => sum + h.bytes, 0);
            const weekDuration = history.reduce((sum, h) => sum + (h.duration || 0), 0);
            const weekMediaBytes = history.reduce((sum, h) => sum + (h.mediaBytes || 0), 0);
            const weekApiBytes = history.reduce((sum, h) => sum + (h.apiBytes || 0), 0);
            const weekRangeRequests = history.reduce((sum, h) => sum + (h.rangeRequests || 0), 0);
            const weekPartialResponses = history.reduce((sum, h) => sum + (h.partialContentResponses || 0), 0);
            const weekMediaRequests = history.reduce((sum, h) => sum + (h.mediaRequests || 0), 0);
            const maxRequestBytes = history.reduce((max, h) => Math.max(max, h.maxRequestBytes || 0), 0);
            
            document.getElementById('weekTotal').textContent = weekTotal.toLocaleString();
            document.getElementById('dailyAvg').textContent = Math.round(weekTotal / history.length).toLocaleString();
            document.getElementById('weekSuccessRate').textContent = weekTotal > 0 ? ((weekSuccess / weekTotal) * 100).toFixed(1) + '%' : '-';
            
            if (history.length >= 2) {
                const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
                const recent = sorted.slice(-3).reduce((s, h) => s + h.total, 0);
                const previous = sorted.slice(-6, -3).reduce((s, h) => s + h.total, 0);
                const trendPercent = previous > 0 ? ((recent - previous) / previous * 100).toFixed(0) : 0;
                document.getElementById('trend').textContent = (trendPercent >= 0 ? '↑' : '↓') + Math.abs(trendPercent) + '%';
                document.getElementById('trend').style.color = trendPercent >= 0 ? '#4ecca3' : '#e94560';
            }
            
            document.getElementById('weekBytes').textContent = formatBytes(weekBytes);
            document.getElementById('dailyBytesAvg').textContent = formatBytes(weekBytes / history.length);
            document.getElementById('mediaBytes').textContent = formatBytes(weekMediaBytes);
            document.getElementById('apiBytes').textContent = formatBytes(weekApiBytes);
            document.getElementById('avgRequestSize').textContent = weekTotal > 0 ? formatBytes(weekBytes / weekTotal) : '-';
            document.getElementById('maxRequestBytes').textContent = formatBytes(maxRequestBytes);
            
            const peakDay = history.reduce((max, h) => h.bytes > max.bytes ? h : max, history[0]);
            document.getElementById('peakDay').textContent = peakDay.date;
            
            document.getElementById('avgResponseTime').textContent = weekTotal > 0 ? (weekDuration / weekTotal).toFixed(0) + 'ms' : '-';
            document.getElementById('rangeRequests').textContent = weekRangeRequests.toLocaleString();
            document.getElementById('partialResponses').textContent = weekPartialResponses.toLocaleString();
            document.getElementById('mediaRequests').textContent = weekMediaRequests.toLocaleString();
            
            const errorRate = weekTotal > 0 ? (weekErrors / weekTotal * 100) : 0;
            let health = '优秀', healthColor = '#4ecca3';
            if (errorRate > 10) { health = '警告'; healthColor = '#f0a500'; }
            if (errorRate > 30) { health = '异常'; healthColor = '#e94560'; }
            document.getElementById('healthStatus').textContent = health;
            document.getElementById('healthStatus').style.color = healthColor;
            
            document.getElementById('weekErrors').textContent = weekErrors.toLocaleString();
            document.getElementById('errorRate').textContent = errorRate.toFixed(2) + '%';
            document.getElementById('statusCodeSummary').textContent = getStatusCodeSummary(today.statusCodes);
            document.getElementById('statsSource').textContent = getStatsSourceLabel(statsSource);
            
            if (history.length >= 2) {
                const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
                const recentErrors = sorted.slice(-3).reduce((s, h) => s + h.error, 0);
                const previousErrors = sorted.slice(-6, -3).reduce((s, h) => s + h.error, 0);
                const errorTrend = previousErrors > 0 ? ((recentErrors - previousErrors) / previousErrors * 100).toFixed(0) : 0;
                document.getElementById('errorTrend').textContent = (errorTrend >= 0 ? '↑' : '↓') + Math.abs(errorTrend) + '%';
                document.getElementById('errorTrend').style.color = errorTrend <= 0 ? '#4ecca3' : '#e94560';
            }
        }
        
        function renderPortStats(today, backends) {
            const tbody = document.getElementById('portStats');
            const ports = Object.keys(backends || {});
            if (!today || !today.ports) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: #888;">暂无数据</td></tr>';
                return;
            }
            tbody.innerHTML = ports.map(port => {
                const backend = backends[port];
                const stats = today.ports[port] || { total: 0, success: 0, error: 0, bytes: 0, duration: 0, mediaBytes: 0, partialContentResponses: 0 };
                const rate = stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) : 0;
                const avgDuration = stats.total > 0 ? Math.round((stats.duration || 0) / stats.total) : 0;
                return '<tr>' +
                    '<td>' + port + '</td>' +
                    '<td>' + (backend.name || '-') + '</td>' +
                    '<td>' + stats.total.toLocaleString() + '</td>' +
                    '<td>' + rate + '%<div class="progress-bar"><div class="progress-fill" style="width:' + rate + '%"></div></div></td>' +
                    '<td>' + formatBytes(stats.bytes) + '</td>' +
                    '<td>' + formatBytes(stats.mediaBytes || 0) + '</td>' +
                    '<td>' + (stats.partialContentResponses || 0).toLocaleString() + '</td>' +
                    '<td>' + avgDuration + 'ms</td>' +
                    '<td><span class="status ' + (backend.enabled ? 'online' : 'offline') + '">' + (backend.enabled ? '启用' : '禁用') + '</span></td>' +
                    '</tr>';
            }).join('');
        }
        
        function renderBackendList(backends) {
            const tbody = document.getElementById('backendList');
            tbody.innerHTML = Object.entries(backends || {}).map(([port, config]) => {
                const proxyUrl = port === 'default' 
                    ? window.location.origin 
                    : window.location.origin.replace(/(:\\d+)?$/, ':' + port);
                return '<tr>' +
                    '<td>' + port + '</td>' +
                    '<td>' + config.name + '</td>' +
                    '<td style="word-break: break-all;">' + config.url + '</td>' +
                    '<td><span class="status ' + (config.enabled ? 'online' : 'offline') + '">' + (config.enabled ? '启用' : '禁用') + '</span></td>' +
                    '<td>' +
                        '<button class="btn btn-primary" onclick="editBackend(\\'' + port + '\\')">编辑</button> ' +
                        '<button class="btn ' + (config.enabled ? 'btn-secondary' : 'btn-primary') + '" onclick="toggleBackend(\\'' + port + '\\')">' + (config.enabled ? '禁用' : '启用') + '</button> ' +
                        '<button class="btn btn-secondary" onclick="copyProxyUrl(\\'' + proxyUrl + '\\')">复制地址</button> ' +
                        '<button class="btn btn-danger" onclick="deleteBackend(\\'' + port + '\\')">删除</button>' +
                    '</td>' +
                    '</tr>';
            }).join('');
        }
        
        function copyProxyUrl(url) {
            navigator.clipboard.writeText(url).then(() => {
                const toast = document.createElement('div');
                toast.textContent = '已复制: ' + url;
                toast.style.cssText = 'position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: #4ecca3; color: #1a1a2e; padding: 12px 24px; border-radius: 5px; font-weight: bold; z-index: 9999;';
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 2000);
            }).catch(() => {
                alert('复制失败，请手动复制: ' + url);
            });
        }
        
        function editBackend(port) {
            fetch('/admin/api/backends', {
                headers: { 'Authorization': 'Bearer ' + token }
            })
            .then(res => res.json())
            .then(data => {
                const backend = data[port];
                if (backend) {
                    document.getElementById('backendPort').value = port;
                    document.getElementById('backendName').value = backend.name;
                    document.getElementById('backendUrl').value = backend.url;
                }
            });
        }
        
        async function saveBackend() {
            const port = document.getElementById('backendPort').value.trim();
            const name = document.getElementById('backendName').value.trim();
            const url = document.getElementById('backendUrl').value.trim();
            
            if (!port || !name || !url) {
                alert('请填写完整信息');
                return;
            }
            
            try {
                const res = await fetch('/admin/api/backends', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ port, name, url, enabled: true })
                });
                const data = await res.json();
                if (data.success) {
                    alert('保存成功');
                    loadDashboard();
                    document.getElementById('backendPort').value = '';
                    document.getElementById('backendName').value = '';
                    document.getElementById('backendUrl').value = '';
                } else {
                    alert(data.error || '保存失败');
                }
            } catch (e) {
                alert('网络错误');
            }
        }
        
        async function toggleBackend(port) {
            try {
                const res = await fetch('/admin/api/backends/toggle', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ port })
                });
                const data = await res.json();
                if (data.success) {
                    loadDashboard();
                }
            } catch (e) {}
        }
        
        async function deleteBackend(port) {
            if (!confirm('确定要删除此后端配置吗？')) return;
            try {
                const res = await fetch('/admin/api/backends', {
                    method: 'DELETE',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ port })
                });
                const data = await res.json();
                if (data.success) {
                    loadDashboard();
                }
            } catch (e) {}
        }
        
        async function resetBackends() {
            if (!confirm('确定要恢复默认配置吗？这将覆盖当前所有后端配置。')) return;
            try {
                const res = await fetch('/admin/api/backends/reset', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const data = await res.json();
                if (data.success) {
                    alert('已恢复默认配置');
                    loadDashboard();
                }
            } catch (e) {}
        }
        
        async function loadAccessControl() {
            try {
                const res = await fetch('/admin/api/access', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const data = await res.json();
                
                renderIPList('blacklist', data.blacklist || [], 'blacklist');
                renderIPList('whitelist', data.whitelist || [], 'whitelist');
            } catch (e) {}
        }
        
        function renderIPList(elementId, ips, type) {
            const container = document.getElementById(elementId);
            container.innerHTML = ips.map(ip => 
                '<div class="ip-item">' +
                    '<span>' + ip + '</span>' +
                    '<button onclick="removeIP(\\'' + type + '\\', \\'' + ip + '\\')">&times;</button>' +
                '</div>'
            ).join('') || '<span style="color: #888;">暂无</span>';
        }
        
        async function addBlacklist() {
            const ip = document.getElementById('blacklistIP').value.trim();
            if (!ip) return;
            await addIP('blacklist', ip);
            document.getElementById('blacklistIP').value = '';
        }
        
        async function addWhitelist() {
            const ip = document.getElementById('whitelistIP').value.trim();
            if (!ip) return;
            await addIP('whitelist', ip);
            document.getElementById('whitelistIP').value = '';
        }
        
        async function addIP(type, ip) {
            try {
                const res = await fetch('/admin/api/access', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ type, ip, action: 'add' })
                });
                const data = await res.json();
                if (data.success) {
                    loadAccessControl();
                }
            } catch (e) {}
        }
        
        async function removeIP(type, ip) {
            try {
                const res = await fetch('/admin/api/access', {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ type, ip, action: 'remove' })
                });
                const data = await res.json();
                if (data.success) {
                    loadAccessControl();
                }
            } catch (e) {}
        }
        
        async function refreshLogs() {
            try {
                const res = await fetch('/admin/api/logs', {
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const logs = await res.json();
                const container = document.getElementById('errorLogs');
                
                if (!logs.length) {
                    container.innerHTML = '<p style="color: #888; text-align: center;">暂无错误日志</p>';
                    return;
                }
                
                container.innerHTML = logs.map(log => 
                    '<div class="log-entry">' +
                        '<div class="log-time">' + new Date(log.time).toLocaleString() + ' | 端口: ' + log.port + ' | IP: ' + log.clientIP + '</div>' +
                        '<div class="log-error">' + log.error + '</div>' +
                        '<div style="color: #888; font-size: 12px; margin-top: 5px;">URL: ' + log.url + '</div>' +
                    '</div>'
                ).join('');
            } catch (e) {}
        }
        
        async function clearLogs() {
            if (!confirm('确定要清除所有错误日志吗？')) return;
            try {
                const res = await fetch('/admin/api/logs/clear', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('errorLogs').innerHTML = '<p style="color: #888; text-align: center;">暂无错误日志</p>';
                }
            } catch (e) {}
        }
        
        init();
    </script>
</body>
</html>`;
}

// ==================== Durable Object 统计聚合 ====================

export class StatsDurableObject {
    constructor(ctx, env) {
        this.ctx = ctx;
        this.env = env;
        this.lastKvSave = 0;
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS daily_stats (
                date TEXT PRIMARY KEY,
                total INTEGER NOT NULL,
                success INTEGER NOT NULL,
                error INTEGER NOT NULL,
                bytes INTEGER NOT NULL,
                duration INTEGER NOT NULL,
                ports TEXT NOT NULL,
                details TEXT
            )
        `);
        this.ensureSchema();
    }

    ensureSchema() {
        try {
            const columns = this.ctx.storage.sql.exec('PRAGMA table_info(daily_stats)').toArray();
            const hasDetails = columns.some(column => column.name === 'details');
            if (!hasDetails) {
                this.ctx.storage.sql.exec('ALTER TABLE daily_stats ADD COLUMN details TEXT');
            }
        } catch (e) {
            if (!String(e.message || '').toLowerCase().includes('duplicate')) {
                console.error('Stats schema migration error:', e.message);
            }
        }
    }

    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/summary' && request.method === 'GET') {
            const days = Math.max(1, Math.min(30, Number(url.searchParams.get('days')) || 7));
            const history = this.getHistory(days);
            const today = new Date().toISOString().split('T')[0];
            const todayStats = history.find(item => item.date === today);
            return new Response(JSON.stringify({
                today: todayStats ? ensureStatsShape({ ...todayStats }) : createEmptyStats(),
                history
            }), {
                headers: { 'Content-Type': 'application/json' }
            });
        }

        if (url.pathname !== '/increment' || request.method !== 'POST') {
            return new Response('Not found', { status: 404 });
        }

        const body = await request.json();
        const today = new Date().toISOString().split('T')[0];
        const stats = this.getStats(today);

        applyStatsIncrement(
            stats,
            String(body.port || 'default'),
            body.success === true,
            Number(body.bytes) || 0,
            Number(body.duration) || 0,
            body.countRequest !== false,
            body.meta || {}
        );

        this.saveStats(today, stats);
        this.syncKvIfNeeded(today, stats);

        return new Response(JSON.stringify({ success: true }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }

    getStats(date) {
        const row = this.ctx.storage.sql
            .exec('SELECT total, success, error, bytes, duration, ports, details FROM daily_stats WHERE date = ?', date)
            .toArray()[0];

        return statsFromStorageRow(row);
    }

    getHistory(days) {
        const today = new Date();
        const from = new Date(today);
        from.setDate(from.getDate() - days + 1);
        const fromStr = from.toISOString().split('T')[0];
        const todayStr = today.toISOString().split('T')[0];

        return this.ctx.storage.sql
            .exec(
                `SELECT date, total, success, error, bytes, duration, ports, details
                 FROM daily_stats
                 WHERE date BETWEEN ? AND ?
                 ORDER BY date DESC
                 LIMIT ?`,
                fromStr,
                todayStr,
                days
            )
            .toArray()
            .map(row => ({
                date: row.date,
                ...statsFromStorageRow(row)
            }));
    }

    saveStats(date, stats) {
        ensureStatsShape(stats);
        this.ctx.storage.sql.exec(
            `INSERT INTO daily_stats (date, total, success, error, bytes, duration, ports, details)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(date) DO UPDATE SET
                total = excluded.total,
                success = excluded.success,
                error = excluded.error,
                bytes = excluded.bytes,
                duration = excluded.duration,
                ports = excluded.ports,
                details = excluded.details`,
            date,
            stats.total,
            stats.success,
            stats.error,
            stats.bytes,
            stats.duration,
            JSON.stringify(stats.ports),
            JSON.stringify(stats)
        );
    }

    syncKvIfNeeded(date, stats) {
        if (!this.env.EMBY_KV) return;
        const now = Date.now();
        if (now - this.lastKvSave < STATS_SAVE_INTERVAL && this.lastKvSave !== 0) return;

        this.lastKvSave = now;
        this.ctx.waitUntil(
            this.env.EMBY_KV.put(`stats:${date}`, JSON.stringify(stats), { expirationTtl: 86400 * 90 })
                .catch(e => console.error('KV write error:', e.message))
        );
    }
}

// ==================== API 处理函数 ====================

async function handleLogin(request, env) {
    const body = await request.json();
    if (body.password === ADMIN_PASSWORD) {
        const token = generateToken();
        if (env && env.EMBY_KV) {
            await env.EMBY_KV.put('session:admin', token, { expirationTtl: 86400 });
        } else {
            memoryToken = token;
        }
        return new Response(JSON.stringify({ success: true, token }), {
            headers: { 'Content-Type': 'application/json' }
        });
    }
    return new Response(JSON.stringify({ success: false, error: '密码错误' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
    });
}

async function handleStatsAPI(request, env) {
    const hasKV = env && env.EMBY_KV;

    if (!await verifySession(request, env)) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const backendsPromise = getBackendConfig(env);

    if (env && env.STATS_DO) {
        try {
            const stub = getStatsDoStub(env);
            const [backends, res] = await Promise.all([
                backendsPromise,
                stub.fetch('https://stats.local/summary?days=7')
            ]);
            const data = await res.json();

            return new Response(JSON.stringify({
                today: data.today || createEmptyStats(),
                history: data.history || [],
                backends: backends,
                kvWarning: !hasKV,
                statsSource: 'durable_object'
            }), { headers: { 'Content-Type': 'application/json' } });
        } catch (e) {
            const backends = await backendsPromise.catch(() => DEFAULT_BACKENDS);
            console.error('Durable Object stats read error:', e.message);
            return new Response(JSON.stringify({
                error: '统计服务暂时不可用',
                details: e.message,
                today: createEmptyStats(),
                history: [],
                backends: backends,
                kvWarning: !hasKV,
                statsSource: 'durable_object_error'
            }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
    }

    const today = new Date().toISOString().split('T')[0];
    const [backends, todayStats, history] = await Promise.all([
        backendsPromise,
        hasKV ? env.EMBY_KV.get(`stats:${today}`, { type: 'json' }).then(stats => stats || createEmptyStats()) : createEmptyStats(),
        hasKV ? getStatsSummary(env, 7) : []
    ]);

    return new Response(JSON.stringify({
        today: todayStats,
        history: history,
        backends: backends,
        kvWarning: !hasKV,
        statsSource: 'kv'
    }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleBackendsAPI(request, env) {
    if (!await verifySession(request, env)) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const backends = { ...(await getBackendConfig(env)) };

    if (request.method === 'GET') {
        return new Response(JSON.stringify(backends), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST') {
        const body = await request.json();
        backends[body.port] = {
            name: body.name,
            url: body.url,
            enabled: body.enabled !== false
        };
        await saveBackendConfig(env, backends);
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'DELETE') {
        const body = await request.json();
        delete backends[body.port];
        await saveBackendConfig(env, backends);
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: '不支持的请求方法' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}

async function handleToggleBackendAPI(request, env) {
    if (!await verifySession(request, env)) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const body = await request.json();
    const backends = { ...(await getBackendConfig(env)) };

    if (backends[body.port]) {
        backends[body.port].enabled = !backends[body.port].enabled;
        await saveBackendConfig(env, backends);
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: '后端不存在' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

async function handleResetBackendsAPI(request, env) {
    if (!await verifySession(request, env)) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    await saveBackendConfig(env, DEFAULT_BACKENDS);
    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleAccessAPI(request, env) {
    if (!env || !env.EMBY_KV) {
        return new Response(JSON.stringify({ blacklist: [], whitelist: [] }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!await verifySession(request, env)) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'GET') {
        const { blacklist, whitelist } = await getAccessConfig(env);
        return new Response(JSON.stringify({ blacklist, whitelist }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST') {
        const body = await request.json();
        const key = body.type === 'blacklist' ? 'config:blacklist' : 'config:whitelist';
        const { blacklist, whitelist } = await getAccessConfig(env);
        let list = body.type === 'blacklist' ? [...blacklist] : [...whitelist];

        if (body.action === 'add' && !list.includes(body.ip)) {
            list.push(body.ip);
        } else if (body.action === 'remove') {
            list = list.filter(ip => ip !== body.ip);
        }

        updateAccessCache(body.type, list);
        await env.EMBY_KV.put(key, JSON.stringify(list));
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ error: '不支持的请求方法' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
}

async function handleLogsAPI(request, env) {
    if (!env || !env.EMBY_KV) {
        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!await verifySession(request, env)) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const logs = await getRecentErrors(env, 50);
    return new Response(JSON.stringify(logs), { headers: { 'Content-Type': 'application/json' } });
}

async function handleClearLogsAPI(request, env) {
    if (!env || !env.EMBY_KV) {
        return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (!await verifySession(request, env)) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    await env.EMBY_KV.delete(ERROR_LOGS_KEY);
    errorLogCache = [];
    lastErrorLogSave = 0;

    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

// ==================== 代理处理函数 ====================

async function handleProxy(request, env, ctx) {
    const url = new URL(request.url);
    const clientIP = getClientIP(request);

    if (!await checkIPAccess(clientIP, env)) {
        return new Response('Access Denied', { status: 403 });
    }

    const backends = await getBackendConfig(env);

    let FRONTEND_URL = "";
    let portKey = "default";

    const port = url.port || "443";

    if (backends[port] && backends[port].enabled) {
        FRONTEND_URL = backends[port].url;
        portKey = port;
    } else if (backends["default"]) {
        FRONTEND_URL = backends["default"].url;
    } else {
        return new Response('No backend configured', { status: 502 });
    }

    if (request.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
                "Access-Control-Allow-Headers": "*",
                "Access-Control-Max-Age": "86400",
            },
        });
    }

    let targetUrlStr;
    const decodedPath = decodeURIComponent(url.pathname);

    if (decodedPath.startsWith('/http://') || decodedPath.startsWith('/https://')) {
        targetUrlStr = decodedPath.substring(1) + url.search;
    } else {
        targetUrlStr = FRONTEND_URL + url.pathname + url.search;
    }

    const targetUrl = new URL(targetUrlStr);
    const requestId = crypto.randomUUID();
    const rangeHeader = request.headers.get('Range') || '';
    proxyDebug('request', {
        requestId,
        method: request.method,
        port: portKey,
        path: url.pathname,
        targetHost: targetUrl.host,
        range: rangeHeader,
        userAgent: request.headers.get('User-Agent') || ''
    });

    const newHeaders = new Headers(request.headers);
    newHeaders.set("Host", targetUrl.host);
    newHeaders.delete("cf-connecting-ip");
    newHeaders.delete("cf-ipcountry");
    newHeaders.delete("cf-ray");
    newHeaders.delete("cf-visitor");

    const startTime = Date.now();

    try {
        const modifiedRequest = new Request(targetUrl, {
            method: request.method,
            headers: newHeaders,
            body: (request.method !== 'GET' && request.method !== 'HEAD') ? request.body : null,
            duplex: 'half',
            redirect: 'manual'
        });

        const response = await fetch(modifiedRequest);
        const responseHeaders = new Headers(response.headers);
        const responseContentType = responseHeaders.get('Content-Type') || '';
        const statsMeta = {
            statusCode: response.status,
            hasRange: Boolean(rangeHeader),
            isPartialContent: response.status === 206,
            isMedia: isMediaResponse(url.pathname, responseContentType)
        };
        proxyDebug('response', {
            requestId,
            status: response.status,
            port: portKey,
            contentType: responseHeaders.get('Content-Type') || '',
            contentLength: responseHeaders.get('Content-Length') || '',
            contentRange: responseHeaders.get('Content-Range') || '',
            acceptRanges: responseHeaders.get('Accept-Ranges') || ''
        });

        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = responseHeaders.get('Location');
            if (location && (location.startsWith('http://') || location.startsWith('https://'))) {
                responseHeaders.set('Location', `/${encodeURIComponent(location)}`);
            }
        }

        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Cache-Control', 'no-store');

        if (!response.body) {
            const duration = Date.now() - startTime;
            proxyDebug('stats', {
                requestId,
                port: portKey,
                bytes: 0,
                duration,
                countRequest: true,
                final: true
            });
            await recordStats(env, portKey, response.ok, 0, duration, true, statsMeta);

            return new Response(null, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders
            });
        }

        const shouldPassThroughBody = request.method === 'GET' && (
            Boolean(rangeHeader) ||
            statsMeta.isPartialContent ||
            statsMeta.isMedia
        );

        if (shouldPassThroughBody) {
            const duration = Date.now() - startTime;
            const bytes = getPassthroughStatsBytes(rangeHeader, responseHeaders);
            const byteSource = getPassthroughByteSource(rangeHeader, bytes);
            const unmeteredBytesHint = bytes > 0 ? 0 : parseContentRangeBytes(responseHeaders.get('Content-Range')) || parseContentLength(responseHeaders);
            const passthroughMeta = {
                ...statsMeta,
                isUnmeteredPassthrough: bytes === 0,
                unmeteredBytesHint
            };
            proxyDebug('stats', {
                requestId,
                port: portKey,
                bytes,
                unmeteredBytesHint,
                duration,
                countRequest: true,
                final: true,
                passthrough: true,
                byteSource
            });
            const statsPromise = recordStats(env, portKey, response.ok, bytes, duration, true, passthroughMeta);
            if (ctx && typeof ctx.waitUntil === 'function') {
                ctx.waitUntil(statsPromise);
            } else {
                await statsPromise;
            }

            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: responseHeaders
            });
        }

        const reader = response.body.getReader();
        let pendingBytes = 0;
        let requestRecorded = false;
        let lastStatsFlush = Date.now();
        const flushStats = (force = false) => {
            if (pendingBytes <= 0 && (requestRecorded || !force)) return;
            const now = Date.now();
            const countRequest = !requestRecorded;
            requestRecorded = true;
            proxyDebug('stats', {
                requestId,
                port: portKey,
                bytes: pendingBytes,
                duration: now - startTime,
                countRequest,
                final: force
            });
            const statsPromise = recordStats(env, portKey, response.ok, pendingBytes, now - startTime, countRequest, statsMeta);
            pendingBytes = 0;
            lastStatsFlush = now;
            if (ctx && typeof ctx.waitUntil === 'function') {
                ctx.waitUntil(statsPromise);
            }
        };

        const countedBody = new ReadableStream({
            async pull(controller) {
                const { done, value } = await reader.read();
                if (done) {
                    flushStats(true);
                    controller.close();
                    return;
                }
                const chunkBytes = value.byteLength || 0;
                pendingBytes += chunkBytes;
                const now = Date.now();
                if (pendingBytes >= STATS_STREAM_FLUSH_BYTES || now - lastStatsFlush >= STATS_STREAM_FLUSH_INTERVAL) {
                    flushStats();
                }
                controller.enqueue(value);
            },
            async cancel(reason) {
                flushStats(true);
                await reader.cancel(reason);
            }
        });

        return new Response(countedBody, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
        });

    } catch (err) {
        const duration = Date.now() - startTime;
        proxyDebug('error', {
            requestId,
            port: portKey,
            path: url.pathname,
            duration,
            error: err.message
        });
        const errorStatsPromise = recordStats(env, portKey, false, 0, duration, true, { statusCode: 502, hasRange: Boolean(rangeHeader), isPartialContent: false, isMedia: isMediaResponse(url.pathname, '') });
        const errorLogPromise = logError(env, portKey, err.message, sanitizeLogUrl(url.pathname + url.search), clientIP);
        if (ctx && typeof ctx.waitUntil === 'function') {
            ctx.waitUntil(Promise.all([errorStatsPromise, errorLogPromise]));
        } else {
            await Promise.all([errorStatsPromise, errorLogPromise]);
        }

        return new Response("Worker Proxy Error: " + err.message, { status: 502 });
    }
}

// ==================== 主入口 ====================

async function handleRequest(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/admin' || url.pathname === '/admin/') {
        return new Response(getAdminHTML(), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }

    if (url.pathname.startsWith('/admin/api/')) {
        const apiPath = url.pathname.replace('/admin/api/', '');

        switch (apiPath) {
            case 'login':
                return handleLogin(request, env);
            case 'stats':
                return handleStatsAPI(request, env);
            case 'backends':
                return handleBackendsAPI(request, env);
            case 'backends/toggle':
                return handleToggleBackendAPI(request, env);
            case 'backends/reset':
                return handleResetBackendsAPI(request, env);
            case 'access':
                return handleAccessAPI(request, env);
            case 'logs':
                return handleLogsAPI(request, env);
            case 'logs/clear':
                return handleClearLogsAPI(request, env);
            default:
                return new Response(JSON.stringify({ error: 'API not found' }), { 
                    status: 404, 
                    headers: { 'Content-Type': 'application/json' } 
                });
        }
    }

    return handleProxy(request, env, ctx);
}

// 事件监听器 - ES Modules 格式
export { statsFromStorageRow };

export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env, ctx);
    }
};
