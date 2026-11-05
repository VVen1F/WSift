'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OWNER = 'VVen1F';
const REPO = 'refract';

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
  return list.find((a) => /AppImage$/i.test(a.name)) || list.find((a) => /\.(zip|exe)$/i.test(a.name)) || null;
}

async function check(current) {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'refract' }
  });
  if (!res.ok) throw new Error(`检查更新失败 (${res.status})`);
  const rel = await res.json();
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

async function download(url, onProgress) {
  const res = await fetch(url, { headers: { 'user-agent': 'refract' } });
  if (!res.ok) throw new Error(`下载失败 (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'update.bin');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-update-'));
  const file = path.join(dir, name);
  const fd = fs.openSync(file, 'w');
  const reader = res.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    fs.writeSync(fd, Buffer.from(value));
    received += value.length;
    onProgress && onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : 0 });
  }
  fs.closeSync(fd);
  return file;
}

/** macOS：挂载 dmg，替换 /Applications 里的 app，然后由主进程重启。 */
function install(file) {
  const { shell } = require('electron');
  if (process.platform !== 'darwin') {
    shell.openPath(file);
    return { mode: 'open', file };
  }
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-mnt-'));
  try {
    execFileSync('hdiutil', ['attach', file, '-nobrowse', '-quiet', '-mountpoint', mnt], { stdio: 'ignore' });
    const appName = fs.readdirSync(mnt).find((f) => f.endsWith('.app'));
    if (!appName) throw new Error('安装包中没有找到 .app');
    const src = path.join(mnt, appName);
    const destRoot = app_is_writable() ? '/Applications' : path.dirname(app_path());
    execFileSync('rsync', ['-a', '--delete', src + '/', path.join(destRoot, appName) + '/'], { stdio: 'ignore' });
    return { mode: 'installed', file, app: path.join(destRoot, appName) };
  } finally {
    try {
      execFileSync('hdiutil', ['detach', mnt, '-quiet'], { stdio: 'ignore' });
    } catch (e) {
      /* 忽略卸载失败 */
    }
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
