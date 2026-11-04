'use strict';
// 无界面冒烟测试：用 stub 顶掉 electron，跑通各模块。
const Module = require('module');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.REFRACT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-data-'));

const handlers = new Map();
const stub = {
  app: {
    getPath: (k) => (k === 'userData' ? process.env.REFRACT_DATA_DIR : os.tmpdir()),
    getVersion: () => '0.1.0',
    getName: () => 'Refract',
    whenReady: () => Promise.resolve(),
    on: () => {},
    quit: () => {},
    relaunch: () => {},
    exit: () => {}
  },
  BrowserWindow: class {
    constructor() { this.webContents = { on: () => {}, send: () => {}, executeJavaScript: () => Promise.resolve(0), setWindowOpenHandler: () => {} }; }
    once() {} on() {} getBounds() { return { width: 1180, height: 780 }; }
    getNormalBounds() { return { width: 1180, height: 780 }; }
    loadFile() { return Promise.resolve(); } show() {} isDestroyed() { return false; } destroy() {}
  },
  ipcMain: {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => handlers.set(ch, fn)
  },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  shell: { openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {} },
  dialog: { showSaveDialog: () => Promise.resolve({ canceled: true }) }
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return stub;
  return origLoad.apply(this, arguments);
};

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra || ''); }
}

(async () => {
  console.log('\n[模块]');
  const httpc = require('../electron/http.js');
  const store = require('../electron/store.js');
  const templates = require('../electron/templates.js');
  const report = require('../electron/report.js');
  const llm = require('../electron/llm.js');
  const updater = require('../electron/updater.js');

  ok('http.send 导出', typeof httpc.send === 'function');
  ok('settings 默认值', store.load().providers.length >= 1);
  ok('settings 含统计', typeof store.load().stats === 'object');
  ok('模板内置 5 套', templates.list().length === 5);
  ok('模板占位符替换', report.fillTemplate('# {{title}}', { title: 'T' }) === '# T');
  ok('报告 prompt 有标题约束', report.SYSTEM_PROMPT.includes('固定句式'));
  ok('报告 prompt 禁 AI 腔', report.SYSTEM_PROMPT.includes('值得注意的是'));
  const chatMsgs = report.buildChatMessages({ material: 'GET / HTTP/1.1', template: '# {{title}}', meta: { product: 'X' }, question: '写报告' });
  ok('对话 prompt 含写作约束', chatMsgs[0].content.includes('固定句式') && chatMsgs[0].content.includes('简洁直接'));
  ok('对话 prompt 带材料', chatMsgs[1].content.includes('GET / HTTP/1.1'));
  ok('LLM joinURL', llm.joinURL('https://x/v1/', '/chat') === 'https://x/v1/chat');
  ok('版本比较', updater.cmp('0.1.0', '0.1.1') === -1 && updater.cmp('1.0.0', '0.9.9') === 1);

  console.log('\n[HTTP]');
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url, body }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const g = await httpc.send(`GET /a HTTP/1.1\nHost: 127.0.0.1:${port}\n\n`, { scheme: 'http' });
  ok('GET 200', g.status === 200);
  const p = await httpc.send(`POST /b HTTP/1.1\nHost: 127.0.0.1:${port}\nContent-Type: application/json\n\n{"x":1}`, { scheme: 'http' });
  ok('POST 带回 body', p.text.includes('"body":"{\\"x\\":1}"'));

  const missing = await httpc.send('GET / HTTP/1.1\n\n', { scheme: 'http' }).catch((e) => e.message);
  ok('缺 Host 抛错', String(missing).includes('Host'));
  srv.close();

  console.log('\n[HTTP/2]');
  const http2 = require('http2');
  const s2 = http2.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ proto: req.httpVersion, url: req.url }));
  });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const p2 = s2.address().port;
  const h2 = await httpc.send(`GET /p2 HTTP/1.1\nHost: 127.0.0.1:${p2}\n\n`, { scheme: 'http', protocol: 'h2' });
  ok('h2 请求成功', h2.status === 200 && h2.protocol === 'h2');
  ok('h2 状态行', h2.text.startsWith('HTTP/2 200'));
  ok('h2 body 透传', h2.text.includes('"proto":"2.0"'));
  s2.close();

  console.log('\n[报告保存]');
  const saved = report.save({ markdown: '# t', images: [], title: 'demo', baseDir: path.join(process.env.REFRACT_DATA_DIR, 'reports') });
  ok('生成 report.md', fs.existsSync(saved.md));

  console.log('\n[主进程]');
  require('../electron/main.js');
  await new Promise((r) => setTimeout(r, 50));
  ok('注册了 IPC', handlers.size >= 10, `实际 ${handlers.size}`);
  for (const ch of ['http:send', 'shot:capture', 'settings:get', 'templates:list', 'llm:chat', 'report:save', 'update:check']) {
    ok(`IPC ${ch}`, handlers.has(ch));
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃：', e);
  process.exit(1);
});
