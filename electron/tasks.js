'use strict';
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const MAX = 200;

function file() {
  return path.join(dataDir(), 'tasks.json');
}

/**
 * 侧栏标题。自定义标题优先，否则用报告一级标题，再否则用详情里第一条有内容的行。
 * renderer/app.js 里的 displayTitle 要和这里保持一致。
 */
function displayTitle(t) {
  const custom = String((t && t.title) || '').trim();
  if (custom) return custom.slice(0, 80);
  const md = /^#\s+(.+)$/m.exec(String((t && t.markdown) || ''));
  if (md) {
    const h = md[1].trim();
    if (h && h !== '报告') return h.slice(0, 80);
  }
  const lines = String((t && t.detail) || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^```/.test(line) || /^(请求|响应)[:：]?$/.test(line)) continue;
    const clean = line.replace(/^#+\s*/, '').trim();
    if (clean) return clean.slice(0, 80);
  }
  return '未命名';
}

function hasContent(t) {
  if (!t) return false;
  if (String(t.title || '').trim()) return true;
  if (String(t.cred || '').trim()) return true;
  if (String(t.detail || '').trim()) return true;
  if (String(t.extra || '').trim()) return true;
  if (String(t.markdown || '').trim()) return true;
  if (Array.isArray(t.images) && t.images.some((p) => String(p || '').trim())) return true;
  return false;
}

function normalize(t) {
  if (!t || typeof t !== 'object') return null;
  const id = String(t.id || '').trim();
  if (!id) return null;
  return {
    id: id.slice(0, 64),
    title: String(t.title || '').slice(0, 80),
    templateId: String(t.templateId || '').slice(0, 64),
    cred: String(t.cred || '').slice(0, 20000),
    detail: String(t.detail || '').slice(0, 200000),
    extra: String(t.extra || '').slice(0, 20000),
    markdown: String(t.markdown || '').slice(0, 400000),
    images: Array.isArray(t.images) ? t.images.map((p) => String(p || '')).filter(Boolean).slice(0, 40) : [],
    exported: String(t.exported || '').slice(0, 500),
    archived: t.archived === true,
    pinned: t.pinned === true,
    workspaceId: String(t.workspaceId || '').slice(0, 64),
    updatedAt: Number(t.updatedAt) || Date.now(),
    createdAt: Number(t.createdAt) || Date.now()
  };
}

function normalizeSpaces(list) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    if (!s || typeof s !== 'object') continue;
    const id = String(s.id || '').trim().slice(0, 64);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(s.name || '未命名').slice(0, 40),
      open: s.open !== false,
      createdAt: Number(s.createdAt) || Date.now()
    });
  }
  return out;
}

function unpack(input) {
  if (Array.isArray(input) || input == null) return { tasks: input || [], workspaces: null };
  return {
    tasks: Array.isArray(input.tasks) ? input.tasks : [],
    workspaces: input.workspaces == null ? null : normalizeSpaces(input.workspaces)
  };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw && raw.tasks);
    const workspaces = normalizeSpaces(raw && !Array.isArray(raw) ? raw.workspaces : []);
    const tasks = [];
    const seen = new Set();
    let dropped = false;
    for (const item of (Array.isArray(list) ? list : []).map(normalize).filter(Boolean)) {
      if (!hasContent(item)) { dropped = true; continue; }
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      tasks.push(item);
      if (tasks.length >= MAX) break;
    }
    if (dropped) saveAll({ tasks, workspaces });
    return { tasks, workspaces };
  } catch (e) {
    return { tasks: [], workspaces: [] };
  }
}

function saveAll(list) {
  const packed = unpack(list);
  const tasks = [];
  const seen = new Set();
  for (const item of packed.tasks.map(normalize).filter(Boolean)) {
    if (!hasContent(item)) continue;
    if (seen.has(item.id)) {
      tasks[tasks.findIndex((t) => t.id === item.id)] = item;
      continue;
    }
    seen.add(item.id);
    tasks.push(item);
    if (tasks.length >= MAX) break;
  }
  fs.mkdirSync(dataDir(), { recursive: true });
  const dest = file();
  const tmp = dest + '.tmp';
  const body = { tasks };
  if (packed.workspaces) body.workspaces = packed.workspaces;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, dest);
  return { tasks, workspaces: packed.workspaces || [] };
}

module.exports = { load, saveAll, displayTitle, normalize, hasContent, normalizeSpaces, file };
