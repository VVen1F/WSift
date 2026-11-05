'use strict';
const fs = require('fs');
const path = require('path');
const { BrowserWindow, app } = require('electron');

let pending = null;

/**
 * 用隐藏窗口渲染 shot.html 并截图，保证图片与界面完全一致。
 */
async function capture({ request, response, width = 1600, out, bytes, ms }) {
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
    const responseText = response || '';
    const size = Number.isFinite(Number(bytes)) ? Math.max(0, Math.round(Number(bytes))) : Buffer.byteLength(String(responseText), 'utf8');
    const timing = Number.isFinite(Number(ms)) ? Math.max(0, Math.round(Number(ms))) : null;
    await win.webContents.executeJavaScript(
      `window.render(${JSON.stringify({ request: request || '', response: responseText, bytes: size, ms: timing })})`
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

function fail(message, code, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/** 缩略图用物理像素。Windows 高 DPI 下 DIP 尺寸会糊，过大则钳到 4096。 */
function thumbnailSizeFor(display) {
  const size = (display && display.size) || { width: 1920, height: 1080 };
  const scale = Number(display && display.scaleFactor) || 1;
  let w = Math.max(1, Math.round(Number(size.width) * scale));
  let h = Math.max(1, Math.round(Number(size.height) * scale));
  const maxEdge = 4096;
  const edge = Math.max(w, h);
  if (edge > maxEdge) {
    const k = maxEdge / edge;
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
  }
  return { width: w, height: h };
}

/** nativeImage 或带同样方法的对象。几乎全黑返回 true。 */
function looksBlack(image) {
  if (!image || (image.isEmpty && image.isEmpty())) return true;
  const small = image.resize ? image.resize({ width: 24, height: 24 }) : image;
  const size = small.getSize ? small.getSize() : { width: 0, height: 0 };
  if (!size.width || !size.height) return true;
  const bmp = small.toBitmap ? small.toBitmap() : null;
  if (!bmp || bmp.length < 4) return true;
  let dark = 0;
  const n = Math.floor(bmp.length / 4);
  for (let i = 0; i < bmp.length; i += 4) {
    if (bmp[i] < 8 && bmp[i + 1] < 8 && bmp[i + 2] < 8) dark++;
  }
  return dark / n > 0.97;
}

function assertNotBlack(image, status) {
  if (!looksBlack(image)) return;
  if (status && status !== 'granted') {
    throw fail('需要屏幕录制权限', 'NO_PERM', { status });
  }
  throw fail('画面是黑的。退出 Refract 再打开，授权才会生效。', 'BLACK_FRAME', { status: status || 'granted' });
}

async function captureScreen(out) {
  const { execFile } = require('child_process');
  const target = out || path.join(app.getPath('temp'), `refract-screen-${Date.now()}.png`);
  const status = screenAccess();
  if (process.platform === 'darwin' && status !== 'granted') {
    throw fail('需要屏幕录制权限', 'NO_PERM', { status });
  }
  if (process.platform === 'darwin') {
    try {
      await new Promise((resolve, reject) => {
        execFile('screencapture', ['-x', '-o', target], { timeout: 8000 }, (err) =>
          err ? reject(err) : resolve()
        );
      });
    } catch (e) {
      const now = screenAccess();
      if (now !== 'granted') throw fail('需要屏幕录制权限', 'NO_PERM', { status: now });
      throw fail('画面是黑的。退出 Refract 再打开，授权才会生效。', 'BLACK_FRAME', { status: now });
    }
    let size = 0;
    try { size = fs.statSync(target).size; } catch (e) { size = 0; }
    if (size < 20 * 1024) {
      const now = screenAccess();
      if (now !== 'granted') throw fail('需要屏幕录制权限', 'NO_PERM', { status: now });
      throw fail('画面是黑的。退出 Refract 再打开，授权才会生效。', 'BLACK_FRAME', { status: now });
    }
    try {
      const { nativeImage } = require('electron');
      assertNotBlack(nativeImage.createFromPath(target), screenAccess());
    } catch (e) {
      if (e.code === 'NO_PERM' || e.code === 'BLACK_FRAME') throw e;
    }
    return { path: target, size };
  }

  const { desktopCapturer, screen, nativeImage } = require('electron');
  const display = screen.getPrimaryDisplay();
  const physical = thumbnailSizeFor(display);
  const dip = {
    width: Math.max(1, Math.round(display.size.width)),
    height: Math.max(1, Math.round(display.size.height))
  };
  let sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: physical });
  let source = pickSource(sources, display);
  let image = source && source.thumbnail;
  if (!image || image.isEmpty()) {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: dip });
    source = pickSource(sources, display);
    image = source && source.thumbnail;
  }
  if (!image || image.isEmpty()) throw new Error('没有可截的屏幕');
  if (nativeImage && looksBlack(image)) {
    throw fail('画面是黑的。退出 Refract 再打开，授权才会生效。', 'BLACK_FRAME');
  }
  fs.writeFileSync(target, image.toPNG());
  return { path: target, size: fs.statSync(target).size, scale: display.scaleFactor || 1 };
}

function pickSource(sources, display) {
  if (!sources || !sources.length) return null;
  const id = display && display.id != null ? String(display.id) : '';
  return sources.find((s) => id && String(s.display_id) === id) || sources[0];
}

module.exports = { capture, captureScreen, screenAccess, thumbnailSizeFor, looksBlack };
