'use strict';
// 内置浏览器控制：拉起 Chrome 的调试端口，用 CDP 导航、执行脚本、截图。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const CANDIDATES = [
  process.env.CHROME || '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
];

function chromePath() {
  for (const p of CANDIDATES) if (p && fs.existsSync(p)) return p;
  return null;
}

let proc = null;
let port = 9222;
let cdp = null;
let pageTarget = null;
let dialogCb = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function waitPort(p, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      return await getJSON(`http://127.0.0.1:${p}/json/version`);
    } catch (e) {
      await sleep(220);
    }
  }
  throw new Error('浏览器调试端口没有起来');
}

class CDP {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }

  open() {
    const WS = globalThis.WebSocket;
    if (!WS) return Promise.reject(new Error('当前运行时没有 WebSocket'));
    return new Promise((resolve, reject) => {
      const ws = new WS(this.url);
      this.ws = ws;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (e) => reject(Object.assign(new Error('调试连接失败'), { cause: e })));
      ws.addEventListener('message', (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch (e) { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: ok, reject: bad } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? bad(new Error(msg.error.message)) : ok(msg.result);
          return;
        }
        if (msg.method) {
          const list = this.handlers.get(msg.method) || [];
          list.forEach((fn) => fn(msg.params));
        }
      });
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(method + ' 超时'));
        }
      }, 15000);
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }

  close() {
    try { this.ws.close(); } catch (e) { /* ignore */ }
  }
}

async function ensure(p = 9222) {
  if (cdp && pageTarget) return { port };
  port = p;
  const bin = chromePath();
  if (!bin) throw new Error('没找到 Chrome，可设置 CHROME 环境变量');

  try {
    await getJSON(`http://127.0.0.1:${port}/json/version`);
  } catch (e) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-chrome-'));
    proc = spawn(bin, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--window-size=1280,860',
      'about:blank'
    ], { detached: true, stdio: 'ignore' });
    proc.unref();
    await waitPort(port);
    await sleep(300);
  }

  const list = await getJSON(`http://127.0.0.1:${port}/json/list`);
  pageTarget = (list || []).find((t) => t.type === 'page');
  if (!pageTarget) {
    await getJSON(`http://127.0.0.1:${port}/json/new?about:blank`);
    const again = await getJSON(`http://127.0.0.1:${port}/json/list`);
    pageTarget = (again || []).find((t) => t.type === 'page');
  }
  if (!pageTarget) throw new Error('没有可用的页面');

  cdp = new CDP(pageTarget.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on('Page.javascriptDialogOpening', (p) => { if (dialogCb) dialogCb(p); });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  return { port };
}

async function navigate(url) {
  await ensure();
  await cdp.send('Page.navigate', { url });
  await sleep(600);
  const st = await cdp.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
  return { url, ready: st.result && st.result.value };
}

async function evaluate(expression) {
  await ensure();
  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true
  });
  return r.result ? r.result.value : null;
}

/** 页面截图（不含浏览器外壳，也没有 alert 弹窗）。 */
async function screenshotPage() {
  await ensure();
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  return Buffer.from(r.data, 'base64');
}

/** 当前页面里是否有阻塞的弹窗；有就返回提示文本。 */
async function dismissDialog(accept = true) {
  try {
    await cdp.send('Page.handleJavaScriptDialog', { accept });
    return true;
  } catch (e) {
    return false;
  }
}

function onDialog(fn) {
  dialogCb = fn;
}

function status() {
  return {
    running: !!cdp,
    chrome: chromePath(),
    port,
    target: pageTarget ? pageTarget.url : null
  };
}

function shutdown() {
  try { cdp && cdp.close(); } catch (e) { /* ignore */ }
  cdp = null;
  pageTarget = null;
}

module.exports = {
  ensure, navigate, evaluate, screenshotPage, dismissDialog,
  onDialog, status, shutdown, chromePath
};
