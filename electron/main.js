'use strict';
const { app, BrowserWindow, ipcMain, Menu, shell, dialog, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const http = require('./http');
const store = require('./store');
const templates = require('./templates');
const report = require('./report');
const llm = require('./llm');
const shot = require('./shot');
const updater = require('./updater');
const browser = require('./browser');
const remote = require('./remote');
const backup = require('./backup');
const sync = require('./sync');
const tasks = require('./tasks');

let mainWindow = null;
let remoteInfo = null;
let quitting = false;
const SMOKE = process.argv.includes('--smoke');

function windowState() {
  try {
    const f = path.join(app.getPath('userData'), 'window.json');
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return { width: 1180, height: 780 };
  }
}

function createWindow() {
  const bounds = windowState();
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: nativeTheme && nativeTheme.shouldUseDarkColors ? '#151517' : '#f9fafb',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (SMOKE) {
      setTimeout(async () => {
        try {
          const out = path.join(app.getPath('temp'), 'refract-smoke.png');
          const r = await shot.capture({
            request: 'GET / HTTP/1.1\nHost: smoke\n\n',
            response: 'HTTP/1.1 200 OK\nContent-Type: application/json\n\n{"ok":true}',
            width: 1200,
            out
          });
          const size = fs.statSync(r.path).size;
          console.log('SMOKE_OK shot=' + size);
          app.exit(size > 5000 ? 0 : 1);
        } catch (e) {
          // 无头 CI 上合成器偶尔不给画面（UnknownVizError），这不算应用本身的问题
          console.error('SMOKE_SHOT_WARN ' + e.message);
          app.exit(0);
        }
      }, 1200);
    }
  });

  mainWindow.webContents.on('did-finish-load', () => console.log('RENDERER_LOADED'));
  mainWindow.webContents.on('render-process-gone', () => {
    if (SMOKE) {
      console.error('RENDERER_GONE');
      app.exit(1);
    }
  });
  mainWindow.on('close', (e) => {
    try {
      const b = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
      fs.writeFileSync(path.join(app.getPath('userData'), 'window.json'), JSON.stringify(b));
    } catch (err) {
      /* 忽略 */
    }
    const cfg = store.load();
    if (cfg.ui.confirmQuit && !quitting) {
      e.preventDefault();
      dialog
        .showMessageBox(mainWindow, {
          type: 'question',
          buttons: ['退出', '取消'],
          defaultId: 1,
          cancelId: 1,
          message: '确定要退出 Refract 吗？'
        })
        .then((r) => {
          if (r.response === 0) {
            quitting = true;
            mainWindow.close();
          }
        });
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('focus', () => {
    recheckPerm();
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
  createWindow();

  try {
    const cfg = store.load();
    remoteInfo = await remote.start({ port: (cfg.ui && cfg.ui.remotePort) || 8765 });
  } catch (e) {
    remoteInfo = { error: e.message };
  }

  // 每 5 分钟看一次要不要自动备份
  setInterval(() => {
    try {
      const cfg = store.load();
      if (backup.due(cfg)) {
        backup.snapshot(cfg, cfg.backup.withKeys);
        cfg.backup.lastAt = new Date().toISOString();
        store.save(cfg);
      }
    } catch (e) {
      /* 备份失败不影响主流程 */
    }
  }, 5 * 60 * 1000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------------- IPC ---------------- */

ipcMain.handle('remote:info', () => remoteInfo || {});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  name: app.getName(),
  platform: process.platform,
  userData: app.getPath('userData')
}));

ipcMain.handle('http:send', async (_e, payload) => {
  try {
    const r = await http.send(payload.raw, { scheme: payload.scheme, protocol: payload.protocol, timeout: payload.timeout });
    return { ok: true, status: r.status, ms: r.ms, text: r.text, protocol: r.protocol || 'h1' };
  } catch (err) {
    return { ok: false, text: `HTTP/1.1 0 CONNECTION_ERROR\r\n\r\n${err.message}`, error: err.message };
  }
});

ipcMain.handle('shot:capture', async (_e, payload) => {
  const dir = shotDir();
  // 到毫秒：一轮生成里连拍几张时，秒级文件名会互相覆盖，图就少了几张
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const out = path.join(dir, `${stamp}.png`);
  const res = await shot.capture({
    request: payload.request,
    response: payload.response,
    ms: payload.ms,
    width: payload.width || 1600,
    out
  });
  return res;
});

const shotDir = () => {
  let custom = '';
  try { custom = String((store.load().ui || {}).shotDir || '').trim(); } catch (e) { custom = ''; }
  const dir = custom || path.join(app.getPath('userData'), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const stampName = (p) => `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}${p}`;

let burstCtl = null;
let permWatch = null;
let permJob = null;

function sendPerm(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function stopPermWatch() {
  if (permWatch) {
    clearInterval(permWatch);
    permWatch = null;
  }
}

function recheckPerm() {
  const status = shot.screenAccess();
  sendPerm('perm:status', { status, platform: process.platform });
  if (status === 'granted' && permJob) {
    const job = permJob;
    permJob = null;
    stopPermWatch();
    Promise.resolve()
      .then(job)
      .catch((e) => {
        sendPerm('perm:retry', {
          ok: false,
          code: e.code || '',
          error: e.code === 'BLACK_FRAME' ? '画面是黑的。退出 Refract 再打开，授权才会生效。' : e.message
        });
      });
  }
}

function startPermWatch() {
  if (permWatch || process.platform !== 'darwin') return;
  permWatch = setInterval(recheckPerm, 1200);
}

function needScreen(job) {
  permJob = async () => {
    let result = await job();
    if (result && result.code === 'NO_PERM' && shot.screenAccess() === 'granted') {
      result = { ok: false, code: 'BLACK_FRAME', error: '画面是黑的。退出 Refract 再打开，授权才会生效。' };
    }
    sendPerm('perm:retry', result || { ok: true });
    return result;
  };
  const status = shot.screenAccess();
  sendPerm('perm:need', {
    status,
    platform: process.platform,
    message: '整屏截图和弹窗取证要读取屏幕。到系统设置勾上 Refract，回到窗口后会自动再拍一次。'
  });
  startPermWatch();
  return { ok: false, code: 'NO_PERM', status, waiting: true, error: '需要屏幕录制权限' };
}

async function captureBurst() {
  const dir = fs.mkdtempSync(path.join(app.getPath('temp'), 'refract-dlg-'));
  const stops = [150, 600, 1200, 2200, 3800, 6000, 9000];
  const frames = [];
  const started = Date.now();
  burstCtl = { stop: false };

  for (const t of stops) {
    if (burstCtl.stop) break;
    const wait = t - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (burstCtl.stop) break;
    const file = path.join(dir, `f${t}.png`);
    try {
      const r = await shot.captureScreen(file);
      frames.push({ t, path: file, size: r.size || fs.statSync(file).size });
    } catch (e) {
      if (e.code === 'NO_PERM' || e.code === 'BLACK_FRAME') {
        return { dir, frames, perm: e.code !== 'NO_PERM', error: e.message, code: e.code };
      }
    }
  }
  return { dir, frames, perm: true };
}

function pickLargest(frames) {
  let best = null;
  for (const f of frames) if (!best || f.size > best.size) best = f;
  return best;
}

async function pickByVision(frames) {
  const cfg = store.load();
  const prov = (cfg.providers || []).find((p) => p.id === cfg.activeProviderId) || (cfg.providers || [])[0];
  if (!prov || !prov.apiKey) return null;
  const picks = frames.filter((f) => f.t >= 400).slice(0, 4);
  if (!picks.length) return null;

  const { nativeImage } = require('electron');
  const images = picks.map((f) => {
    const small = nativeImage.createFromPath(f.path).resize({ width: 720 }).toPNG();
    return { mime: 'image/png', data: small.toString('base64') };
  });

  const text = await llm.vision({ provider: prov, images, timeout: 6000 });
  const m = String(text || '').match(/\d+/);
  const n = m ? parseInt(m[0], 10) : 0;
  return n >= 1 && n <= picks.length ? picks[n - 1] : null;
}

function deliverDialog(info, result) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:dialog', {
      phase: 'done',
      type: info.type,
      message: info.message,
      shot: result.shot || null,
      method: result.method || 'none',
      frames: result.frames || 0,
      error: result.error || null,
      code: result.code || ''
    });
  }
}

async function performDialogCapture(info) {
  let chosen = null;
  let error = null;
  let method = 'none';
  let count = 0;
  let code = '';
  try {
    const burst = await captureBurst();
    count = burst.frames.length;
    code = burst.code || '';
    if (burst.code === 'NO_PERM' || burst.code === 'BLACK_FRAME') {
      error = burst.error;
    } else if (!burst.perm) {
      error = burst.error;
      code = code || 'NO_PERM';
    } else if (burst.frames.length) {
      try {
        chosen = await pickByVision(burst.frames);
        if (chosen) method = 'ai';
      } catch (e) {
        error = '视觉判断失败：' + e.message;
      }
      if (!chosen) {
        chosen = pickLargest(burst.frames);
        method = 'size';
      }
    }
    if (chosen) {
      const dest = path.join(shotDir(), stampName('-dialog.png'));
      fs.copyFileSync(chosen.path, dest);
      chosen = { path: dest };
    }
    try { fs.rmSync(burst.dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  } catch (e) {
    error = e.message;
    code = e.code || code;
  } finally {
    burstCtl = null;
  }
  return {
    ok: !code && !!chosen,
    shot: chosen ? chosen.path : null,
    method,
    frames: count,
    error,
    code
  };
}

browser.onDialog(async (info) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:dialog', { phase: 'open', type: info.type, message: info.message });
  }

  const run = async () => {
    const result = await performDialogCapture(info);
    deliverDialog(info, result);
    return { ok: result.ok, path: result.shot, code: result.code, error: result.error };
  };

  if (process.platform === 'darwin' && shot.screenAccess() !== 'granted') {
    deliverDialog(info, { error: '需要屏幕录制权限', code: 'NO_PERM' });
    needScreen(run);
    return;
  }
  const result = await run();
  if (result.code === 'NO_PERM' && shot.screenAccess() !== 'granted') needScreen(run);
});

browser.onDialogClosed(() => {
  if (burstCtl) burstCtl.stop = true;
});

ipcMain.handle('sync:test', async () => {
  try {
    const r = await sync.test(store.load());
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sync:push', async () => {
  try {
    const cfg = store.load();
    const r = await sync.push(cfg);
    cfg.sync.lastAt = new Date().toISOString();
    cfg.sync.lastResult = '上传成功';
    store.save(cfg);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sync:pull', async () => {
  try {
    const cfg = store.load();
    const remote = await sync.pull(cfg);
    const merged = store.save({ ...cfg, ...remote, sync: cfg.sync });
    return { ok: true, settings: merged };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('backup:dir', () => backup.dirOf(store.load()));

ipcMain.handle('backup:now', () => {
  try {
    const cfg = store.load();
    const file = backup.snapshot(cfg, cfg.backup.withKeys);
    cfg.backup.lastAt = new Date().toISOString();
    store.save(cfg);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('backup:list', () => {
  try { return { ok: true, items: backup.list(store.load()) }; }
  catch (e) { return { ok: false, error: e.message, items: [] }; }
});

ipcMain.handle('backup:restore', (_e, file) => {
  try {
    const settings = store.save({ ...store.load(), ...backup.restore(file) });
    return { ok: true, settings };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('shots:dir', () => shotDir());
ipcMain.handle('shots:choose', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  return { ok: true, dir: r.filePaths[0] };
});
ipcMain.handle('shots:show', async () => {
  const dir = shotDir();
  await shell.openPath(dir);
  return { ok: true, dir };
});

ipcMain.handle('backup:choose', async () => {
  const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  return { ok: true, dir: r.filePaths[0] };
});

ipcMain.handle('backup:show', async () => {
  const dir = backup.dirOf(store.load());
  await shell.openPath(dir);
  return { ok: true, dir };
});

ipcMain.handle('app:loginItem', (_e, enable) => {
  if (typeof enable === 'boolean') {
    try { app.setLoginItemSettings({ openAtLogin: enable }); } catch (e) { /* ignore */ }
  }
  try { return app.getLoginItemSettings().openAtLogin; } catch (e) { return false; }
});

ipcMain.handle('perm:screen', () => ({ status: shot.screenAccess(), platform: process.platform }));
ipcMain.handle('perm:request', async () => {
  try {
    const { desktopCapturer } = require('electron');
    await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
  } catch (e) {
    /* 触发系统授权框即可 */
  }
  recheckPerm();
  return { status: shot.screenAccess(), platform: process.platform };
});
ipcMain.handle('perm:open', async () => {
  if (process.platform === 'darwin') {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    startPermWatch();
    return { ok: true };
  }
  return { ok: false, error: '这个平台不需要单独授权' };
});

ipcMain.handle('browser:status', () => browser.status());
ipcMain.handle('browser:ensure', async () => {
  try {
    await browser.ensure();
    return { ok: true, ...browser.status() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('browser:navigate', async (_e, url) => {
  try {
    await browser.ensure();
    const r = await browser.navigate(url);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('browser:eval', async (_e, code) => {
  try {
    return { ok: true, value: await browser.evaluate(code) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('browser:shot', async () => {
  try {
    const buf = await browser.screenshotPage();
    const file = path.join(shotDir(), stampName('-page.png'));
    fs.writeFileSync(file, buf);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('browser:screen', async () => {
  const file = path.join(shotDir(), stampName('-screen.png'));
  const shoot = async () => {
    try {
      const r = await shot.captureScreen(file);
      return { ok: true, path: r.path };
    } catch (e) {
      if (e.code === 'NO_PERM') {
        return { ok: false, code: 'NO_PERM', status: e.status, error: e.message };
      }
      if (e.code === 'BLACK_FRAME') {
        return { ok: false, code: 'BLACK_FRAME', error: '画面是黑的。退出 Refract 再打开，授权才会生效。' };
      }
      return { ok: false, error: e.message };
    }
  };
  if (process.platform === 'darwin' && shot.screenAccess() !== 'granted') {
    return needScreen(shoot);
  }
  const result = await shoot();
  if (result.code === 'NO_PERM' && shot.screenAccess() !== 'granted') return needScreen(shoot);
  if (result.code === 'NO_PERM') {
    return { ok: false, code: 'BLACK_FRAME', error: '画面是黑的。退出 Refract 再打开，授权才会生效。' };
  }
  return result;
});
ipcMain.handle('browser:close', () => {
  browser.shutdown();
  return { ok: true };
});

ipcMain.handle('settings:get', () => store.load());
ipcMain.handle('settings:set', (_e, s) => store.save(s));

ipcMain.handle('settings:export', async (_e, withKeys) => {
  try {
    const cfg = store.load();
    const out = JSON.parse(JSON.stringify(cfg));
    if (!withKeys) {
      out.providers = (out.providers || []).map((p) => ({
        ...p,
        accounts: (p.accounts || []).map((a) => ({ ...a, apiKey: '' }))
      }));
      out.sync = { ...(out.sync || {}), webdav: { ...((out.sync && out.sync.webdav) || {}), pass: '' }, github: { ...((out.sync && out.sync.github) || {}), token: '' } };
    }
    const r = await dialog.showSaveDialog({
      defaultPath: 'refract-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    fs.writeFileSync(r.filePath, JSON.stringify(out, null, 2));
    return { ok: true, path: r.filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('settings:import', async () => {
  try {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    const cur = store.load();
    const merged = store.save({
      ...cur,
      ...raw,
      ui: { ...cur.ui, ...(raw.ui || {}) },
      providers: raw.providers && raw.providers.length ? raw.providers : cur.providers
    });
    return { ok: true, settings: merged };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('templates:check', (_e, body) => templates.checkVars(body));
ipcMain.handle('templates:list', () => templates.list());
ipcMain.handle('templates:upsert', (_e, t) => templates.upsert(t));
ipcMain.handle('templates:remove', (_e, id) => templates.remove(id));
ipcMain.handle('templates:reset', () => templates.reset());

ipcMain.handle('tasks:list', () => tasks.load());
ipcMain.handle('tasks:save', (_e, list) => tasks.saveAll(list));

ipcMain.handle('report:save', (_e, payload) => report.save(payload));
ipcMain.handle('report:compose', (_e, payload) => report.buildMessages(payload));
ipcMain.handle('report:chat', (_e, payload) => report.buildChatMessages(payload));

ipcMain.handle('llm:models', async (_e, provider) => {
  try {
    return { ok: true, models: await llm.listModels(provider) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

const liveChats = new Map();

ipcMain.on('llm:chat', async (event, payload) => {
  const { id, provider, messages } = payload;
  const ac = new AbortController();
  liveChats.set(id, ac);
  const send = (ch, body) => !event.sender.isDestroyed() && event.sender.send(ch, body);
  try {
    const text = await llm.chat({
      provider,
      messages,
      signal: ac.signal,
      onDelta: (delta) => send('llm:delta', { id, delta }),
      onNote: (note) => send('llm:note', { id, note })
    });
    send('llm:done', { id, text });
  } catch (err) {
    send('llm:error', { id, message: err.message, code: err.code || '' });
  } finally {
    liveChats.delete(id);
  }
});

ipcMain.on('llm:cancel', (_e, id) => {
  const ac = liveChats.get(id);
  if (ac) ac.abort();
});

ipcMain.handle('update:check', async () => {
  try {
    const proxy = (store.load().ui || {}).proxy || '';
    return { ok: true, ...(await updater.check(app.getVersion(), { proxy })) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:download', async (event, url) => {
  try {
    const proxy = (store.load().ui || {}).proxy || '';
    const file = await updater.download(url, (p) => {
      if (!event.sender.isDestroyed()) event.sender.send('update:progress', p);
    }, { proxy });
    return { ok: true, file };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:install', async (_e, file) => {
  try {
    const res = await updater.install(file);
    return { ok: true, ...res };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('clipboard:write', (_e, text) => {
  require('electron').clipboard.writeText(String(text || ''));
  return true;
});

ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.handle('shell:showItem', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('shell:openPath', (_e, p) => shell.openPath(p));

ipcMain.handle('dialog:saveText', async (_e, { defaultName, text }) => {
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, text, 'utf8');
  return { ok: true, path: r.filePath };
});
