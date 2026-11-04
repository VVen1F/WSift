'use strict';
const { app, BrowserWindow, ipcMain, Menu, shell, dialog } = require('electron');
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

let mainWindow = null;
let remoteInfo = null;
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
    backgroundColor: '#f5f5f7',
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
          console.error('SMOKE_SHOT_FAIL ' + e.message);
          app.exit(1);
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
  mainWindow.on('close', () => {
    try {
      const b = mainWindow.getNormalBounds ? mainWindow.getNormalBounds() : mainWindow.getBounds();
      fs.writeFileSync(path.join(app.getPath('userData'), 'window.json'), JSON.stringify(b));
    } catch (e) {
      /* 忽略 */
    }
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
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
  const dir = path.join(app.getPath('userData'), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const out = path.join(dir, `${stamp}.png`);
  const res = await shot.capture({
    request: payload.request,
    response: payload.response,
    width: payload.width || 1600,
    out
  });
  return res;
});

const shotDir = () => {
  const dir = path.join(app.getPath('userData'), 'shots');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const stampName = (p) => `${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}${p}`;

browser.onDialog(async (info) => {
  let shot = null;
  let error = null;
  try {
    const r = await shot.captureScreen(path.join(shotDir(), stampName('-dialog.png')));
    shot = r.path;
  } catch (e) {
    error = e.message;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser:dialog', {
      type: info.type, message: info.message, shot, error
    });
  }
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
  try {
    const r = await shot.captureScreen(path.join(shotDir(), stampName('-screen.png')));
    return { ok: true, path: r.path };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('browser:close', () => {
  browser.shutdown();
  return { ok: true };
});

ipcMain.handle('settings:get', () => store.load());
ipcMain.handle('settings:set', (_e, s) => store.save(s));

ipcMain.handle('templates:list', () => templates.list());
ipcMain.handle('templates:upsert', (_e, t) => templates.upsert(t));
ipcMain.handle('templates:remove', (_e, id) => templates.remove(id));
ipcMain.handle('templates:reset', () => templates.reset());

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

ipcMain.on('llm:chat', async (event, payload) => {
  const { id, provider, messages } = payload;
  try {
    const text = await llm.chat({
      provider,
      messages,
      onDelta: (delta) => !event.sender.isDestroyed() && event.sender.send('llm:delta', { id, delta })
    });
    !event.sender.isDestroyed() && event.sender.send('llm:done', { id, text });
  } catch (err) {
    !event.sender.isDestroyed() && event.sender.send('llm:error', { id, message: err.message });
  }
});

ipcMain.handle('update:check', async () => {
  try {
    return { ok: true, ...(await updater.check(app.getVersion())) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:download', async (event, url) => {
  try {
    const file = await updater.download(url, (p) => {
      if (!event.sender.isDestroyed()) event.sender.send('update:progress', p);
    });
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
