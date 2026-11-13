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

/**
 * 第一次运行（还没有 templates.json）时把内置模板写进去。
 * 之后即使用户删掉了也不补，尊重用户的选择。
 */
function ensurePresets() {
  if (fs.existsSync(file())) return loadAll();
  saveAll(PRESETS.map((t) => ({ ...t })));
  return loadAll();
}

function list() {
  return ensurePresets();
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

/** 恢复内置模板：只重置 preset-* 那几条，用户自己建/导入的不动。 */
function restorePresets() {
  const mine = loadAll().filter((t) => !String(t.id || '').startsWith('preset-'));
  saveAll(mine.concat(PRESETS.map((t) => ({ ...t }))));
  return loadAll();
}

const KNOWN_VARS = [
  'title', 'type', 'level', 'url', 'date', 'description', 'steps',
  'impact', 'fix', 'account', 'author', 'product'
];

// 雷神众测提交页要求的字段样式（用户点「雷神模板」才装，不是内置）
const PRESETS = [
  {
    id: 'preset-leishen',
    name: '雷神众测',
    platform: '雷神众测',
    body: "漏洞提交模板\n\n漏洞标题\n【填写漏洞标题】\n格式参考：XX系统-XX功能，存在存储型XSS漏洞\n\n漏洞等级\n【高危 / 中危】\n\n漏洞等级自评依据\n【粘贴《漏洞等级判断标准》对应项原文】\n提示：准确输入自评依据可加快漏洞审核\n\n漏洞类型\n【从下拉框选择漏洞类型】\n\n漏洞URL\n【填写漏洞URL】\n格式要求：需含有漏洞影响站点，需带准确协议及端口（统一小写、末位不带/）；漏洞影响的文件/cgi（必须以/开头）；漏洞影响参数（如id、param等，不需要填写键值）。例如：https://www.xxx.com:8080/commitBug?projectid=1\n\n漏洞描述\n【填写简要描述】\n\n漏洞危害\n【填写漏洞危害】\n\n漏洞详情\n描述* 请明确的写出，我们该如何重现该漏洞？请用相关细节替换下面的所有[方形]部分。\n请记住，您提供的详细信息越多，我们就越容易进行分类和快速响应，因此请务必花时间填写报告！\n##POC：\n[添加POC，如有数据包请添加数据包]\n##重现步骤：\n[添加我们如何重现问题的详细信息]\n1.[添加步骤]\n2.[添加步骤]\n3.[添加步骤]\n##支持材料/参考：\n[列出任何其他材料（例如屏幕截图粘贴或者将图片拉至此处）]\n\n修复建议\n【填写修复建议】\n"
  }
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

module.exports = { list, upsert, remove, reset, restorePresets, checkVars, KNOWN_VARS, nameFromFile, file, PRESETS };
