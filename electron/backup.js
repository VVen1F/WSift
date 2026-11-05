'use strict';
// 本地备份：把 settings.json 打成带时间戳的快照，按份数轮转。
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function dirOf(cfg) {
  const custom = cfg && cfg.backup && cfg.backup.dir;
  const d = custom || path.join(app.getPath('userData'), 'backups');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${ms}`;
}

function list(cfg) {
  const dir = dirOf(cfg);
  return fs
    .readdirSync(dir)
    .filter((f) => /^refract-.*\.json$/.test(f))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, path: path.join(dir, f), size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function prune(dir, keep) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^refract-.*\.json$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const x of files.slice(keep)) {
    try { fs.unlinkSync(path.join(dir, x.f)); } catch (e) { /* ignore */ }
  }
}

function snapshot(cfg, withKeys) {
  const dir = dirOf(cfg);
  const out = JSON.parse(JSON.stringify(cfg));
  if (!withKeys) {
    out.providers = (out.providers || []).map((p) => ({
      ...p,
      accounts: (p.accounts || []).map((a) => ({ ...a, apiKey: '' }))
    }));
  }
  const base = `refract-${stamp()}`;
  let file = path.join(dir, `${base}.json`);
  let n = 1;
  while (fs.existsSync(file)) file = path.join(dir, `${base}-${n++}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  prune(dir, Math.max(1, Number(cfg.backup && cfg.backup.keep) || 7));
  return file;
}

function restore(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

const INTERVALS = { '1h': 3600e3, '6h': 6 * 3600e3, '1d': 24 * 3600e3, '1w': 7 * 24 * 3600e3 };

function due(cfg) {
  const auto = cfg.backup && cfg.backup.auto;
  const interval = INTERVALS[auto];
  if (!interval) return false;
  const last = cfg.backup.lastAt ? Date.parse(cfg.backup.lastAt) : 0;
  return Date.now() - last >= interval;
}

module.exports = { dirOf, list, snapshot, restore, due, prune };
