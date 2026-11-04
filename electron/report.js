'use strict';
const fs = require('fs');
const path = require('path');

/** 后端硬编码的写作约束：所有报告都必须过这一层，保证风格一致。 */
const SYSTEM_PROMPT = `你是一名有十年经验的 SRC 漏洞报告作者。你的输出只有报告正文，不解释、不寒暄、不复述写作过程。

【标题】
- 固定句式：<系统名><功能点>存在<漏洞类型>。例：某社区创作平台草稿保存接口存在越权
- 不超过 30 字，不加“严重/高危/紧急/重大”等形容词，不用感叹号、不用书名号
- 不写“可导致”“进而”“从而”这类推理词

【结构】
- 严格按给定模板的章节输出，不增删章节
- 先结论后证据：每节第一句就把结论说完
- 每段不超过三句，能用一句说清就不写第二句
- 参数名、路径、字段用行内代码；请求与响应整段放进 \`\`\`http 代码块，原样保留不改写

【语言】
- 用陈述句，省略主语。禁止“我们”“笔者”“值得注意的是”“综上所述”“此外”“同时”
- 禁止比喻、排比，禁止“极大地”“严重影响”这类程度副词
- 不猜测：材料里没有的信息不要编造；缺的写“未验证”或留空
- 中文标点，中英文之间不加空格，不用 emoji

【一致性】
- 等级只用：严重 / 高 / 中 / 低
- 日期统一 yyyy-MM-dd
- “修复建议”给 2-4 条，每条一句，动词开头`;

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function buildMessages({ material, template, meta = {} }) {
  const facts = [
    `模板：\n${template || ''}`,
    `系统名称：${meta.product || '未提供'}`,
    `影响地址：${meta.url || '未提供'}`,
    `漏洞类型：${meta.type || '未提供'}`,
    `危害等级：${meta.level || '未判定'}`,
    `日期：${meta.date || today()}`,
    '',
    '材料（请求、响应、现象、复测记录）：',
    material || '（无）'
  ].join('\n');

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content:
        '按下面的模板和材料写完整报告。只输出 Markdown 正文，不要代码块包裹整篇报告。\n\n' + facts
    }
  ];
}

function fillTemplate(body, vars) {
  return String(body || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

function slugify(title) {
  const s = String(title || 'report')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 40);
  return s || 'report';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 保存报告与图片到同一文件夹。
 * @returns {{dir:string, md:string, images:string[]}}
 */
function save({ markdown, images = [], title = '', baseDir }) {
  const root = baseDir || path.join(require('os').homedir(), 'Documents', 'Refract');
  const dir = path.join(root, `${stamp()}-${slugify(title)}`);
  const imgDir = path.join(dir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });

  const written = [];
  images.forEach((src, i) => {
    if (!src || !fs.existsSync(src)) return;
    const ext = path.extname(src) || '.png';
    const name = `${String(i + 1).padStart(2, '0')}${ext}`;
    fs.copyFileSync(src, path.join(imgDir, name));
    written.push(name);
  });

  const mdPath = path.join(dir, 'report.md');
  fs.writeFileSync(mdPath, markdown || '', 'utf8');
  return { dir, md: mdPath, images: written };
}

module.exports = { SYSTEM_PROMPT, buildMessages, fillTemplate, save, slugify, today };
