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
  const glm = store.DEFAULTS.providers.find((p) => p.id === 'glm');
  const brand = /智谱|智普|zhipu/i;
  ok('内置 GLM 预设', !!(glm && glm.kind === 'anthropic' && glm.activeModel === 'glm-4.6' && glm.baseURL === 'https://open.bigmodel.cn/api/anthropic' && !(glm.accounts || []).some((a) => a.apiKey)));
  ok('预设名称不含厂商品牌', !!(glm && glm.name && !brand.test(glm.name)));
  ok('预设数据不含厂商品牌', !brand.test(JSON.stringify(store.DEFAULTS)));
  const surfaced = ['README.md', 'renderer/index.html', 'renderer/app.js', 'renderer/style.css', 'electron/llm.js']
    .map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8'))
    .join('\n');
  ok('界面与说明不含智谱品牌', !brand.test(surfaced));
  ok('新建表单预填 GLM', surfaced.includes(glm.baseURL) && surfaced.includes('例如：OpenAI 生产') && surfaced.includes("model: 'glm-4.6'"));
  const renamed = store.migrateProvider({ id: 'glm', name: '智谱 GLM', kind: 'anthropic', baseURL: glm.baseURL, apiKey: '', model: 'glm-4.6' });
  ok('旧默认名会改成 GLM', renamed.name === 'GLM' && renamed.baseURL === glm.baseURL);
  const kept = store.migrateProvider({ id: 'other', name: '我的线路', kind: 'anthropic', baseURL: 'https://example.test', apiKey: '', model: 'm' });
  ok('自定义名称保留', kept.name === '我的线路');
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
  const reportRoot = path.join(process.env.REFRACT_DATA_DIR, 'reports');
  const shotFile = path.join(process.env.REFRACT_DATA_DIR, 'one.png');
  fs.writeFileSync(shotFile, Buffer.from('png-bytes'));
  const saved = report.save({ markdown: '# t\n', images: [shotFile], title: '演示', baseDir: reportRoot });
  ok('生成 report.md', fs.existsSync(saved.md));
  ok('生成 zip', saved.zip && fs.existsSync(saved.zip));
  const zip = require('../electron/zip.js');
  const zbuf = fs.readFileSync(saved.zip);
  const names = zip.list(zbuf).map((e) => e.name);
  ok('zip 含标题/report.md', names.indexOf('演示/report.md') >= 0, names.join(','));
  ok('zip 含 images/01.png', names.indexOf('演示/images/01.png') >= 0, names.join(','));
  const mdInZip = zip.read(zbuf, '演示/report.md').toString('utf8');
  ok('md 相对路径对得上', mdInZip.includes('](images/01.png)') && !mdInZip.includes(shotFile));
  ok('文件夹里的图和 md 一致', fs.existsSync(path.join(saved.dir, 'images', '01.png')));

  console.log('\n[模板占位符]');
  ok('内置占位符通过', templates.checkVars(templates.BUILTIN[0].body).ok === true);
  ok('未知占位符', templates.checkVars('{{nope}}').unknown[0] === 'nope');
  ok('未闭合', templates.checkVars('{{title').unclosed === true);

  console.log('\n[安装包选择]');
  const assets = [
    { name: 'Refract-0.6.0-arm64.dmg' },
    { name: 'Refract-0.6.0.dmg' },
    { name: 'Refract-Setup-0.6.0.exe' },
    { name: 'Refract-0.6.0.AppImage' }
  ];
  ok('mac 选 dmg', /arm64\.dmg$/.test(updater.pickAsset(assets, 'darwin', 'arm64').name));
  ok('windows 选 exe', /\.exe$/.test(updater.pickAsset(assets, 'win32', 'x64').name));

  console.log('\n[截图尺寸]');
  const shot = require('../electron/shot.js');
  ok('高 DPI 用物理像素', shot.thumbnailSizeFor({ size: { width: 1920, height: 1080 }, scaleFactor: 1.5 }).width === 2880);
  ok('超大屏钳制', shot.thumbnailSizeFor({ size: { width: 5000, height: 2000 }, scaleFactor: 2 }).width === 4096);
  const blackBmp = Buffer.alloc(16, 0);
  ok('全黑判定', shot.looksBlack({
    isEmpty: () => false,
    resize: () => ({ getSize: () => ({ width: 2, height: 2 }), toBitmap: () => blackBmp })
  }) === true);
  const lit = Buffer.from([0, 0, 0, 255, 200, 200, 200, 255, 180, 180, 180, 255, 20, 20, 20, 255]);
  ok('有内容不算黑', shot.looksBlack({
    isEmpty: () => false,
    resize: () => ({ getSize: () => ({ width: 2, height: 2 }), toBitmap: () => lit })
  }) === false);

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
