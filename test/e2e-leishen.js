'use strict';
/**
 * 雷神众测整条链路的端到端测试：不需要真账号。
 *
 *   npm run test:e2e
 *
 * 起一个假平台（test/mock-platform.js，按实测契约回包），驱动真窗口走：
 * 加两个账号 → 选 A 登录（图形码 + 假 IMAP 收邮箱码）→ 换 token →
 * 拉类型 → 选账号/项目/等级 → 传图 → 提交；
 * 中途切到 B 账号，确认项目列表跟着变、只列参与中的项目。
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

  // 1) 加两个账号，分别登录
  const login = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const a = await window.api.leishen.accountSave({ email: 'a@qq.com', password: ${JSON.stringify(mock.PASSWORD)}, imapCode: 'imapcode' });
    const b = await window.api.leishen.accountSave({ email: 'b@qq.com', password: ${JSON.stringify(mock.PASSWORD)}, imapCode: 'imapcode' });
    await lsLoadAccounts();
    document.querySelector('#navSettings').click();
    await sleep(300);
    document.querySelector('#settingsPop [data-sec="leishen"]').click();
    await sleep(500);

    const doLogin = async (id) => {
      lsOpenLogin(id);
      for (let i = 0; i < 60; i++) { await sleep(200); const img = document.getElementById('lsLoginCap'); if (img && img.src.startsWith('data:image')) break; }
      document.getElementById('lsLoginCode').value = ${JSON.stringify(mock.CAPTCHA_TEXT)};
      document.getElementById('lsLoginGo').click();
      for (let i = 0; i < 200; i++) {
        await sleep(500);
        const r = await window.api.leishen.accounts();
        const acc = (r.list || []).find((x) => x.id === id);
        if (acc && acc.loggedIn) return true;
        const note = document.getElementById('lsLoginNote').textContent;
        if (/失败|错误|超时/.test(note) && i > 6) return note;
      }
      return 'timeout';
    };

    const ra = await doLogin(a.id);
    const rb = await doLogin(b.id);
    await lsLoadAccounts();
    // 渲染进程的整包回写不能把账号冲掉（以前会）
    const before = (await window.api.leishen.accounts()).list.length;
    persist();
    await sleep(600);
    const after = (await window.api.leishen.accounts()).list.length;
    return { a: ra, b: rb, accounts: LS.accounts.length, rows: document.querySelectorAll('#lsAccounts .ls-acc').length, aId: a.id, bId: b.id, before, after };
  })()`);
  if (!login || login.error) return fail('登录：' + JSON.stringify(login));
  if (login.a !== true || login.b !== true) return fail('两个账号没都登录上：' + JSON.stringify(login));
  if (login.accounts !== 2 || login.rows !== 2) return fail('账号列表：' + JSON.stringify(login));
  if (login.before !== 2 || login.after !== 2) return fail('persist 把账号冲掉了：' + JSON.stringify(login));

  // 2) 打开提交框：先列项目（跨账号并集），选项目后再筛账号
  const dialog = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    S.reportMd = ${JSON.stringify(MD)};
    S.images = ${JSON.stringify(images)};
    await lsOpenSubmit();
    for (let i = 0; i < 100; i++) { await sleep(200); const m = document.getElementById('lsSubmitModal'); if (m && !m.hidden) break; }
    if (document.getElementById('lsSubmitModal').hidden) return { error: '提交框没打开：' + document.getElementById('lsSubmitNote').textContent };
    await sleep(1200);
    const opts = (sel) => Array.from(document.getElementById(sel).options).map((o) => o.value).filter(Boolean);
    const projects = opts('lsProjectSel');
    const pick = async (pid) => {
      const s = document.getElementById('lsProjectSel');
      s.value = pid;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(1500);
    };
    await pick('11655');
    const accFor11655 = opts('lsAccount');
    const grades11655 = opts('lsGrade');
    await pick('11665');
    const accFor11665 = opts('lsAccount');
    // 换成第二个账号（B）看等级能不能拉
    const accSel = document.getElementById('lsAccount');
    accSel.value = accSel.options[1] ? accSel.options[1].value : accSel.value;
    accSel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1200);
    const gradesForB = opts('lsGrade');
    return { projects, accFor11655, accFor11665, grades11655, gradesForB, typeVal: document.getElementById('lsType').value, note: document.getElementById('lsSubmitNote').textContent };
  })()`);
  if (!dialog || dialog.error) return fail('提交框：' + JSON.stringify(dialog));
  if (!dialog.projects.includes('11665') || !dialog.projects.includes('11655')) return fail('项目列表不对：' + JSON.stringify(dialog.projects));
  if (dialog.projects.includes('11653')) return fail('已结束的项目不该出现：' + JSON.stringify(dialog.projects));
  if (dialog.accFor11655.length !== 1) return fail('11655 只该有 A 一个账号：' + JSON.stringify(dialog.accFor11655));
  if (dialog.accFor11665.length !== 2) return fail('11665 该有 A、B 两个账号：' + JSON.stringify(dialog.accFor11665));
  if (dialog.grades11655.length < 2 || dialog.gradesForB.length < 2) return fail('等级没拉出来：' + JSON.stringify(dialog));
  if (dialog.typeVal !== 'SQL注入') return fail('类型没按报告自动选中：' + JSON.stringify(dialog.typeVal));

  // 3) 连点两下只能发一次
  const race = await run(`(async () => {
    const payload = {
      draft: true,
      accountId: ${JSON.stringify(login.aId)},
      reportMarkdown: '标题\\n\\n正文一段',
      fields: { title: '并发测试', grade: 'high', bugtype: 'SQL注入', projectId: '11665', url: 'https://x/y?id=1', describe: '描述', danger: '危害', detailHtml: '正文', repair: '修复', judgeBasis: '依据' },
      images: [],
      captcha: { code: 'race-cap', text: '1234' }
    };
    let out = [];
    try {
      out = await Promise.all([window.api.leishen.submit(payload), window.api.leishen.submit(payload)]);
    } catch (e) {
      return { threw: String((e && e.message) || e) };
    }
    return { okCount: out.filter((x) => x && x.ok).length, blocked: out.filter((x) => x && /别重复点|还在提交/.test(x.error || '')).length, errors: out.map((x) => x && x.error) };
  })()`);
  if (!race || race.okCount !== 1 || race.blocked !== 1) return fail('连点保护：' + JSON.stringify(race));

  // 4) 正常提交
  const submit = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ps = document.getElementById('lsProjectSel');
    ps.value = '11665';
    ps.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1500);
    const accSel = document.getElementById('lsAccount');
    if (accSel.options.length) { accSel.value = accSel.options[0].value; accSel.dispatchEvent(new Event('change', { bubbles: true })); }
    await sleep(1200);
    document.getElementById('lsSubmitCode').value = ${JSON.stringify(mock.CAPTCHA_TEXT)};
    document.getElementById('lsSubmitBtn').click();
    let note = '';
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      note = document.getElementById('lsSubmitNote').textContent;
      if (document.getElementById('lsSubmitModal').hidden) return { ok: true };
      if (note && !/提交中|上传/.test(note)) return { ok: false, error: note };
    }
    return { ok: false, error: '超时：' + note };
  })()`);
  if (!submit || !submit.ok) return fail('提交：' + JSON.stringify(submit));

  const sent = mock.state.submitted[0] || {};
  const problems = [];
  if (mock.state.submitted.length !== 1) problems.push('平台没收到提交');
  if (sent.holegrade !== 'high') problems.push('等级不是 high：' + sent.holegrade);
  if (sent.holeCode !== sent.holegrade) problems.push('holeCode 和 holegrade 不一致');
  if (sent.holeReport) problems.push('不该带附件，但带了：' + sent.holeReport);
  let detail = '';
  try { detail = Buffer.from(String(sent.holedetail || ''), 'base64').toString('utf8'); } catch (e) { detail = ''; }
  if (!detail.startsWith('[[\u00a7p\u00a7]]')) problems.push('正文编码不对');
  if (!detail.includes('[[\u00a7img src=')) problems.push('正文里没有图片');
  if (!sent.judgeBasis) problems.push('没有自评依据');
  if (!sent.checkCode) problems.push('没有验证码');
  if (String(sent.projectid) !== '11665') problems.push('项目 id 不对：' + sent.projectid);
  if (problems.length) return fail(problems.join('；'));

  console.log('E2E 通过：两个账号 → 项目 ' + dialog.projects.join('/') + ' → 11655 账号 ' + dialog.accFor11655.length +
    ' → 11665 账号 ' + dialog.accFor11665.length + ' → 等级 ' + dialog.grades11655.join('/') +
    ' → 传图 2 张 → 提交成功（正文文字 + 图片，无附件）');
  app.exit(0);
});
