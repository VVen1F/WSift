'use strict';
// 走代理的 HTTP 客户端：检查更新、下载安装包用它。
// Node 的 fetch 不认代理，所以这里自己建隧道。
const fs = require('fs');
const http = require('http');
const https = require('https');
const { openSocket } = require('./http');

const DEFAULT_TIMEOUT = 30000;

function openRequest(urlStr, opts = {}) {
  const u = new URL(urlStr);
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || (secure ? 443 : 80);
  const headers = { host: u.host, 'user-agent': 'refract', ...(opts.headers || {}) };

  return new Promise((resolve, reject) => {
    const fire = (socket) => {
      const mod = secure ? https : http;
      const req = mod.request(
        {
          host: u.hostname,
          port,
          path: u.pathname + u.search,
          method: opts.method || 'GET',
          headers,
          agent: false,
          ...(socket ? { createConnection: () => socket } : {})
        },
        resolve
      );
      req.on('error', reject);
      req.setTimeout(opts.timeout || DEFAULT_TIMEOUT, () => req.destroy(new Error('连接超时')));
      req.end();
    };

    if (!opts.proxy) return fire(null);
    openSocket({ host: u.hostname, port }, secure ? 'https' : 'http', opts.proxy, u.hostname).then(fire, reject);
  });
}

function collect(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
  });
}

async function fetchJSON(url, opts = {}) {
  const res = await openRequest(url, opts);
  const body = await collect(res);
  if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
  return JSON.parse(body.toString('utf8'));
}

async function download(url, file, opts = {}) {
  const res = await openRequest(url, { ...opts, timeout: opts.timeout || 120000 });
  if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
  const total = Number(res.headers['content-length']) || 0;
  const fd = fs.openSync(file, 'w');
  let received = 0;
  try {
    for await (const chunk of res) {
      fs.writeSync(fd, chunk);
      received += chunk.length;
      if (opts.onProgress) opts.onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0 });
    }
  } finally {
    fs.closeSync(fd);
  }
  return { file, bytes: received };
}

/** 5xx 和网络错误重试，GitHub 的 CDN 偶尔 504。 */
async function retry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const status = Number((String(e.message).match(/HTTP (\d+)/) || [])[1]);
      if (status && status < 500) throw e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}

module.exports = { openRequest, fetchJSON, download, retry };
