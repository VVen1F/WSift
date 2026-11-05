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
  const longMsgs = [
    { role: 'system', content: 'S'.repeat(100) },
    { role: 'user', content: 'a'.repeat(4000) },
    { role: 'assistant', content: 'b'.repeat(4000) },
    { role: 'user', content: 'last' }
  ];
  ok('上下文裁剪保留 system', llm.trimMessages(longMsgs, 1)[0].role === 'system');
  ok('上下文裁剪会丢掉最早的消息', llm.trimMessages(longMsgs, 1).length < longMsgs.length);
  ok('不限上下文时原样返回', llm.trimMessages(longMsgs, 0).length === longMsgs.length);
  ok('会话 id 固定', typeof llm.SESSION_ID === 'string' && llm.SESSION_ID.startsWith('refract-'));

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

  console.log('\n[备份]');
  const backup = require('../electron/backup.js');
  const bkCfg = store.load();
  bkCfg.backup.keep = 2;
  for (let i = 0; i < 4; i++) backup.snapshot(bkCfg, false);
  const bkList = backup.list(bkCfg);
  ok('保留份数生效', bkList.length === 2, `实际 ${bkList.length}`);
  const bkJson = JSON.parse(fs.readFileSync(bkList[0].path, 'utf8'));
  ok('默认不含 Key', bkJson.providers.every((p) => (p.accounts || []).every((a) => !a.apiKey)));
  ok('能读回来', Array.isArray(backup.restore(bkList[0].path).providers));
  ok('到期判断', backup.due({ backup: { auto: '1h', lastAt: new Date().toISOString() } }) === false);

  console.log('\n[云端同步]');
  const sync = require('../electron/sync.js');
  const files = {};
  const dav = http.createServer((reqq, ress) => {
    if (reqq.method === 'PUT') {
      let b = '';
      reqq.on('data', (c) => (b += c));
      reqq.on('end', () => { files[reqq.url] = b; ress.writeHead(201); ress.end(); });
      return;
    }
    if (reqq.method === 'GET') {
      if (!files[reqq.url]) { ress.writeHead(404); return ress.end(); }
      ress.writeHead(200);
      return ress.end(files[reqq.url]);
    }
    if (reqq.method === 'HEAD') { ress.writeHead(files[reqq.url] ? 200 : 404); return ress.end(); }
    ress.writeHead(405); ress.end();
  });
  await new Promise((r) => dav.listen(0, '127.0.0.1', r));
  const davPort = dav.address().port;
  const syncCfg = {
    sync: { kind: 'webdav', webdav: { url: `http://127.0.0.1:${davPort}/dav`, user: 'u', pass: 'p', path: 's.json' }, github: {} },
    backup: { withKeys: false },
    providers: [{ id: 'g', accounts: [{ id: 'a', apiKey: 'SECRETKEY' }], models: ['m'], activeModel: 'm' }],
    ui: {}
  };
  const up = await sync.push(syncCfg);
  ok('WebDAV 上传成功', up.ok === true);
  const stored = files['/dav/s.json'] || '';
  ok('上传内容不含 Key', stored.length > 0 && !stored.includes('SECRETKEY'));
  ok('上传内容不含同步凭据', !stored.includes('"sync"'));
  const down = await sync.pull(syncCfg);
  ok('WebDAV 下载成功', down.providers.length === 1);
  const t = await sync.test(syncCfg);
  ok('WebDAV 连通性', t.ok === true && /成功/.test(t.message));
  dav.close();

  console.log('\n[旧配置迁移]');
  const oldProv = { id: 'x', name: 'X', kind: 'openai', baseURL: 'u', apiKey: 'k1', model: 'm1' };
  const mig = store.migrateProvider(oldProv);
  ok('apiKey 变成账号', mig.accounts.length === 1 && mig.accounts[0].apiKey === 'k1');
  ok('model 变成模型列表', mig.models[0] === 'm1' && mig.activeModel === 'm1');

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
