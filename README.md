# Emby 反向代理 + 管理面板

一个功能完整的 Emby 反向代理系统，基于 Cloudflare Workers 构建，包含可视化仪表盘和管理后台。


<img width="1280" height="1102" alt="image" src="https://github.com/user-attachments/assets/3164ad61-606a-4453-a12c-7b4d74b4c0b1" />


## ✨ 功能特性

### 🔄 反向代理
- 多端口路由支持（根据访问端口自动切换后端）
- 自动处理重定向，实现"免翻墙"访问
- 支持 HTTP/HTTPS 后端
- CORS 跨域支持

### 📊 可视化仪表盘
- 今日请求统计（请求数、成功率、流量、错误数）
- 近7天请求趋势图表（折线图 + 饼图）
- 专业数据分析（请求分析、流量分析、性能分析、错误分析）
- 各端口详细统计

### 🖥️ 后端管理
- 在线添加/编辑/删除后端服务器
- 一键启用/禁用后端
- 复制反代地址功能
- 恢复默认配置

### 🛡️ 访问控制
- IP 黑名单（禁止指定 IP 访问）
- IP 白名单（仅允许指定 IP 访问）
- 白名单优先级高于黑名单

### 📋 错误日志
- 自动记录请求错误
- 显示错误时间、端口、IP、URL
- 一键清除日志

### 📖 使用说明
- 内置完整的使用文档
- 部署、配置、常见问题解答

## 🚀 快速开始

### 1. 部署 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单选择 **Workers & Pages**
3. 点击 **Create Worker** 创建新 Worker
4. 将 `workers.js` 代码完整复制到编辑器中
5. 点击 **Save and Deploy** 部署

部署后会获得默认域名：`你的worker名.你的账户.workers.dev`

### 2. 创建并绑定 KV

**创建 KV 命名空间：**
1. 左侧菜单 **Workers & Pages** → **KV**
2. 点击 **Create a namespace**
3. 输入名称：`EMBY_KV`
4. 点击 **Add**

**绑定 KV 到 Worker：**
1. 进入 Worker → **Settings** → **Variables**
2. 点击 **Add variable** → 选择 **KV Namespace**
3. Variable name 填写：`EMBY_KV`（必须完全一致）
4. Value 选择刚创建的 KV 命名空间
5. 点击 **Save**

> ⚠️ 绑定 KV 后，必须重新部署 Worker 才能生效！

### 3. 访问管理面板

- 地址：`https://你的域名/admin`
- 默认密码：`admin123`（请及时修改代码中的 `ADMIN_PASSWORD`）

## 🌐 绑定自定义域名

### 方法一：直接绑定自定义域名

1. 进入 Worker → **Settings** → **Triggers**
2. 点击 **Add Custom Domain**
3. 输入你的域名，如：`emby.你的域名.com`
4. 点击 **Add Custom Domain**

> 💡 域名需要已托管到 Cloudflare

### 方法二：通过 CNAME 绑定优选域名（推荐）

通过 CNAME 绑定优选域名可以获得更好的访问速度。

**以绑定 saas.sin.fan 为例：**

1. 进入 Cloudflare **DNS** 管理页面
2. 点击 **Add record** 添加记录
3. 配置如下：

| 项目 | 值 |
|------|-----|
| 类型 | CNAME |
| 名称 | emby（或其他子域名） |
| 目标 | saas.sin.fan |
| 代理状态 | 仅DNS（必须关闭橙色云朵） |

4. 点击 **Save** 保存
5. 在 Worker 中绑定该域名：Worker → **Settings** → **Triggers** → **Add Custom Domain** → 输入 `emby.你的域名.com`

## 🔌 多端口说明

本系统支持根据访问端口自动路由到不同的后端服务器：

| 访问端口 | 说明 |
|----------|------|
| 默认（443） | 使用 default 后端配置 |
| 8443 | 使用端口 8443 对应的后端 |
| 2053 | 使用端口 2053 对应的后端 |

> ⚠️ 使用非标准端口时，需要在 Cloudflare 中配置并开启该端口的 HTTPS 支持。
> 
> Cloudflare 支持的 HTTPS 端口：443, 2053, 2083, 2087, 2096, 8443

## ⚙️ 配置说明

### 修改管理员密码

修改代码第 9 行的 `ADMIN_PASSWORD` 值：

```javascript
const ADMIN_PASSWORD = "你的强密码";
```

### 默认后端配置

修改代码中的 `DEFAULT_BACKENDS` 对象：

```javascript
const DEFAULT_BACKENDS = {
    "8443": {
        name: "Emby 2",
        url: "https://your-emby-server:8443",
        enabled: true
    },
    "default": {
        name: "Emby 1",
        url: "https://your-emby-server",
        enabled: true
    }
};
```

## 📁 项目结构

```
Emby反代/
├── workers.js      # Worker 主代码
└── README.md       # 项目说明文档
```

## 🔧 技术栈

- **Cloudflare Workers** - Serverless 边缘计算平台
- **Cloudflare KV** - 键值存储（用于统计数据、配置存储）
- **原生 JavaScript** - 无框架依赖，轻量高效

## ❓ 常见问题

### Q: 为什么提示 "KV 未配置"？
A: 请确保已正确绑定 KV，变量名必须完全为 `EMBY_KV`，绑定后需重新部署。

### Q: 为什么出现 429 错误？
A: KV 写入频率超限。免费版每天 1000 次写入，本系统已优化为每 30 秒写入一次。

### Q: 如何修改管理员密码？
A: 修改代码中的 `ADMIN_PASSWORD` 值，然后重新部署。

### Q: 为什么无法访问后端？
A: 检查后端地址是否正确，确保后端服务器可被 Cloudflare 访问（非内网地址）。

### Q: 绑定自定义域名后无法访问？
A: 确保域名已托管到 Cloudflare，DNS 记录已生效。

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

⭐ 如果这个项目对你有帮助，请给一个 Star！
