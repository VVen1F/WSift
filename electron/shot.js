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
      backgroundThrottling: false,
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

    await new Promise((r) => setTimeout(r, 220));

    let image = await win.webContents.capturePage();
    if (!image || image.isEmpty()) {
      // 隐藏窗口偶尔不绘制：挪到屏幕外显示一次再截
      win.setPosition(-20000, 0);
      win.showInactive();
      await new Promise((r) => setTimeout(r, 400));
      image = await win.webContents.capturePage();
    }
    if (!image || image.isEmpty()) throw new Error('截图失败：窗口未绘制');
    const target = out || path.join(app.getPath('temp'), `refract-${Date.now()}.png`);
    fs.writeFileSync(target, image.toPNG());
    return { path: target, width, height: h };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 整屏截图：把浏览器外壳、alert 弹窗一起拍进去。
 * macOS 用 screencapture，其它平台退回 desktopCapturer。
 */
/** macOS 屏幕录制权限状态：granted / denied / not-determined / restricted */
function screenAccess() {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return require('electron').systemPreferences.getMediaAccessStatus('screen');
  } catch (e) {
    return 'unknown';
  }
}

async function captureScreen(out) {
  const { execFile } = require('child_process');
  const target = out || path.join(app.getPath('temp'), `refract-screen-${Date.now()}.png`);
  if (process.platform === 'darwin') {
    try {
      // 用异步的，别把主进程卡住
      await new Promise((resolve, reject) => {
        execFile('screencapture', ['-x', '-o', target], { timeout: 5000 }, (err) =>
          err ? reject(err) : resolve()
        );
      });
    } catch (e) {
      throw Object.assign(new Error('screencapture 失败：' + e.message), { code: 'NO_PERM' });
    }
    let size = 0;
    try { size = fs.statSync(target).size; } catch (e) { size = 0; }
    if (size < 20 * 1024) {
      // 没权限时拍出来基本是全黑/全白，压缩后很小
      throw Object.assign(new Error('屏幕录制权限没开，截出来是空白'), { code: 'NO_PERM' });
    }
    return { path: target, size };
  }
  const { desktopCapturer, screen } = require('electron');
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: screen.getPrimaryDisplay().size
  });
  if (!sources.length) throw new Error('没有可截的屏幕');
  fs.writeFileSync(target, sources[0].thumbnail.toPNG());
  return { path: target };
}

module.exports = { capture, captureScreen, screenAccess };
