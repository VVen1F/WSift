'use strict';
/**
 * 假雷神平台：按前端 bundle 里的真实约定回包，用来在没账号的情况下跑通
 * 「登录 → 拉类型/等级 → 传图/传 docx → 提交」整条链路。
 *   HTTP: http://127.0.0.1:8199/web/v1/*
 *   IMAP: tls://127.0.0.1:9993
 */
const http = require('http');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CERT_DIR = path.join(__dirname, 'certs');

const PORT = Number(process.env.MOCK_PORT || 8199);
const IMAP_PORT = Number(process.env.MOCK_IMAP_PORT || 9993);
const PASSWORD = process.env.MOCK_PASSWORD || 'mock-password';
const TOKEN = 'mock-' + 'token-123';
const CAPTCHA_TEXT = process.env.MOCK_CAPTCHA || '1234';

const state = {
  captcha: new Map(),
  mailCode: '',
  mails: [
    { uid: 1, from: 'news@qq.com', subject: '广告', body: 'hello' }
  ],
  seen: [],
  submitted: []
};

let captchaNo = 0;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function json(res, payload, code = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function authOk(req) {
  const t = req.headers.authorization || '';
  return t === TOKEN;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function multipartInfo(buf) {
  const text = buf.toString('latin1');
  const name = (/filename="([^"]*)"/.exec(text) || [])[1] || '';
  return { name, size: buf.length };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname.replace(/^\/web\/v1/, '');
  state.seen.push(req.method + ' ' + p);
  const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : Buffer.alloc(0);

  if (p === '/imageCode') {
    captchaNo += 1;
    const code = 'cap-' + captchaNo;
    state.captcha.set(code, CAPTCHA_TEXT);
    return json(res, { errcode: '0', errmsg: 'success', ret: { code, photo: 'data:image/png;base64,' + PNG.toString('base64') } });
  }

  if (p === '/portal/emailcode') {
    const email = url.searchParams.get('email') || '';
    const code = url.searchParams.get('code') || '';
    const text = url.searchParams.get('photoCode') || '';
    if (!state.captcha.has(code)) return json(res, { errcode: '200', errmsg: '图形验证码已过期' });
    if (state.captcha.get(code) !== text) return json(res, { errcode: '200', errmsg: '图形验证码错误' });
    state.mailCode = String(Math.floor(100000 + Math.random() * 900000));
    state.mails.push({
      uid: state.mails.length + 1,
      from: 'auth_thorsrc@dbappsecurity.com',
      subject: '【雷神众测】登录验证码',
      body: '您的验证码是 ' + state.mailCode + '，5 分钟内有效。'
    });
    console.log('[mock] emailcode -> ' + email + ' code ' + state.mailCode);
    return json(res, { errcode: '0', errmsg: 'success', ret: true });
  }

  if (p === '/portal/login') {
    let data = {};
    try { data = JSON.parse(body.toString('utf8') || '{}'); } catch (e) { data = {}; }
    const leishen = require(path.join(ROOT, 'electron', 'leishen.js'));
    if (data.password !== leishen.encryptPassword(PASSWORD) || !data.password) {
      return json(res, { errcode: '200', errmsg: '登录失败或未登录' });
    }
    if (String(data.checkcode || '') !== state.mailCode) {
      return json(res, { errcode: '200', errmsg: '邮箱验证码错误' });
    }
    return json(res, { errcode: '0', errmsg: 'success', ret: { token: TOKEN, email: data.email } });
  }

  // 以下都要登录
  if (p === '/bugcategory') {
    if (!authOk(req)) return json(res, { errcode: '200', errmsg: '权限鉴定失败' });
    return json(res, {
      errcode: '0',
      ret: {
        zh: [
          { label: 'Web漏洞', value: '', children: [{ label: 'SQL注入', value: 'SQL注入@@@11' }, { label: 'XSS', value: 'XSS@@@12' }] },
          { label: '逻辑漏洞', value: '', children: [{ label: '越权', value: '越权@@@21' }] }
        ]
      }
    });
  }

  if (p.startsWith('/setHole/getHoleLevel/')) {
    if (!authOk(req)) return json(res, { errcode: '200', errmsg: '权限鉴定失败' });
    // 真平台这个接口成功也回 errcode 200 + 「操作成功」，这里照样模拟
    return json(res, {
      errcode: 200,
      errmsg: '操作成功',
      ret: [
        { holeCode: 'urgent', holeLevelName: '紧急', holeDescription: 'd', holeMoney: 0, weight: 4 },
        { holeCode: 'high', holeLevelName: '高危', holeDescription: 'd', holeMoney: 0, weight: 3 },
        { holeCode: 'middle', holeLevelName: '中危', holeDescription: 'd', holeMoney: 0, weight: 2 }
      ]
    });
  }

  if (p === '/project/getProjectdetail') {
    if (!authOk(req)) return json(res, { errcode: '200', errmsg: '权限鉴定失败' });
    return json(res, { errcode: '0', ret: { data: { projectname: '测试项目', holeReportTemplate: 'https://cdn.test/tpl.docx' } } });
  }

  if (p === '/hacker/uploadHoleReport') {
    if (!authOk(req)) return json(res, { errcode: '200', errmsg: '权限鉴定失败' });
    const info = multipartInfo(body);
    if (!/\.docx$/i.test(info.name)) return json(res, { errcode: '200', errmsg: '仅支持 .docx 格式的文件' });
    if (!body.includes(Buffer.from('PK\u0003\u0004', 'binary'))) return json(res, { errcode: '200', errmsg: '文件不是 docx' });
    console.log('[mock] holeReport ' + info.name + ' ' + info.size + 'B');
    return json(res, { errcode: '0', errmsg: 'success', ret: 'uploaded-' + info.name });
  }

  if (p === '/portal/uploadfile') {
    if (!authOk(req)) return json(res, { errcode: '200', errmsg: '权限鉴定失败' });
    if (!body.includes(PNG)) return json(res, { errcode: '200', errmsg: '图片内容不对' });
    return json(res, { errcode: '0', errmsg: 'success', ret: 'https://cdn.test/' + Date.now() + '.png' });
  }

  if (p === '/hacker/submitBug' || p === '/hacker/saveDraft') {
    if (!authOk(req)) return json(res, { errcode: '200', errmsg: '权限鉴定失败' });
    let data = {};
    try { data = JSON.parse(body.toString('utf8') || '{}'); } catch (e) { data = {}; }
    const need = ['holetitle', 'holegrade', 'judgeBasis', 'bugtype', 'holeurl', 'holedescribe', 'holedanger', 'holedetail', 'repairpropose', 'holeReport', 'checkCode'];
    const missing = need.filter((k) => !String(data[k] || '').trim());
    if (missing.length) return json(res, { errcode: '200', errmsg: '保存漏洞失败（缺 ' + missing.join(',') + '）' });
    if (data.holeCode !== data.holegrade) return json(res, { errcode: '200', errmsg: '保存漏洞失败（holeCode 不一致）' });
    if (!/@@@/.test(data.bugtype) && data.bugtype !== 'SQL注入' && data.bugtype !== 'XSS' && data.bugtype !== '越权') {
      return json(res, { errcode: '200', errmsg: '保存漏洞失败（漏洞类型不存在）' });
    }
    let decoded = '';
    try { decoded = Buffer.from(String(data.holedetail || ''), 'base64').toString('utf8'); } catch (e) { decoded = ''; }
    if (!decoded.startsWith('[[\u00a7p\u00a7]]')) return json(res, { errcode: '200', errmsg: '保存漏洞失败（正文编码不对）' });
    if (p === '/hacker/saveDraft') {
      console.log('[mock] draft saved');
      return json(res, { errcode: '0', errmsg: '保存成功', ret: { id: 9 } });
    }
    if (!data.code) return json(res, { errcode: '200', errmsg: '验证码不能为空' });
    if (state.captcha.has(data.code) && state.captcha.get(data.code) !== data.checkCode) {
      return json(res, { errcode: '200', errmsg: '验证码错误' });
    }
    state.submitted.push(data);
    console.log('[mock] submit ok title=' + data.holetitle.slice(0, 30) + ' grade=' + data.holegrade + ' type=' + data.bugtype);
    return json(res, { errcode: '0', errmsg: '提交成功', ret: { id: 1001 } });
  }

  return json(res, { errcode: '404', errmsg: 'no such api: ' + p }, 404);
});

server.listen(PORT, '127.0.0.1', () => console.log('[mock] http on ' + PORT));

/* ---------------- 假 IMAP（TLS） ---------------- */

function rawMail(mail) {
  const head = [
    'From: ' + mail.from,
    'To: you@qq.com',
    'Subject: ' + mail.subject,
    'Date: ' + new Date().toUTCString(),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: 8bit'
  ].join('\r\n');
  return Buffer.from(head + '\r\n\r\n' + mail.body + '\r\n', 'utf8');
}

const imap = tls.createServer({
  key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')),
  cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem'))
}, (sock) => {
  let buf = '';
  let authed = false;
  sock.write('* OK fake IMAP ready\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const tag = (line.split(' ')[0] || '').trim();
      const rest = line.slice(tag.length + 1);
      const cmd = rest.split(' ')[0].toUpperCase();
      if (cmd === 'ID') {
        sock.write(tag + ' OK ID completed\r\n');
      } else if (cmd === 'LOGIN') {
        const pass = (/"[^"]*"$/.exec(rest) || [''])[0].replace(/"/g, '');
        if (pass === 'imapcode') {
          authed = true;
          sock.write(tag + ' OK LOGIN completed\r\n');
        } else {
          sock.write(tag + ' NO [AUTHENTICATIONFAILED] Invalid credentials\r\n');
        }
      } else if (cmd === 'SELECT') {
        sock.write('* ' + state.mails.length + ' EXISTS\r\n* OK [UIDVALIDITY 1] UIDs valid\r\n' + tag + ' OK [READ-WRITE] SELECT completed\r\n');
      } else if (cmd === 'UID' && /SEARCH/i.test(rest)) {
        sock.write('* SEARCH ' + state.mails.map((m) => m.uid).join(' ') + '\r\n' + tag + ' OK SEARCH completed\r\n');
      } else if (cmd === 'UID' && /FETCH/i.test(rest)) {
        const uid = Number((/FETCH (\d+)/i.exec(rest) || [])[1]);
        const mail = state.mails.find((m) => m.uid === uid);
        if (!mail) {
          sock.write(tag + ' OK FETCH completed\r\n');
        } else {
          const raw = rawMail(mail);
          sock.write('* 1 FETCH (UID ' + uid + ' BODY[] {' + raw.length + '}\r\n');
          sock.write(raw);
          sock.write(')\r\n' + tag + ' OK FETCH completed\r\n');
        }
      } else if (cmd === 'LOGOUT') {
        sock.write('* BYE\r\n' + tag + ' OK LOGOUT completed\r\n');
        sock.end();
      } else {
        sock.write(tag + ' OK ' + cmd + ' completed\r\n');
      }
    }
  });
  sock.on('error', () => {});
});
imap.listen(IMAP_PORT, '127.0.0.1', () => console.log('[mock] imap on ' + IMAP_PORT));

function close() {
  try { server.close(); } catch (e) { /* 忽略 */ }
  try { imap.close(); } catch (e) { /* 忽略 */ }
}

module.exports = { state, TOKEN, CAPTCHA_TEXT, PASSWORD, close, port: PORT, imapPort: IMAP_PORT };

if (require.main === module) {
  process.on('SIGTERM', () => { close(); process.exit(0); });
}
