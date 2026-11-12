'use strict';
/**
 * 雷神众测整条链路的端到端测试：不需要真账号。
 *
 *   npm run test:e2e
 *
 * 起一个假平台（test/mock-platform.js，按前端 bundle 的真实约定回包），
 * 然后驱动真窗口走：填账号 → 图形码 → 邮箱验证码（假 IMAP）→ 换 token →
 * 拉类型/项目等级 → 生成 docx → 传图 + 传报告 → 提交。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'refract-e2e-'));

process.env.LEISHEN_API_BASE = 'http://127.0.0.1:8199/web/v1';
process.env.LEISHEN_ORIGIN = 'http://127.0.0.1:8199';
process.env.LEISHEN_IMAP_HOST = '127.0.0.1';
process.env.LEISHEN_IMAP_PORT = '9993';
process.env.REFRACT_DATA_DIR = path.join(WORK, 'data');

const mock = require('./mock-platform.js');
const { app, BrowserWindow } = require('electron');
require(path.join(ROOT, 'electron', 'main.js'));

const MD = [
  '漏洞提交模板', '',
  '漏洞标题', '某商城 order 接口 id 参数存在 SQL 注入', '',
  '漏洞等级', '高危', '',
  '漏洞等级自评依据', '可直接读取全库订单与用户手机号，符合高危项「可获取大量敏感数据」。', '',
  '漏洞类型', 'SQL注入', '',
  '漏洞URL', 'https://shop.example.com/api/order?id=1', '',
  '漏洞描述', 'order 接口 id 参数未过滤，单引号闭合后报错回显。', '',
  '漏洞危害', '可拖库，读取全部订单与用户手机号、地址。', '',
  '漏洞详情', 'GET /api/order?id=1%27 HTTP/1.1', 'Host: shop.example.com', '',
  '修复建议', '参数化查询，过滤 id。'
].join('\n');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const images = [1, 2].map((n) => {
  const p = path.join(WORK, 'shot-' + n + '.png');
  fs.writeFileSync(p, PNG);
  return p;
});

function fail(msg) {
  console.log('E2E 失败：' + msg);
  app.exit(1);
}

app.whenReady().then(async () => {
  await new Promise((r) => setTimeout(r, 3000));
  const win = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())[0];
  if (!win) return fail('没有窗口');

  const run = (code) => win.webContents.executeJavaScript(code, true).catch((e) => ({ error: String(e.message || e) }));

  const login = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await window.api.leishen.save({ email: 'me@qq.com', password: ${JSON.stringify(mock.PASSWORD)}, imapCode: 'imapcode', projectId: '11665' });
    document.querySelector('#navSettings').click();
    await sleep(300);
    document.querySelector('#settingsPop [data-sec="leishen"]').click();
    await sleep(500);
    document.getElementById('btnLsLogin').click();
    for (let i = 0; i < 50; i++) { await sleep(200); const img = document.getElementById('lsLoginCap'); if (img && img.src.startsWith('data:image')) break; }
    document.getElementById('lsLoginCode').value = ${JSON.stringify(mock.CAPTCHA_TEXT)};
    document.getElementById('lsLoginGo').click();
    let token = '';
    for (let i = 0; i < 200; i++) {
      await sleep(500);
      const c = await window.api.leishen.cfg();
      if (c.token) { token = c.token; break; }
      const note = document.getElementById('lsLoginNote').textContent;
      if (/失败|错误|超时/.test(note) && i > 6) return { error: note };
    }
    await sleep(1200);
    return { gotToken: !!token && token === ${JSON.stringify(mock.TOKEN)}, note: document.getElementById('lsLoginNote').textContent, types: (typeof LS !== 'undefined' && LS.types ? LS.types.length : -1) };
  })()`);
  if (!login || login.error || !login.gotToken) return fail('登录：' + JSON.stringify(login));

  const submit = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    S.reportMd = ${JSON.stringify(MD)};
    S.images = ${JSON.stringify(images)};
    document.getElementById('btnSubmit').click();
    for (let i = 0; i < 80; i++) { await sleep(200); const m = document.getElementById('lsSubmitModal'); if (m && !m.hidden) break; }
    if (document.getElementById('lsSubmitModal').hidden) return { error: '提交框没打开：' + document.getElementById('lsSubmitNote').textContent };
    const grades = Array.from(document.getElementById('lsGrade').options).map((o) => o.value);
    const types = Array.from(document.getElementById('lsType').options).map((o) => o.value).filter(Boolean);
    document.getElementById('lsSubmitCode').value = ${JSON.stringify(mock.CAPTCHA_TEXT)};
    document.getElementById('lsSubmitBtn').click();
    let note = '';
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      note = document.getElementById('lsSubmitNote').textContent;
      if (document.getElementById('lsSubmitModal').hidden) return { ok: true, grades, types };
      if (note && !/提交中|上传|生成 docx/.test(note)) return { ok: false, error: note, grades, types };
    }
    return { ok: false, error: '超时：' + note, grades, types };
  })()`);
  if (!submit || !submit.ok) return fail('提交：' + JSON.stringify(submit));

  const sent = mock.state.submitted[0] || {};
  const problems = [];
  if (mock.state.submitted.length !== 1) problems.push('平台没收到提交');
  if (sent.holegrade !== 'high') problems.push('等级不是 high：' + sent.holegrade);
  if (sent.holeCode !== sent.holegrade) problems.push('holeCode 和 holegrade 不一致');
  if (!sent.holeReport) problems.push('没带报告文件');
  let detail = '';
  try { detail = Buffer.from(String(sent.holedetail || ''), 'base64').toString('utf8'); } catch (e) { detail = ''; }
  if (!detail.startsWith('[[\u00a7p\u00a7]]')) problems.push('正文编码不对');
  if (!detail.includes('[[\u00a7img src=')) problems.push('正文里没有图片');
  if (!sent.judgeBasis) problems.push('没有自评依据');
  if (!sent.checkCode) problems.push('没有验证码');
  if (problems.length) return fail(problems.join('；'));

  console.log('E2E 通过：登录 → 类型 ' + login.types + ' 个 → 项目等级 ' + submit.grades.join('/') +
    ' → 传图 2 张 → docx 报告 ' + sent.holeReport + ' → 提交成功（' + String(sent.holetitle).slice(0, 20) + '…）');
  app.exit(0);
});
