'use strict';
const fs = require('fs');
const path = require('path');
const zip = require('./zip');

/** 后端硬编码的写作约束：所有报告都必须过这一层。 */
const SYSTEM_PROMPT = `你写漏洞报告正文。只输出正文，不解释、不寒暄。

【名称】
- 第一行就是报告名，也是文件夹和压缩包的名字
- 句式：产品 接口或功能 参数名 漏洞类型
- 例：新浪财经 ifund 开放接口 num 参数 SQL 注入
- 词与词之间用空格，不要写「存在」，不要在末尾加「复测」「漏洞」「报告」
- 这是写报告，不是复测，全文不要出现「复测」

【正文】
- 纯文本。不要 Markdown
- 不要 # 标题，不要二级三级标题，不要表格，不要加粗
- 不要反引号，不要代码块，不要用三个反引号包住请求
- 先写结论，再写证据。每段不超过三句
- 禁止「值得注意的是」「综上所述」「此外」「同时」「我们」「笔者」
- 材料里没有的不要编。缺的写「未验证」

【数据包】
- 全文最后写一份可以直接复制发送的原始 HTTP 请求
- 从请求行开始，接着所有请求头，空一行，再写 body。没有 body 也要保留那个空行
- 这是截图前面的内容。请求写完就停，不要再写别的段落
- 不要写成 curl`;

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const FOLLOW_TEMPLATE = `用户提供了自己的模板。按模板的章节和版式填写，模板里的表格和标题保留，不要另起一套排版，不要增删章节。
全文不要出现「复测」。
模板里如果有请求或数据包的位置，把完整的原始 HTTP 请求填在那里：请求行、全部头、空行、body。没有这个位置就写在正文最后。不要用三个反引号把整篇或请求包起来。不要写成 curl。
材料里没有的不要编。禁止「值得注意的是」「综上所述」。`;

function promptFor(template) {
  return String(template || '').trim() ? FOLLOW_TEMPLATE : SYSTEM_PROMPT;
}

function buildMessages({ material, template, meta = {}, extra }) {
  const hasTpl = String(template || '').trim();
  const facts = [
    hasTpl ? `模板：\n${template}` : '',
    `系统名称：${meta.product || '从材料里的域名和页面推断'}`,
    `影响地址：${meta.url || '从材料里的请求行和 Host 推断'}`,
    `漏洞类型：${meta.type || '从材料推断'}`,
    `危害等级：${meta.level || '按实际影响面判定'}`,
    `日期：${meta.date || today()}`,
    '',
    '材料（请求、响应、现象、测试记录）：',
    material || '（无）',
    extra ? `\n其他要求：${extra}` : ''
  ].filter((x) => x !== '').join('\n');

  return [
    { role: 'system', content: promptFor(template) },
    {
      role: 'user',
      content: (hasTpl ? '按下面的模板和材料写报告。\n\n' : '按材料写报告。输出纯文本。\n\n') + facts
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
用户要求写报告时，直接输出纯文本正文，遵守下面的写作约束。`;

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
    { role: 'system', content: CHAT_SYSTEM + '\n\n' + promptFor(template) },
    { role: 'user', content: (facts ? facts + '\n\n' : '') + '用户：' + (question || '') }
  ];
}

function fillTemplate(body, vars) {
  return String(body || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (vars[k] == null ? '' : String(vars[k])));
}

function slugify(title) {
  const s = String(title || 'report')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/复测\s*$/g, '')
    .trim()
    .slice(0, 80);
  return s || 'report';
}

/** 去掉模型偶尔带上的表格、标题和代码标记。数据包保持原样换行。 */
function toPlain(markdown) {
  let s = String(markdown || '').replace(/\r\n/g, '\n');
  s = s.replace(/```[a-zA-Z0-9]*[ \t]*\n?/g, '');
  s = s.replace(/```/g, '');
  s = s.replace(/`([^`\n]+)`/g, '$1');
  s = s.replace(/^#{1,6}[ \t]+/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_\n]+)__/g, '$1');
  s = s.replace(/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/gm, '');
  s = s.replace(/^\|(.+)\|\s*$/gm, (_, inner) => inner.split('|').map((c) => c.trim()).filter(Boolean).join('  '));
  const lines = s.split('\n');
  if (lines[0]) lines[0] = lines[0].replace(/[\s]*复测\s*$/g, '').trim();
  s = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function imageFileName(src, index) {
  const ext = (path.extname(src) || '.png').toLowerCase();
  const use = ext === '.jpeg' ? '.jpg' : ext === '.png' || ext === '.jpg' || ext === '.webp' || ext === '.gif' ? ext : '.png';
  return `${String(index).padStart(2, '0')}${use}`;
}

/**
 * 组装 zip 内的文件：`<标题>/report.md` + `<标题>/images/01.png`。
 * 文末截图链接改成与压缩包内一致的相对路径。
 */
function bundle({ markdown, images = [], title = '' }) {
  const root = slugify(title);
  const names = [];
  const files = [];
  for (const src of images) {
    if (!src || !fs.existsSync(src)) continue;
    const name = imageFileName(src, names.length + 1);
    names.push(name);
    files.push({ name: `${root}/images/${name}`, data: fs.readFileSync(src) });
  }

  let md = toPlain(String(markdown || '').replace(/\n*## 截图[\s\S]*$/, ''));
  if (names.length) {
    md += '\n\n' + names.map((n) => `![](images/${n})`).join('\n\n') + '\n';
  } else {
    md += '\n';
  }
  files.unshift({ name: `${root}/report.md`, data: Buffer.from(md, 'utf8') });
  return { root, markdown: md, files, names };
}

/**
 * 写出文件夹，并在旁边打一个 zip。zip 根目录是标题。
 * @returns {{dir:string, md:string, zip:string, images:string[]}}
 */
function save({ markdown, images = [], title = '', baseDir }) {
  const packed = bundle({ markdown, images, title });
  const root = baseDir || path.join(require('os').homedir(), 'Documents', 'Refract');
  let name = packed.root;
  let dir = path.join(root, name);
  let n = 2;
  while (fs.existsSync(dir) || fs.existsSync(`${dir}.zip`)) {
    name = `${packed.root}-${n}`;
    dir = path.join(root, name);
    n += 1;
  }
  if (name !== packed.root) {
    packed.files.forEach((f) => {
      f.name = name + f.name.slice(packed.root.length);
    });
  }
  const imgDir = path.join(dir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });

  const mdPath = path.join(dir, 'report.md');
  fs.writeFileSync(mdPath, packed.markdown, 'utf8');
  const written = [];
  for (const f of packed.files) {
    if (!f.name.includes('/images/')) continue;
    const base = path.basename(f.name);
    fs.writeFileSync(path.join(imgDir, base), f.data);
    written.push(base);
  }

  const zipPath = `${dir}.zip`;
  fs.writeFileSync(zipPath, zip.write(packed.files));
  return { dir, md: mdPath, zip: zipPath, images: written };
}

module.exports = {
  SYSTEM_PROMPT,
  FOLLOW_TEMPLATE,
  CHAT_SYSTEM,
  buildMessages,
  buildChatMessages,
  fillTemplate,
  bundle,
  save,
  slugify,
  toPlain,
  today
};
