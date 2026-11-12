'use strict';
/**
 * 用现成的 token / cookie 直接验证平台接口（只读，不会提交任何东西）。
 *
 *   node test/probe.js <token 或 cookie> [项目id]
 *
 * 支持三种给法：
 *   1. 纯 token            a1b2c3...
 *   2. 整段 cookie         jwtToken=a1b2c3...; other=xx
 *   3. 浏览器复制的一行    Authorization: a1b2c3...
 *
 * 会依次问：图形码（不要 token）、类型树、我的项目、项目等级、项目详情，
 * 并把 errcode/errmsg/ret 的形状打出来，方便对照「0 成功 / 200 下是哪种失败」。
 */
const path = require('path');

const BASE = process.env.LEISHEN_API_BASE || 'https://www.bountyteam.com/web/v1';
const ORIGIN = process.env.LEISHEN_ORIGIN || 'https://www.bountyteam.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

function tokenFrom(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const jwt = /(?:^|[;\s])jwtToken=([^;\s]+)/i.exec(text);
  if (jwt) return jwt[1].replace(/^"|"$/g, '');
  const auth = /^authorization:\s*(.+)$/i.exec(text);
  if (auth) return auth[1].trim();
  return text.replace(/^Bearer\s+/i, '').trim();
}

async function call(method, apiPath, token, params) {
  const url = new URL(BASE + apiPath);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  const headers = { Origin: ORIGIN, Referer: ORIGIN + '/', 'User-Agent': UA, Accept: 'application/json' };
  if (token) headers.Authorization = token;
  const res = await fetch(url, { method, headers, signal: AbortSignal.timeout(20000) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = { __raw: text.slice(0, 200) }; }
  return { status: res.status, json };
}

function shape(value) {
  if (Array.isArray(value)) return 'list[' + value.length + ']';
  if (value === null) return 'null';
  if (typeof value === 'object') return 'object{' + Object.keys(value).slice(0, 6).join(',') + '}';
  return typeof value;
}

function report(name, r) {
  const j = r.json || {};
  const code = j.errcode;
  const msg = j.errmsg;
  const ret = j.ret;
  const mark = String(code) === '0' ? '成功' : '失败';
  console.log(`${name}
  HTTP ${r.status}  errcode=${code}  errmsg=${msg}  [${mark}]
  ret=${shape(ret)}`);
  if (Array.isArray(ret) && ret.length && typeof ret[0] === 'object') {
    console.log('  第一项: ' + JSON.stringify(ret[0]).slice(0, 220));
  } else if (ret && typeof ret === 'object' && !Array.isArray(ret)) {
    const data = ret.data;
    console.log('  ret: ' + JSON.stringify(data !== undefined ? { data: Array.isArray(data) ? `list[${data.length}]` : shape(data), total: ret.total } : Object.keys(ret)).slice(0, 220));
    if (Array.isArray(data) && data.length) console.log('  data[0]: ' + JSON.stringify(data[0]).slice(0, 220));
  }
  return j;
}

(async () => {
  const token = tokenFrom(process.argv[2]);
  const projectId = process.argv[3] || '11665';
  if (!token) {
    console.log('用法：node test/probe.js <token 或 cookie> [项目id]');
    process.exit(2);
  }
  console.log('token 长度 ' + token.length + '，前 6 位 ' + token.slice(0, 6) + '…\n');

  report('GET /imageCode（不需要登录）', await call('GET', '/imageCode'));

  const types = report('GET /bugcategory', await call('GET', '/bugcategory', token));
  if (Array.isArray((types.ret || {}).zh)) {
    const walk = (nodes, depth) => (nodes || []).forEach((n) => {
      if (depth < 1) console.log('  '.repeat(depth + 1) + '- ' + n.label + (n.children && n.children.length ? `（${n.children.length} 个子类）` : ` = ${n.value}`));
      if (n.children && n.children.length && depth < 1) walk(n.children, depth + 1);
    });
    walk(types.ret.zh, 0);
  }

  const projects = report('GET /project/getpersonalprojectList', await call('GET', '/project/getpersonalprojectList', token, { size: 50, page: 1, projectSubType: '', projectType: '', status: '', search: '' }));
  const rows = ((projects.ret || {}).data) || [];
  const usable = rows.filter((x) => ['apply', 'doing'].includes(String(x.states || '')));
  console.log('  可提交的项目 ' + usable.length + ' 个：' + usable.slice(0, 8).map((x) => x.id + '/' + x.name + '/' + x.states).join('、'));

  const target = usable.find((x) => String(x.id) === String(projectId)) ? projectId : (usable[0] && usable[0].id) || projectId;
  report('GET /setHole/getHoleLevel/' + target, await call('GET', '/setHole/getHoleLevel/' + target, token));
  report('GET /project/getProjectdetail?id=' + target, await call('GET', '/project/getProjectdetail', token, { id: target }));

  console.log('\n说明：0/成功 = 有权限；200/无权操作 = 这个账号没参与该项目；401/权限鉴定失败 = token 过期。');
  console.log('只读了接口，没有提交任何东西。');
})().catch((e) => {
  console.log('探测失败：' + (e.message || e));
  process.exit(1);
});
