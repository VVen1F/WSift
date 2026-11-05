'use strict';
const fs = require('fs');
const path = require('path');
const zip = require('./zip');

/** 模板里允许的占位符。未知名字在编辑时标出来。 */
const TEMPLATE_VARS = [
  'title', 'type', 'level', 'url', 'date', 'description', 'steps',
  'impact', 'fix', 'account', 'product', 'author'
];

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

function buildMessages({ material, template, meta = {}, extra }) {
  const facts = [
    `模板：\n${template || ''}`,
    `系统名称：${meta.product || '从材料里的域名和页面推断'}`,
    `影响地址：${meta.url || '从材料里的请求行和 Host 推断'}`,
    `漏洞类型：${meta.type || '从材料推断'}`,
    `危害等级：${meta.level || '按实际影响面判定'}`,
    `日期：${meta.date || today()}`,
    '',
    '材料（请求、响应、现象、测试记录）：',
    material || '（无）',
    extra ? `\n其他要求：${extra}` : ''
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

const CHAT_SYSTEM = `你是 Refract 里的助手，帮用户做漏洞测试和写报告。

【回答】
- 简洁直接，不寒暄，不复述用户说过的话
- 先给结论，再给理由；能一句说清就不写第二句
- 用户没给的信息不要编造，不确定就说不确定
- 不要出现“作为 AI”“我来帮你”这类话

【写报告】
用户要求写报告时，直接输出完整 Markdown 正文，不要用代码块包住整篇，
标题、结构、语气严格遵守下面的写作约束。`;

function buildChatMessages({ material, template, meta = {}, question, extra }) {
  const facts = [
    meta.product ? `系统名称：${meta.product}` : '',
    meta.url ? `影响地址：${meta.url}` : '',
    meta.type ? `漏洞类型：${meta.type}` : '',
    meta.level ? `危害等级：${meta.level}` : '',
    template ? `报告模板：\n${template}` : '',
    material ? `材料：\n${material}` : '',
    extra ? `其他要求：${extra}` : ''
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: CHAT_SYSTEM + '\n\n' + SYSTEM_PROMPT },
    { role: 'user', content: (facts ? facts + '\n\n' : '') + '用户：' + (question || '') }
  ];
}

function fillTemplate(body, vars) {
  return String(body || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

function scanVars(body) {
  const used = [];
  const re = /\{\{\s*(\w+)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(body || '')))) {
    if (!used.includes(m[1])) used.push(m[1]);
  }
  return { used, unknown: used.filter((k) => !TEMPLATE_VARS.includes(k)) };
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

function imageName(i) {
  return `${String(i + 1).padStart(2, '0')}.png`;
}

/** 只收存在的文件，序号与正文里的 images/NN.png 对齐。 */
function packImages(images) {
  const packed = [];
  (images || []).forEach((src, i) => {
    if (!src || !fs.existsSync(src)) return;
    const name = imageName(i);
    packed.push({ src, name, rel: `images/${name}`, index: i });
  });
  return packed;
}

function withImageLinks(markdown, packed) {
  let md = String(markdown || '');
  const missing = packed.filter((p) => !md.includes(p.rel));
  if (!missing.length) return md.endsWith('\n') || !md ? md : md + '\n';
  const block = missing.map((p) => `![${p.index + 1}](${p.rel})`).join('\n\n');
  return md.replace(/\s+$/, '') + '\n\n## 截图\n\n' + block + '\n';
}

/**
 * 保存报告与图片到同一文件夹。
 * 图片一律写成 images/NN.png，和正文里的相对路径一致。
 * @returns {{dir:string, md:string, images:string[]}}
 */
function save({ markdown, images = [], title = '', baseDir }) {
  const root = baseDir || path.join(require('os').homedir(), 'Documents', 'Refract');
  const dir = path.join(root, `${stamp()}-${slugify(title)}`);
  const imgDir = path.join(dir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });

  const packed = packImages(images);
  packed.forEach((p) => fs.copyFileSync(p.src, path.join(imgDir, p.name)));

  const md = withImageLinks(markdown, packed);
  const mdPath = path.join(dir, 'report.md');
  fs.writeFileSync(mdPath, md, 'utf8');
  return { dir, md: mdPath, images: packed.map((p) => p.name) };
}

/**
 * 导出 zip：<标题>/report.md + <标题>/images/NN.png。
 * 没有运行时依赖，zip 由 electron/zip.js 写成。
 */
function exportZip({ markdown, images = [], title = '', dest, baseDir }) {
  const folder = slugify(title);
  const packed = packImages(images);
  const md = withImageLinks(markdown, packed);
  const entries = [
    { name: `${folder}/report.md`, data: Buffer.from(md, 'utf8') },
    ...packed.map((p) => ({ name: `${folder}/${p.rel}`, data: fs.readFileSync(p.src) }))
  ];
  const root = baseDir || path.join(require('os').homedir(), 'Documents', 'Refract');
  const file = dest || path.join(root, `${stamp()}-${folder}.zip`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zip.pack(entries));
  return {
    zip: file,
    title: folder,
    images: packed.map((p) => p.rel),
    entries: entries.map((e) => e.name)
  };
}

module.exports = {
  SYSTEM_PROMPT,
  CHAT_SYSTEM,
  TEMPLATE_VARS,
  buildMessages,
  buildChatMessages,
  fillTemplate,
  scanVars,
  save,
  exportZip,
  slugify,
  today
};
