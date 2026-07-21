'use strict';

const http = require('http');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

const BLOCK_DOMAINS = [
  '4sapi.com',
  '529961.com',
  '88996.cloud',
  '88code.ai',
  '88code.org',
  '91code.pro',
  '992236.xyz',
  'ai.codeqaq.com',
  'ai.hybgzs.com',
  'ai.kjvhh.com',
  'aicanapi.com',
  'aicodemirror.com',
  'aicoding.sh',
  'aifast.site',
  'aigocode.com',
  'aihubmix.com',
  'anmory.com',
  'anyrouter.top',
  'api.5202030.xyz',
  'api.ablai.top',
  'api.bianxie.ai',
  'api.bltcy.ai',
  'api.cpass.cc',
  'api.dev88.tech',
  'api.dreamger.com',
  'api.expansion.chat',
  'api.gueai.com',
  'api.holdai.top',
  'api.ikuncode.cc',
  'api.lconai.com',
  'api.linkapi.org',
  'api.mkeai.com',
  'api.nekoapi.com',
  'api.oaipro.com',
  'api.ruyun.fun',
  'api.ssopen.top',
  'api.tu-zi.com',
  'api.uglycat.cc',
  'api.v3.cm',
  'api.whatai.cc',
  'api.wpgzs.top',
  'api.xty.app',
  'api.yuegle.com',
  'api.zzyu.me',
  'apimart.ai',
  'apipro.maynor1024.live',
  'apiyi.com',
  'applyj.hiapi.top',
  'augmunt.com',
  'b4u.qzz.io',
  'clauddy.com',
  'claude-code-hub.app',
  'claude-opus.top',
  'claudeide.net',
  'cloudsway.net',
  'cn-beijing.fcapp.run',
  'cn-shanghai.fcapp.run',
  'co.yes.vg',
  'code.wenwen-ai.com',
  'code.x-aio.com',
  'codeilab.com',
  'cubence.com',
  'datadoghq.com',
  'deeprouter.top',
  'dhcoder.net',
  'dimaray.com',
  'dmxapi.com',
  'docs.aigc2d.com',
  'duckcoding.com',
  'fk.hshwk.org',
  'flapcode.com',
  'foxcode.hshwk.org',
  'foxcode.rjj.cc',
  'fuli.hxi.me',
  'getgoapi.com',
  'gpt.zhizengzeng.com',
  'gptgod.cloud',
  'gptkey.eu.org',
  'gptpay.store',
  'growthbook.io',
  'hdgsb.com',
  'henapi.top',
  'high-five-ai.xyz',
  'hongshan.com',
  'instcopilot-api.com',
  'intsig.net',
  'iwhalecloud.com',
  'jeniya.top',
  'jiekou.ai',
  'kg-api.cloud',
  'lemongpt.top',
  'new-api.u4vr.com',
  'new.xychatai.com',
  'nin.ai',
  'one-api.bltcy.top',
  'one.ocoolai.com',
  'oneapi.paintbot.top',
  'open.xiaojingai.com',
  'openclaude.me',
  'opus.gptuu.com',
  'packyapi.com',
  'poloai.top',
  'poloapi.top',
  'privnode.com',
  'proxyai.com',
  'qinzhiai.com',
  'right.codes',
  'runanytime.hxi.me',
  'sentry.io',
  'sssaicode.com',
  'statsig.anthropic.com',
  'statsig.com',
  'status.claude.com',
  'stepfun-inc.com',
  'store.zzyus.top',
  'tiantianai.pro',
  'uiuiapi.com',
  'uniapi.ai',
  'vip.undyingapi.com',
  'wolfai.top',
  'wzw.de5.net',
  'wzw.pp.ua',
  'xairouter.com',
  'xaixapi.com',
  'xiaohuapi.site',
  'xiaohumini.site',
  'xy.poloapi.com',
  'yansd666.com',
  'yansd666.top',
  'yunwu.ai',
  'yunwu.zeabur.app',
  'zenmux.ai',
  'zhihuiapi.top',
];

const MITM_DOMAINS = [
  'claude.ai',
  'api.anthropic.com',
];

const DEFAULT_HEADER_TIMEOUT_MS = 10000;
const DEFAULT_MAX_HEADER_BYTES = 64 * 1024;

function shouldBlock(host) {
  const h = host.toLowerCase();
  return BLOCK_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

function shouldMitm(host) {
  const h = host.toLowerCase();
  return MITM_DOMAINS.some((d) => h === d || h.endsWith('.' + d));
}

function parseDomainFromPath(reqPath) {
  try {
    const url = new URL(`https://claude.ai${reqPath}`);
    return url.searchParams.get('domain') || 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

function normalizeRequestTarget(target) {
  if (!target) return null;
  if (target.startsWith('/')) return target;

  try {
    const url = new URL(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return `${url.pathname}${url.search}`;
  } catch (_) {
    return null;
  }
}

function parseRequestLine(line) {
  const parts = line.split(' ');
  if (parts.length !== 3) return null;

  const [method, target, version] = parts;
  if (!/^[A-Z]+$/.test(method)) return null;
  if (!target) return null;
  if (version !== 'HTTP/1.1' && version !== 'HTTP/1.0') return null;

  return { method, target, version };
}

function sendTextResponse(tlsSocket, statusCode, statusText, body) {
  tlsSocket.end(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
    'Content-Type: text/plain; charset=utf-8\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    'Connection: close\r\n\r\n' +
    body
  );
}

function sendNoContentResponse(tlsSocket) {
  tlsSocket.end(
    'HTTP/1.1 204 No Content\r\n' +
    'Content-Length: 0\r\n' +
    'Connection: close\r\n\r\n'
  );
}

function formatMitmLog(message, reqPath) {
  return `${message} path=${reqPath || 'unknown'}`;
}

function buildConnectRequest(host, port, upstreamProxy) {
  const lines = [
    `CONNECT ${host}:${port} HTTP/1.1`,
    `Host: ${host}:${port}`,
  ];

  if (upstreamProxy && (upstreamProxy.username || upstreamProxy.password)) {
    const username = decodeURIComponent(upstreamProxy.username);
    const password = decodeURIComponent(upstreamProxy.password);
    const credentials = Buffer.from(`${username}:${password}`).toString('base64');
    lines.push(`Proxy-Authorization: Basic ${credentials}`);
  }

  return lines.join('\r\n') + '\r\n\r\n';
}

function tunnelThroughSocket({ clientSocket, targetSocket, head }) {
  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  if (head && head.length > 0) {
    targetSocket.write(head);
  }
  clientSocket.pipe(targetSocket);
  targetSocket.pipe(clientSocket);
}

function connectDirect({ host, port, clientSocket, head }) {
  const targetSocket = net.connect(port, host, () => {
    tunnelThroughSocket({ clientSocket, targetSocket, head });
  });

  targetSocket.on('error', () => {
    clientSocket.destroy();
  });

  clientSocket.on('error', () => {
    targetSocket.destroy();
  });
}

function connectViaUpstream({ host, port, clientSocket, head, upstreamProxy }) {
  const upstreamSocket = net.connect(Number(upstreamProxy.port || 80), upstreamProxy.hostname, () => {
    upstreamSocket.write(buildConnectRequest(host, port, upstreamProxy));
  });

  let buffer = Buffer.alloc(0);
  let connected = false;

  upstreamSocket.on('data', (chunk) => {
    if (connected) return;
    buffer = Buffer.concat([buffer, chunk]);

    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const header = buffer.subarray(0, headerEnd).toString();
    const rest = buffer.subarray(headerEnd + 4);
    const statusLine = header.split('\r\n')[0] || '';

    if (!/^HTTP\/1\.[01] 2\d\d\b/.test(statusLine)) {
      clientSocket.destroy();
      upstreamSocket.destroy();
      return;
    }

    connected = true;
    upstreamSocket.removeAllListeners('data');
    tunnelThroughSocket({ clientSocket, targetSocket: upstreamSocket, head });
    if (rest.length > 0) {
      clientSocket.write(rest);
    }
  });

  upstreamSocket.on('error', () => {
    clientSocket.destroy();
  });

  clientSocket.on('error', () => {
    upstreamSocket.destroy();
  });
}

function createProxy(opts) {
  const log = (opts && opts.log) || (() => {});
  const getSecureContext = (opts && opts.getSecureContext) || (() => { throw new Error('secureContext not configured'); });
  const headerTimeoutMs = (opts && opts.headerTimeoutMs) || DEFAULT_HEADER_TIMEOUT_MS;
  const maxHeaderBytes = (opts && opts.maxHeaderBytes) || DEFAULT_MAX_HEADER_BYTES;
  const upstreamProxy = opts && opts.upstreamProxyUrl ? new URL(opts.upstreamProxyUrl) : null;
  const server = http.createServer();

  server.on('connect', (req, clientSocket, head) => {
    const [host, portStr] = req.url.split(':');
    const port = parseInt(portStr) || 443;

    if (shouldBlock(host)) {
      log(`Blocked: ${host}:${port}`);
      clientSocket.destroy();
      return;
    }

    if (shouldMitm(host)) {
      log(formatMitmLog(`MITM: ${host}:${port}`, 'CONNECT'));
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      let sc;
      try {
        sc = getSecureContext(host);
      } catch (err) {
        log(formatMitmLog(`MITM setup failed for ${host}: ${err.message}`, 'CONNECT'));
        clientSocket.destroy();
        return;
      }

      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        secureContext: sc,
        ALPNProtocols: ['http/1.1'],
      });

      let buffer = Buffer.alloc(0);
      let handled = false;
      const headerTimer = setTimeout(() => {
        if (handled) return;
        handled = true;
        log(formatMitmLog(`Blocked incomplete MITM header: ${host}:${port}`));
        tlsSocket.destroy();
      }, headerTimeoutMs);

      function cleanupHeaderTimer() {
        clearTimeout(headerTimer);
      }

      tlsSocket.on('data', (chunk) => {
        if (handled) return;
        buffer = Buffer.concat([buffer, chunk]);

        if (buffer.length > maxHeaderBytes) {
          handled = true;
          cleanupHeaderTimer();
          log(formatMitmLog(`Blocked oversized MITM header: ${host}:${port}`));
          tlsSocket.destroy();
          return;
        }

        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) return;

        handled = true;
        cleanupHeaderTimer();
        const headerPart = buffer.subarray(0, headerEnd).toString();
        const lines = headerPart.split('\r\n');
        const request = parseRequestLine(lines[0]);

        if (!request) {
          log(formatMitmLog(`Blocked malformed MITM request: ${host}:${port}`));
          tlsSocket.destroy();
          return;
        }

        const { method } = request;
        const reqPath = normalizeRequestTarget(request.target);

        if (method === 'CONNECT') {
          log(formatMitmLog(`Blocked CONNECT inside MITM: ${host}:${port}`, reqPath));
          tlsSocket.destroy();
          return;
        }

        if (reqPath && reqPath.startsWith('/api/web/domain_info')) {
          const domain = parseDomainFromPath(reqPath);
          log(formatMitmLog(`Faked domain check: ${domain}`, reqPath));
          const body = JSON.stringify({ domain, can_fetch: true });
          tlsSocket.end(
            'HTTP/1.1 200 OK\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            'Connection: close\r\n\r\n' +
            body
          );
        } else if (host.toLowerCase() === 'api.anthropic.com' && reqPath && reqPath.startsWith('/v1/')) {
          log(formatMitmLog(`Blocked API request: ${host}:${port}`, reqPath));
          sendTextResponse(tlsSocket, 403, 'Forbidden', 'blocked');
        } else if (host.toLowerCase() === 'api.anthropic.com' && reqPath && reqPath.startsWith('/api/event_logging/')) {
          log(formatMitmLog(`Blocked event logging request: ${host}:${port}`, reqPath));
          sendNoContentResponse(tlsSocket);
        } else {
          log(formatMitmLog(`Blocked via MITM: ${host}:${port}`, reqPath));
          tlsSocket.destroy();
        }
      });

      tlsSocket.on('error', () => {});
      tlsSocket.on('close', cleanupHeaderTimer);
      return;
    }

    if (upstreamProxy) {
      log(`Tunnel via upstream: ${host}:${port}`);
      connectViaUpstream({ host, port, clientSocket, head, upstreamProxy });
    } else {
      log(`Tunnel: ${host}:${port}`);
      connectDirect({ host, port, clientSocket, head });
    }
  });

  return server;
}

module.exports = { createProxy, shouldBlock };
