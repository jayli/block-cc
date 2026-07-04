# block-cc 设计文档

## 目标

`npx block-cc claude` 启动 Claude Code，自动拦截其向 Anthropic/第三方服务发出的非必要 HTTPS 请求（遥测、打点、更新检查、错误上报等），防止上报用户数据。仅作用于 Claude Code 进程，不影响系统中浏览器等应用正常访问被拦截域名。

## 技术方案

使用 Node.js 标准库实现 HTTP CONNECT 代理，在 TLS 握手前的 CONNECT 阶段按域名阻断。

- 零 npm 依赖
- 不需要安装 TLS 根证书
- 跨平台（Windows/macOS/Linux 零差异）

## 核心原理

```
Claude Code                  Proxy (localhost:随机端口)       目标服务器
    │                              │                              │
    │ CONNECT api.anthropic.com    │                              │
    │──────────────────────────────>                              │
    │                              │                              │
    │  检查域名是否在 BLOCK_DOMAINS │                              │
    │  ├─ 在列表: socket.destroy() │                              │
    │  └─ 不在列表: net.connect()  │                              │
    │                 ↓            │                              │
    │                建立 TCP 隧道  │                              │
    │                双向 pipe 转发 │  ──────────────────────────>  │
    │                              │  <──────────────────────────  │
```

## 架构

```
┌──────────────────────┐
│  npx block-cc claude │  ← 用户入口
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  CLI (index.js)       │
│  1. 检测 Claude Code  │
│     是否安装           │
│  2. 启动代理 (随机端口)│
│  3. spawn claude      │
│     + HTTP(S)_PROXY   │
│  4. 等待子进程退出     │
│  5. 关闭代理，退出     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│  代理 (proxy.js)      │
│  http.createServer    │
│  ├─ connect 事件      │
│  ├─ 域名匹配 → destroy│
│  ├─ 不匹配 → 隧道转发 │
│  └─ 日志 → stderr     │
└──────────────────────┘
```

## 拦截域名列表

| 域名 | 拦截原因 |
|------|----------|
| `statsig.com` | 特性开关 / AB 实验 |
| `datadoghq.com` | Datadog 日志上报 |
| `sentry.io` | 错误上报 |
| `growthbook.io` | 特性开关 |
| `claude.ai` | 域名信息查询、网页端请求 |
| `api.anthropic.com` | 遥测、指标、配置、会话上传等 |

注：用户自定义 API 端点使用独立域名，因此 `api.anthropic.com` 全量拦截不影响正常 API 调用。

## 文件结构

```
block-cc/
├── package.json
├── index.js          # CLI 入口
└── proxy.js          # HTTP CONNECT 代理
```

## 关键设计决策

### 环境变量注入

通过 `spawn` 的 `env` 对象注入 `HTTP_PROXY` 和 `HTTPS_PROXY`，仅作用于 Claude Code 子进程。不写入 shell 配置文件，不影响浏览器或其他应用。

### 端口分配

`server.listen(0)` 让系统自动分配空闲端口，避免端口冲突。

### Claude Code 安装检测

直接尝试执行 `spawnSync('claude', ['--version'])`，根据 `ENOENT` 错误判断是否安装。跨平台兼容 Windows 的 `.cmd` 包装。

## 不做的事情

- 不读取配置文件，拦截列表硬编码
- 不支持命令行参数配置端口或域名
- 不做 URL 路径级过滤（不安装 TLS 证书）
- 不持久化代理进程
- 不拦截 `api.anthropic.com` 以外的正常 API 请求
