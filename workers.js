// ============================================
// Emby 反向代理 + 管理后台
// Cloudflare Worker 版本
// ============================================

// ==================== 配置区 ====================
// 管理员密码（建议通过环境变量设置：wrangler.toml 或 Cloudflare Dashboard）
const ADMIN_PASSWORD = "yourpassword"; // 请修改为强密码！

// KV 命名空间绑定（需要在 wrangler.toml 中配置）
// [[kv_namespaces]]
// binding = "EMBY_KV"
// id = "你的KV命名空间ID"

// ==================== 默认后端配置 ====================
const DEFAULT_BACKENDS = {
    "8443": {
        name: "Emby 2",
        url: "https://link00.okemby.org:8443",
        enabled: true
    },
    "2053": {
        name: "Emby 3",
        url: "https://www.lilyemby.com",
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

// 内存中的统计缓存（减少KV写入频率）
const STATS_RETENTION_TTL = 86400 * 90;
const STATS_REQUEST_PREFIX = 'stats:req:';
const STATS_TIMEZONE = 'Asia/Shanghai';
const STATS_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
    timeZone: STATS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
});

function createEmptyStats() {
    return { total: 0, success: 0, error: 0, bytes: 0, duration: 0, ports: {}, peakQps: 0 };
}

const STATS_MINUTE_BUCKET_PREFIX = 'stats:req_per_minute:';
const STATS_PEAK_QPS_PREFIX = 'stats:peak_qps:';


function getStatsDateString(date = new Date()) {
    const parts = STATS_DATE_FORMATTER.formatToParts(date);
    const year = parts.find(part => part.type === 'year')?.value || '1970';
    const month = parts.find(part => part.type === 'month')?.value || '01';
    const day = parts.find(part => part.type === 'day')?.value || '01';
    return `${year}-${month}-${day}`;
}

function mergeStats(target, source) {
    if (!source) return target;

    target.total += Number(source.total) || 0;
    target.success += Number(source.success) || 0;
    target.error += Number(source.error) || 0;
    target.bytes += Number(source.bytes) || 0;
    target.duration += Number(source.duration) || 0;

    if (source.ports && typeof source.ports === 'object') {
        for (const [port, portStats] of Object.entries(source.ports)) {
            if (!target.ports[port]) {
                target.ports[port] = { total: 0, success: 0, error: 0, bytes: 0, duration: 0 };
            }
            target.ports[port].total += Number(portStats?.total) || 0;
            target.ports[port].success += Number(portStats?.success) || 0;
            target.ports[port].error += Number(portStats?.error) || 0;
            target.ports[port].bytes += Number(portStats?.bytes) || 0;
            target.ports[port].duration += Number(portStats?.duration) || 0;
        }
    }

    return target;
}

function addRequestStats(target, port, success, bytes, duration) {
    const portKey = port || 'default';

    target.total++;
    if (success) target.success++;
    else target.error++;
    target.bytes += Number(bytes) || 0;
    target.duration += Number(duration) || 0;

    if (!target.ports[portKey]) {
        target.ports[portKey] = { total: 0, success: 0, error: 0, bytes: 0, duration: 0 };
    }

    target.ports[portKey].total++;
    if (success) target.ports[portKey].success++;
    else target.ports[portKey].error++;
    target.ports[portKey].bytes += Number(bytes) || 0;
    target.ports[portKey].duration += Number(duration) || 0;
}

// 统计写入间隔（毫秒）- 每30秒写入一次KV
const PEAK_QPS_WRITE_INTERVAL = 10;
let minuteCountCache = {}; // { date_bucket: count }

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

// 检查IP是否在黑名单/白名单中
async function checkIPAccess(clientIP, env) {
    if (!env || !env.EMBY_KV) return true;
    const blacklist = await env.EMBY_KV.get('config:blacklist', { type: 'json' }) || [];
    const whitelist = await env.EMBY_KV.get('config:whitelist', { type: 'json' });
    
    // 如果设置了白名单，只允许白名单IP
    if (whitelist && whitelist.length > 0) {
        return whitelist.includes(clientIP);
    }
    
    // 否则检查黑名单
    return !blacklist.includes(clientIP);
}

// 获取后端配置
async function getBackendConfig(env) {
    if (!env || !env.EMBY_KV) return DEFAULT_BACKENDS;
    const config = await env.EMBY_KV.get('config:backends', { type: 'json' });
    return config || DEFAULT_BACKENDS;
}

// 保存后端配置
async function saveBackendConfig(env, config) {
    if (!env || !env.EMBY_KV) return;
    await env.EMBY_KV.put('config:backends', JSON.stringify(config));
}

// 记录统计数据（使用内存缓存，减少KV写入）
async function recordStats(env, port, success, bytes, duration) {
    if (!env || !env.EMBY_KV) return;
    
    const statsKey = `${STATS_REQUEST_PREFIX}${getStatsDateString()}:${Date.now()}:${crypto.randomUUID()}`;
    const payload = {
        time: new Date().toISOString(),
        port: port || 'default',
        success: Boolean(success),
        bytes: Number(bytes) || 0,
        duration: Number(duration) || 0
    };

    // 精准峰值QPS统计：按每分钟请求数记录并计算最大值（每10次请求写一次KV）
    try {
        const now = Date.now();
        const bucket = Math.floor(now / 60000);
        const dateStr = getStatsDateString(new Date(now));
        const bucketKey = `${dateStr}:${bucket}`;

        minuteCountCache[bucketKey] = (minuteCountCache[bucketKey] || 0) + 1;

        if (minuteCountCache[bucketKey] >= PEAK_QPS_WRITE_INTERVAL) {
            const writeCount = minuteCountCache[bucketKey];
            minuteCountCache[bucketKey] = 0;

            const minuteKey = `${STATS_MINUTE_BUCKET_PREFIX}${dateStr}:${bucket}`;
            let minuteCount = Number(await env.EMBY_KV.get(minuteKey)) || 0;
            minuteCount += writeCount;
            await env.EMBY_KV.put(minuteKey, String(minuteCount), { expirationTtl: STATS_RETENTION_TTL });

            const peakKey = `${STATS_PEAK_QPS_PREFIX}${dateStr}`;
            let currentPeak = Number(await env.EMBY_KV.get(peakKey)) || 0;
            if (minuteCount > currentPeak) {
                await env.EMBY_KV.put(peakKey, String(minuteCount), { expirationTtl: STATS_RETENTION_TTL });
            }
        }
    } catch (e) {
        console.error('KV peakQps update error:', e.message);
    }
    
    // 如果是新的一天，重置缓存
    
    // 更新内存中的统计数据
    
    // 每30秒写入一次KV，或者首次请求时写入
    try {
        await env.EMBY_KV.put(statsKey, JSON.stringify(payload), { expirationTtl: STATS_RETENTION_TTL });
    } catch (e) {
            // KV写入失败时忽略，不影响代理功能
        console.error('KV write error:', e.message);
    }
}

// 错误日志缓存
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
    
    // 每60秒写入一次KV
    if (now - lastErrorLogSave >= ERROR_LOG_SAVE_INTERVAL) {
        lastErrorLogSave = now;
        try {
            // 只保存最新的错误
            const recentErrors = errorLogCache.slice(-10);
            for (let i = 0; i < recentErrors.length; i++) {
                const key = `logs:errors:${now + i}`;
                await env.EMBY_KV.put(key, JSON.stringify(recentErrors[i]), { expirationTtl: 86400 * 7 });
            }
        } catch (e) {
            console.error('KV write error:', e.message);
        }
    }
}

// 获取最近错误日志
async function getRecentErrors(env, limit = 50) {
    if (!env || !env.EMBY_KV) return [];
    const list = await env.EMBY_KV.list({ prefix: 'logs:errors:', limit: limit });
    const logs = [];
    for (const key of list.keys) {
        const log = await env.EMBY_KV.get(key.name, { type: 'json' });
        if (log) logs.push(log);
    }
    return logs.sort((a, b) => new Date(b.time) - new Date(a.time));
}

// 获取统计数据
async function getDailyStats(env, dateStr) {
    const combinedStats = createEmptyStats();
    if (!env || !env.EMBY_KV) return combinedStats;

    const legacyStats = await env.EMBY_KV.get(`stats:${dateStr}`, { type: 'json' });
    mergeStats(combinedStats, legacyStats);

    // 读取当日最高QPS
    combinedStats.peakQps = Number(await env.EMBY_KV.get(`${STATS_PEAK_QPS_PREFIX}${dateStr}`)) || 0;

    let cursor = undefined;
    do {
        const page = await env.EMBY_KV.list({
            prefix: `${STATS_REQUEST_PREFIX}${dateStr}:`,
            limit: 100,  // 减少limit以避免太多KV请求
            cursor
        });

        const events = await Promise.all(
            page.keys.map(key => env.EMBY_KV.get(key.name, { type: 'json' }))
        );

        for (const event of events) {
            if (!event) continue;
            addRequestStats(
                combinedStats,
                event.port || 'default',
                Boolean(event.success),
                event.bytes,
                event.duration
            );
        }

        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    return combinedStats;
}

async function getStatsSummary(env, days = 3) {  // 减少默认天数以减少KV请求
    if (!env || !env.EMBY_KV) return [];
    const stats = [];
    
    for (let i = 0; i < days; i++) {
        const date = new Date(Date.now() - (i * 86400000));
        const dateStr = getStatsDateString(date);
        const dayStats = await getDailyStats(env, dateStr);
        if (dayStats.total > 0 || dayStats.bytes > 0 || dayStats.error > 0 || dayStats.success > 0 || Object.keys(dayStats.ports).length > 0) {
            stats.push({ date: dateStr, ...dayStats });
        }
    }
    
    return stats;
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
        :root {
            --bg: #08121f;
            --panel: rgba(15, 26, 43, 0.86);
            --panel-soft: rgba(18, 33, 53, 0.72);
            --line: rgba(151, 167, 191, 0.16);
            --text: #ecf4ff;
            --muted: #93a7bf;
            --brand: #62d1b2;
            --brand-strong: #2aa582;
            --danger: #ff8f78;
            --warning: #f2c46d;
            --shadow: 0 28px 60px rgba(0, 0, 0, 0.28);
            --radius-lg: 26px;
            --radius-md: 18px;
            --radius-sm: 14px;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { min-height: 100%; }
        body {
            font-family: "Avenir Next", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
            color: var(--text);
            background:
                radial-gradient(circle at 10% 10%, rgba(98, 209, 178, 0.14), transparent 26%),
                radial-gradient(circle at 85% 0%, rgba(59, 130, 246, 0.14), transparent 24%),
                linear-gradient(160deg, #08121f 0%, #0b1626 45%, #0e1b2f 100%);
            overflow-x: hidden;
        }

        body::before {
            content: "";
            position: fixed;
            inset: -25%;
            background:
                radial-gradient(circle at 20% 25%, rgba(98, 209, 178, 0.08), transparent 20%),
                radial-gradient(circle at 80% 70%, rgba(59, 130, 246, 0.08), transparent 20%);
            filter: blur(36px);
            pointer-events: none;
            z-index: 0;
        }

        a { color: #8fead1; text-decoration: none; }
        a:hover { color: #c3fff0; }
        button, input, select { font: inherit; }

        .container {
            position: relative;
            z-index: 1;
            max-width: 1480px;
            margin: 0 auto;
            padding: 28px 20px 40px;
        }

        .eyebrow {
            display: inline-flex;
            align-items: center;
            padding: 7px 12px;
            border: 1px solid rgba(98, 209, 178, 0.24);
            border-radius: 999px;
            background: rgba(98, 209, 178, 0.08);
            color: #a9f1dd;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.1em;
            text-transform: uppercase;
        }

        .login-container {
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            padding: 24px;
            position: relative;
            z-index: 1;
        }

        .login-box {
            width: 100%;
            max-width: 460px;
            padding: 42px;
            border: 1px solid var(--line);
            border-radius: 30px;
            background:
                radial-gradient(circle at top right, rgba(98, 209, 178, 0.14), transparent 34%),
                linear-gradient(160deg, rgba(12, 23, 39, 0.96), rgba(18, 33, 53, 0.9));
            box-shadow: var(--shadow);
            backdrop-filter: blur(18px);
        }

        .login-box h1 {
            margin: 18px 0 12px;
            font-size: 34px;
            line-height: 1.12;
            letter-spacing: -0.04em;
            color: var(--text);
        }

        .login-copy {
            margin-bottom: 24px;
            color: var(--muted);
            line-height: 1.8;
        }

        .login-box input {
            width: 100%;
            padding: 15px 16px;
            margin: 12px 0 14px;
            border: 1px solid rgba(151, 167, 191, 0.16);
            border-radius: 14px;
            background: rgba(8, 16, 28, 0.7);
            color: var(--text);
            font-size: 15px;
            outline: none;
            transition: border-color 0.2s ease, box-shadow 0.2s ease;
        }

        .login-box input:focus,
        .form-group input:focus,
        .form-group select:focus {
            border-color: rgba(98, 209, 178, 0.34);
            box-shadow: 0 0 0 4px rgba(98, 209, 178, 0.1);
        }

        .login-box button,
        .header button,
        .btn {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            padding: 12px 18px;
            border: 1px solid transparent;
            border-radius: 14px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 700;
            transition: transform 0.2s ease, opacity 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
        }

        .login-box button {
            width: 100%;
            background: linear-gradient(135deg, var(--brand), var(--brand-strong));
            color: #061711;
            box-shadow: 0 18px 34px rgba(42, 165, 130, 0.24);
        }

        .login-box button:hover,
        .header button:hover,
        .btn:hover {
            transform: translateY(-1px);
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 18px;
            margin-bottom: 28px;
            padding: 26px 28px;
            border: 1px solid var(--line);
            border-radius: var(--radius-lg);
            background:
                radial-gradient(circle at top right, rgba(59, 130, 246, 0.14), transparent 30%),
                linear-gradient(145deg, rgba(13, 25, 41, 0.96), rgba(18, 33, 53, 0.88));
            box-shadow: var(--shadow);
        }

        .header h1 {
            margin: 14px 0 10px;
            font-size: clamp(30px, 4vw, 46px);
            line-height: 1.08;
            letter-spacing: -0.05em;
            color: var(--text);
        }

        .header-subtitle {
            color: var(--muted);
            line-height: 1.8;
            max-width: 740px;
        }

        .header-actions {
            display: flex;
            gap: 12px;
            align-items: stretch;
            flex-wrap: wrap;
        }

        .header-chip {
            min-width: 170px;
            padding: 14px 16px;
            border: 1px solid rgba(151, 167, 191, 0.12);
            border-radius: 16px;
            background: rgba(255, 255, 255, 0.04);
        }

        .header-chip span {
            display: block;
            color: var(--muted);
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }

        .header-chip strong {
            display: block;
            margin-top: 10px;
            font-size: 15px;
            word-break: break-all;
        }

        .header button {
            background: linear-gradient(135deg, #ff9b85, #ff7b63);
            color: #2c0903;
            box-shadow: 0 16px 28px rgba(255, 123, 99, 0.18);
        }

        .hero-card {
            position: relative;
            overflow: hidden;
            display: grid;
            grid-template-columns: 1.35fr 0.9fr;
            gap: 18px;
            padding: 28px;
            margin-bottom: 24px;
            border: 1px solid var(--line);
            border-radius: var(--radius-lg);
            background:
                radial-gradient(circle at top right, rgba(59, 130, 246, 0.14), transparent 26%),
                radial-gradient(circle at 10% 20%, rgba(98, 209, 178, 0.12), transparent 28%),
                linear-gradient(145deg, rgba(13, 25, 41, 0.96), rgba(18, 33, 53, 0.88));
            box-shadow: var(--shadow);
        }

        .hero-card::after {
            content: "";
            position: absolute;
            right: -80px;
            top: -110px;
            width: 280px;
            height: 280px;
            border-radius: 50%;
            background: radial-gradient(circle, rgba(98, 209, 178, 0.12), transparent 68%);
            pointer-events: none;
        }

        .hero-copy h2 {
            margin: 14px 0 12px;
            font-size: clamp(30px, 3.5vw, 50px);
            line-height: 1.05;
            letter-spacing: -0.05em;
        }

        .hero-copy p {
            max-width: 720px;
            color: var(--muted);
            line-height: 1.8;
        }

        .hero-metrics {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 14px;
            align-self: end;
        }

        .hero-metric {
            padding: 16px 18px;
            border: 1px solid rgba(151, 167, 191, 0.12);
            border-radius: 16px;
            background: rgba(255, 255, 255, 0.04);
        }

        .hero-metric span {
            display: block;
            color: var(--muted);
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }

        .hero-metric strong {
            display: block;
            margin-top: 10px;
            font-size: 28px;
            color: var(--text);
            letter-spacing: -0.04em;
        }

        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 28px;
        }

        .stat-card,
        .panel,
        .chart-box,
        .analysis-card {
            border: 1px solid var(--line);
            box-shadow: var(--shadow);
            backdrop-filter: blur(16px);
        }

        .stat-card {
            position: relative;
            padding: 22px 20px;
            border-radius: 22px;
            background: linear-gradient(180deg, rgba(15, 26, 43, 0.95), rgba(18, 33, 53, 0.78));
            text-align: left;
        }

        .stat-card::before {
            content: "";
            position: absolute;
            left: 20px;
            top: 18px;
            width: 38px;
            height: 4px;
            border-radius: 999px;
            background: linear-gradient(90deg, var(--brand), rgba(98, 209, 178, 0.18));
        }

        .stat-card.error::before { background: linear-gradient(90deg, var(--danger), rgba(255, 143, 120, 0.18)); }
        .stat-card.warning::before { background: linear-gradient(90deg, var(--warning), rgba(242, 196, 109, 0.18)); }

        .stat-card h3 {
            margin-top: 18px;
            color: #a8bdd6;
            font-size: 12px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }

        .stat-card .value {
            margin-top: 16px;
            font-size: clamp(28px, 2.8vw, 38px);
            font-weight: 800;
            letter-spacing: -0.05em;
            color: var(--brand);
        }

        .stat-card.warning .value { color: var(--warning); }
        .stat-card.error .value { color: var(--danger); }

        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }

        .tab {
            padding: 13px 18px;
            border-radius: 999px;
            border: 1px solid rgba(151, 167, 191, 0.12);
            background: rgba(255, 255, 255, 0.04);
            color: #a6bdd8;
            cursor: pointer;
            font-size: 14px;
            font-weight: 700;
        }

        .tab.active {
            background: linear-gradient(135deg, rgba(98, 209, 178, 0.2), rgba(59, 130, 246, 0.14));
            color: var(--text);
            border-color: rgba(98, 209, 178, 0.22);
        }

        .tab:hover:not(.active) {
            background: rgba(255, 255, 255, 0.08);
            color: var(--text);
        }

        .panel {
            display: none;
            border-radius: var(--radius-lg);
            padding: 26px;
            background: linear-gradient(180deg, rgba(15, 26, 43, 0.94), rgba(18, 33, 53, 0.82));
        }

        .panel.active { display: block; }
        .section { margin-bottom: 30px; }

        .section-title {
            font-size: 18px;
            color: var(--text);
            margin-bottom: 18px;
            padding-bottom: 12px;
            border-bottom: 1px solid rgba(151, 167, 191, 0.12);
            letter-spacing: -0.03em;
        }

        .chart-row { display: grid; grid-template-columns: 2fr 1fr; gap: 20px; }
        .chart-box {
            border-radius: 20px;
            padding: 22px;
            background: rgba(8, 16, 28, 0.4);
        }

        .chart-box h4 {
            color: #a8bdd6;
            font-size: 13px;
            font-weight: 700;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            margin-bottom: 16px;
        }

        .line-chart { height: 220px; position: relative; padding: 8px 0 34px 18px; }
        .line-chart svg { width: 100%; height: 100%; }
        .chart-line { fill: none; stroke: var(--brand); stroke-width: 3; stroke-linecap: round; }
        .chart-area { fill: url(#gradient); opacity: 0.34; }
        .chart-label { font-size: 11px; fill: #91a7c3; }

        .pie-chart { display: flex; align-items: center; justify-content: center; gap: 24px; min-height: 220px; }
        .pie-chart svg { width: 140px; height: 140px; }
        .pie-legend { font-size: 12px; color: var(--muted); }
        .pie-legend-item { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
        .pie-legend-color { width: 12px; height: 12px; border-radius: 999px; }
        .donut-center-label { fill: #8fa8c4; font-size: 6px; text-anchor: middle; }
        .donut-center-value { fill: var(--text); font-size: 9px; font-weight: 700; text-anchor: middle; }

        .analysis-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 16px; }
        .analysis-card {
            border-radius: 18px;
            padding: 18px;
            background: rgba(255, 255, 255, 0.03);
        }

        .analysis-card h4 {
            color: #a8bdd6;
            font-size: 12px;
            margin-bottom: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }

        .analysis-item {
            display: flex;
            justify-content: space-between;
            gap: 16px;
            padding: 10px 0;
            border-bottom: 1px solid rgba(151, 167, 191, 0.08);
        }

        .analysis-item:last-child { border-bottom: none; }
        .analysis-label { color: #a4bad5; }
        .analysis-value { color: var(--brand); font-weight: 700; text-align: right; }
        .analysis-value.is-good,
        .analysis-value.is-warn,
        .analysis-value.is-bad,
        .stat-card .value.is-good,
        .stat-card .value.is-warn,
        .stat-card .value.is-bad {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            min-width: 84px;
            padding: 6px 12px;
            border-radius: 999px;
            border: 1px solid transparent;
        }
        .analysis-value.is-good,
        .stat-card .value.is-good {
            color: #9ff2dc;
            background: rgba(98, 209, 178, 0.14);
            border-color: rgba(98, 209, 178, 0.24);
        }
        .analysis-value.is-warn,
        .stat-card .value.is-warn {
            color: #ffe2a6;
            background: rgba(242, 196, 109, 0.14);
            border-color: rgba(242, 196, 109, 0.24);
        }
        .analysis-value.is-bad,
        .stat-card .value.is-bad {
            color: #ffd2c8;
            background: rgba(255, 143, 120, 0.14);
            border-color: rgba(255, 143, 120, 0.24);
        }

        table { width: 100%; border-collapse: collapse; }
        th, td {
            padding: 13px 12px;
            text-align: left;
            border-bottom: 1px solid rgba(151, 167, 191, 0.08);
            vertical-align: top;
        }

        th {
            color: #9fb5d0;
            font-weight: 700;
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }

        tr:hover { background: rgba(98, 209, 178, 0.04); }

        .form-group { margin-bottom: 20px; }
        .form-group label {
            display: block;
            margin-bottom: 8px;
            color: #a8bdd6;
            font-size: 13px;
            font-weight: 600;
        }

        .form-group input, .form-group select {
            width: 100%;
            padding: 13px 15px;
            border: 1px solid rgba(151, 167, 191, 0.14);
            border-radius: 14px;
            background: rgba(8, 16, 28, 0.6);
            color: var(--text);
            font-size: 14px;
            outline: none;
        }

        .form-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; }

        .btn {
            margin-right: 10px;
            margin-bottom: 6px;
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--brand), var(--brand-strong));
            color: #071711;
            box-shadow: 0 16px 28px rgba(42, 165, 130, 0.2);
        }

        .btn-danger {
            background: linear-gradient(135deg, #ff9b85, #ff7b63);
            color: #2c0903;
            box-shadow: 0 16px 28px rgba(255, 123, 99, 0.16);
        }

        .btn-secondary {
            background: rgba(255, 255, 255, 0.05);
            border-color: rgba(151, 167, 191, 0.12);
            color: var(--text);
        }

        .status {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 6px 12px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 700;
            border: 1px solid transparent;
        }

        .status.online {
            background: rgba(98, 209, 178, 0.12);
            color: #9ff2dc;
            border-color: rgba(98, 209, 178, 0.2);
        }

        .status.offline {
            background: rgba(255, 143, 120, 0.12);
            color: #ffd6ce;
            border-color: rgba(255, 143, 120, 0.2);
        }

        .log-entry {
            padding: 16px 18px;
            border-left: 3px solid var(--danger);
            background: linear-gradient(180deg, rgba(255, 143, 120, 0.1), rgba(255, 143, 120, 0.04));
            margin-bottom: 12px;
            border-radius: 0 16px 16px 0;
        }

        .log-time { color: #a8bdd6; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
        .log-error { color: #ffdacf; margin-top: 8px; font-weight: 700; word-break: break-all; }

        .ip-list { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 15px; }
        .ip-item {
            background: rgba(255, 255, 255, 0.05);
            padding: 9px 14px;
            border-radius: 999px;
            display: flex;
            align-items: center;
            gap: 10px;
            border: 1px solid rgba(151, 167, 191, 0.12);
        }

        .ip-item button {
            width: 24px;
            height: 24px;
            border: none;
            border-radius: 999px;
            background: rgba(255, 143, 120, 0.18);
            color: #ffd6ce;
            cursor: pointer;
        }

        .alert {
            padding: 16px 18px;
            border-radius: 18px;
            margin-bottom: 20px;
        }

        .alert-warning {
            background: rgba(255, 143, 120, 0.12);
            border: 1px solid rgba(255, 143, 120, 0.24);
            color: #ffd5cb;
        }

        .alert-info {
            background: rgba(98, 209, 178, 0.1);
            border: 1px solid rgba(98, 209, 178, 0.2);
            color: #baf7e8;
        }

        .progress-bar {
            height: 8px;
            background: rgba(151, 167, 191, 0.12);
            border-radius: 999px;
            overflow: hidden;
            margin-top: 7px;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--brand), #3b82f6);
            border-radius: 999px;
            transition: width 0.3s;
        }

        .guide-section { margin-bottom: 24px; }
        .guide-section h4 {
            color: var(--text);
            margin-bottom: 12px;
            font-size: 18px;
            letter-spacing: -0.03em;
        }

        .guide-section p,
        .guide-section ul { color: var(--muted); line-height: 1.85; }
        .guide-section ul { margin-left: 20px; }
        .guide-section li { margin-bottom: 6px; }

        .guide-section code {
            background: rgba(255, 255, 255, 0.05);
            padding: 2px 8px;
            border-radius: 8px;
            color: #9df0db;
            font-family: Consolas, "SFMono-Regular", monospace;
        }

        .guide-section pre {
            background: rgba(8, 16, 28, 0.66);
            padding: 15px;
            border-radius: 14px;
            overflow-x: auto;
            margin: 10px 0;
            border: 1px solid rgba(151, 167, 191, 0.1);
        }

        .guide-section pre code { background: none; padding: 0; }

        .guide-tip,
        .guide-warning {
            padding: 14px 16px;
            margin: 15px 0;
            border-radius: 16px;
        }

        .guide-tip {
            background: rgba(98, 209, 178, 0.1);
            border: 1px solid rgba(98, 209, 178, 0.18);
            color: #baf7e8;
        }

        .guide-warning {
            background: rgba(255, 143, 120, 0.1);
            border: 1px solid rgba(255, 143, 120, 0.18);
            color: #ffd9cf;
        }

        .toast {
            position: fixed;
            right: 24px;
            bottom: 24px;
            z-index: 9999;
            padding: 13px 16px;
            border-radius: 14px;
            background: rgba(8, 16, 28, 0.94);
            color: var(--text);
            border: 1px solid rgba(98, 209, 178, 0.2);
            box-shadow: var(--shadow);
        }

        @media (max-width: 1100px) {
            .header { flex-direction: column; }
            .hero-card { grid-template-columns: 1fr; }
            .chart-row { grid-template-columns: 1fr; }
        }

        @media (max-width: 768px) {
            .container { padding-left: 14px; padding-right: 14px; }
            .login-box { padding: 34px 24px; }
            .stats-grid { grid-template-columns: repeat(2, 1fr); }
            .hero-metrics { grid-template-columns: 1fr; }
            .form-row { grid-template-columns: 1fr; }
            .header-actions { width: 100%; }
            .header-chip { flex: 1; }
            table { font-size: 14px; }
            th, td { padding: 10px; }
        }

        @media (max-width: 560px) {
            .stats-grid { grid-template-columns: 1fr; }
            .tabs { gap: 8px; }
            .tab { width: calc(50% - 4px); text-align: center; }
            .header-chip { width: 100%; }
        }
    </style>
</head>
<body>
    <div id="loginPage" class="login-container">
        <div class="login-box">
            <span class="eyebrow">运营监控中心</span>
            <h1>进入代理运营监控中心</h1>
            <p class="login-copy">集中查看线路运行状态、请求趋势、安全策略与异常日志，为日常运营监控和稳定性巡检提供统一视图。</p>
            <input type="password" id="password" placeholder="请输入管理员密码" onkeypress="if(event.key==='Enter')login()">
            <button onclick="login()">登录控制台</button>
            <p id="loginError" style="color: #e94560; text-align: center; margin-top: 15px;"></p>
        </div>
    </div>
    
    <div id="mainPage" class="container" style="display: none;">
        <div class="header">
            <div>
                <span class="eyebrow">运营监控中心</span>
                <h1>Emby 反代管理面板</h1>
                <p class="header-subtitle">面向日常运营监控场景，集中查看请求趋势、线路状态、安全策略与异常波动，提升监控判断与处置效率。</p>
            </div>
            <div class="header-actions">
                <div class="header-chip">
                    <span>当前入口</span>
                    <strong id="headerOrigin">-</strong>
                </div>
                <button onclick="logout()">退出登录</button>
            </div>
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
                <h3>峰值请求/分钟</h3>
                <div class="value" id="peakQps">-</div>
            </div>
        </div>

        <div class="hero-card">
            <div class="hero-copy">
                <span class="eyebrow">运营总览</span>
                <h2>集中掌握代理服务的核心运营态势。</h2>
                <p>在同一视图中快速研判请求规模、服务可用性、异常波动与流量分布，支撑日常监控、巡检与稳定性运营。</p>
            </div>
            <div class="hero-metrics">
                <div class="hero-metric"><span>今日请求</span><strong id="heroRequests">-</strong></div>
                <div class="hero-metric"><span>启用后端</span><strong id="heroBackends">-</strong></div>
                <div class="hero-metric"><span>成功率</span><strong id="heroSuccess">-</strong></div>
                <div class="hero-metric"><span>平均延迟</span><strong id="heroLatency">-</strong></div>
            </div>
        </div>
        
        <div class="tabs">
            <button class="tab active" onclick="showPanel('dashboard', this)">运营总览</button>
            <button class="tab" onclick="showPanel('backends', this)">后端管理</button>
            <button class="tab" onclick="showPanel('access', this)">访问控制</button>
            <button class="tab" onclick="showPanel('logs', this)">异常日志</button>
            <button class="tab" onclick="showPanel('guide', this)">部署说明</button>
        </div>
        
        <div id="dashboard" class="panel active">
            <div class="section">
                <h3 class="section-title">近 7 天请求趋势</h3>
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
                <h3 class="section-title">监控分析</h3>
                <div class="analysis-grid">
                    <div class="analysis-card">
                        <h4>请求监控</h4>
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
                        <h4>流量监控</h4>
                        <div class="analysis-item">
                            <span class="analysis-label">7天总流量</span>
                            <span class="analysis-value" id="weekBytes">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">日均流量</span>
                            <span class="analysis-value" id="dailyBytesAvg">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">平均请求大小</span>
                            <span class="analysis-value" id="avgRequestSize">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">峰值流量日</span>
                            <span class="analysis-value" id="peakDay">-</span>
                        </div>
                    </div>
                    <div class="analysis-card">
                        <h4>性能监控</h4>
                        <div class="analysis-item">
                            <span class="analysis-label">平均响应时间</span>
                            <span class="analysis-value" id="avgResponseTime">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">健康状态</span>
                            <span class="analysis-value" id="healthStatus">-</span>
                        </div>
                    </div>
                    <div class="analysis-card">
                        <h4>异常监控</h4>
                        <div class="analysis-item">
                            <span class="analysis-label">7天总错误</span>
                            <span class="analysis-value" id="weekErrors">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">错误率</span>
                            <span class="analysis-value" id="errorRate">-</span>
                        </div>
                        <div class="analysis-item">
                            <span class="analysis-label">错误趋势</span>
                            <span class="analysis-value" id="errorTrend">-</span>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="section">
                <h3 class="section-title">各端口统计</h3>
                <table>
                    <thead>
                        <tr>
                            <th>端口</th>
                            <th>名称</th>
                            <th>今日请求</th>
                            <th>成功率</th>
                            <th>今日流量</th>
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
                <h3>异常日志</h3>
                <div>
                    <button class="btn btn-secondary" onclick="refreshLogs()">刷新</button>
                    <button class="btn btn-danger" onclick="clearLogs()">清除全部</button>
                </div>
            </div>
            <div id="errorLogs"></div>
        </div>
        
        <div id="guide" class="panel">
            <h3 style="margin-bottom: 25px;">📖 部署说明</h3>
            
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
        
        function showPanel(name, trigger) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
            if (trigger) {
                trigger.classList.add('active');
            }
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
                const headerOrigin = document.getElementById('headerOrigin');
                if (headerOrigin) {
                    headerOrigin.textContent = window.location.host || window.location.origin;
                }
                
                if (data.kvWarning) {
                    kvAvailable = false;
                    document.getElementById('kvWarning').style.display = 'block';
                    document.getElementById('kvWarning').textContent = 'KV 未绑定，统计与管理功能会受到限制。请先创建 KV 命名空间并绑定到 Worker。';
                } else {
                    document.getElementById('kvWarning').style.display = 'none';
                }
                
                if (data.today) {
                    document.getElementById('todayTotal').textContent = data.today.total.toLocaleString();
                    const rateValue = data.today.total > 0 ? ((data.today.success / data.today.total) * 100) : 0;
                    document.getElementById('successRate').textContent = rateValue.toFixed(1) + '%';
                    setMetricState(document.getElementById('successRate'), getSuccessState(rateValue));
                    document.getElementById('todayBytes').textContent = formatBytes(data.today.bytes);
                    document.getElementById('todayErrors').textContent = data.today.error;
                    
                    const avgDuration = data.today.total > 0 ? (data.today.duration / data.today.total).toFixed(0) : 0;
                    document.getElementById('avgDuration').textContent = avgDuration + 'ms';

                    document.getElementById('peakQps').textContent = data.today.peakQps ? Math.round(data.today.peakQps).toLocaleString() + ' 次/分钟' : '-';
                    const activeBackends = Object.values(data.backends || {}).filter(item => item && item.enabled).length;
                    const heroRequests = document.getElementById('heroRequests');
                    const heroBackends = document.getElementById('heroBackends');
                    const heroSuccess = document.getElementById('heroSuccess');
                    const heroLatency = document.getElementById('heroLatency');
                    if (heroRequests) heroRequests.textContent = data.today.total.toLocaleString();
                    if (heroBackends) heroBackends.textContent = String(activeBackends);
                    if (heroSuccess) heroSuccess.textContent = rateValue.toFixed(1) + '%';
                    if (heroLatency) heroLatency.textContent = avgDuration + 'ms';
                } else {
                    document.getElementById('peakQps').textContent = '-';
                }
                
                renderLineChart(data.history || []);
                renderPieChart(data.today, data.backends);
                renderAnalysis(data.history || [], data.today);
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

        function setMetricState(element, state) {
            if (!element) return;
            element.classList.remove('is-good', 'is-warn', 'is-bad');
            if (state) element.classList.add(state);
        }

        function getSuccessState(rate) {
            if (rate >= 98) return 'is-good';
            if (rate >= 90) return 'is-warn';
            return 'is-bad';
        }

        function getErrorState(rate) {
            if (rate <= 2) return 'is-good';
            if (rate <= 10) return 'is-warn';
            return 'is-bad';
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
            
            const colors = ['#62d1b2', '#5b8cff', '#f2c46d', '#ff8f78', '#c084fc', '#34d399', '#f472b6', '#22c55e'];
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
                    const outerRadius = 40;
                    const innerRadius = 22;
                    const x1 = 50 + outerRadius * Math.sin(startAngle);
                    const y1 = 50 - outerRadius * Math.cos(startAngle);
                    const x2 = 50 + outerRadius * Math.sin(endAngle);
                    const y2 = 50 - outerRadius * Math.cos(endAngle);
                    const x3 = 50 + innerRadius * Math.sin(endAngle);
                    const y3 = 50 - innerRadius * Math.cos(endAngle);
                    const x4 = 50 + innerRadius * Math.sin(startAngle);
                    const y4 = 50 - innerRadius * Math.cos(startAngle);
                    const largeArc = percent > 0.5 ? 1 : 0;
                    
                    paths += '<path d="M' + x1 + ',' + y1 +
                        ' A' + outerRadius + ',' + outerRadius + ' 0 ' + largeArc + ',1 ' + x2 + ',' + y2 +
                        ' L' + x3 + ',' + y3 +
                        ' A' + innerRadius + ',' + innerRadius + ' 0 ' + largeArc + ',0 ' + x4 + ',' + y4 +
                        ' Z" fill="' + colors[i % colors.length] + '" stroke="rgba(8,18,31,0.72)" stroke-width="1.2"/>';
                }
                
                cumulativePercent += percent;
                
                const backend = backends[port] || {};
                legend += '<div class="pie-legend-item">' +
                    '<div class="pie-legend-color" style="background:' + colors[i % colors.length] + '"></div>' +
                    '<span>' + (backend.name || port) + ': ' + formatBytes(data.bytes) + '</span>' +
                '</div>';
            });
            
            container.innerHTML = '<svg viewBox="0 0 100 100">' +
                paths +
                '<text x="50" y="45" class="donut-center-label">总流量</text>' +
                '<text x="50" y="56" class="donut-center-value">' + formatBytes(total) + '</text>' +
                '</svg><div class="pie-legend">' + legend + '</div>';
        }
        
        function renderAnalysis(history, today) {
            if (!history.length) {
                document.getElementById('weekTotal').textContent = '-';
                document.getElementById('dailyAvg').textContent = '-';
                document.getElementById('weekSuccessRate').textContent = '-';
                document.getElementById('trend').textContent = '-';
                document.getElementById('weekBytes').textContent = '-';
                document.getElementById('dailyBytesAvg').textContent = '-';
                document.getElementById('avgRequestSize').textContent = '-';
                document.getElementById('peakDay').textContent = '-';
                return;
            }
            
            const weekTotal = history.reduce((sum, h) => sum + h.total, 0);
            const weekSuccess = history.reduce((sum, h) => sum + h.success, 0);
            const weekErrors = history.reduce((sum, h) => sum + h.error, 0);
            const weekBytes = history.reduce((sum, h) => sum + h.bytes, 0);
            const weekDuration = history.reduce((sum, h) => sum + (h.duration || 0), 0);
            
            document.getElementById('weekTotal').textContent = weekTotal.toLocaleString();
            document.getElementById('dailyAvg').textContent = Math.round(weekTotal / history.length).toLocaleString();
            const weekSuccessRateValue = weekTotal > 0 ? ((weekSuccess / weekTotal) * 100) : 0;
            document.getElementById('weekSuccessRate').textContent = weekTotal > 0 ? weekSuccessRateValue.toFixed(1) + '%' : '-';
            setMetricState(document.getElementById('weekSuccessRate'), weekTotal > 0 ? getSuccessState(weekSuccessRateValue) : '');
            
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
            document.getElementById('avgRequestSize').textContent = weekTotal > 0 ? formatBytes(weekBytes / weekTotal) : '-';
            
            const peakDay = history.reduce((max, h) => h.bytes > max.bytes ? h : max, history[0]);
            document.getElementById('peakDay').textContent = peakDay.date;
            
            document.getElementById('avgResponseTime').textContent = weekTotal > 0 ? (weekDuration / weekTotal).toFixed(0) + 'ms' : '-';
            
            const errorRate = weekTotal > 0 ? (weekErrors / weekTotal * 100) : 0;
            let health = '优秀', healthColor = '#4ecca3';
            if (errorRate > 10) { health = '警告'; healthColor = '#f0a500'; }
            if (errorRate > 30) { health = '异常'; healthColor = '#e94560'; }
            document.getElementById('healthStatus').textContent = health;
            document.getElementById('healthStatus').style.color = healthColor;
            setMetricState(document.getElementById('healthStatus'), getErrorState(errorRate));
            
            document.getElementById('weekErrors').textContent = weekErrors.toLocaleString();
            document.getElementById('errorRate').textContent = errorRate.toFixed(2) + '%';
            setMetricState(document.getElementById('errorRate'), getErrorState(errorRate));
            
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
                tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #888;">暂无数据</td></tr>';
                return;
            }
            tbody.innerHTML = ports.map(port => {
                const backend = backends[port];
                const stats = today.ports[port] || { total: 0, success: 0, error: 0, bytes: 0, duration: 0 };
                const rate = stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) : 0;
                const avgDuration = stats.total > 0 ? Math.round((stats.duration || 0) / stats.total) : 0;
                return '<tr>' +
                    '<td>' + port + '</td>' +
                    '<td>' + (backend.name || '-') + '</td>' +
                    '<td>' + stats.total.toLocaleString() + '</td>' +
                    '<td>' + rate + '%<div class="progress-bar"><div class="progress-fill" style="width:' + rate + '%"></div></div></td>' +
                    '<td>' + formatBytes(stats.bytes) + '</td>' +
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
                toast.className = 'toast';
                toast.textContent = '已复制入口地址';
                document.body.appendChild(toast);
                setTimeout(() => toast.remove(), 2200);
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
                    container.innerHTML = '<p style="color: #888; text-align: center;">暂无异常日志</p>';
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
            if (!confirm('确定要清除所有异常日志吗？')) return;
            try {
                const res = await fetch('/admin/api/logs/clear', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token }
                });
                const data = await res.json();
                if (data.success) {
                    document.getElementById('errorLogs').innerHTML = '<p style="color: #888; text-align: center;">暂无异常日志</p>';
                }
            } catch (e) {}
        }
        
        init();
    </script>
</body>
</html>`;
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

    const today = getStatsDateString();
    const history = hasKV ? await getStatsSummary(env, 7) : [];
    const todayEntry = history.find(item => item.date === today);
    const todayStats = todayEntry ? {
        total: todayEntry.total,
        success: todayEntry.success,
        error: todayEntry.error,
        bytes: todayEntry.bytes,
        duration: todayEntry.duration,
        ports: todayEntry.ports,
        peakQps: todayEntry.peakQps || 0
    } : createEmptyStats();
    const backends = await getBackendConfig(env);

    return new Response(JSON.stringify({
        today: todayStats,
        history: history,
        backends: backends,
        kvWarning: !hasKV
    }), { headers: { 'Content-Type': 'application/json' } });
}

async function handleBackendsAPI(request, env) {
    if (!await verifySession(request, env)) {
        return new Response(JSON.stringify({ error: '未授权' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const backends = await getBackendConfig(env);

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
    const backends = await getBackendConfig(env);

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
        const blacklist = await env.EMBY_KV.get('config:blacklist', { type: 'json' }) || [];
        const whitelist = await env.EMBY_KV.get('config:whitelist', { type: 'json' }) || [];
        return new Response(JSON.stringify({ blacklist, whitelist }), { headers: { 'Content-Type': 'application/json' } });
    }

    if (request.method === 'POST') {
        const body = await request.json();
        const key = body.type === 'blacklist' ? 'config:blacklist' : 'config:whitelist';
        let list = await env.EMBY_KV.get(key, { type: 'json' }) || [];

        if (body.action === 'add' && !list.includes(body.ip)) {
            list.push(body.ip);
        } else if (body.action === 'remove') {
            list = list.filter(ip => ip !== body.ip);
        }

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

    const list = await env.EMBY_KV.list({ prefix: 'logs:errors:' });
    for (const key of list.keys) {
        await env.EMBY_KV.delete(key.name);
    }

    errorLogCache = [];

    return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
}

// ==================== 代理处理函数 ====================

async function handleProxy(request, env) {
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
            body: (request.method !== 'GET' && request.method !== 'HEAD') ? await request.clone().arrayBuffer() : null,
            redirect: 'manual'
        });

        const response = await fetch(modifiedRequest);
        const responseHeaders = new Headers(response.headers);

        // 移除重定向处理，避免错误的重定向URL编码
        // 如果后端返回绝对URL重定向，保持不变让浏览器直接访问

        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Cache-Control', 'no-store');

        const contentLength = parseInt(responseHeaders.get('Content-Length') || '0');
        const duration = Date.now() - startTime;
        await recordStats(env, portKey, true, contentLength, duration);

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
        });

    } catch (err) {
        const duration = Date.now() - startTime;
        await recordStats(env, portKey, false, 0, duration);
        await logError(env, portKey, err.message, url.pathname + url.search, clientIP);

        return new Response("Worker Proxy Error: " + err.message, { status: 502 });
    }
}

// ==================== 主入口 ====================

async function handleRequest(request, env) {
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

    return handleProxy(request, env);
}

// 事件监听器 - ES Modules 格式
export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env);
    }
};
