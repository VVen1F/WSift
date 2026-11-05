'use strict';
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const OLD_BUILTIN_IDS = ['general', 'butian', 'butian-box', 'cnvd', 'edu'];

/**
 * 文件名是「漏洞提交模板.md」这类通称时，用上一级文件夹名。
 * 例：…/雷神众测/漏洞提交模板.md → 雷神众测
 */
function nameFromFile(filePath, fileName) {
  const raw = fileName || (filePath ? path.basename(filePath) : '');
  const stem = String(raw).replace(/\.(md|markdown|txt)$/i, '').trim();
  const generic = /^(漏洞提交模板|漏洞模板|提交模板|模板|template)$/i.test(stem);
  if (generic && filePath) {
    const parent = path.basename(path.dirname(filePath));
    if (parent && parent !== '.' && parent !== '/' && parent !== '\\') return parent;
  }
  return stem || '未命名模板';
}

function file() {
  return path.join(dataDir(), 'templates.json');
}

function loadAll() {
  let list = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(raw)) list = raw;
  } catch (e) {
    return [];
  }
  const kept = list.filter((t) => t && OLD_BUILTIN_IDS.indexOf(t.id) < 0 && !t.builtin);
  if (kept.length !== list.length) saveAll(kept);
  return kept;
}

function saveAll(list) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(list, null, 2), 'utf8');
  return list;
}

function list() {
  return loadAll();
}

function upsert(tpl) {
  const all = loadAll();
  const item = {
    id: tpl.id || 'custom-' + Date.now().toString(36),
    name: tpl.name || '未命名模板',
    platform: tpl.platform || '自定义',
    builtin: !!tpl.builtin && !!all.find((t) => t.id === tpl.id),
    body: tpl.body || ''
  };
  const i = all.findIndex((t) => t.id === item.id);
  if (i >= 0) all[i] = item;
  else all.push(item);
  saveAll(all);
  return item;
}

function remove(id) {
  const all = loadAll().filter((t) => t.id !== id);
  saveAll(all);
  return all;
}

function reset() {
  return saveAll([]);
}

const KNOWN_VARS = [
  'title', 'type', 'level', 'url', 'date', 'description', 'steps',
  'impact', 'fix', 'account', 'author', 'product'
];

/** 模板占位符：未闭合，或用了内置模板里没有的名字。 */
function checkVars(body) {
  const s = String(body || '');
  const open = (s.match(/\{\{/g) || []).length;
  const close = (s.match(/\}\}/g) || []).length;
  let unclosed = open !== close;
  const unknown = [];
  const re = /\{\{\s*([^}]*?)\s*\}\}/g;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1];
    if (!/^\w+$/.test(name) || KNOWN_VARS.indexOf(name) < 0) unknown.push(name || '空');
    if (!name) unclosed = true;
  }
  if (/\{\{[^}]*$/.test(s)) unclosed = true;
  return { ok: !unclosed && unknown.length === 0, unclosed, unknown: [...new Set(unknown)] };
}

module.exports = { list, upsert, remove, reset, checkVars, KNOWN_VARS, nameFromFile, file };
