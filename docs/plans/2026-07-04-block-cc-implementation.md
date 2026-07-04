# block-cc Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现 `npx block-cc claude` 命令，启动一个本地 HTTP CONNECT 代理拦截遥测域名，然后启动 Claude Code 并注入代理环境变量。

**Architecture:** Node.js 零依赖 HTTP CONNECT 代理。在 CONNECT 阶段按域名匹配，拦截则 `socket.destroy()` 丢弃连接，不拦截则 `net.connect` 隧道透明转发。CLI 入口通过 `spawn` 启动 Claude Code 并注入 `HTTP_PROXY`/`HTTPS_PROXY`。

**Tech Stack:** Node.js 标准库（`http`, `net`, `child_process`），零 npm 依赖

**Design doc:** `docs/plans/2026-07-04-block-cc-design.md`

---

### Task 1: 项目骨架搭建

**Files:**
- Modify: `package.json`

**Step 1: 更新 package.json**

当前内容：
```json
{
  "name": "block-cc",
  "version": "1.0.0",
  "description": "block-cc",
  "homepage": "https://github.com/jayli/block-cc#readme",
  "bugs": {
    "url": "https://github.com/jayli/block-cc/issues"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/jayli/block-cc.git"
  },
  "license": "ISC",
  "author": "",
  "type": "commonjs",
  "main": "index.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  }
}
```

修改为：

```json
{
  "name": "block-cc",
  "version": "1.0.0",
  "description": "Launch Claude Code with telemetry domains blocked",
  "homepage": "https://github.com/jayli/block-cc#readme",
  "bugs": {
    "url": "https://github.com/jayli/block-cc/issues"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/jayli/block-cc.git"
  },
  "license": "ISC",
  "author": "",
  "type": "commonjs",
  "bin": {
    "block-cc": "./index.js"
  },
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  }
}
```

改动：更新 `description`，添加 `bin` 字段，移除 `main`（CLI 工具不需要 `main` 入口）。

**Step 2: Commit**

```bash
git add package.json
git commit -m "chore: add bin entry and update description"
```

---

### Task 2: HTTP CONNECT 代理模块

**Files:**
- Create: `proxy.js`

**Step 1: 创建 proxy.js**

```js
'use strict';

const http = require('http');
const net = require('net');

const BLOCK_DOMAINS = [
  'statsig.com',
  'datadoghq.com',
  'sentry.io',
  'growthbook.io',
  'claude.ai',
  'api.anthropic.com',
];

function shouldBlock(host) {
  return BLOCK_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

function createProxy() {
  const server = http.createServer();

  server.on('connect', (req, clientSocket, head) => {
    const [host, port] = req.url.split(':');

    if (shouldBlock(host)) {
      console.error(`[block-cc] Blocked: ${host}:${port}`);
      clientSocket.destroy();
      return;
    }

    const targetSocket = net.connect(port || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      targetSocket.write(head);
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });

    targetSocket.on('error', () => {
      clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      targetSocket.destroy();
    });
  });

  return server;
}

module.exports = { createProxy, shouldBlock };
```

**说明：**
- `shouldBlock` 支持精确域名匹配和子域名匹配（如 `api.statsig.com` 也命中 `statsig.com`）
- 错误处理：任一端出错时销毁另一端，避免资源泄漏
- 被拦截的请求输出到 stderr，方便用户确认拦截生效

**Step 2: Commit**

```bash
git add proxy.js
git commit -m "feat: add HTTP CONNECT proxy with domain blocking"
```

---

### Task 3: CLI 入口

**Files:**
- Create: `index.js`

**Step 1: 创建 index.js**

```js
#!/usr/bin/env node
'use strict';

const { spawn, spawnSync } = require('child_process');
const { createProxy } = require('./proxy');

const USAGE = 'Usage: npx block-cc claude';

function checkClaude() {
  const result = spawnSync('claude', ['--version'], {
    shell: true,
    stdio: 'pipe',
  });
  if (result.error && result.error.code === 'ENOENT') {
    console.error(
      'Claude Code 未安装，请先执行: npm install -g @anthropic-ai/claude-code'
    );
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args[0] !== 'claude') {
    console.error(USAGE);
    process.exit(1);
  }

  checkClaude();

  const proxy = createProxy();

  proxy.listen(0, '127.0.0.1', () => {
    const port = proxy.address().port;

    const env = {
      ...process.env,
      HTTP_PROXY: `http://127.0.0.1:${port}`,
      HTTPS_PROXY: `http://127.0.0.1:${port}`,
    };

    const claude = spawn('claude', args.slice(1), {
      env,
      stdio: 'inherit',
      shell: true,
    });

    claude.on('exit', (code, signal) => {
      proxy.close();
      if (signal) {
        process.exit(128 + (signal === 'SIGTERM' ? 15 : 9));
      }
      process.exit(code || 0);
    });
  });

  proxy.on('error', (err) => {
    console.error(`[block-cc] Proxy error: ${err.message}`);
    process.exit(1);
  });
}

main();
```

**要点：**
- Shebang `#!/usr/bin/env node` 使文件可直接执行
- `checkClaude()` 跨平台兼容：`spawnSync` + `shell: true` 使 Windows 也能找到 `claude.cmd`
- `proxy.listen(0)` 自动分配空闲端口
- `proxy.listen` 回调内 `spawn('claude', ...)` 保证代理就绪后才启动 Claude Code
- `stdio: 'inherit'` 让用户直接与 Claude Code 交互
- claude 退出后自动关闭代理
- 代理错误兜底

**Step 2: Commit**

```bash
git add index.js
git commit -m "feat: add CLI entry with claude detection and proxy lifecycle"
```

---

### Task 4: 手动验证

**Step 1: 创建本地测试脚本（临时，验证后删除）**

创建一个简单的测试来验证 shouldBlock 逻辑。

```bash
node -e "
const { shouldBlock } = require('./proxy');
const tests = [
  ['statsig.com', true],
  ['api.statsig.com', true],
  ['example.com', false],
  ['api.anthropic.com', true],
  ['my-api.example.com', false],
];
let ok = true;
for (const [host, expected] of tests) {
  const result = shouldBlock(host);
  if (result !== expected) {
    console.error('FAIL: shouldBlock(%s) = %s, expected %s', host, result, expected);
    ok = false;
  }
}
if (ok) console.log('All shouldBlock tests passed');
"
```

**Step 2: 验证 Claude Code 检测逻辑**

```bash
node -e "
const { spawnSync } = require('child_process');
const r = spawnSync('claude', ['--version'], { shell: true, stdio: 'pipe' });
if (r.error && r.error.code === 'ENOENT') console.log('Claude Code not found');
else console.log('Claude Code found, version:', r.stdout.toString().trim());
"
```

**Step 3: 端到端验证**

在开发目录本地链接后启动 Claude Code，观察 stderr 输出确认拦截生效：

```bash
# 先链接到全局（需要 cd 到项目根目录）
npm link
# 启动（确认 claude 已安装的前提下）
block-cc claude
# 打开 Claude Code 后执行 WebSearch 工具，观察 stderr 是否输出 Blocked
# 正常对话/工具调用应不受影响
```

**Step 4: Commit（如有修复）**

验证过程中发现的问题修复后提交。

---

### Task 5: 清理并最终检查

**Step 1: 确认文件结构**

```
block-cc/
├── docs/
│   └── plans/
│       ├── 2026-07-04-block-cc-design.md
│       └── 2026-07-04-block-cc-implementation.md
├── index.js
├── proxy.js
├── package.json
├── LICENSE
└── README.md
```

**Step 2: 最终验证**

```bash
node -e "require('./proxy')" && echo "proxy.js loads OK"
node -e "require('./index.js')" | head -5  # 应输出 usage（因为没传 claude 参数）
```

**Step 3: Commit**

```bash
git add -A
git status
# 确认无意外文件后提交在验证中如果有修复的内容
```

---
