# block-cc

<img src="./logo/logo.png" style="width:400px" />

阻止 Claude Code 向 Anthropic 官方发送遥测、日志、更新检查等非必要网络请求，保护你的隐私数据。

当然你也没办法使用 claude 的官方模型，只能自定义 ANTHROPIC_BASE_URL 来使用 cc。

## 无需安装，直接运行

```bash
npx block-cc claude
```

Claude Code 的所有额外参数会透传：

```bash
npx block-cc claude -c          # 等同于 claude -c
```

## 原理

启动时会自动启动一个本地 HTTP CONNECT 代理，拦截以下域名的连接（包括不限于）：

| 域名 | 拦截原因 |
|------|----------|
| `statsig.com` | 特性开关 / AB 实验 |
| `datadoghq.com` | Datadog 日志上报 |
| `sentry.io` | 错误上报 |
| `growthbook.io` | 特性开关 |
| `claude.ai` | 官网域名查询 |
| `api.anthropic.com` | 遥测、指标、配置同步、会话上传等 |

阻断发生在 TLS 握手之前的 CONNECT 阶段，正常 API 请求和工具调用依赖的网络请求不受影响（前提是你的自定义 API 端点是独立域名）。

代理仅作用于 Claude Code 进程，不影响浏览器或其他应用。

## 要求

- Node.js >= 18
- Claude Code 已安装

## 特点

- 零依赖，仅使用 Node.js 标准库
- 跨平台（macOS / Linux / Windows）
- 随 Claude Code 退出自动清理代理
