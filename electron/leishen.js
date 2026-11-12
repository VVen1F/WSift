'use strict';
/**
 * 雷神众测（bountyteam.com）：登录换 token、图形/邮箱验证码、漏洞类型、上传、提交/存草稿。
 * 端口自两个 Python 包（leishen-login / leishen-submit），接口和字段名保持原样。
 */
const crypto = require('crypto');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const BASE = 'https://www.bountyteam.com/web/v1';
const ORIGIN = 'https://www.bountyteam.com';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const AES_KEY = Buffer.from('bceori33ptky987r', 'utf8');
const AES_IV = AES_KEY;

const IMAP_HOST = 'imap.qq.com';
const IMAP_PORT = 993;
const MAIL_SENDER = 'auth_thorsrc@dbappsecurity.com';

class LeishenError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LeishenError';
    if (code) this.code = code;
  }
}

/* ---------------- 密码加密 ---------------- */

/** 平台前端是 AES-CBC + 补 0 到 16 字节，再 base64。 */
function encryptPassword(plain) {
  const data = Buffer.from(String(plain == null ? '' : plain), 'utf8');
  const pad = 16 - (data.length % 16);
  const buf = Buffer.concat([data, Buffer.alloc(pad)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_IV);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(buf), cipher.final()]).toString('base64');
}

/* ---------------- HTTP ---------------- */

function headersFor(token, extra) {
  const h = { Origin: ORIGIN, Referer: ORIGIN + '/', 'User-Agent': USER_AGENT };
  if (token) h.Authorization = token;
  return Object.assign(h, extra || {});
}

async function request(method, apiPath, opts = {}) {
  const url = new URL(BASE + apiPath);
  if (opts.params) {
    for (const [k, v] of Object.entries(opts.params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers = headersFor(opts.token);
  const init = { method, headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res;
  try {
    res = await fetch(url, Object.assign(init, { signal: AbortSignal.timeout(opts.timeout || 25000) }));
  } catch (e) {
    throw new LeishenError('连不上雷神平台：' + (e.message || e));
  }
  let payload = null;
  try {
    payload = await res.json();
  } catch (e) {
    throw new LeishenError(`平台返回 HTTP ${res.status}（不是 JSON）`);
  }
  const code = String(payload && payload.errcode);
  const msg = String((payload && payload.errmsg) || '');
  // 平台把「token 过期」也放在 errcode 200 里，只能看文案
  if (code === '401' || code === '403' || (code !== '0' && /登录|权限|失效|未登录/.test(msg))) {
    throw new LeishenError(msg || '登录已失效', 'AUTH');
  }
  if (!opts.allowError && code !== '0') {
    throw new LeishenError(msg || '平台返回错误', 'API');
  }
  return payload;
}

/* ---------------- 图形验证码 ---------------- */

/** 提交表单认 /imageCode（4 位字母数字），/captcha/generate 会一直报验证码错误。 */
async function imageCode() {
  const j = await request('GET', '/imageCode');
  const ret = (j && j.ret) || {};
  return { code: String(ret.code || ''), image: String(ret.photo || '') };
}

/* ---------------- 图形码识别（可选，装了 ddddocr 才用） ---------------- */

let ocrState = null;

/** 本机有没有 python3 + ddddocr。有就能自动识别验证码，没有就手动填。 */
function ocrReady() {
  if (ocrState !== null) return Promise.resolve(ocrState);
  return new Promise((resolve) => {
    execFile('python3', ['-c', 'import ddddocr, PIL; print("ok")'], { timeout: 20000 }, (err, out) => {
      ocrState = !err && /ok/.test(String(out || ''));
      resolve(ocrState);
    });
  });
}

/**
 * 把验证码图片交给 ddddocr 识别。默认调用本机 python3，
 * 测试时可以传 opts.cmd / opts.args 换成别的东西。
 */
function ocrImage(png, opts = {}) {
  const code = [
    'import sys, base64, re',
    'import ddddocr',
    'raw = base64.b64decode(sys.stdin.read())',
    'engine = ddddocr.DdddOcr(show_ad=False)',
    'print(re.sub(r"[^0-9a-zA-Z]", "", engine.classification(raw) or ""))'
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(opts.cmd || 'python3', opts.args || ['-c', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.once('error', reject);
    child.once('close', (code0) => {
      const text = String(out).trim();
      if (code0 === 0 && text) return resolve(text);
      reject(new Error(String(err || '验证码没认出来').trim().split('\n')[0].slice(0, 120)));
    });
    child.stdin.end(Buffer.isBuffer(png) ? png.toString('base64') : String(png || ''));
  });
}

/* ---------------- 登录 ---------------- */

async function sendEmailCode({ email, code, text }) {
  const j = await request('GET', '/portal/emailcode', {
    params: { email: email || '', photoCode: text || '', code: code || '' },
    allowError: true
  });
  return String(j && j.errcode) === '0';
}

async function loginWithCode({ email, password, checkcode }) {
  const j = await request('POST', '/portal/login', {
    body: {
      email: email || '',
      password: encryptPassword(password || ''),
      checkcode: checkcode || ''
    },
    allowError: true
  });
  if (String(j && j.errcode) !== '0') {
    let msg = String((j && j.errmsg) || '登录失败');
    if (msg === '登录失败或未登录') msg = '平台密码不正确';
    throw new LeishenError(msg, 'LOGIN');
  }
  const token = String(((j && j.ret) || {}).token || '');
  if (!token) throw new LeishenError('登录成功但没拿到 token');
  return token;
}

/* ---------------- IMAP 取邮箱验证码 ---------------- */

class Imap {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.tagNo = 0;
    this.waiters = [];
    this.failed = null;
    sock.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      const list = this.waiters;
      this.waiters = [];
      list.forEach((w) => w());
    });
    sock.on('error', (e) => { this.failed = e; this.flush(); });
    sock.on('close', () => { this.failed = this.failed || new Error('邮箱连接断开'); this.flush(); });
  }
  flush() {
    const list = this.waiters;
    this.waiters = [];
    list.forEach((w) => w());
  }
  more(ms) {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('邮箱没有响应')), ms || 20000);
      this.waiters.push(() => {
        clearTimeout(timer);
        if (this.failed) reject(this.failed);
        else resolve();
      });
    });
  }
  async readLine(ms) {
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i >= 0) {
        const line = this.buf.slice(0, i).toString('utf8');
        this.buf = this.buf.slice(i + 2);
        return line;
      }
      await this.more(ms);
    }
  }
  async readExact(n, ms) {
    while (this.buf.length < n) await this.more(ms);
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
  async cmd(text, ms) {
    const tag = 'a' + ++this.tagNo;
    this.sock.write(`${tag} ${text}\r\n`);
    const lines = [];
    for (;;) {
      const line = await this.readLine(ms);
      if (line.startsWith(tag + ' ')) {
        return { ok: /^\S+ OK/i.test(line), lines, line };
      }
      lines.push(line);
    }
  }
  async fetchBody(uid, ms) {
    const tag = 'a' + ++this.tagNo;
    this.sock.write(`${tag} UID FETCH ${uid} (BODY.PEEK[])\r\n`);
    let body = null;
    for (;;) {
      const line = await this.readLine(ms);
      if (line.startsWith(tag + ' ')) break;
      const m = /\{(\d+)\}$/.exec(line.trim());
      if (m && !body) {
        body = await this.readExact(Number(m[1]), ms);
        await this.readLine(ms); // 收尾的 ")"
      }
    }
    return body;
  }
  close() {
    try { this.sock.write('a999 LOGOUT\r\n'); } catch (e) { /* 忽略 */ }
    try { this.sock.end(); } catch (e) { /* 忽略 */ }
  }
}

function quote(v) {
  return '"' + String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

async function openInbox(email, imapCode, timeout = 20000) {
  const sock = await new Promise((resolve, reject) => {
    const s = tls.connect({ host: IMAP_HOST, port: IMAP_PORT, servername: IMAP_HOST, rejectUnauthorized: false }, () => resolve(s));
    s.setTimeout(timeout, () => s.destroy(new Error('连不上 QQ 邮箱')));
    s.once('error', reject);
  });
  const conn = new Imap(sock);
  const greet = await conn.readLine(timeout);
  if (!/^\* OK/i.test(greet)) throw new Error('邮箱没有正常应答：' + greet.slice(0, 60));
  const id = await conn.cmd('ID ("name" "Refract" "version" "1.0")', timeout).catch(() => null);
  const login = await conn.cmd(`LOGIN ${quote(email)} ${quote(imapCode)}`, timeout);
  if (!login.ok) {
    const msg = login.line || '';
    conn.close();
    if (/AUTHENTICATIONFAILED|LOGIN failed|invalid/i.test(msg)) throw new Error('邮箱授权码不对（不是 QQ 密码）');
    throw new Error('邮箱登录失败：' + msg.slice(0, 80));
  }
  const sel = await conn.cmd('SELECT INBOX', timeout);
  if (!sel.ok) {
    conn.close();
    throw new Error('邮箱打不开，检查授权码');
  }
  return conn;
}

async function latestUid(email, imapCode) {
  const conn = await openInbox(email, imapCode);
  try {
    const r = await conn.cmd('UID SEARCH ALL');
    const line = (r.lines || []).find((l) => /^\* SEARCH/i.test(l)) || '';
    const ids = line.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean);
    return ids.length ? Number(ids[ids.length - 1]) || 0 : 0;
  } finally {
    conn.close();
  }
}

function decodeQuotedPrintable(src) {
  const bytes = [];
  const text = String(src).replace(/=\r?\n/g, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function decodePart(body, encoding) {
  const enc = String(encoding || '').toLowerCase();
  if (enc.includes('base64')) {
    try { return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8'); } catch (e) { return body; }
  }
  if (enc.includes('quoted-printable')) return decodeQuotedPrintable(body);
  return body;
}

function headerValue(headers, name) {
  const m = new RegExp('^' + name + ':[ \\t]*(.*)$', 'im');
  const hit = m.exec(headers);
  return hit ? hit[1].trim() : '';
}

/** 从邮件里抠 6 位验证码：先找「验证码/校验码」附近，再退回第一个 6 位串。 */
function codeFromMail(raw) {
  const text = String(raw || '');
  const cut = text.indexOf('\r\n\r\n');
  const head = cut >= 0 ? text.slice(0, cut) : '';
  const bodyRaw = cut >= 0 ? text.slice(cut + 4) : text;
  const encoding = headerValue(head, 'Content-Transfer-Encoding');
  const decoded = decodePart(bodyRaw, encoding);
  const flat = decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const near = /(?:验证码|校验码|verification\s*code)[^0-9A-Za-z]{0,30}([0-9A-Za-z]{6})/i.exec(flat);
  if (near) return near[1];
  const any = /\b([0-9A-Za-z]{6})\b/.exec(flat);
  return any ? any[1] : '';
}

async function fetchLatestCode(email, imapCode, opts = {}) {
  const afterUid = Number(opts.afterUid) || 0;
  const since = Number(opts.since) || Date.now() / 1000 - 5;
  const deadline = Date.now() + (Number(opts.timeout) || 90) * 1000;
  const conn = await openInbox(email, imapCode);
  try {
    while (Date.now() < deadline) {
      const r = await conn.cmd('UID SEARCH ALL');
      const line = (r.lines || []).find((l) => /^\* SEARCH/i.test(l)) || '';
      const uids = line.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean).map(Number);
      for (const uid of uids.slice(-15).reverse()) {
        if (uid <= afterUid) break;
        const raw = await conn.fetchBody(uid);
        if (!raw) continue;
        const text = raw.toString('utf8');
        const cut = text.indexOf('\r\n\r\n');
        const head = cut >= 0 ? text.slice(0, cut) : text;
        const from = headerValue(head, 'From').toLowerCase();
        if (!from.includes(MAIL_SENDER) && !from.includes('雷神')) continue;
        const code = codeFromMail(text);
        if (code) return code;
      }
      await new Promise((r2) => setTimeout(r2, 3000));
    }
  } finally {
    conn.close();
  }
  throw new Error('等邮箱验证码超时（检查授权码、垃圾箱、发件人白名单）');
}

/* ---------------- 漏洞类型 ---------------- */

async function bugTypes(token) {
  const data = await request('GET', '/bugcategory', { token, allowError: true });
  const ret = (data && data.ret) || {};
  const tree = ret.zh || ret;
  const rows = [];
  const walk = (nodes, prefix) => {
    for (const node of nodes || []) {
      if (!node || typeof node !== 'object') continue;
      const label = String(node.label || '');
      const value = String(node.value || '');
      const title = prefix ? prefix + ' / ' + label : label;
      const children = node.children || [];
      if (children.length) walk(children, title);
      else if (value) rows.push({ id: value.split('@@@')[0].slice(0, 80), name: label, path: title.slice(0, 80) });
    }
  };
  walk(Array.isArray(tree) ? tree : [], '');
  return rows;
}

/* ---------------- 上传 ---------------- */

function mimeFor(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.doc')) return 'application/msword';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

async function upload(token, apiPath, field, filename, raw, mime, timeout = 60000) {
  const boundary = '----leishen' + crypto.randomBytes(8).toString('hex');
  const safe = String(filename || 'file').replace(/"/g, '').slice(0, 80);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${safe}"\r\n` +
    `Content-Type: ${mime || mimeFor(safe)}\r\n\r\n`, 'utf8');
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw)), tail]);
  let res;
  try {
    res = await fetch(BASE + apiPath, {
      method: 'POST',
      headers: headersFor(token, { 'Content-Type': `multipart/form-data; boundary=${boundary}` }),
      body,
      signal: AbortSignal.timeout(timeout)
    });
  } catch (e) {
    throw new LeishenError('上传时连不上平台：' + (e.message || e));
  }
  try {
    return await res.json();
  } catch (e) {
    throw new LeishenError(`上传返回 HTTP ${res.status}（不是 JSON）`);
  }
}

function assertUploadOk(payload, fallback) {
  const code = String(payload && payload.errcode);
  if (code === '0') return;
  const msg = String((payload && payload.errmsg) || fallback || '上传失败');
  // 上传接口同样把登录失效放在 errcode 200 里
  if (code === '401' || code === '403' || /登录|权限|失效/.test(msg)) throw new LeishenError(msg, 'AUTH');
  throw new LeishenError(msg.slice(0, 200), 'UPLOAD');
}

async function uploadReport(token, filename, raw) {
  const payload = await upload(token, '/hacker/uploadHoleReport', 'file', filename, raw, mimeFor(filename));
  assertUploadOk(payload, '报告上传失败');
  return String((payload && payload.ret) || '');
}

async function uploadImage(token, filename, raw) {
  const payload = await upload(token, '/portal/uploadfile', 'myFileName', filename, raw, mimeFor(filename));
  assertUploadOk(payload, '图片上传失败');
  let ret = payload.ret;
  if (ret && typeof ret === 'object') ret = ret.url || ret.src || ret.path || '';
  const url = String(ret || '').trim();
  if (!url) throw new LeishenError('图片上传没有返回地址');
  return url;
}

/* ---------------- 正文编码 ---------------- */

/** 平台正文不是直接存 HTML：<p>/<br>/<img> 换成占位符，再整体 base64。 */
function encodeHoleDetail(html) {
  let text = String(html || '');
  text = text.replace(/<img [^>]*src=['"]([^'"]+)[^>]*>/gi, (m, src) => `[[§img src="${src}"§]]`);
  text = text.replace(/<p>/g, '[[§p§]]').replace(/<\/p>/g, '[[§/p§]]');
  text = text.replace(/<br>/g, '[[§br§]]').replace(/<br\/>/g, '[[§br§]]');
  text = text.replace(/<a[^>]*>/g, '').replace(/<\/a>/g, '').replace(/\n/g, '[[§br§]]');
  return Buffer.from(text, 'utf8').toString('base64');
}

// 平台前端只有这四档（见提交页的等级表），没有 serious
const GRADES = { urgent: '紧急', high: '高危', middle: '中危', low: '低危' };
const GRADE_BY_TEXT = { 紧急: 'urgent', 严重: 'urgent', 高危: 'high', 中危: 'middle', 低危: 'low' };

function gradeKey(text) {
  const t = String(text || '').trim();
  if (GRADE_BY_TEXT[t]) return GRADE_BY_TEXT[t];
  const low = t.toLowerCase();
  if (low === 'serious') return 'urgent';
  if (['urgent', 'high', 'middle', 'low'].includes(low)) return low;
  return 'high';
}

function makeFields(f = {}) {
  const grade = gradeKey(f.grade);
  return {
    holetitle: String(f.title || '').trim(),
    holegrade: grade,
    holeCode: grade,
    judgeBasis: String(f.judgeBasis || ''),
    bugtype: String(f.bugtype || ''),
    holeurl: String(f.url || '').trim(),
    holedescribe: String(f.describe || '').trim(),
    holedanger: String(f.danger || '').trim(),
    holedetail: String(f.detailHtml || ''),
    repairpropose: String(f.repair || '').trim(),
    POC: '',
    projectid: String(f.projectId || '').trim()
  };
}

/**
 * 正文里先传图拿到平台地址，再把图拼进 HTML、编码成平台要的形态。
 * images: [{ path }]，返回上传后的地址数组。
 */
async function buildDetail(token, fields, images, opts = {}) {
  const urls = [];
  for (const item of images || []) {
    const file = typeof item === 'string' ? item : item && item.path;
    if (!file || !fs.existsSync(file)) continue;
    const url = await uploadImage(token, path.basename(file), fs.readFileSync(file));
    urls.push(url);
  }
  const parts = [];
  const blocks = String(fields.holedetail || '').split(/\n{2,}/);
  for (const block of blocks) {
    const text = block.trim().split(/\n/).map((l) => l.replace(/^#+\s*/, '')).join('\n').trim();
    if (!text) continue;
    parts.push('<p>' + escapeHtml(text).replace(/\n/g, '<br>') + '</p>');
  }
  for (const url of urls) parts.push(`<p><img src="${url}"></p>`);
  const payload = Object.assign({}, fields, { holedetail: encodeHoleDetail(parts.join('')) });
  if (opts.reportBytes && opts.reportName) {
    // 平台只收 .docx，这里传主进程刚生成的那份
    payload.holeReport = await uploadReport(token, opts.reportName, opts.reportBytes);
  } else if (opts.reportFile && fs.existsSync(opts.reportFile)) {
    const name = path.basename(opts.reportFile);
    payload.holeReport = await uploadReport(token, name, fs.readFileSync(opts.reportFile));
  }
  return payload;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function submit(token, payload, draft) {
  const apiPath = draft ? '/hacker/saveDraft' : '/hacker/submitBug';
  const body = Object.assign({}, payload);
  if (!String(body.id || '').trim()) delete body.id;
  const data = await request('POST', apiPath, { token, body, allowError: true });
  if (String((data && data.errcode)) !== '0') {
    throw new LeishenError(String((data && data.errmsg) || (draft ? '没有存成草稿' : '没有提交成功')).slice(0, 200), 'SUBMIT');
  }
  return data;
}

/* ---------------- 把我们的报告解析成平台字段 ---------------- */

// 长的放前面：否则「漏洞等级自评依据」会被「漏洞等级」先吃掉
const SECTION_RE = /^[\s#*　]*([一二三四五六七八九十]+[、.．]|){0,1}\s*(漏洞等级自评依据|漏洞名称|漏洞标题|漏洞类型|漏洞级别|漏洞等级|漏洞描述|漏洞详情|漏洞危害|危害分析|危害说明|复现步骤|漏洞证明|修复建议|修复方案|漏洞URL|漏洞url|目标网站URL|受影响URL|影响地址|自评依据|标题|等级)\s*[:：]?\s*(.*)$/;

function cleanLine(line) {
  // 报告里常混进零宽空格、全角空格、BOM，先清掉再认字段
  return String(line || '').replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').replace(/^[\s\u3000]+/, '').trimEnd();
}

function sectionMap(md) {
  const out = {};
  const lines = String(md || '').split(/\r?\n/).map(cleanLine);
  let current = null;
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (m && m[2]) {
      const key = m[2].replace(/\s/g, '');
      const inline = (m[3] || '').trim();
      current = key;
      out[current] = out[current] || [];
      if (inline) out[current].push(inline);
      continue;
    }
    if (current) out[current].push(line);
  }
  const pick = (...keys) => {
    for (const k of keys) {
      const v = out[k];
      if (v && v.join('\n').trim()) return v.join('\n').trim();
    }
    return '';
  };
  return { pick, raw: out };
}

/** 从生成的纯文本报告里解析出提交表单要的字段。 */
function parseReport(md) {
  const { pick } = sectionMap(md);
  const text = String(md || '');
  const firstLine = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const cleanTitle = (s) => String(s || '')
    .replace(/^#+\s*/, '')
    .replace(/^(漏洞名称|漏洞标题|报告名称|标题|名称)\s*[:：]\s*/, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 80);

  let title = cleanTitle(pick('漏洞名称', '漏洞标题', '标题'));
  if (!title) title = cleanTitle(firstLine);

  const gradeText = pick('漏洞级别', '漏洞等级', '等级') || (/(严重|高危|中危|低危)/.exec(text) || [])[1] || '';
  const typeText = pick('漏洞类型');

  const urlM = /https?:\/\/[^\s'"<>）)]+/.exec(pick('漏洞URL', '目标网站URL', '影响地址', '受影响URL') || text);
  const hostM = /^\s*host:\s*(\S+)/im.exec(text);
  const url = urlM ? urlM[0] : (hostM ? 'https://' + hostM[1] : '');

  let describe = pick('漏洞描述') || '';
  let danger = pick('漏洞危害', '危害分析', '危害说明') || '';
  const repair = pick('修复建议', '修复方案') || '';
  const judgeBasis = pick('漏洞等级自评依据', '自评依据') || '';

  // 老模板没有「描述/危害」两段时，用正文兜底：描述取第一个数据包之前的段落
  const bodyText = String(pick('漏洞详情', '漏洞证明', '复现步骤') || text);
  if (!describe) {
    const firstReq = bodyText.search(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\//m);
    const head = (firstReq > 0 ? bodyText.slice(0, firstReq) : bodyText).trim();
    describe = (head || bodyText).split(/\n{2,}/).filter((s) => s.trim()).slice(0, 2).join('\n').slice(0, 600);
  }
  if (!danger) {
    const hit = /[^\n]*(?:危害|影响|可被|可读取|可接管)[^\n]*/m.exec(bodyText);
    danger = hit ? hit[0].trim().slice(0, 400) : '';
  }

  // 正文：优先用「漏洞证明/复现步骤/漏洞详情」，没有就把全文塞进去
  let detail = pick('漏洞详情', '漏洞证明', '复现步骤');
  if (!detail) detail = text;

  return {
    title: title || '漏洞报告',
    grade: gradeKey(gradeText),
    gradeText: gradeText || GRADES[gradeKey(gradeText)],
    typeText,
    url,
    describe: describe.slice(0, 2000),
    danger: danger.slice(0, 2000),
    repair: repair.slice(0, 2000),
    judgeBasis: judgeBasis.slice(0, 500),
    detail
  };
}

/** 用平台的类型列表猜一个「漏洞类型」，猜不到就留空让人选。 */
function guessBugType(typeText, types) {
  const list = types || [];
  const hay = String(typeText || '').toLowerCase();
  if (!hay) return '';
  for (const t of list) {
    const name = String(t.name || '').toLowerCase();
    if (name && hay.includes(name)) return t.id;
  }
  const table = [
    [['sql', '注入'], ['sql注入', 'sql']],
    [['xss', '跨站'], ['xss', '跨站']],
    [['越权', '未授权', '权限'], ['越权', '未授权', '权限']],
    [['ssrf'], ['ssrf']],
    [['上传'], ['上传']],
    [['信息泄露', '敏感信息'], ['信息泄露', '敏感']],
    [['csrf'], ['csrf']],
    [['命令执行', 'rce'], ['命令执行', 'rce', '代码执行']],
    [['逻辑'], ['逻辑']],
    [['cors'], ['cors']]
  ];
  for (const [keys, wants] of table) {
    if (!keys.some((k) => hay.includes(k))) continue;
    const hit = list.find((t) => wants.some((w) => String(t.path || t.name || '').toLowerCase().includes(w)));
    if (hit) return hit.id;
  }
  return '';
}

module.exports = {
  BASE,
  ORIGIN,
  GRADES,
  GRADES_TEXT: GRADE_BY_TEXT,
  gradeKey,
  encryptPassword,
  request,
  imageCode,
  ocrReady,
  ocrImage,
  sendEmailCode,
  loginWithCode,
  fetchLatestCode,
  latestUid,
  codeFromMail,
  bugTypes,
  uploadReport,
  uploadImage,
  encodeHoleDetail,
  makeFields,
  buildDetail,
  submit,
  parseReport,
  guessBugType,
  LeishenError
};
