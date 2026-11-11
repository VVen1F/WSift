'use strict';
// HTTP/2 发送：把编辑器里的 h1 报文翻译成 h2 请求，响应再还原成可读报文体。
const http2 = require('http2');
const zlib = require('zlib');
const { parseRequest, timeoutMs } = require('./http');

const DROP = new Set([
  'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding',
  'upgrade', 'host', 'content-length', 'te', 'trailer'
]);

function decodeBody(buf, headers) {
  const ce = String(headers['content-encoding'] || '').toLowerCase();
  try {
    if (ce.includes('gzip')) return zlib.gunzipSync(buf);
    if (ce.includes('deflate')) return zlib.inflateSync(buf);
    if (ce.includes('br')) return zlib.brotliDecompressSync(buf);
  } catch (e) {
    /* 解压失败保留原样 */
  }
  return buf;
}

function toText(status, headers, bodyText) {
  const lines = [`HTTP/2 ${status}`];
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':')) continue;
    lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
  return lines.join('\r\n') + '\r\n\r\n' + bodyText;
}

function connect(origin, timeout) {
  return new Promise((resolve, reject) => {
    const session = http2.connect(origin, {
      rejectUnauthorized: false,
      ALPNProtocols: ['h2']
    });
    const timer = setTimeout(() => {
      session.destroy();
      reject(new Error('HTTP/2 连接超时'));
    }, timeout);

    session.once('connect', () => {
      clearTimeout(timer);
      const alpn = session.socket && session.socket.alpnProtocol;
      if (alpn && alpn !== 'h2') {
        session.close();
        reject(Object.assign(new Error('服务端不支持 HTTP/2'), { code: 'NO_H2' }));
        return;
      }
      resolve(session);
    });
    session.once('error', (err) => {
      clearTimeout(timer);
      // 连接阶段失败（服务端不认 h2、证书、网络）统一标记为可回落
      const noH2 = /application protocol|ALPN/i.test(err.message || '') ||
        err.code === 'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL';
      reject(Object.assign(err, {
        code: noH2 ? 'NO_H2' : (err.code || 'H2_ERROR'),
        beforeResponse: true
      }));
    });
  });
}

async function send(raw, opts = {}) {
  const req = parseRequest(raw);
  const timeout = timeoutMs(opts.timeout);

  let scheme = opts.scheme || 'https';
  let host = '';
  let path = req.target;
  for (const [k, v] of req.headers) {
    if (k.toLowerCase() === 'host') host = v;
  }
  if (/^https?:\/\//i.test(path)) {
    const u = new URL(path);
    scheme = u.protocol.replace(':', '');
    host = u.host;
    path = u.pathname + u.search;
  }
  if (!host) throw new Error('缺少 Host 头');

  const origin = `${scheme}://${host}`;
  const session = await connect(origin, timeout);

  const headers = {
    ':method': req.method,
    ':path': path,
    ':scheme': scheme,
    ':authority': host
  };
  for (const [k, v] of req.headers) {
    const lk = k.toLowerCase();
    if (DROP.has(lk)) continue;
    headers[lk] = headers[lk] ? headers[lk] + ', ' + v : v;
  }

  const body = Buffer.from(req.body || '', 'utf8');
  if (body.length) headers['content-length'] = String(body.length);

  const started = Date.now();

  try {
    return await new Promise((resolve, reject) => {
      const stream = session.request(headers, { endStream: body.length === 0 });
      const chunks = [];
      let resHeaders = {};
      let status = 0;
      let gotResponse = false;
      const timer = setTimeout(() => {
        stream.destroy();
        reject(new Error('HTTP/2 请求超时'));
      }, timeout);

      stream.on('response', (h) => {
        gotResponse = true;
        resHeaders = h;
        status = Number(h[':status']) || 0;
      });
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        clearTimeout(timer);
        const buf = decodeBody(Buffer.concat(chunks), resHeaders);
        const ct = String(resHeaders['content-type'] || '');
        const m = /charset=([\w-]+)/i.exec(ct);
        let charset = m ? m[1].toLowerCase() : 'utf-8';
        if (charset === 'gbk' || charset === 'gb2312') charset = 'gb18030';
        let text;
        try {
          text = new TextDecoder(charset).decode(buf);
        } catch (e) {
          text = buf.toString('utf8');
        }
        resolve({ status, ms: Date.now() - started, text: toText(status, resHeaders, text), protocol: 'h2' });
      });
      stream.on('error', (err) => {
        clearTimeout(timer);
        err.beforeResponse = !gotResponse;
        reject(err);
      });

      if (body.length) stream.end(body);
    });
  } finally {
    session.close();
  }
}

module.exports = { send };
