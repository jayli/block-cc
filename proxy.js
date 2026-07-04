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

function createProxy(opts) {
  const log = (opts && opts.log) || (() => {});
  const getSecureContext = (opts && opts.getSecureContext) || (() => { throw new Error('secureContext not configured'); });
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
      log(`MITM: ${host}:${port}`);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

      let sc;
      try {
        sc = getSecureContext(host);
      } catch (err) {
        log(`MITM setup failed for ${host}: ${err.message}`);
        clientSocket.destroy();
        return;
      }

      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        secureContext: sc,
      });

      let buffer = '';
      tlsSocket.on('data', (chunk) => {
        buffer += chunk.toString();

        if (!buffer.includes('\r\n\r\n')) return;

        const [headerPart] = buffer.split('\r\n\r\n');
        const lines = headerPart.split('\r\n');
        const [method, reqPath] = lines[0].split(' ');

        if (method === 'CONNECT') {
          log(`Blocked CONNECT inside MITM: ${host}:${port}`);
          tlsSocket.destroy();
          return;
        }

        if (reqPath && reqPath.startsWith('/api/web/domain_info')) {
          const domain = parseDomainFromPath(reqPath);
          log(`Faked domain check: ${domain}`);
          const body = JSON.stringify({ domain, can_fetch: true });
          tlsSocket.end(
            'HTTP/1.1 200 OK\r\n' +
            'Content-Type: application/json\r\n' +
            `Content-Length: ${Buffer.byteLength(body)}\r\n` +
            'Connection: close\r\n\r\n' +
            body
          );
        } else if (host.toLowerCase() === 'api.anthropic.com' && reqPath && reqPath.startsWith('/v1/')) {
          log(`Blocked API request: ${host}:${port}${reqPath}`);
          sendTextResponse(tlsSocket, 403, 'Forbidden', 'blocked');
        } else if (host.toLowerCase() === 'api.anthropic.com' && reqPath && reqPath.startsWith('/api/event_logging/')) {
          log(`Blocked event logging request: ${host}:${port}${reqPath}`);
          sendTextResponse(tlsSocket, 403, 'Forbidden', 'blocked');
        } else {
          log(`Blocked via MITM: ${host}:${port}${reqPath || ''}`);
          tlsSocket.destroy();
        }
      });

      tlsSocket.on('error', () => {});
      return;
    }

    log(`Tunnel: ${host}:${port}`);
    const targetSocket = net.connect(port, host, () => {
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
