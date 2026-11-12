'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const net = require('./net');

const OWNER = 'VVen1F';
const REPO = 'WSift';

function cmp(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function pickAsset(assets, platform, arch) {
  const list = assets || [];
  const plat = platform || process.platform;
  const cpu = arch || process.arch;
  if (plat === 'darwin') {
    const dmgs = list.filter((a) => /\.dmg$/i.test(a.name));
    return dmgs.find((a) => (cpu === 'arm64' ? /arm64/i.test(a.name) : !/arm64/i.test(a.name))) || dmgs[0] || null;
  }
  if (plat === 'win32') return list.find((a) => /\.exe$/i.test(a.name)) || null;
  // Linux 只认 AppImage：没有就返回 null，别把 Windows 安装包下下来
  return list.find((a) => /AppImage$/i.test(a.name)) || null;
}

async function check(current, opts = {}) {
  const rel = await net.retry(() =>
    net.fetchJSON(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
      headers: { accept: 'application/vnd.github+json' },
      proxy: opts.proxy || ''
    })
  );
  const latest = String(rel.tag_name || '').replace(/^v/, '');
  const assets = rel.assets || [];
  const asset = pickAsset(assets);
  return {
    hasUpdate: cmp(latest, current) > 0,
    latest,
    current,
    notes: rel.body || '',
    url: rel.html_url,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null
  };
}

async function download(url, onProgress, opts = {}) {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'update.bin');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsift-update-'));
  const file = path.join(dir, name);
  await net.retry(() => net.download(url, file, { proxy: opts.proxy || '', onProgress }));
  return file;
}

function run(cmd, args, timeout = 180000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').trim().split('\n')[0];
        return reject(Object.assign(new Error(msg || `${cmd} 失败`), { code: err.code }));
      }
      resolve(stdout);
    });
  });
}

/**
 * macOS：挂载 dmg，替换 /Applications 里的 app，然后由主进程重启。
 * 全程异步——hdiutil 挂载要几秒，用同步版会把主进程卡住，界面看着就像死了。
 */
async function install(file) {
  const { shell } = require('electron');
  if (!file || !fs.existsSync(file)) throw new Error('安装包不存在，重新下载一次');
  const size = fs.statSync(file).size;
  if (size < 1024 * 1024) throw new Error(`安装包不完整（${Math.round(size / 1024)} KB），重新下载一次`);
  if (process.platform !== 'darwin') {
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
    return { mode: 'open', file };
  }
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'wsift-mnt-'));
  try {
    await run('hdiutil', ['attach', file, '-nobrowse', '-quiet', '-mountpoint', mnt]);
    const appName = fs.readdirSync(mnt).find((f) => f.endsWith('.app'));
    if (!appName) throw new Error('安装包中没有找到 .app');
    const src = path.join(mnt, appName);
    const destRoot = app_is_writable() ? '/Applications' : path.dirname(app_path());
    const dest = path.join(destRoot, appName);
    await run('rsync', ['-a', '--delete', src + '/', dest + '/']);
    if (!fs.existsSync(path.join(dest, 'Contents', 'MacOS'))) throw new Error('安装包复制失败，检查 /Applications 权限');
    return { mode: 'installed', file, app: dest };
  } finally {
    await run('hdiutil', ['detach', mnt, '-quiet']).catch(() => {});
  }
}

function app_path() {
  return require('electron').app.getPath('exe').replace(/\/Contents\/MacOS\/[^/]+$/, '');
}

function app_is_writable() {
  try {
    fs.accessSync('/Applications', fs.constants.W_OK);
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = { check, download, install, cmp, pickAsset, OWNER, REPO };
