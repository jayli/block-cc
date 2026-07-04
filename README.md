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

三层拦截，确保万无一失：

**第一层：网络代理拦截** — 启动本地 HTTP CONNECT 代理，在 TLS 握手之前阻断以下域名：

| 域名 | 拦截原因 |
|------|----------|
| `statsig.com` | 特性开关 / AB 实验 |
| `datadoghq.com` | Datadog 日志上报 |
| `sentry.io` | 错误上报 |
| `growthbook.io` | 特性开关 |
| `api.anthropic.com` | 遥测、指标、配置同步、会话上传等 |

**第二层：TLS MITM 精确拦截** — 对 `claude.ai` 进行 TLS 中间人，精确到 URL 路径：

- `claude.ai/api/web/domain_info` → 本地返回 `{"domain":"...","can_fetch":true}`，请求不离开本机
- `claude.ai` 其他所有路径 → 阻断

首次运行自动生成本地 CA 证书，通过 `NODE_EXTRA_CA_CERTS` 让 Claude Code 自动信任，无需手动安装。

**第三层：环境变量关闭** — 注入开关，从应用层禁用更新和反馈：

```
DISABLE_AUTOUPDATER=1
CLAUDE_CODE_DISABLE_UPDATE_CHECK=1
CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1
```

代理和环境变量均仅作用于 Claude Code 进程，不影响浏览器或其他应用。

## 要求

- Node.js >= 18
- Claude Code 已安装
- `openssl`（macOS/Linux 自带）

## 特点

- 零依赖，仅使用 Node.js 标准库
- 跨平台（macOS / Linux / Windows）
- 随 Claude Code 退出自动清理代理
