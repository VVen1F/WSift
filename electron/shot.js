'use strict';
const fs = require('fs');
const path = require('path');
const { BrowserWindow, app } = require('electron');

let pending = null;

/**
 * 用隐藏窗口渲染 shot.html 并截图，保证图片与界面完全一致。
 */
async function capture({ request, response, width = 1600, out }) {
  const win = new BrowserWindow({
    show: false,
    frame: false,
    width,
    height: 800,
    backgroundColor: '#ffffff',
    webPreferences: {
      offscreen: false,
      contextIsolation: true,
      nodeIntegration: false,
      paintWhenInitiallyHidden: true
    }
  });

  try {
    await win.loadFile(path.join(__dirname, '..', 'renderer', 'shot.html'));
    await win.webContents.executeJavaScript(
      `window.render(${JSON.stringify({ request: request || '', response: response || '' })})`
    );

    const height = await win.webContents.executeJavaScript(
      'Math.ceil(document.documentElement.getBoundingClientRect().height)'
    );
    const h = Math.max(240, Math.min(Number(height) || 800, 20000));
    win.setContentSize(width, h);

    await new Promise((r) => setTimeout(r, 180));

    const image = await win.webContents.capturePage();
    const target = out || path.join(app.getPath('temp'), `refract-${Date.now()}.png`);
    fs.writeFileSync(target, image.toPNG());
    return { path: target, width, height: h };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { capture };
