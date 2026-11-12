'use strict';
// 云端同步：WebDAV 或 GitHub 仓库里的一个 JSON 文件，上传/下载整份设置。
const fs = require('fs');

function b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

function joinUrl(base, sub) {
  if (!base) return '';
  if (!sub) return base;
  return base.replace(/\/+$/, '') + '/' + sub.replace(/^\/+/, '');
}

function basicAuth(user, pass) {
  return 'Basic ' + Buffer.from(`${user || ''}:${pass || ''}`, 'utf8').toString('base64');
}

async function webdavPut(cfg, text) {
  const s = cfg.sync.webdav || {};
  const url = joinUrl(s.url, s.path || 'wsift-settings.json');
  if (!s.url) throw new Error('没填 WebDAV 地址');
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: basicAuth(s.user, s.pass),
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: text
  });
  if (!res.ok && res.status !== 201 && res.status !== 204) {
    throw new Error(`上传失败：HTTP ${res.status}`);
  }
  return { ok: true, target: url };
}

async function webdavGet(cfg) {
  const s = cfg.sync.webdav || {};
  const url = joinUrl(s.url, s.path || 'wsift-settings.json');
  if (!s.url) throw new Error('没填 WebDAV 地址');
  const res = await fetch(url, { headers: { Authorization: basicAuth(s.user, s.pass) } });
  if (res.status === 404) throw new Error('远端还没有这份文件');
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  return await res.text();
}

function repoOf(s) {
  // 既接受 sync 对象，也接受 github 子对象
  const repo = (s.github ? s.github.repo : s.repo) || '';
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error('GitHub 仓库要写成 owner/repo');
  return repo;
}

async function githubPut(cfg, text) {
  const s = cfg.sync.github || {};
  const repo = repoOf(s);
  const path = (s.path || 'wsift-settings.json').replace(/^\/+/, '');
  const branch = s.branch || 'main';
  const api = `https://api.github.com/repos/${repo}/contents/${encodeURI(path)}`;
  const headers = {
    Authorization: `Bearer ${s.token || ''}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'WSift'
  };

  let sha;
  const head = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
  if (head.ok) {
    const j = await head.json();
    sha = j.sha;
  } else if (head.status !== 404) {
    throw new Error(`读取失败：HTTP ${head.status}`);
  }

  const res = await fetch(api, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message: 'wsift: 同步设置', content: b64(text), branch, ...(sha ? { sha } : {}) })
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`上传失败：HTTP ${res.status} ${detail.slice(0, 120)}`);
  }
  return { ok: true, target: `github:${repo}/${path}` };
}

async function githubGet(cfg) {
  const s = cfg.sync.github || {};
  const repo = repoOf(s);
  const path = (s.path || 'wsift-settings.json').replace(/^\/+/, '');
  const branch = s.branch || 'main';
  const api = `https://api.github.com/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(api, {
    headers: {
      Authorization: `Bearer ${s.token || ''}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'WSift'
    }
  });
  if (res.status === 404) throw new Error('仓库里还没有这份文件');
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const j = await res.json();
  return Buffer.from(j.content || '', 'base64').toString('utf8');
}

function payloadOf(cfg, withKeys) {
  const out = JSON.parse(JSON.stringify(cfg));
  delete out.sync; // 别把凭据同步到云端
  if (!withKeys) {
    out.providers = (out.providers || []).map((p) => ({
      ...p,
      accounts: (p.accounts || []).map((a) => ({ ...a, apiKey: '' }))
    }));
  }
  return JSON.stringify(out, null, 2);
}

async function push(cfg) {
  const kind = cfg.sync && cfg.sync.kind;
  const text = payloadOf(cfg, cfg.backup && cfg.backup.withKeys);
  if (kind === 'webdav') return webdavPut(cfg, text);
  if (kind === 'github') return githubPut(cfg, text);
  throw new Error('还没选同步方式');
}

async function pull(cfg) {
  const kind = cfg.sync && cfg.sync.kind;
  if (kind === 'webdav') return JSON.parse(await webdavGet(cfg));
  if (kind === 'github') return JSON.parse(await githubGet(cfg));
  throw new Error('还没选同步方式');
}

async function test(cfg) {
  const kind = cfg.sync && cfg.sync.kind;
  if (kind === 'webdav') {
    const s = cfg.sync.webdav || {};
    const url = joinUrl(s.url, s.path || 'wsift-settings.json');
    if (!s.url) throw new Error('没填 WebDAV 地址');
    const res = await fetch(url, { method: 'HEAD', headers: { Authorization: basicAuth(s.user, s.pass) } });
    if (res.status === 401) throw new Error('认证失败，检查用户名和密码');
    return { ok: true, message: res.ok ? '连接成功，远端已有文件' : `连接成功（HTTP ${res.status}）` };
  }
  if (kind === 'github') {
    const s = cfg.sync.github || {};
    const repo = repoOf(s);
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Authorization: `Bearer ${s.token || ''}`, Accept: 'application/vnd.github+json', 'User-Agent': 'WSift' }
    });
    if (res.status === 401 || res.status === 403) throw new Error('Token 无效或没有权限');
    if (res.status === 404) throw new Error('找不到仓库，检查 owner/repo 和 Token');
    return { ok: true, message: '连接成功' };
  }
  throw new Error('还没选同步方式');
}

module.exports = { push, pull, test, payloadOf, joinUrl };
