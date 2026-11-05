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
/** macOS 屏幕录制权限状态：granted / denied / not-determined / restricted / unknown */
function screenAccess() {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return require('electron').systemPreferences.getMediaAccessStatus('screen');
  } catch (e) {
    return 'unknown';
  }
}

function screenBlocked(status) {
  return status === 'denied' || status === 'not-determined' || status === 'restricted';
}

function needsScreenGrant() {
  return process.platform === 'darwin' && screenBlocked(screenAccess());
}

/**
 * desktopCapturer 的 thumbnailSize 要物理像素。
 * Windows 高 DPI 下 display.size 是 DIP，直接用会把图缩小、发糊。
 */
function capturePixelSize(display) {
  const size = (display && display.size) || { width: 1, height: 1 };
  const scale = Number(display && display.scaleFactor) || 1;
  const s = scale > 0 ? scale : 1;
  return {
    width: Math.max(1, Math.round((Number(size.width) || 1) * s)),
    height: Math.max(1, Math.round((Number(size.height) || 1) * s)),
    scale: s
  };
}

/** BGRA 位图几乎全黑或全白。 */
function bitmapMostlyBlank(bgra) {
  if (!bgra || bgra.length < 4) return true;
  const n = Math.floor(bgra.length / 4);
  let dark = 0;
  let light = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const y = (bgra[o] + bgra[o + 1] + bgra[o + 2]) / 3;
    if (y < 12) dark++;
    else if (y > 245) light++;
  }
  return dark / n > 0.97 || light / n > 0.97;
}

function frameIsBlank(file) {
  try {
    const { nativeImage } = require('electron');
    if (!nativeImage || typeof nativeImage.createFromPath !== 'function') {
      return fs.statSync(file).size < 20 * 1024;
    }
    const img = nativeImage.createFromPath(file);
    if (!img || img.isEmpty()) return true;
    const small = img.resize({ width: 24, height: 24 });
    const bmp = small.toBitmap();
    if (!bmp || !bmp.length) return fs.statSync(file).size < 20 * 1024;
    return bitmapMostlyBlank(bmp);
  } catch (e) {
    try { return fs.statSync(file).size < 20 * 1024; } catch (err) { return true; }
  }
}

async function captureScreen(out) {
  const { execFile } = require('child_process');
  const target = out || path.join(app.getPath('temp'), `refract-screen-${Date.now()}.png`);
  if (process.platform === 'darwin') {
    const status = screenAccess();
    if (screenBlocked(status)) {
      throw Object.assign(new Error('屏幕录制未授权'), { code: 'NEED_PERM', status });
    }
    try {
      await new Promise((resolve, reject) => {
        execFile('screencapture', ['-x', '-o', target], { timeout: 8000 }, (err) =>
          err ? reject(err) : resolve()
        );
      });
    } catch (e) {
      const again = screenAccess();
      if (screenBlocked(again)) {
        throw Object.assign(new Error('屏幕录制未授权'), { code: 'NEED_PERM', status: again });
      }
      throw Object.assign(new Error('screencapture 失败：' + e.message), { code: 'CAPTURE_FAIL', status: again });
    }
    if (frameIsBlank(target)) {
      throw Object.assign(new Error('截图是黑屏'), { code: 'BLACK_FRAME', status: screenAccess() });
    }
    let size = 0;
    try { size = fs.statSync(target).size; } catch (e) { size = 0; }
    return { path: target, size };
  }

  const { desktopCapturer, screen } = require('electron');
  const display = screen.getPrimaryDisplay();
  const px = capturePixelSize(display);
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: px.width, height: px.height }
  });
  const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) throw new Error('没有可截的屏幕');
  fs.writeFileSync(target, source.thumbnail.toPNG());
  return { path: target, size: fs.statSync(target).size, scale: px.scale };
}

module.exports = {
  capture,
  captureScreen,
  screenAccess,
  needsScreenGrant,
  capturePixelSize,
  bitmapMostlyBlank
};
