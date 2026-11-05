'use strict';
// 局域网访问：把同一套界面和接口用 HTTP 暴露出去，别的电脑打开就是同一个客户端。
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

let server = null;
let port = 0;

const BRIDGE = `(function(){
  const j = (u, opt) => fetch(u, Object.assign({headers:{'content-type':'application/json'}}, opt)).then(r => r.json());

  window.api = {
    info: () => j('/api/info'),
    send: (p) => j('/api/send', {method:'POST', body: JSON.stringify(p)}),
    capture: (p) => j('/api/capture', {method:'POST', body: JSON.stringify(p)}),
    settings: {
      get: () => j('/api/settings'),
      set: (s) => j('/api/settings', {method:'POST', body: JSON.stringify(s)}),
      export: () => Promise.resolve({ok:false, error:'远程模式请在本机导出'}),
      import: () => Promise.resolve({ok:false, error:'远程模式请在本机导入'})
    },
    templates: {
      list: () => j('/api/templates'),
      upsert: (t) => j('/api/templates', {method:'POST', body: JSON.stringify(t)}),
      remove: (id) => j('/api/templates/' + encodeURIComponent(id), {method:'DELETE'}),
      reset: () => j('/api/templates/reset', {method:'POST', body:'{}'}),
      check: (body) => j('/api/templates/check', {method:'POST', body: JSON.stringify({ body })})
    },
    models: (p) => j('/api/models', {method:'POST', body: JSON.stringify(p)}),
    chatMessages: (p) => j('/api/report/chat', {method:'POST', body: JSON.stringify(p)}),
    chat(payload) {
      fetch('/api/chat', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({provider: payload.provider, messages: payload.messages})})
        .then(async (res) => {
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split('\\n');
            buf = parts.pop();
            for (const line of parts) {
              if (!line.startsWith('data:')) continue;
              let ev; try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
              if (ev.delta) payload.onDelta && payload.onDelta(ev.delta);
              if (ev.done) payload.onDone && payload.onDone(ev.text || '');
              if (ev.error) payload.onError && payload.onError(ev.error);
            }
          }
        })
        .catch((e) => payload.onError && payload.onError(e.message));
    },
    clipboard: (t) => navigator.clipboard.writeText(t).then(() => true).catch(() => false),
    saveReport: (p) => j('/api/report/save', {method:'POST', body: JSON.stringify(p)}),
    imageUrl: (p) => '/api/shot?path=' + encodeURIComponent(p),
    perm: {
      screen: () => Promise.resolve({ status: 'granted', platform: 'remote' }),
      request: () => Promise.resolve({ status: 'granted', platform: 'remote' }),
      open: () => Promise.resolve({ ok: false, error: '远程模式请在本机授权' })
    },
    browser: {
      status: () => j('/api/browser/status'),
      go: (url) => j('/api/browser/go', {method:'POST', body: JSON.stringify({url})}),
      shot: () => j('/api/browser/shot', {method:'POST', body:'{}'}),
      screen: () => j('/api/browser/screen', {method:'POST', body:'{}'}),
      close: () => j('/api/browser/close', {method:'POST', body:'{}'}),
      onDialog(){ return function(){}; }
    },
    update: {
      check: () => j('/api/update/check'),
      download: () => Promise.resolve({ok:false, error:'远程模式不支持安装'}),
      install: () => Promise.resolve({ok:false, error:'远程模式不支持安装'}),
      relaunch: () => {}
    },
    showItem: () => {}, openExternal: (u) => window.open(u, '_blank'), openPath: () => {}, saveText: () => {}
  };
})();`;

function send(res, code, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  res.writeHead(code, { 'content-type': type || 'application/json; charset=utf-8', 'content-length': buf.length });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function staticFile(res, root, rel) {
  const file = path.join(root, rel);
  if (!file.startsWith(root)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

function start(opts) {
  if (server) return Promise.resolve({ port, url: urlFor(port) });

  const root = path.join(__dirname, '..', 'renderer');
  const shotsDir = () => {
    const dir = path.join(require('electron').app.getPath('userData'), 'shots');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const httpc = require('./http');
  const store = require('./store');
  const templates = require('./templates');
  const report = require('./report');
  const llm = require('./llm');
  const shot = require('./shot');
  const browser = require('./browser');
  const updater = require('./updater');

  server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    try {
      if (req.method === 'GET' && p === '/bridge.js') return send(res, 200, BRIDGE, MIME['.js']);

      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
          .replace('<script src="app.js"></script>', '<script src="bridge.js"></script>\n<script src="app.js"></script>');
        return send(res, 200, html, MIME['.html']);
      }

      if (req.method === 'GET' && p === '/api/info') {
        const { app } = require('electron');
        return send(res, 200, JSON.stringify({ version: app.getVersion(), platform: process.platform }));
      }
      if (req.method === 'GET' && p === '/api/settings') return send(res, 200, JSON.stringify(store.load()));
      if (req.method === 'POST' && p === '/api/settings') {
        const b = await readBody(req);
        return send(res, 200, JSON.stringify(store.save(b)));
      }

      if (req.method === 'POST' && p === '/api/templates/check') {
        const b = await readBody(req);
        return send(res, 200, JSON.stringify(templates.checkVars(b.body)));
      }
      if (req.method === 'GET' && p === '/api/templates') return send(res, 200, JSON.stringify(templates.list()));
      if (req.method === 'POST' && p === '/api/templates') {
        return send(res, 200, JSON.stringify(templates.upsert(await readBody(req))));
      }
      if (req.method === 'POST' && p === '/api/templates/reset') {
        return send(res, 200, JSON.stringify(templates.reset()));
      }
      if (req.method === 'DELETE' && p.startsWith('/api/templates/')) {
        const id = decodeURIComponent(p.split('/').pop());
        return send(res, 200, JSON.stringify(templates.remove(id)));
      }

      if (req.method === 'POST' && p === '/api/send') {
        const b = await readBody(req);
        try {
          const r = await httpc.send(b.raw, { scheme: b.scheme, protocol: b.protocol, timeout: b.timeout });
          return send(res, 200, JSON.stringify({ ok: true, status: r.status, ms: r.ms, text: r.text, protocol: r.protocol || 'h1' }));
        } catch (e) {
          return send(res, 200, JSON.stringify({ ok: false, error: e.message, text: 'HTTP/1.1 0 CONNECTION_ERROR\r\n\r\n' + e.message }));
        }
      }

      if (req.method === 'POST' && p === '/api/capture') {
        const b = await readBody(req);
        const name = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '.png';
        const out = path.join(shotsDir(), name);
        const r = await shot.capture({ request: b.request, response: b.response, width: b.width || 1600, out });
        return send(res, 200, JSON.stringify({ path: r.path, url: '/api/shot?path=' + encodeURIComponent(r.path) }));
      }

      if (req.method === 'GET' && p === '/api/shot') {
        const file = u.searchParams.get('path') || '';
        const dir = shotsDir();
        if (!file.startsWith(dir)) return send(res, 403, 'forbidden', 'text/plain');
        return staticFile(res, dir, path.relative(dir, file));
      }

      if (req.method === 'POST' && p === '/api/models') {
        const b = await readBody(req);
        try { return send(res, 200, JSON.stringify({ ok: true, models: await llm.listModels(b) })); }
        catch (e) { return send(res, 200, JSON.stringify({ ok: false, error: e.message })); }
      }

      if (req.method === 'POST' && p === '/api/report/chat') {
        return send(res, 200, JSON.stringify(report.buildChatMessages(await readBody(req))));
      }

      if (req.method === 'POST' && p === '/api/chat') {
        const b = await readBody(req);
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        });
        try {
          const text = await llm.chat({
            provider: b.provider,
            messages: b.messages,
            onDelta: (d) => res.write('data: ' + JSON.stringify({ delta: d }) + '\n\n')
          });
          res.write('data: ' + JSON.stringify({ done: true, text }) + '\n\n');
        } catch (e) {
          res.write('data: ' + JSON.stringify({ error: e.message }) + '\n\n');
        }
        return res.end();
      }

      if (req.method === 'POST' && p === '/api/report/save') {
        return send(res, 200, JSON.stringify(report.save(await readBody(req))));
      }

      if (req.method === 'GET' && p === '/api/update/check') {
        try {
          const { app } = require('electron');
          return send(res, 200, JSON.stringify({ ok: true, ...(await updater.check(app.getVersion())) }));
        } catch (e) {
          return send(res, 200, JSON.stringify({ ok: false, error: e.message }));
        }
      }

      if (p.startsWith('/api/browser/')) {
        const action = p.split('/').pop();
        if (action === 'status') return send(res, 200, JSON.stringify(browser.status()));
        if (action === 'go') {
          const b = await readBody(req);
          try { await browser.ensure(); return send(res, 200, JSON.stringify({ ok: true, ...(await browser.navigate(b.url)) })); }
          catch (e) { return send(res, 200, JSON.stringify({ ok: false, error: e.message })); }
        }
        if (action === 'shot') {
          try {
            const buf = await browser.screenshotPage();
            const name = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-page.png';
            const file = path.join(shotsDir(), name);
            fs.writeFileSync(file, buf);
            return send(res, 200, JSON.stringify({ ok: true, path: file }));
          } catch (e) { return send(res, 200, JSON.stringify({ ok: false, error: e.message })); }
        }
        if (action === 'screen') {
          try {
            const r = await shot.captureScreen(path.join(shotsDir(), new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14) + '-screen.png'));
            return send(res, 200, JSON.stringify({ ok: true, path: r.path }));
          } catch (e) { return send(res, 200, JSON.stringify({ ok: false, error: e.message })); }
        }
        if (action === 'close') { browser.shutdown(); return send(res, 200, JSON.stringify({ ok: true })); }
      }

      if (req.method === 'GET') return staticFile(res, root, p.slice(1));
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 500, { error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    const wanted = opts && opts.port ? opts.port : 8765;
    const tryListen = (p) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && p < wanted + 10) return tryListen(p + 1);
        reject(err);
      });
      server.listen(p, '0.0.0.0', () => {
        port = p;
        resolve({ port, url: urlFor(port) });
      });
    };
    tryListen(wanted);
  });
}

function urlFor(p) {
  const nets = os.networkInterfaces();
  let ip = '127.0.0.1';
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) { ip = n.address; break; }
    }
    if (ip !== '127.0.0.1') break;
  }
  return `http://${ip}:${p}`;
}

function stop() {
  if (server) { server.close(); server = null; }
}

module.exports = { start, stop, urlFor };
