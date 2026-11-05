'use strict';
// 原始 HTTP 发送：直接写 socket，保证请求行、头顺序、body 与编辑器里看到的一致。
const net = require('net');
const tls = require('tls');
const zlib = require('zlib');

function parseRequest(raw) {
  const text = raw.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const idx = text.indexOf('\r\n\r\n');
  const head = idx >= 0 ? text.slice(0, idx) : text;
  const body = idx >= 0 ? text.slice(idx + 4) : '';
  const lines = head.split('\r\n');
  const first = lines[0].split(/\s+/);
  if (first.length < 2) throw new Error('请求行格式不对，需要 METHOD PATH HTTP/1.1');
  const headers = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return { method: first[0], target: first[1], version: first[2] || 'HTTP/1.1', headers, body };
}

function header(headers, name) {
  const hit = headers.find(([k]) => k.toLowerCase() === name.toLowerCase());
  return hit ? hit[1] : '';
}

async function send(raw, opts = {}) {
  const protocol = opts.protocol || 'auto';
  const wantH2 = protocol === 'h2' || (protocol === 'auto' && (opts.scheme || 'https') === 'https');

  if (wantH2) {
    try {
      const h2 = require('./http2');
      return await h2.send(raw, opts);
    } catch (err) {
      if (protocol === 'h2') throw err;
      // 自动模式：只在「还没拿到响应」时回落，避免写请求被重复发送
      if (!(err.code === 'NO_H2' || err.beforeResponse)) throw err;
    }
  }
  return sendH1(raw, opts);
}


/* ---------------- 代理隧道 ---------------- */

function parseProxy(str) {
  try {
    const u = new URL(String(str || '').trim());
    return {
      protocol: u.protocol.replace(':', ''),
      host: u.hostname,
      port: Number(u.port) || (u.protocol === 'socks5:' || u.protocol === 'socks5h:' ? 1080 : 8080),
      user: decodeURIComponent(u.username || ''),
      pass: decodeURIComponent(u.password || '')
    };
  } catch (e) {
    throw new Error('代理地址格式不对：' + str);
  }
}

function httpConnect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    const fail = (e) => { sock.destroy(); reject(e); };
    sock.setTimeout(15000, () => fail(new Error('代理连接超时')));
    sock.once('error', fail);
    sock.once('connect', () => {
      const auth = proxy.user
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.pass}`).toString('base64')}\r\n`
        : '';
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth}\r\n`);
      let buf = '';
      const onData = (d) => {
        buf += d.toString('latin1');
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        sock.removeListener('data', onData);
        const line = buf.split('\r\n')[0];
        const code = Number(line.split(' ')[1]);
        if (code !== 200) return fail(new Error('代理拒绝隧道：' + line));
        sock.setTimeout(0);
        resolve(sock);
      };
      sock.on('data', onData);
    });
  });
}

function socksConnect(proxy, host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: proxy.host, port: proxy.port });
    const fail = (e) => { sock.destroy(); reject(e); };
    sock.setTimeout(15000, () => fail(new Error('SOCKS 代理超时')));
    sock.once('error', fail);

    let step = 'greet';
    let buf = Buffer.alloc(0);

    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      try {
        if (step === 'greet') {
          if (buf.length < 2) return;
          if (buf[1] !== 0x00) throw new Error('SOCKS 代理要求认证');
          buf = buf.slice(2);
          step = 'auth';
          if (proxy.user) {
            const u = Buffer.from(proxy.user);
            const pw = Buffer.from(proxy.pass);
            sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([pw.length]), pw]));
          } else {
            buf = buf;
            step = 'connect';
            sendConnect();
          }
          if (proxy.user && buf.length) onData(Buffer.alloc(0));
          return;
        }
        if (step === 'auth') {
          if (buf.length < 2) return;
          if (buf[1] !== 0x00) throw new Error('SOCKS 认证失败');
          buf = buf.slice(2);
          step = 'connect';
          sendConnect();
          return;
        }
        if (step === 'reply') {
          if (buf.length < 4) return;
          if (buf[1] !== 0x00) throw new Error('SOCKS 连接失败：' + buf[1]);
          sock.removeListener('data', onData);
          sock.setTimeout(0);
          resolve(sock);
        }
      } catch (e) {
        fail(e);
      }
    };

    function sendConnect() {
      const hb = Buffer.from(host);
      const req = Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]),
        hb,
        Buffer.from([(port >> 8) & 0xff, port & 0xff])
      ]);
      sock.write(req);
      step = 'reply';
      if (buf.length) onData(Buffer.alloc(0));
    }

    sock.once('connect', () => {
      if (proxy.user) sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
      else sock.write(Buffer.from([0x05, 0x01, 0x00]));
      sock.on('data', onData);
    });
  });
}

/** 按需建立到目标的 socket（可经代理）。 */
function openSocket(target, scheme, proxyStr, servername) {
  const base = proxyStr
    ? (() => {
        const pr = parseProxy(proxyStr);
        return /^socks/.test(pr.protocol) ? socksConnect(pr, target.host, target.port) : httpConnect(pr, target.host, target.port);
      })()
    : Promise.resolve(null);

  return base.then((tunnel) => {
    if (!tunnel) {
      return scheme === 'https'
        ? tls.connect({ host: target.host, port: target.port, servername, rejectUnauthorized: false })
        : net.connect({ host: target.host, port: target.port });
    }
    if (scheme !== 'https') return tunnel;
    return new Promise((resolve, reject) => {
      const s = tls.connect({ socket: tunnel, servername }, () => resolve(s));
      s.once('error', reject);
    });
  });
}

async function sendH1(raw, opts = {}) {
  const timeout = opts.timeout || 30000;
  const req = parseRequest(raw);

  let scheme = opts.scheme || 'https';
  let host = header(req.headers, 'host');
  let path = req.target;

  if (/^https?:\/\//i.test(path)) {
    const u = new URL(path);
    scheme = u.protocol.replace(':', '');
    host = u.host;
    path = u.pathname + u.search;
  }
  if (!host) throw new Error('缺少 Host 头');

  const [hostname, portRaw] = host.startsWith('[')
    ? [host, 443]
    : host.includes(':') ? [host.slice(0, host.lastIndexOf(':')), host.slice(host.lastIndexOf(':') + 1)]
                         : [host, 0];
  const port = Number(portRaw) || (scheme === 'https' ? 443 : 80);

  let bodyBuf = Buffer.from(req.body, 'utf8');
  const drop = new Set(['content-length', 'transfer-encoding', 'connection', 'proxy-connection']);
  const headers = req.headers.filter(([k]) => !drop.has(k.toLowerCase()));
  if (bodyBuf.length || ['POST', 'PUT', 'PATCH'].includes(req.method.toUpperCase())) {
    headers.push(['Content-Length', String(bodyBuf.length)]);
  }
  headers.push(['Connection', 'close']);

  const head =
    `${req.method} ${path} ${req.version}\r\n` +
    headers.map(([k, v]) => `${k}: ${v}`).join('\r\n') +
    '\r\n\r\n';

  const started = Date.now();
  const res = await new Promise((resolve, reject) => {
    const servername = /^[\d.]+$|:/.test(hostname) ? undefined : hostname.replace(/^\[|\]$/g, '');
    openSocket({ host: hostname, port }, scheme, opts.proxy, servername)
      .then((raw) => {
        const socket = raw;
        socket.setTimeout(timeout);
        const ready = scheme === 'https' && !opts.proxy ? 'secureConnect' : 'connect';
        const start = () => {
          socket.write(head);
          if (bodyBuf.length) socket.write(bodyBuf);
        };
        if (socket.connecting === false && socket.encrypted) start();
        else socket.once(ready, start);
        const chunks = [];
        socket.on('data', (c) => chunks.push(c));
        socket.on('end', () => resolve(Buffer.concat(chunks)));
        socket.on('timeout', () => { socket.destroy(); reject(new Error('连接超时')); });
        socket.on('error', reject);
      })
      .catch(reject);
  });

  const out = decodeResponse(res, Date.now() - started);
  out.protocol = 'h1';
  return out;
}

function decodeResponse(buf, ms) {
  const sep = buf.indexOf('\r\n\r\n');
  if (sep < 0) {
    return { status: 0, ms, text: buf.toString('utf8'), raw: buf.toString('utf8') };
  }
  const headText = buf.slice(0, sep).toString('latin1');
  let bodyBuf = buf.slice(sep + 4);
  const lines = headText.split('\r\n');
  const statusLine = lines[0];
  const headers = lines.slice(1).filter(Boolean).map((l) => {
    const i = l.indexOf(':');
    return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
  });

  const te = (headers.find(([k]) => k.toLowerCase() === 'transfer-encoding') || [, ''])[1].toLowerCase();
  if (te.includes('chunked')) bodyBuf = dechunk(bodyBuf);

  const ce = (headers.find(([k]) => k.toLowerCase() === 'content-encoding') || [, ''])[1].toLowerCase();
  try {
    if (ce.includes('gzip')) bodyBuf = zlib.gunzipSync(bodyBuf);
    else if (ce.includes('deflate')) bodyBuf = zlib.inflateSync(bodyBuf);
    else if (ce.includes('br')) bodyBuf = zlib.brotliDecompressSync(bodyBuf);
  } catch (e) {
    // 解压失败就保留原始字节
  }

  const ct = (headers.find(([k]) => k.toLowerCase() === 'content-type') || [, ''])[1];
  const m = /charset=([\w-]+)/i.exec(ct);
  let charset = m ? m[1].toLowerCase() : 'utf-8';
  if (charset === 'gbk' || charset === 'gb2312') charset = 'gb18030';

  let bodyText;
  try {
    bodyText = new TextDecoder(charset).decode(bodyBuf);
  } catch (e) {
    bodyText = bodyBuf.toString('utf8');
  }

  const text = headText + '\r\n\r\n' + bodyText;
  const status = Number((/^HTTP\/[\d.]+\s+(\d+)/.exec(statusLine) || [0, 0])[1]);
  return { status, ms, text, headers, raw: text };
}

function dechunk(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = parseInt(buf.slice(i, nl).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(buf.slice(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return Buffer.concat(out);
}

module.exports = { send, parseRequest, decodeResponse, dechunk, parseProxy, openSocket };
