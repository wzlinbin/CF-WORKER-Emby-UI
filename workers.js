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
        url: "https://XXX.YYY.ZZZ:8443",
        enabled: true
    },
    "2053": {
        name: "Emby 3",
        url: "https://XXX.YYY.ZZZ",
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
        :root{--bg-primary:#0a0e1a;--bg-secondary:#111827;--bg-card:rgba(17,24,39,0.8);--border-color:rgba(59,130,246,0.1);--text-primary:#f8fafc;--text-secondary:#94a3b8;--accent-primary:#3b82f6;--success:#10b981;--danger:#ef4444}
        *{margin:0;padding:0;box-sizing:border-box}
        body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif;background:var(--bg-primary);color:var(--text-primary);min-height:100vh}
        .container{position:relative;z-index:1;max-width:1400px;margin:0 auto;padding:20px}
        .login-wrapper{display:flex;justify-content:center;align-items:center;min-height:100vh}
        .login-card{width:100%;max-width:420px;padding:40px;background:var(--bg-card);backdrop-filter:blur(20px);border:1px solid var(--border-color);border-radius:24px;box-shadow:0 10px 40px rgba(0,0,0,0.5)}
        .login-logo{width:64px;height:64px;margin:0 auto 20px;background:linear-gradient(135deg,var(--accent-primary),#8b5cf6);border-radius:16px;display:flex;align-items:center;justify-content:center;font-size:28px;box-shadow:0 8px 32px rgba(59,130,246,0.3)}
        .login-title{text-align:center;font-size:24px;font-weight:600;margin-bottom:8px;background:linear-gradient(135deg,var(--text-primary),var(--accent-primary));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
        .login-subtitle{text-align:center;color:var(--text-secondary);font-size:14px;margin-bottom:32px}
        .form-input{width:100%;padding:14px 18px;margin-bottom:16px;background:rgba(0,0,0,0.3);border:1px solid var(--border-color);border-radius:12px;color:var(--text-primary);font-size:15px;transition:all 0.3s}
        .form-input:focus{outline:none;border-color:var(--accent-primary);box-shadow:0 0 0 4px rgba(59,130,246,0.1)}
        .btn-primary{width:100%;padding:14px;background:linear-gradient(135deg,var(--accent-primary),#8b5cf6);border:none;border-radius:12px;color:white;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 4px 20px rgba(59,130,246,0.3);transition:all 0.3s}
        .btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 30px rgba(59,130,246,0.4)}
        .dashboard-header{display:flex;justify-content:space-between;align-items:center;padding:24px 28px;background:var(--bg-card);backdrop-filter:blur(20px);border:1px solid var(--border-color);border-radius:20px;margin-bottom:24px}
        .header-left h1{font-size:28px;font-weight:700;margin-bottom:4px}
        .header-left p{color:var(--text-secondary);font-size:14px}
        .header-right{display:flex;gap:16px;align-items:center}
        .server-status{display:flex;align-items:center;gap:8px;padding:10px 16px;background:rgba(16,185,129,0.1);border:1px solid rgba(16,185,129,0.2);border-radius:12px;color:var(--success);font-size:13px;font-weight:500}
        .status-dot{width:8px;height:8px;background:var(--success);border-radius:50%;animation:pulse 2s ease-in-out infinite}
        @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(1.2)}}
        .btn-logout{padding:10px 20px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:12px;color:var(--danger);font-size:14px;font-weight:500;cursor:pointer;transition:all 0.3s}
        .btn-logout:hover{background:rgba(239,68,68,0.2);transform:translateY(-1px)}
        .stats-overview{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-bottom:24px}
        .stat-card{position:relative;padding:24px;background:var(--bg-card);backdrop-filter:blur(20px);border:1px solid var(--border-color);border-radius:20px;overflow:hidden;transition:all 0.3s}
        .stat-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px}
        .stat-card.stat-total::before{background:linear-gradient(90deg,#4facfe,#00f2fe)}
        .stat-card.stat-success::before{background:linear-gradient(90deg,#43e97b,#38f9d7)}
        .stat-card.stat-error::before{background:linear-gradient(90deg,#f093fb,#f5576c)}
        .stat-card.stat-bandwidth::before{background:linear-gradient(90deg,#667eea,#764ba2)}
        .stat-card:hover{transform:translateY(-4px);box-shadow:0 10px 40px rgba(0,0,0,0.5)}
        .stat-icon{width:48px;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:16px}
        .stat-card.stat-total .stat-icon{background:rgba(79,172,254,0.15)}
        .stat-card.stat-success .stat-icon{background:rgba(67,233,123,0.15)}
        .stat-card.stat-error .stat-icon{background:rgba(245,147,108,0.15)}
        .stat-card.stat-bandwidth .stat-icon{background:rgba(102,126,234,0.15)}
        .stat-label{color:var(--text-secondary);font-size:13px;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px}
        .stat-value{font-size:32px;font-weight:700;line-height:1.2}
        .stat-card.stat-total .stat-value{color:#4facfe}
        .stat-card.stat-success .stat-value{color:#43e97b}
        .stat-card.stat-error .stat-value{color:#f593fc}
        .stat-card.stat-bandwidth .stat-value{color:#667eea}
        .stat-trend{margin-top:12px;font-size:12px;color:var(--text-secondary)}
        .tabs-nav{display:flex;gap:8px;padding:6px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:16px;margin-bottom:24px}
        .tab-btn{flex:0 0 auto;padding:12px 24px;background:transparent;border:none;border-radius:12px;color:var(--text-secondary);font-size:14px;font-weight:500;cursor:pointer;transition:all 0.3s}
        .tab-btn:hover{color:var(--text-primary);background:rgba(31,41,55,0.6)}
        .tab-btn.active{background:var(--accent-primary);color:white;box-shadow:0 4px 15px rgba(59,130,246,0.3)}
        .panel-content{display:none}
        .panel-content.active{display:block}
        .card{background:var(--bg-card);backdrop-filter:blur(20px);border:1px solid var(--border-color);border-radius:20px;padding:24px;margin-bottom:20px}
        .card-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid var(--border-color)}
        .card-title{font-size:18px;font-weight:600}
        .backend-list{display:flex;flex-direction:column;gap:12px}
        .backend-item{display:flex;align-items:center;gap:16px;padding:20px;background:rgba(0,0,0,0.2);border:1px solid var(--border-color);border-radius:16px;transition:all 0.3s}
        .backend-item:hover{border-color:var(--accent-primary);background:rgba(31,41,55,0.6)}
        .backend-status{width:12px;height:12px;border-radius:50%;flex-shrink:0}
        .backend-status.active{background:var(--success);box-shadow:0 0 20px rgba(16,185,129,0.4)}
        .backend-status.inactive{background:var(--text-secondary)}
        .backend-info{flex:1;min-width:0}
        .backend-name{font-size:16px;font-weight:600;margin-bottom:4px}
        .backend-url{font-size:13px;color:var(--text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .backend-port{padding:6px 12px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2);border-radius:8px;color:var(--accent-primary);font-size:13px;font-weight:600}
        .btn-toggle{padding:8px 16px;background:transparent;border:1px solid var(--border-color);border-radius:10px;color:var(--text-secondary);font-size:13px;cursor:pointer;transition:all 0.3s}
        .btn-toggle:hover{border-color:var(--accent-primary);color:var(--accent-primary)}
        .btn-toggle.active{background:rgba(16,185,129,0.1);border-color:var(--success);color:var(--success)}
        .btn-add{padding:12px 24px;background:linear-gradient(135deg,var(--success),#059669);border:none;border-radius:12px;color:white;font-size:14px;font-weight:600;cursor:pointer;transition:all 0.3s}
        .btn-add:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(16,185,129,0.3)}
        .btn-delete{padding:8px 16px;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.2);border-radius:10px;color:var(--danger);font-size:13px;cursor:pointer;transition:all 0.3s}
        .btn-delete:hover{background:rgba(239,68,68,0.2)}
        .form-group{margin-bottom:20px}
        .form-label{display:block;margin-bottom:8px;font-size:14px;font-weight:500;color:var(--text-secondary)}
        .form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
        .ip-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
        .ip-tag{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;background:rgba(59,130,246,0.1);border:1px solid rgba(59,130,246,0.2);border-radius:10px;font-size:13px;color:var(--text-primary)}
        .ip-tag .remove-ip{cursor:pointer;color:var(--text-secondary);transition:color 0.2s}
        .ip-tag .remove-ip:hover{color:var(--danger)}
        .ip-input-group{display:flex;gap:10px;margin-top:16px}
        .ip-input-group input{flex:1;padding:12px 16px;background:rgba(0,0,0,0.3);border:1px solid var(--border-color);border-radius:12px;color:var(--text-primary);font-size:14px}
        .ip-input-group input:focus{outline:none;border-color:var(--accent-primary)}
        .log-list{display:flex;flex-direction:column;gap:10px;max-height:500px;overflow-y:auto}
        .log-item{padding:16px;background:rgba(0,0,0,0.2);border-left:3px solid var(--danger);border-radius:12px;font-family:monospace;font-size:13px}
        .log-time{color:var(--text-secondary);font-size:12px;margin-bottom:8px}
        .log-error{color:var(--danger);margin-bottom:8px;word-break:break-all}
        .log-details{color:var(--text-secondary);font-size:12px}
        .empty-state{text-align:center;padding:60px 20px;color:var(--text-secondary)}
        .empty-icon{font-size:48px;margin-bottom:16px;opacity:0.5}
        .toast{position:fixed;bottom:24px;right:24px;padding:16px 24px;background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:14px;box-shadow:0 10px 40px rgba(0,0,0,0.5);display:none;z-index:1000}
        .toast.show{display:block}.toast.success{border-color:var(--success)}.toast.error{border-color:var(--danger)}
        @media(max-width:768px){.dashboard-header{flex-direction:column;gap:16px;text-align:center}.header-right{flex-wrap:wrap;justify-content:center}.stats-overview{grid-template-columns:1fr}.form-row{grid-template-columns:1fr}}
    </style>
</head>
<body>
<div class="container">
<div id="loginPage" class="login-wrapper"><div class="login-card"><div class="login-logo">🎬</div><h1 class="login-title">Emby 反代管理</h1><p class="login-subtitle">请输入管理员密码进行登录</p><form id="loginForm"><input type="password" id="passwordInput" class="form-input" placeholder="管理员密码" required><button type="submit" class="btn-primary">登 录</button></form></div></div>
<div id="dashboardPage" style="display:none"><div class="dashboard-header"><div class="header-left"><h1>🎬 Emby 反代管理面板</h1><p>实时监控 · 智能调度 · 高效稳定</p></div><div class="header-right"><div class="server-status"><span class="status-dot"></span><span>服务运行正常</span></div><button class="btn-logout" onclick="logout()">退出登录</button></div></div>
<div class="stats-overview"><div class="stat-card stat-total"><div class="stat-icon">📊</div><div class="stat-label">总请求数</div><div class="stat-value" id="statTotal">0</div><div class="stat-trend">今日实时数据</div></div><div class="stat-card stat-success"><div class="stat-icon">✅</div><div class="stat-label">成功请求</div><div class="stat-value" id="statSuccess">0</div><div class="stat-trend">成功率：<strong id="statRate">0%</strong></div></div><div class="stat-card stat-error"><div class="stat-icon">⚠️</div><div class="stat-label">错误次数</div><div class="stat-value" id="statError">0</div><div class="stat-trend">错误率：<strong id="statErrorRate">0%</strong></div></div><div class="stat-card stat-bandwidth"><div class="stat-icon">💾</div><div class="stat-label">流量统计</div><div class="stat-value" id="statBandwidth">0 GB</div><div class="stat-trend">今日累计</div></div></div>
<div class="tabs-nav"><button class="tab-btn active" data-tab="backends">🖥️ 后端配置</button><button class="tab-btn" data-tab="access">🔒 访问控制</button><button class="tab-btn" data-tab="logs">📋 错误日志</button></div>
<div id="panel-backends" class="panel-content active"><div class="card"><div class="card-header"><h2 class="card-title">🖥️ 后端服务器列表</h2><button class="btn-add" onclick="showAddBackend()">+ 添加后端</button></div><div id="backendList" class="backend-list"></div></div><div id="backendFormCard" class="card" style="display:none"><div class="card-header"><h2 class="card-title">➕ 添加后端服务器</h2></div><form id="backendForm"><input type="hidden" id="editPort"><div class="form-row"><div class="form-group"><label class="form-label">端口</label><input type="text" id="formPort" class="form-input" required></div><div class="form-group"><label class="form-label">名称</label><input type="text" id="formName" class="form-input" required></div></div><div class="form-group"><label class="form-label">后端地址</label><input type="url" id="formUrl" class="form-input" required></div><div style="display:flex;gap:12px"><button type="submit" class="btn-add">保存</button><button type="button" class="btn-toggle" onclick="hideBackendForm()">取消</button></div></form></div></div>
<div id="panel-access" class="panel-content"><div class="card"><div class="card-header"><h2 class="card-title">🔒 IP 访问控制</h2></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:24px"><div><h3 style="margin-bottom:12px;font-size:15px;color:var(--text-secondary)">白名单 IP</h3><div id="whitelistDisplay" class="ip-list"></div><div class="ip-input-group"><input type="text" id="whitelistInput" placeholder="输入 IP"><button class="btn-add" onclick="addIP('whitelist')">添加</button></div></div><div><h3 style="margin-bottom:12px;font-size:15px;color:var(--text-secondary)">黑名单 IP</h3><div id="blacklistDisplay" class="ip-list"></div><div class="ip-input-group"><input type="text" id="blacklistInput" placeholder="输入 IP"><button class="btn-add" style="background:linear-gradient(135deg,var(--danger),#dc2626)" onclick="addIP('blacklist')">添加</button></div></div></div></div></div>
<div id="panel-logs" class="panel-content"><div class="card"><div class="card-header"><h2 class="card-title">📋 错误日志</h2><button class="btn-delete" onclick="clearLogs()">清空</button></div><div id="logList" class="log-list"></div></div></div>
</div></div>
<div id="toast" class="toast"></div>
<script>
let token=localStorage.getItem('admin_token'),backends={},whitelist=[],blacklist=[];
function showToast(m,t='success'){const e=document.getElementById('toast');e.textContent=m;e.className='toast show '+t;setTimeout(()=>e.className='toast',3000)}
function formatBytes(b){if(!b||b===0)return'0 B';const k=1024,s=['B','KB','MB','GB','TB'],i=Math.floor(Math.log(b)/Math.log(k));return(b/Math.pow(k,i)).toFixed(2)+' '+s[i]}
document.querySelectorAll('.tab-btn').forEach(b=>{b.addEventListener('click',()=>{document.querySelectorAll('.tab-btn').forEach(x=>x.classList.remove('active'));document.querySelectorAll('.panel-content').forEach(x=>x.classList.remove('active'));b.classList.add('active');document.getElementById('panel-'+b.dataset.tab).classList.add('active')})});
document.getElementById('loginForm').addEventListener('submit',async e=>{e.preventDefault();const p=document.getElementById('passwordInput').value;try{const r=await fetch('/admin/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p})});const d=await r.json();if(d.success){token=d.token;localStorage.setItem('admin_token',token);showDashboard()}else showToast(d.error||'密码错误','error')}catch(err){showToast('登录失败:'+err.message,'error')}});
function logout(){localStorage.removeItem('admin_token');token=null;document.getElementById('loginPage').style.display='flex';document.getElementById('dashboardPage').style.display='none'}
async function showDashboard(){document.getElementById('loginPage').style.display='none';document.getElementById('dashboardPage').style.display='block';await loadStats();await loadBackends();await loadAccessConfig();await loadLogs()}
async function loadStats(){try{const r=await fetch('/admin/api/stats',{headers:{'Authorization':'Bearer '+token}});const d=await r.json();if(d.today){document.getElementById('statTotal').textContent=d.today.total.toLocaleString();document.getElementById('statSuccess').textContent=d.today.success.toLocaleString();document.getElementById('statError').textContent=d.today.error.toLocaleString();document.getElementById('statBandwidth').textContent=formatBytes(d.today.bytes);const rt=d.today.total>0?((d.today.success/d.today.total)*100).toFixed(1):0;const er=d.today.total>0?((d.today.error/d.today.total)*100).toFixed(1):0;document.getElementById('statRate').textContent=rt+'%';document.getElementById('statErrorRate').textContent=er+'%'}}catch(e){console.error(e)}}
async function loadBackends(){try{const r=await fetch('/admin/api/backends',{headers:{'Authorization':'Bearer '+token}});backends=await r.json();renderBackends()}catch(e){showToast('加载失败','error')}}
function renderBackends(){const c=document.getElementById('backendList'),p=Object.keys(backends);if(p.length===0){c.innerHTML='<div class="empty-state"><div class="empty-icon">📭</div><p>暂无配置</p></div>';return}c.innerHTML=p.map(port=>{const b=backends[port];return'<div class="backend-item"><div class="backend-status '+(b.enabled?'active':'inactive')+'"></div><div class="backend-info"><div class="backend-name">'+(b.name||'未命名')+'</div><div class="backend-url">'+b.url+'</div></div><span class="backend-port">'+port+'</span><button class="btn-toggle '+(b.enabled?'active':'')+'" onclick="toggleBackend(\''+port+'\')">'+(b.enabled?'已启用':'已禁用')+'</button><button class="btn-delete" onclick="deleteBackend(\''+port+'\')">删除</button></div>'}).join('')}
function showAddBackend(){document.getElementById('backendFormCard').style.display='block';document.getElementById('backendForm').reset();document.getElementById('editPort').value=''}
function hideBackendForm(){document.getElementById('backendFormCard').style.display='none'}
document.getElementById('backendForm').addEventListener('submit',async e=>{e.preventDefault();const port=document.getElementById('formPort').value.trim(),name=document.getElementById('formName').value.trim(),url=document.getElementById('formUrl').value.trim(),editPort=document.getElementById('editPort').value;try{if(editPort&&editPort!==port)await fetch('/admin/api/backends',{method:'DELETE',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({port:editPort})});const res=await fetch('/admin/api/backends',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({port,name,url,enabled:true})});if(res.ok){showToast('保存成功');hideBackendForm();loadBackends()}else showToast('失败','error')}catch(err){showToast('错误:'+err.message,'error')}}
async function toggleBackend(port){try{const res=await fetch('/admin/api/backends/toggle',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({port})});if(res.ok){showToast('已更新');loadBackends()}}catch(err){showToast('失败','error')}}
async function deleteBackend(port){if(!confirm('确定删除？'))return;try{const res=await fetch('/admin/api/backends',{method:'DELETE',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({port})});if(res.ok){showToast('已删除');loadBackends()}}catch(err){showToast('失败','error')}}
async function loadAccessConfig(){try{const res=await fetch('/admin/api/access',{headers:{'Authorization':'Bearer '+token}});const d=await res.json();whitelist=d.whitelist||[];blacklist=d.blacklist||[];renderAccessConfig()}catch(e){console.error(e)}}
function renderAccessConfig(){document.getElementById('whitelistDisplay').innerHTML=whitelist.map(ip=>'<span class="ip-tag">'+ip+' <span class="remove-ip" onclick="removeIP(\'whitelist\',\''+ip+'\')">x</span></span>').join('')||'<span style="color:var(--text-secondary);font-size:13px">暂无</span>';document.getElementById('blacklistDisplay').innerHTML=blacklist.map(ip=>'<span class="ip-tag" style="background:rgba(239,68,68,0.1);border-color:rgba(239,68,68,0.2)">'+ip+' <span class="remove-ip" onclick="removeIP(\'blacklist\',\''+ip+'\')">x</span></span>').join('')||'<span style="color:var(--text-secondary);font-size:13px">暂无</span>'}
async function addIP(type){const input=document.getElementById(type+'Input'),ip=input.value.trim();if(!ip){showToast('请输入 IP','error');return}try{const res=await fetch('/admin/api/access',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({type,action:'add',ip})});if(res.ok){showToast('添加成功');input.value='';loadAccessConfig()}}catch(err){showToast('失败','error')}}
async function removeIP(type,ip){try{const res=await fetch('/admin/api/access',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({type,action:'remove',ip})});if(res.ok){showToast('已移除');loadAccessConfig()}}catch(err){showToast('失败','error')}}
async function loadLogs(){try{const res=await fetch('/admin/api/logs',{headers:{'Authorization':'Bearer '+token}});const logs=await res.json();renderLogs(logs)}catch(e){console.error(e)}}
function renderLogs(logs){const c=document.getElementById('logList');if(!logs||logs.length===0){c.innerHTML='<div class="empty-state"><div class="empty-icon">📭</div><p>暂无日志</p></div>';return}c.innerHTML=logs.map(log=>'<div class="log-item"><div class="log-time">'+new Date(log.time).toLocaleString('zh-CN')+'</div><div class="log-error">'+(log.error||'Error')+'</div><div class="log-details">端口:'+(log.port||'N/A')+' | URL:'+(log.url||'N/A')+'</div></div>').join('')}
async function clearLogs(){if(!confirm('确定清空？'))return;try{const res=await fetch('/admin/api/logs/clear',{method:'POST',headers:{'Authorization':'Bearer '+token}});if(res.ok){showToast('已清空');loadLogs()}}catch(err){showToast('失败','error')}}
if(token)showDashboard();
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