// Cloudflare 支持的 HTTPS 端口: 443(默认), 2053, 2083, 2087, 2096, 8443
// 自行替换为你真实的Emby地址和端口（包含协议http/https，末尾不要斜杠）

// 请求处理函数
async function handleRequest(request) {
    const url = new URL(request.url);  // 获取请求的 URL 对象

    // 核心修改：根据请求的端口分配对应的 Emby 地址
    let FRONTEND_URL = "";
    switch (url.port) {
        case "8443":
            FRONTEND_URL = "https://link00.okemby.org:8443"; // Emby 2 的真实地址
            break;
        case "2053":
            FRONTEND_URL = "https://www.lilyemby.com"; // Emby 3 的真实地址
            break;
        default:
        case "8880":
            FRONTEND_URL = "http://wf.vban.com:8880"; // Emby 1 (默认) 的真实地址
            break;
    }

    // 处理 OPTIONS 预检请求（解决客户端连接问题）
    // 当客户端发送 OPTIONS 请求时，浏览器会首先进行预检请求，确认服务器是否允许该操作。
    if (request.method === "OPTIONS") {
        return new Response(null, {
            headers: {
                "Access-Control-Allow-Origin": "*",  // 允许所有域名跨域访问
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",  // 允许的 HTTP 方法
                "Access-Control-Allow-Headers": "*",  // 允许所有请求头
                "Access-Control-Max-Age": "86400",  // 预检请求的缓存时间（秒）
            },
        });
    }

    // 2. 确定目标 URL
    let targetUrlStr;
    const decodedPath = decodeURIComponent(url.pathname);  // 解码路径部分（避免 URL 编码干扰）

    // 如果请求的路径是一个以 "http://" 或 "https://" 开头的链接（即后端重定向链接）
    if (decodedPath.startsWith('/http://') || decodedPath.startsWith('/https://')) {
        // 处理被拦截的后端重定向链接，去掉开头的 "/" 并加上查询字符串
        targetUrlStr = decodedPath.substring(1) + url.search;
    } else {
        // 正常访问前端，使用通过端口判断得出的前端地址和路径
        targetUrlStr = FRONTEND_URL + url.pathname + url.search;
    }

    // 3. 构造新请求
    const targetUrl = new URL(targetUrlStr);  // 创建目标请求的 URL
    const newHeaders = new Headers(request.headers);  // 克隆请求头

    // 必须更新 Host 头，否则后端会拒绝访问
    newHeaders.set("Host", targetUrl.host);
    // 移除可能引起冲突的 Cloudflare 特定头部
    newHeaders.delete("cf-connecting-ip");
    newHeaders.delete("cf-ipcountry");
    newHeaders.delete("cf-ray");
    newHeaders.delete("cf-visitor");

    // 4. 发起请求
    // 使用 request.clone() 确保在处理 POST/PUT 请求时，body 不会因为多次读取而报错
    const modifiedRequest = new Request(targetUrl, {
        method: request.method,  // 使用原请求的 HTTP 方法
        headers: newHeaders,  // 使用修改后的请求头
        body: (request.method !== 'GET' && request.method !== 'HEAD') ? await request.clone().arrayBuffer() : null,  // 对于 POST/PUT 请求，读取请求体
        redirect: 'manual'  // 禁用自动重定向，手动处理
    });

    try {
        // 5. 发起并获取响应
        const response = await fetch(modifiedRequest);
        const responseHeaders = new Headers(response.headers);

        // 6. 核心：拦截并改写后端重定向，保持“免翻墙”
        // 如果响应是 301, 302, 303, 307, 308 重定向，修改 Location 头部
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            const location = responseHeaders.get('Location');
            if (location && (location.startsWith('http://') || location.startsWith('https://'))) {
                // 将后端域名包装进 Worker 路径，避免需要翻墙
                responseHeaders.set('Location', `/${encodeURIComponent(location)}`);
            }
        }

        // 7. 加上跨域支持和禁用缓存
        responseHeaders.set('Access-Control-Allow-Origin', '*');  // 跨域访问
        responseHeaders.set('Cache-Control', 'no-store');  // 禁用缓存

        // 返回处理后的响应
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders
        });

    } catch (err) {
        // 如果请求失败，返回502错误并附上错误信息
        return new Response("Worker Proxy Error: " + err.message, { status: 502 });
    }
}

// 事件监听器，监听 fetch 事件并执行 handleRequest
// Cloudflare Worker 需要通过 fetch 事件来处理所有的 HTTP 请求
addEventListener("fetch", event => {
    event.respondWith(handleRequest(event.request));  // 对每个请求调用 handleRequest 函数
});