// ============================================
// Emby 反向代理 + 管理后台
// Cloudflare Worker 版本
// ============================================

// ==================== 配置区 ====================
// 管理员密码（建议通过环境变量设置：wrangler.toml 或 Cloudflare Dashboard）
const ADMIN_PASSWORD = "admin123"; // 请修改为强密码！

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
    },
    "default": {
        name: "Emby 1 (默认)",
        url: "http://wf.vban.com:8880",
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
let statsCache = {
    date: '',
    data: { total: 0, success: 0, error: 0, bytes: 0, duration: 0, ports: {} },
    lastSave: 0
};

// 统计写入间隔（毫秒）- 每30秒写入一次KV
const STATS_SAVE_INTERVAL = 30000;

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
    
    const today = new Date().toISOString().split('T')[0];
    const now = Date.now();
    
    // 如果是新的一天，重置缓存
    if (statsCache.date !== today) {
        statsCache.date = today;
        statsCache.data = { total: 0, success: 0, error: 0, bytes: 0, duration: 0, ports: {} };
        statsCache.lastSave = 0;
    }
    
    // 更新内存中的统计数据
    statsCache.data.total++;
    if (success) statsCache.data.success++;
    else statsCache.data.error++;
    statsCache.data.bytes += bytes;
    statsCache.data.duration += duration;
    
    if (!statsCache.data.ports[port]) {
        statsCache.data.ports[port] = { total: 0, success: 0, error: 0, bytes: 0 };
    }
    statsCache.data.ports[port].total++;
    if (success) statsCache.data.ports[port].success++;
    else statsCache.data.ports[port].error++;
    statsCache.data.ports[port].bytes += bytes;
    
    // 每30秒写入一次KV，或者首次请求时写入
    if (now - statsCache.lastSave >= STATS_SAVE_INTERVAL || statsCache.lastSave === 0) {
        statsCache.lastSave = now;
        try {
            const key = `stats:${today}`;
            await env.EMBY_KV.put(key, JSON.stringify(statsCache.data), { expirationTtl: 86400 * 90 });
        } catch (e) {
            // KV写入失败时忽略，不影响代理功能
            console.error('KV write error:', e.message);
        }
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
async function getStatsSummary(env, days = 7) {
    if (!env || !env.EMBY_KV) return [];
    const stats = [];
    const today = new Date();
    
    for (let i = 0; i < days; i++) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const dateStr = date.toISOString().split('T')[0];
        const dayStats = await env.EMBY_KV.get(`stats:${dateStr}`, { type: 'json' });
        if (dayStats) {
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
        
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin-bottom: 30px; }
        .stat-card { background: #16213e; padding: 25px; border-radius: 10px; text-align: center; }
        .stat-card h3 { color: #888; font-size: 14px; margin-bottom: 10px; }
        .stat-card .value { font-size: 32px; font-weight: bold; color: #4ecca3; }
        .stat-card.error .value { color: #e94560; }
        
        .tabs { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
        .tab { padding: 12px 24px; background: #16213e; border: none; border-radius: 5px; color: #888; cursor: pointer; font-size: 14px; }
        .tab.active { background: #4ecca3; color: #1a1a2e; font-weight: bold; }
        .tab:hover:not(.active) { background: #1f3460; }
        
        .panel { display: none; background: #16213e; border-radius: 10px; padding: 25px; }
        .panel.active { display: block; }
        
        table { width: 100%; border-collapse: collapse; }
        th, td { padding: 15px; text-align: left; border-bottom: 1px solid #333; }
        th { color: #4ecca3; font-weight: 600; }
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
        
        .chart-container { height: 300px; position: relative; margin-top: 20px; }
        .bar-chart { display: flex; align-items: flex-end; height: 250px; gap: 5px; padding: 10px 0; overflow-x: auto; }
        .bar { min-width: 40px; flex: 1; background: linear-gradient(to top, #4ecca3, #3db892); border-radius: 3px 3px 0 0; min-height: 5px; position: relative; }
        .bar:hover { opacity: 0.8; }
        .bar-label { position: absolute; bottom: -25px; left: 50%; transform: translateX(-50%); font-size: 11px; color: #888; white-space: nowrap; }
        .bar-value { position: absolute; top: -20px; left: 50%; transform: translateX(-50%); font-size: 11px; color: #4ecca3; }
        
        .log-entry { padding: 12px; border-left: 3px solid #e94560; background: rgba(233, 69, 96, 0.1); margin-bottom: 10px; border-radius: 0 5px 5px 0; }
        .log-time { color: #888; font-size: 12px; }
        .log-error { color: #e94560; margin-top: 5px; word-break: break-all; }
        
        .ip-list { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 15px; }
        .ip-item { background: #1a1a2e; padding: 8px 15px; border-radius: 20px; display: flex; align-items: center; gap: 10px; }
        .ip-item button { background: none; border: none; color: #e94560; cursor: pointer; font-size: 18px; }
        
        .alert { padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .alert-warning { background: rgba(233, 69, 96, 0.2); border: 1px solid #e94560; color: #e94560; }
        
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
        </div>
        
        <div class="tabs">
            <button class="tab active" onclick="showPanel('dashboard')">📊 仪表盘</button>
            <button class="tab" onclick="showPanel('backends')">🖥️ 后端管理</button>
            <button class="tab" onclick="showPanel('access')">🛡️ 访问控制</button>
            <button class="tab" onclick="showPanel('logs')">📋 错误日志</button>
        </div>
        
        <div id="dashboard" class="panel active">
            <h3 style="margin-bottom: 20px;">近7天请求统计</h3>
            <div class="chart-container">
                <div class="bar-chart" id="chart"></div>
            </div>
            
            <h3 style="margin: 30px 0 20px;">各端口统计</h3>
            <table>
                <thead>
                    <tr>
                        <th>端口</th>
                        <th>名称</th>
                        <th>今日请求</th>
                        <th>成功率</th>
                        <th>今日流量</th>
                        <th>状态</th>
                    </tr>
                </thead>
                <tbody id="portStats"></tbody>
            </table>
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
                <h3>最近错误日志</h3>
                <button class="btn btn-secondary" onclick="refreshLogs()">刷新</button>
            </div>
            <div id="errorLogs"></div>
        </div>
    </div>

    <script>
        let token = localStorage.getItem('admin_token') || '';
        let kvAvailable = true;
        
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
                }
                
                renderChart(data.history || []);
                renderPortStats(data.today, data.backends);
                renderBackendList(data.backends);
            } catch (e) {
                console.error('加载仪表盘失败', e);
            }
        }
        
        function formatBytes(bytes) {
            if (bytes === 0) return '0 B';
            const k = 1024;
            const sizes = ['B', 'KB', 'MB', 'GB'];
            const i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        }
        
        function renderChart(history) {
            const chart = document.getElementById('chart');
            if (!history.length) {
                chart.innerHTML = '<p style="color: #888; text-align: center; width: 100%;">暂无数据</p>';
                return;
            }
            const max = Math.max(...history.map(h => h.total));
            chart.innerHTML = history.reverse().map(h => {
                const height = max > 0 ? (h.total / max * 200) : 0;
                return '<div class="bar" style="height: ' + height + 'px" title="' + h.total + ' 请求">' +
                    '<span class="bar-value">' + h.total + '</span>' +
                    '<span class="bar-label">' + h.date.slice(5) + '</span></div>';
            }).join('');
        }
        
        function renderPortStats(today, backends) {
            const tbody = document.getElementById('portStats');
            const ports = Object.keys(backends || {});
            if (!today || !today.ports) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #888;">暂无数据</td></tr>';
                return;
            }
            tbody.innerHTML = ports.map(port => {
                const backend = backends[port];
                const stats = today.ports[port] || { total: 0, success: 0, bytes: 0 };
                const rate = stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(1) : 0;
                return '<tr>' +
                    '<td>' + port + '</td>' +
                    '<td>' + (backend.name || '-') + '</td>' +
                    '<td>' + stats.total.toLocaleString() + '</td>' +
                    '<td>' + rate + '%</td>' +
                    '<td>' + formatBytes(stats.bytes) + '</td>' +
                    '<td><span class="status ' + (backend.enabled ? 'online' : 'offline') + '">' + (backend.enabled ? '启用' : '禁用') + '</span></td>' +
                    '</tr>';
            }).join('');
        }
        
        function renderBackendList(backends) {
            const tbody = document.getElementById('backendList');
            tbody.innerHTML = Object.entries(backends || {}).map(([port, config]) => {
                // 生成反代地址
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
                // 显示复制成功提示
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
            // 没有KV时，存储到内存
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
    
    const today = new Date().toISOString().split('T')[0];
    const todayStats = hasKV ? (await env.EMBY_KV.get(`stats:${today}`, { type: 'json' }) || { total: 0, success: 0, error: 0, bytes: 0, ports: {} }) : { total: 0, success: 0, error: 0, bytes: 0, ports: {} };
    const history = hasKV ? await getStatsSummary(env, 7) : [];
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

// ==================== 代理处理函数 ====================

async function handleProxy(request, env) {
    const url = new URL(request.url);
    const clientIP = getClientIP(request);
    
    // 检查IP访问权限
    if (!await checkIPAccess(clientIP, env)) {
        return new Response('Access Denied', { status: 403 });
    }
    
    // 获取后端配置
    const backends = await getBackendConfig(env);
    
    // 根据端口选择后端
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
    
    // 处理 OPTIONS 预检请求
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
    
    // 确定目标 URL
    let targetUrlStr;
    const decodedPath = decodeURIComponent(url.pathname);
    
    if (decodedPath.startsWith('/http://') || decodedPath.startsWith('/https://')) {
        targetUrlStr = decodedPath.substring(1) + url.search;
    } else {
        targetUrlStr = FRONTEND_URL + url.pathname + url.search;
    }
    
    // 构造新请求
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
        
        // 拦截重定向
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = responseHeaders.get('Location');
            if (location && (location.startsWith('http://') || location.startsWith('https://'))) {
                responseHeaders.set('Location', `/${encodeURIComponent(location)}`);
            }
        }
        
        responseHeaders.set('Access-Control-Allow-Origin', '*');
        responseHeaders.set('Cache-Control', 'no-store');
        
        // 记录统计
        const contentLength = parseInt(responseHeaders.get('Content-Length') || '0');
        const duration = Date.now() - startTime;
        await recordStats(env, portKey, true, contentLength, duration);
        
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
        });
        
    } catch (err) {
        // 记录错误
        const duration = Date.now() - startTime;
        await recordStats(env, portKey, false, 0, duration);
        await logError(env, portKey, err.message, url.pathname + url.search, clientIP);
        
        return new Response("Worker Proxy Error: " + err.message, { status: 502 });
    }
}

// ==================== 主入口 ====================

async function handleRequest(request, env) {
    const url = new URL(request.url);
    
    // 管理面板路由（优先处理，不受 KV 影响）
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
        return new Response(getAdminHTML(), {
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
    }
    
    // API 路由
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
            default:
                return new Response(JSON.stringify({ error: 'API not found' }), { 
                    status: 404, 
                    headers: { 'Content-Type': 'application/json' } 
                });
        }
    }
    
    // 代理请求
    return handleProxy(request, env);
}

// 事件监听器 - ES Modules 格式
export default {
    async fetch(request, env, ctx) {
        return handleRequest(request, env);
    }
};