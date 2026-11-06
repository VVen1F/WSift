'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const S = {
  settings: null,
  templates: [],
  tplId: null,
  lastReq: '',
  lastRes: '',
  reportMd: '',
  reportDir: '',
  images: [],
  pendingShots: [],
  updating: null,
  info: null
};

const TASKS = { list: [], workspaces: [], wsId: null, id: null, busyId: null, showArchived: false };
let clearArmed = false;
let clearTimer = 0;
let saveChain = Promise.resolve();

/* ---------------- 基础 ---------------- */

window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  const msg = reason && reason.message ? reason.message : String(reason || '出错了');
  console.error(reason);
  try { toast(msg, true); } catch (err) { /* 提示本身失败时不再抛 */ }
});

function toast(msg, isErr, action) {
  const t = $('#toast');
  t.replaceChildren();
  t.append(document.createTextNode(msg));
  if (action && action.label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-act';
    b.textContent = action.label;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(t._h);
      t.className = 'toast';
      action.run();
    });
    t.append(b);
  }
  t.className = 'toast on' + (isErr ? ' err' : '') + (action ? ' act' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.className = 'toast'; }, action ? 5000 : 2600);
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function debounce(fn, ms) {
  let h;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}

/* ---------------- 高亮 ---------------- */

function jsonHL(src) {
  const re = /"(?<str>(?:\\.|[^"\\])*)"(?<colon>\s*:)?|(?<num>-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?<lit>\b(?:true|false|null)\b)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(src))) {
    out += esc(src.slice(last, m.index));
    if (m.groups.str !== undefined) {
      const colon = m.groups.colon || '';
      const body = m[0].slice(0, m[0].length - colon.length);
      out += `<span class="${colon ? 'jk' : 'js'}">${esc(body)}</span>${esc(colon)}`;
    } else {
      out += `<span class="jn">${esc(m[0])}</span>`;
    }
    last = m.index + m[0].length;
  }
  return out + esc(src.slice(last));
}

function colorCookie(v, firstOnly) {
  return v.split(';').map((seg, i) => {
    if (i > 0 && firstOnly) return ';' + esc(seg);
    const m = seg.match(/^(\s*)([^=]+)=(.*)$/);
    if (!m) return (i ? ';' : '') + esc(seg);
    return (i ? ';' : '') + esc(m[1]) + `<span class="hn">${esc(m[2])}=</span><span class="cv">${esc(m[3])}</span>`;
  }).join('');
}

function highlight(text) {
  if (!text) return '';
  const sep = text.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
  const i = text.indexOf(sep);
  const head = i >= 0 ? text.slice(0, i) : text;
  const body = i >= 0 ? text.slice(i + sep.length) : '';

  const headHtml = head.split(/\r?\n/).map((ln, idx) => {
    if (idx === 0 && /^(HTTP\/[\d.]+\s|GET\s|POST\s|PUT\s|DELETE\s|PATCH\s|HEAD\s|OPTIONS\s)/.test(ln)) {
      return `<span class="l1">${esc(ln)}</span>`;
    }
    const m = ln.match(/^([A-Za-z0-9!#$%&'*+.^_`|~-]+):(.*)$/);
    if (!m) return esc(ln);
    const lower = m[1].toLowerCase();
    let v;
    if (lower === 'cookie' || lower === 'set-cookie') {
      const sp = (m[2].match(/^\s*/) || [''])[0];
      v = esc(sp) + colorCookie(m[2].slice(sp.length), lower === 'set-cookie');
    } else {
      v = esc(m[2]);
    }
    return `<span class="hn">${esc(m[1])}</span>:${v}`;
  }).join('\n');

  let bodyHtml = '';
  if (body) {
    const t = body.trim();
    let isJson = false;
    if (t && (t[0] === '{' || t[0] === '[')) {
      try { JSON.parse(t); isJson = true; } catch (e) { /* 不是 JSON */ }
    }
    bodyHtml = isJson ? jsonHL(body) : esc(body);
  }
  return headHtml + (body ? '\n\n' + bodyHtml : '');
}

/* ---------------- 极简 Markdown 渲染 ---------------- */

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2" />');
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

function mdToHtml(md) {
  const lines = String(md || '').split(/\r?\n/);
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:-]+\|/.test(lines[i + 1])) {
      const head = line.split('|').slice(1, -1).map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      out.push(
        '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      );
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>` + items.map((t) => `<li>${inline(t)}</li>`).join('') + `</${tag}>`);
      continue;
    }

    const para = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^(#{1,4}\s|```|\s*\|)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    // 以 | 开头但又不是表格的行（比如 shell 管道的续行）会让上面一行都收不进来，
    // 不兜底就是死循环 + 内存爆掉
    if (!para.length) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

/* ---------------- 导航 ---------------- */

function go(page) {
  try {
    $$('.nav').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
    const neu = $('#btnNewTask');
    if (neu) neu.classList.toggle('on', page === 'report');
    $$('.page').forEach((p) => p.classList.toggle('on', p.id === 'page-' + page));
    if (page === 'report') syncReportVisibility();
    renderTaskList();
  } catch (e) {
    console.error(e);
  }
}

$$('.nav').forEach((b) => b.addEventListener('click', () => { if (b.dataset.page) go(b.dataset.page); }));

/* ---------------- 测试 ---------------- */

const SAMPLE = 'GET / HTTP/1.1\nHost: example.com\nUser-Agent: Mozilla/5.0\nAccept: */*\n\n';

async function doSend() {
  const raw = $('#req').value;
  if (!raw.trim()) return toast('请求为空', true);
  const scheme = $('#scheme').value;
  const protocol = $('#protocol') ? $('#protocol').value : 'auto';
  $('#statusText').textContent = '发送中…';
  const r = await window.api.send({ raw, scheme, protocol });
  S.lastReq = raw;
  S.lastRes = r.text || '';
  S.lastMs = r.ok && Number.isFinite(r.ms) ? r.ms : null;
  $('#res').innerHTML = highlight(S.lastRes);
  const proto = (r.protocol || 'h1').toUpperCase();
  $('#statusText').innerHTML = r.ok
    ? `<span class="ok">${r.status}</span> · ${r.ms} ms · ${proto}`
    : `<span class="bad">失败</span> · ${esc(r.error || '')}`;
  $('#resMeta').textContent = r.ok ? `${r.ms} ms · ${proto}` : '';
  if (S.settings.ui.autoShot) doShot();
}

async function doShot() {
  if (!S.lastRes) return toast('先发送一次请求', true);
  $('#shotPath').textContent = '截图中…';
  try {
    const r = await window.api.capture({
      request: $('#req').value || S.lastReq,
      response: S.lastRes,
      width: Number(S.settings.ui.shotWidth) || 1600,
      ms: S.lastMs
    });
    rememberShot(r.path);
    S.settings.stats.shots = (S.settings.stats.shots || 0) + 1;
    persist();
    renderStats();
    $('#shotPath').textContent = '已保存 ' + r.path.split('/').pop();
    toast('截图已保存');
  } catch (e) {
    $('#shotPath').textContent = '';
    toast('截图失败：' + e.message, true);
  }
}

$('#btnSend').addEventListener('click', doSend);
$('#btnShot').addEventListener('click', doShot);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    if ($('#page-repeater').classList.contains('on')) doSend();
  }
});

$('#btnToReport').addEventListener('click', () => {
  if (!S.lastRes) return toast('先发送一次请求', true);
  const detail =
    '请求：\n```http\n' + (S.lastReq || $('#req').value) + '\n```\n\n响应：\n```http\n' + S.lastRes + '\n```';
  const host = deriveMeta(S.lastReq || $('#req').value).host;
  createTask({
    title: host || '',
    detail,
    images: S.pendingShots.splice(0, S.pendingShots.length)
  });
  toast('已新建报告');
});

/* ---------------- 报告 ---------------- */

function providerKey(p) {
  const acc = (p.accounts || []).find((a) => a.id === p.activeAccountId) || (p.accounts || [])[0] || {};
  return acc.apiKey || '';
}

function flattenProvider(p) {
  if (!p) return null;
  const acc = (p.accounts || []).find((a) => a.id === p.activeAccountId) || (p.accounts || [])[0] || {};
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseURL: p.baseURL,
    modelsURL: p.modelsURL,
    apiKey: acc.apiKey || '',
    accountName: acc.name || '',
    model: p.activeModel || (p.models || [])[0] || '',
    models: p.models || [],
    proxy: p.proxy || '',
    sessionHeader: p.sessionHeader || '',
    limitSec: p.limitSec || 0,
    limitMin: p.limitMin || 0,
    contextK: p.contextK || 0
  };
}

function activeProvider() {
  const s = S.settings;
  const list = s.providers || [];
  const usable = (p) => p && p.enabled !== false && providerKey(p);
  const cur = list.find((p) => p.id === s.activeProviderId);
  const picked = usable(cur) ? cur : list.find(usable) || cur || list[0];
  return flattenProvider(picked);
}

function fillTemplateSelect() {
  const sel = $('#rTemplate');
  const prev = sel.value;
  if (!S.templates.length) {
    sel.innerHTML = '<option value="">无模板</option>';
    return;
  }
  sel.innerHTML = S.templates.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join('');
  if (prev && Array.from(sel.options).some((o) => o.value === prev)) sel.value = prev;
}

function deriveMeta(material) {
  const host = /^\s*host:\s*(\S+)/im.exec(material || '');
  const url = /https?:\/\/[^\s'"<>`]+/.exec(material || '');
  const hostName = host ? host[1].split(':')[0] : '';
  return {
    product: '',
    url: url ? url[0] : hostName ? 'https://' + hostName : '',
    type: '',
    host: hostName
  };
}

function mdTitle(md) {
  const line = String(md || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  return line
    .replace(/^#+\s*/, '')
    // 模型爱把字段名写进标题，去掉这些前缀
    .replace(/^(漏洞名称|报告名称|标题|名称)\s*[:：]\s*/, '')
    .replace(/[\s]*复测\s*$/g, '')
    .replace(/[\\/:*?"<>|]/g, '')
    .trim()
    .slice(0, 80) || '报告';
}

const runs = new Map();

// 流式预览的节流参数：报告不是越长越要每帧重排
const STREAM_PAINT_MS = 240;
const STREAM_TAIL = 12000;
const MAX_REPORT_CHARS = 200000;

function stopRun(id) {
  const run = runs.get(id);
  runs.delete(id);
  if (run && run.cancel) {
    try { run.cancel(); } catch (e) { /* 停止失败也不要打断当前操作 */ }
  }
  if (run && run.clock) clearInterval(run.clock);
  if (TASKS.busyId === id) TASKS.busyId = null;
}

function safeDom(fn) {
  try { fn(); } catch (e) { console.error(e); }
}


/** 模型偶尔把思考过程写进正文，开头一段英文要切掉。 */
function cleanModelText(md) {
  const text = String(md || '');
  if (!/[\u4e00-\u9fa5]/.test(text)) return text;
  const head = text.slice(0, 160);
  const latin = (head.match(/[A-Za-z]/g) || []).length;
  if (latin > 40 && !/HTTP\//.test(head)) {
    const i = text.search(/[\u4e00-\u9fa5]/);
    if (i > 0) return text.slice(i).trim();
  }
  return text;
}

/** 有请求行才算写了报告。 */
function hasRequestLine(md) {
  return /^\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\/\d/m.test(String(md || ''));
}

function looksLikeRefusal(md) {
  const head = String(md || '').slice(0, 240);
  return !hasRequestLine(md) && /无法|抱歉|不能|请补充|请提供|cannot|unable/i.test(head);
}


/* ---------------- 数据包自动截图 ---------------- */

// 从漏洞详情里抽出所有 HTTP 请求包（围栏里或裸文本都认）
function extractPackets(text) {
  const lines = String(text || '').split(/\r?\n/);
  const reqLine = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\/[\d.]+/;
  const headRe = /^[A-Za-z0-9-]+:\s?\S/;
  const out = [];
  const seen = new Set();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    const bare = line.replace(/^```[a-zA-Z]*\s*/, '');
    if (!reqLine.test(bare)) { i++; continue; }
    const block = [bare];
    i++;
    while (i < lines.length) {
      const cur = lines[i];
      const t = cur.trim();
      if (t === '```') { i++; break; }
      if (!t) {
        // 空行后面如果是 body（不以 Header: 形式开头），继续收
        let j = i + 1;
        const body = [];
        while (j < lines.length && lines[j].trim() && lines[j].trim() !== '```') body.push(lines[j++]);
        if (body.length) { block.push('', ...body); i = j; }
        else i++;
        break;
      }
      if (!headRe.test(t)) break;
      block.push(t);
      i++;
    }
    const pkt = block.join('\n');
    const key = pkt.slice(0, 300);
    if (!seen.has(key)) { seen.add(key); out.push(pkt); }
  }
  return out;
}

// 逐个重放详情里的包，返回 [{pkt, res, ms, ok}]
async function replayPackets(task) {
  const pkts = extractPackets(task && task.detail ? task.detail : '');
  const out = [];
  for (const pkt of pkts) {
    let scheme = 'https';
    const m = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(https?:\/\/\S+)/i.exec(pkt);
    if (m) scheme = m[2].toLowerCase().startsWith('http:') ? 'http' : 'https';
    try {
      const r = await window.api.send({ raw: pkt, scheme, protocol: 'auto', timeout: 20 });
      out.push({ pkt, ok: !!r.ok, status: r.status || 0, ms: r.ms || 0, res: r.text || '' });
    } catch (e) {
      out.push({ pkt, ok: false, status: 0, ms: 0, res: '' });
    }
  }
  return out;
}


// 让模型根据实测响应提出几条验证探针，返回 [{raw, why}]
function probesFromText(txt) {
  const t = String(txt || '');
  const a = t.indexOf('[');
  const b = t.lastIndexOf(']');
  if (a < 0 || b <= a) return [];
  let arr;
  try { arr = JSON.parse(t.slice(a, b + 1)); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr.slice(0, 6)) {
    if (!it) continue;
    const url = String(it.url || '');
    if (!/^https?:\/\//i.test(url)) continue;
    const u = new URL(url);
    const method = String(it.method || 'GET').toUpperCase();
    const lines = [method + ' ' + (u.pathname || '/') + (u.search || '') + ' HTTP/1.1'];
    lines.push('Host: ' + u.host);
    const headers = it.headers && typeof it.headers === 'object' ? it.headers : {};
    for (const k of Object.keys(headers)) {
      if (/^host$/i.test(k)) continue;
      lines.push(k + ': ' + String(headers[k]));
    }
    const body = it.body ? String(it.body) : '';
    if (body && !Object.keys(headers).some((k) => /^content-length$/i.test(k))) {
      lines.push('Content-Length: ' + new TextEncoder().encode(body).length);
    }
    lines.push('');
    if (body) lines.push(body);
    out.push({ raw: lines.join('\n'), why: String(it.why || '') });
  }
  return out;
}

// 用一次轻量对话产出探针计划
async function planProbes(material, prov) {
  const sys = '你是渗透测试助手。根据材料里的目标与已观测响应，给出最多 4 条用于验证危害的 HTTP 探针，' +
    '只输出 JSON 数组，元素形如 {"method":"GET","url":"https://...","headers":{},"body":"","why":"说明"}。' +
    '要求：只读、无害、可重复；不要写脚本或解释文字。';
  let txt = '';
  await window.api.chat({
    provider: prov,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: material.slice(0, 6000) }],
    onNote: () => {},
    onDelta: (d) => { txt += d; },
    onDone: () => {}
  });
  return probesFromText(txt);
}

// 把详情里的每个数据包都截一张图挂到任务上，已截过的跳过
async function attachPacketShots(task, probes) {
  if (!task) return 0;
  const pkts = extractPackets(task.detail || '');
  if (!pkts.length) return 0;
  task.images = Array.isArray(task.images) ? task.images : [];
  task.shotPackets = Array.isArray(task.shotPackets) ? task.shotPackets : [];
  const shot = new Set(task.shotPackets);
  const width = Number(S.settings.ui.shotWidth) || 1600;
  const byPkt = new Map((probes || []).map((x) => [x.pkt.slice(0, 300), x]));
  let added = 0;
  for (const pkt of pkts) {
    const key = pkt.slice(0, 300);
    if (shot.has(key)) continue;
    const pr = byPkt.get(key);
    try {
      const r = await window.api.capture({
        request: pkt,
        response: pr && pr.res ? pr.res : '',
        width,
        ms: pr ? pr.ms : 0
      });
      if (r && r.path) {
        task.images.push(r.path);
        shot.add(key);
        task.shotPackets.push(key);
        added++;
      }
    } catch (e) {
      // 单张失败不影响生成
    }
  }
  if (added) {
    if (task.id === TASKS.id) S.images = task.images;
    saveTasksSoon();
  }
  return added;
}

async function generateReport() {
  const prov = activeProvider();
  if (!prov || !prov.apiKey) return toast('先在设置里配置模型和 API Key', true);
  let task = currentTask();
  if (!task && formHasContent()) task = onTaskEdit();
  if (!task) return toast('先把漏洞详情填上', true);
  if (runs.has(task.id) || TASKS.busyId === task.id) return;
  if (TASKS.starting) return;
  TASKS.starting = true;

  readFormInto(task, false);
  const tpl = S.templates.find((t) => t.id === task.templateId) || null;
  const extra = (task.extra || '').trim();
  const cred = (task.cred || '').trim();
  const detail = (task.detail || '').trim();
  if (!detail) {
    TASKS.starting = false;
    return toast('先把漏洞详情填上', true);
  }

  // 材料里没有请求包就别调模型了，省得它写一篇「我写不了」
  if (!/^\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\S+\s+HTTP\/\d/m.test(detail) && detail.length < 40) {
    TASKS.starting = false;
    return toast('材料里没有请求包，先发一次包或贴一段请求', true);
  }

  // 先按详情把每个包真发一次，拿真实响应；再据此截图
  let probes = [];
  try { probes = await replayPackets(task); } catch (e) { probes = []; }

  // 让模型基于实测响应出探针，再真的打一遍（慢一点没关系）
  try {
    const rounds = Number(S.settings.report && S.settings.report.probeRounds);
    const n = Number.isFinite(rounds) ? Math.max(0, Math.min(2, rounds)) : 1;
    if (n > 0 && probes.length) {
      const seen = new Set(probes.map((x) => x.pkt.slice(0, 300)));
      const brief = probes.map((p) => p.pkt + '\n--> ' + String(p.res || '').slice(0, 800)).join('\n\n');
      const planned = await planProbes(brief, prov);
      for (const it of planned) {
        const key = it.raw.slice(0, 300);
        if (seen.has(key)) continue;
        seen.add(key);
        const m = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(https?:\/\/\S+)/i.exec(it.raw);
        const scheme = m && m[2].toLowerCase().startsWith('http:') ? 'http' : 'https';
        try {
          const r = await window.api.send({ raw: it.raw, scheme, protocol: 'auto', timeout: 20 });
          probes.push({ pkt: it.raw, ok: !!r.ok, status: r.status || 0, ms: r.ms || 0, res: r.text || '', why: it.why, probe: true });
        } catch (e) {
          probes.push({ pkt: it.raw, ok: false, status: 0, ms: 0, res: '', why: it.why, probe: true });
        }
      }
    }
  } catch (e) { /* 探针失败不影响正常生成 */ }

  await attachPacketShots(task, probes);
  if (probes.length) {
    const okN = probes.filter((p) => p.ok).length;
    toast('已实测 ' + probes.length + ' 个数据包' + (okN ? '（' + okN + ' 个通）' : ''));
  }

  const realBlock = probes.length
    ? '\n\n以下是这些请求包\u5b9e\u6d4b\u54cd\u5e94（工具刚刚真实发送得到，不是草稿里的文字）：\n\n' +
      probes.map((p, i) =>
        '### ' + (p.probe ? '探针 ' : '包 ') + (i + 1) + (p.why ? '（' + p.why + '）' : '') +
        '\n```http\n' + p.pkt + '\n```\n实测：' +
        (p.ok ? 'HTTP ' + p.status + ' · ' + p.ms + 'ms' : '发送失败') + '\n```http\n' +
        String(p.res || '').slice(0, 4000) + '\n```'
      ).join('\n\n')
    : '';

  const material = (cred ? '账号密码：\n' + cred + '\n\n' : '') + detail + realBlock;
  let messages;
  try {
    messages = await window.api.compose({
      material,
      template: tpl ? tpl.body : '',
      meta: deriveMeta(material),
      extra
    });
  } catch (e) {
    TASKS.starting = false;
    return toast(e.message || '生成失败', true);
  }
  TASKS.starting = false;
  if (!TASKS.list.some((t) => t.id === task.id)) return;
  if (runs.has(task.id)) return;

  const taskId = task.id;
  TASKS.busyId = taskId;
  S.reportMd = '';
  task.markdown = '';
  const started = Date.now();
  let buf = '';
  let note = '';
  let raf = 0;
  let revealed = false;
  const viewing = () => TASKS.id === taskId && document.getElementById('page-report') && document.getElementById('page-report').classList.contains('on');
  const paintWait = () => {
    if (!runs.has(taskId) || !viewing()) return;
    safeDom(() => {
      const preview = $('#mdPreview');
      const status = $('#genStatus');
      if (!preview || !status) return;
      const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
      if (buf) {
        status.textContent = '生成中 · ' + buf.length + ' 字 · ' + sec + 's';
        return;
      }
      const label = note ? '思考中 · ' + sec + 's' : '等待模型 · ' + sec + 's';
      status.textContent = label;
      preview.innerHTML = '<div class="empty">' + esc(note ? note.slice(-80) : label) + '</div>';
      preview.classList.add('live');
    });
  };
  const clock = setInterval(paintWait, 500);
  const run = { cancel: null, clock };
  runs.set(taskId, run);
  paintWait();
  syncGenButton();
  renderTaskList();
  safeDom(() => {
    const block = document.querySelector('.preview-block');
    if (block && viewing()) block.scrollIntoView({ block: 'nearest', behavior: motionOff() ? 'auto' : 'smooth' });
  });

  const paint = () => {
    raf = 0;
    if (!viewing()) return;
    const tail = buf.length > STREAM_TAIL ? buf.slice(-STREAM_TAIL) : buf;
    safeDom(() => {
      const preview = $('#mdPreview');
      const status = $('#genStatus');
      if (!preview || !status) return;
      // 流式阶段只贴纯文本：整篇 markdown 每 80ms 重解析一次会卡死界面
      preview.textContent = tail;
      preview.classList.add('live');
      const sec = Math.max(0, Math.round((Date.now() - started) / 1000));
      status.textContent = '生成中 · ' + buf.length + ' 字 · ' + sec + 's';
      if (!revealed) {
        revealed = true;
        const block = document.querySelector('.preview-block');
        if (block) block.scrollIntoView({ block: 'nearest' });
      }
    });
  };

  const finish = () => {
    const current = runs.get(taskId);
    if (current && current.clock) clearInterval(current.clock);
    runs.delete(taskId);
    if (TASKS.busyId === taskId) TASKS.busyId = null;
    if (reportChat && reportChat.id === (current && current.id)) reportChat = null;
    safeDom(() => {
      const preview = $('#mdPreview');
      if (preview && viewing()) preview.classList.remove('live');
      syncGenButton();
      renderTaskList();
    });
  };

  reportChat = window.api.chat({
    provider: prov,
    messages,
    onNote: (n) => {
      note = n || note;
      if (!buf) paintWait();
    },
    onDelta: (d) => {
      if (buf.length > MAX_REPORT_CHARS) {
        // 模型失控时直接掐掉，别把内存和界面拖死
        if (reportChat && reportChat.cancel) { try { reportChat.cancel(); } catch (e) {} }
        return;
      }
      buf += d;
      // 流式期间不解析 markdown、不拷贝整段到任务对象，只按节拍更新预览
      if (TASKS.id === taskId && !raf) raf = setTimeout(paint, STREAM_PAINT_MS);
    },
    onDone: (raw) => {
      const live = TASKS.list.find((x) => x.id === taskId);
      const md = cleanModelText(raw || buf);

      if (looksLikeRefusal(md)) {
        if (live) live.markdown = '';
        if (viewing()) {
          safeDom(() => {
            const preview = $('#mdPreview');
            const status = $('#genStatus');
            if (preview) preview.innerHTML = '<div class="empty">材料不够，模型没写出报告</div>';
            if (status) status.textContent = '没有正文';
          });
        }
        finish();
        saveTasksNow();
        return toast('材料不够，模型没写出报告', true);
      }
      if (live) {
        live.markdown = md;
        if (!String(live.title || '').trim()) {
          const h = mdTitle(md);
          if (h && h !== '报告') live.title = h;
        }
        live.updatedAt = Date.now();
      }
      S.reportMd = md;
      if (viewing()) {
        safeDom(() => {
          if (live && live.title && $('#rTitle')) $('#rTitle').value = live.title;
          const preview = $('#mdPreview');
          const status = $('#genStatus');
          if (preview) preview.innerHTML = md ? mdToHtml(md) : '<div class="empty">模型没有返回正文</div>';
          if (status) status.textContent = md ? '已生成 · ' + md.length + ' 字' : '没有正文';
        });
      }
      finish();
      saveTasksNow();
    },
    onError: (msg, code) => {
      const stopped = code === 'ABORT' || msg === '已停止';
      if (viewing()) {
        safeDom(() => {
          const preview = $('#mdPreview');
          const status = $('#genStatus');
          if (buf && preview) {
            preview.innerHTML = mdToHtml(buf);
            if (status) status.textContent = stopped ? '已停止 · ' + buf.length + ' 字' : '失败';
          } else if (preview) {
            preview.innerHTML = '<div class="empty">' + esc(stopped ? '已停止' : msg) + '</div>';
            if (status) status.textContent = stopped ? '已停止' : '失败';
          }
        });
      }
      finish();
      if (!stopped) toast(msg, true);
      else if (buf) saveTasksNow();
    }
  });
  if (reportChat) {
    run.cancel = reportChat.cancel;
    run.id = reportChat.id;
  }
}

function imagesSection(list) {
  const imgs = (list || S.images || []).filter(Boolean);
  if (!imgs.length) return '';
  return '\n\n' + imgs.map((_, i) => `![](images/${String(i + 1).padStart(2, '0')}.png)`).join('\n\n') + '\n';
}

async function saveReport() {
  if (!S.reportMd) return toast('先生成报告', true);
  const task = currentTask();
  if (task) readFormInto(task, false);
  const title = (task && task.title) || mdTitle(S.reportMd);
  if (task) await attachPacketShots(task);
  const imgs = (S.images && S.images.length ? S.images : (task && task.images) || []).filter(Boolean);
  const md = S.reportMd.replace(/\s+$/, '') + imagesSection(imgs);
  const r = await window.api.saveReport({ markdown: md, images: imgs, title });
  S.reportDir = (r && (r.zip || r.dir)) || '';
  if (task) {
    task.exported = S.reportDir;
    task.markdown = S.reportMd;
    task.updatedAt = Date.now();
    saveTasksNow();
    renderTaskList();
  }
  S.settings.stats.reports = (S.settings.stats.reports || 0) + 1;
  persist();
  renderStats();
  toast('已导出 ' + (r.zip || r.dir));
  $('#btnReveal').disabled = false;
  return r;
}

let reportChat = null;

function syncGenButton() {
  const gen = $('#btnGen');
  if (!gen) return;
  const busy = TASKS.busyId && TASKS.busyId === TASKS.id;
  gen.textContent = busy ? '停止' : '生成';
  gen.disabled = false;
}

function cancelReport() {
  if (TASKS.id) stopRun(TASKS.id);
  safeDom(() => {
    syncGenButton();
    renderTaskList();
  });
}

$('#btnGen').addEventListener('click', () => {
  try {
    if ((TASKS.busyId && TASKS.busyId === TASKS.id) || (TASKS.id && runs.has(TASKS.id))) return cancelReport();
    generateReport();
  } catch (e) {
    toast(e.message || '生成失败', true);
  }
});
$('#btnSave').addEventListener('click', saveReport);
$('#btnCopy').addEventListener('click', async () => {
  if (!S.reportMd) return toast('还没有报告', true);
  try {
    await navigator.clipboard.writeText(S.reportMd);
  } catch (e) {
    await window.api.clipboard(S.reportMd);
  }
  toast('已复制');
});
$('#btnReveal').addEventListener('click', () => {
  if (!S.reportDir) return toast('先导出一次', true);
  window.api.showItem(S.reportDir);
});

/* ---------------- 报告任务 ---------------- */

function currentTask() {
  return TASKS.list.find((t) => t.id === TASKS.id) || null;
}

function displayTitle(t) {
  const custom = String((t && t.title) || '').trim();
  if (custom) return custom.slice(0, 80);
  const md = /^#\s+(.+)$/m.exec(String((t && t.markdown) || ''));
  if (md) {
    const h = md[1].trim();
    if (h && h !== '报告') return h.slice(0, 80);
  }
  const lines = String((t && t.detail) || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^```/.test(line) || /^(请求|响应)[:：]?$/.test(line)) continue;
    const clean = line.replace(/^#+\s*/, '').trim();
    if (clean) return clean.slice(0, 80);
  }
  return '未命名';
}

function dayGroup(ts) {
  const d = new Date(ts || Date.now());
  const now = new Date();
  const start = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const diff = start(now) - start(d);
  if (diff === 0) return '今天';
  if (diff === 86400000) return '昨天';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function sortedTasks() {
  return TASKS.list.slice().sort((a, b) => {
    const pin = (b.pinned === true) - (a.pinned === true);
    if (pin) return pin;
    return (b.updatedAt || 0) - (a.updatedAt || 0) || (b.createdAt || 0) - (a.createdAt || 0);
  });
}

function saveTasksNow() {
  if (!window.api || !window.api.tasks) return Promise.resolve();
  const job = () => window.api.tasks.save({ tasks: TASKS.list, workspaces: TASKS.workspaces }).catch(() => {});
  saveChain = saveChain.then(job, job);
  return saveChain;
}

const saveTasksSoon = debounce(() => saveTasksNow(), 400);

function readFormInto(t) {
  if (!t || !$('#rTitle')) return;
  t.title = $('#rTitle').value.trim();
  t.templateId = $('#rTemplate').value;
  t.cred = $('#rCred').value;
  t.detail = $('#rDetail').value;
  t.extra = $('#rExtra').value;
  if (TASKS.busyId !== t.id) t.markdown = S.reportMd || '';
  t.images = S.images || [];
  t.exported = S.reportDir || '';
}

function applyTask(t) {
  const empty = $('#reportEmpty');
  const col = $('#reportCol');
  if (empty) empty.hidden = true;
  if (col) col.hidden = false;
  $('#rTitle').value = t.title || '';
  const sel = $('#rTemplate');
  if (sel && t.templateId && Array.from(sel.options).some((o) => o.value === t.templateId)) {
    sel.value = t.templateId;
  }
  $('#rCred').value = t.cred || '';
  $('#rDetail').value = t.detail || '';
  $('#rExtra').value = t.extra || '';
  S.reportMd = t.markdown || '';
  S.reportDir = t.exported || '';
  S.images = Array.isArray(t.images) ? t.images : (t.images = []);
  $('#mdPreview').innerHTML = S.reportMd ? mdToHtml(S.reportMd) : '<div class="empty">生成后显示在这里</div>';
  $('#genStatus').textContent = S.reportMd ? '已生成 · ' + S.reportMd.length + ' 字' : '未生成';
  const reveal = $('#btnReveal');
  if (reveal) reveal.disabled = !S.reportDir;
  const preview = $('#mdPreview');
  if (preview) preview.classList.toggle('live', TASKS.busyId === t.id);
  syncGenButton();
}

function hasContent(t) {
  if (!t) return false;
  if (String(t.title || '').trim()) return true;
  if (String(t.cred || '').trim()) return true;
  if (String(t.detail || '').trim()) return true;
  if (String(t.extra || '').trim()) return true;
  if (String(t.markdown || '').trim()) return true;
  if (Array.isArray(t.images) && t.images.some((p) => String(p || '').trim())) return true;
  return false;
}

function formHasContent() {
  if (['rTitle', 'rCred', 'rDetail', 'rExtra'].some((id) => {
    const el = document.getElementById(id);
    return !!(el && el.value.trim());
  })) return true;
  if (String(S.reportMd || '').trim()) return true;
  if (S.images && S.images.length) return true;
  return false;
}

function activeTasks() {
  return sortedTasks().filter((t) => !t.archived && hasContent(t));
}

function archivedTasks() {
  return sortedTasks().filter((t) => t.archived && hasContent(t));
}

function showReportForm() {
  const col = $('#reportCol');
  if (col) col.hidden = false;
}

function syncReportVisibility() {
  showReportForm();
}

function blankForm(opts) {
  opts = opts || {};
  TASKS.id = null;
  S.reportMd = '';
  S.reportDir = '';
  S.images = [];
  if ($('#rTitle')) $('#rTitle').value = '';
  if ($('#rCred')) $('#rCred').value = '';
  if ($('#rDetail')) $('#rDetail').value = '';
  if ($('#rExtra')) $('#rExtra').value = '';
  const preview = $('#mdPreview');
  if (preview) {
    preview.classList.remove('live');
    preview.innerHTML = '<div class="empty">生成后显示在这里</div>';
  }
  const st = $('#genStatus');
  if (st) st.textContent = '未生成';
  const reveal = $('#btnReveal');
  if (reveal) reveal.disabled = true;
  showReportForm();
  go('report');
  if (opts.focus) {
    const field = $('#rDetail');
    if (field) field.focus();
  }
}

function kickSwap() {
  const col = $('#reportCol');
  if (!col || col.hidden || motionOff()) return;
  col.classList.remove('swap');
  void col.offsetWidth;
  col.classList.add('swap');
}

const ARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8z"/><path d="M3 8l2.2-3h13.6L21 8"/><path d="M10 12h4"/></svg>';

function taskRow(t, archivedRow) {
  const onPage = document.getElementById('page-report').classList.contains('on');
  const on = onPage && t.id === TASKS.id;
  const busy = TASKS.busyId === t.id;
  let actions = '<span class="task-meta">生成中</span>';
  if (!busy && archivedRow) {
    actions = `<button class="task-del" type="button" data-unarch="${esc(t.id)}">恢复</button>`;
  } else if (!busy) {
    actions = `<button class="task-arch" type="button" data-arch="${esc(t.id)}" aria-label="放入已归档">${ARCH_ICON}</button>`;
  }
    return `<div class="task${on ? ' on' : ''}${archivedRow ? ' archived' : ' in-ws'}${t.pinned ? ' pinned' : ''}" data-id="${esc(t.id)}" role="button" tabindex="0">` +
    `<span class="task-title">${esc(displayTitle(t))}</span><span class="task-time">${esc(relTime(t.updatedAt || t.createdAt))}</span>${actions}</div>`;
}

function relTime(ts) {
  const diff = Math.max(0, Date.now() - (Number(ts) || Date.now()));
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + '分钟';
  const hour = Math.floor(min / 60);
  if (hour < 24) return hour + '小时';
  return Math.floor(hour / 24) + '天';
}

function ensureWorkspaces() {
  if (!Array.isArray(TASKS.workspaces)) TASKS.workspaces = [];
  if (!TASKS.workspaces.length) {
    TASKS.workspaces.push({ id: 'ws-default', name: '默认工作区', open: true, createdAt: Date.now() });
  }
  if (!TASKS.wsId || !TASKS.workspaces.some((w) => w.id === TASKS.wsId)) TASKS.wsId = TASKS.workspaces[0].id;
  return TASKS.wsId;
}

function workspaceHtml() {
  ensureWorkspaces();
  const folder = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3 7.5h5.2l1.8 2H21v9.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7.5z"/></svg>';
  return TASKS.workspaces.map((w) => {
    const mine = activeTasks().filter((t) => (t.workspaceId || 'ws-default') === w.id);
    const open = w.open !== false;
    let block = `<div class="ws${w.id === TASKS.wsId ? ' on' : ''}" data-ws="${esc(w.id)}" role="button" tabindex="0">` +
      `<span class="ws-chev">${open ? '▾' : '▸'}</span>${folder}<span class="ws-name">${esc(w.name)}</span>` +
      `<button class="icon-btn ws-add" type="button" data-ws-new="${esc(w.id)}" aria-label="新建任务"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button></div>`;
    if (open) block += mine.map((t) => taskRow(t, false)).join('');
    return block;
  }).join('');
}

function renderTaskList() {
  const box = $('#taskList');
  if (!box) return;
  const focused = document.activeElement && document.activeElement.closest
    ? document.activeElement.closest('#taskList .task')
    : null;
  const focusId = focused ? focused.dataset.id : '';
  const tasks = activeTasks();
  const archived = archivedTasks();
  const clearBtn = $('#btnTasksClear');
  if (clearBtn) clearBtn.hidden = tasks.length === 0;
  ensureWorkspaces();
  if (!tasks.length && !archived.length && TASKS.workspaces.length <= 1) {
    box.innerHTML = workspaceHtml() + '<div class="task-empty">还没有报告</div>';
    setClearArm(false);
    return;
  }
  let html = workspaceHtml();
  if (archived.length) {
    html += `<button class="task-arch-head" type="button" data-arch-toggle>已归档会话 ${archived.length}</button>`;
    if (TASKS.showArchived) archived.forEach((t) => { html += taskRow(t, true); });
  }
  box.innerHTML = html;
  if (focusId) {
    const again = box.querySelector('.task[data-id="' + focusId + '"]');
    if (again) again.focus();
  }
}

function onTaskEdit() {
  if (!formHasContent()) {
    const cur = currentTask();
    if (cur && TASKS.busyId !== cur.id) {
      TASKS.list = TASKS.list.filter((t) => t.id !== cur.id);
      TASKS.id = null;
      renderTaskList();
      saveTasksNow();
    }
    return null;
  }
  let t = currentTask();
  const fresh = !t;
  if (!t) {
    const now = Date.now();
    t = {
      id: 't' + now.toString(36) + Math.random().toString(36).slice(2, 6),
      title: '',
      templateId: '',
      cred: '',
      detail: '',
      extra: '',
      markdown: '',
      images: [],
      exported: '',
      archived: false,
      pinned: false,
      workspaceId: ensureWorkspaces(),
      updatedAt: now,
      createdAt: now
    };
    TASKS.list.unshift(t);
    TASKS.id = t.id;
  }
  readFormInto(t);
  t.updatedAt = Date.now();
  if (fresh) renderTaskList();
  else {
    const title = document.querySelector('#taskList .task.on .task-title');
    if (title) title.textContent = displayTitle(t);
  }
  saveTasksSoon();
  return t;
}

function flushDraft() {
  const cur = currentTask();
  if (cur) {
    readFormInto(cur);
    cur.updatedAt = Date.now();
    if (!hasContent(cur) && TASKS.busyId !== cur.id) {
      TASKS.list = TASKS.list.filter((t) => t.id !== cur.id);
      if (TASKS.id === cur.id) TASKS.id = null;
      saveTasksNow();
    }
    return cur;
  }
  if (formHasContent()) return onTaskEdit();
  return null;
}

function selectTask(id) {
  if (!id) return;
  const page = document.getElementById('page-report');
  const wasReport = page && page.classList.contains('on');
  if (TASKS.id === id && wasReport) return;
  if (!currentTask() && formHasContent()) onTaskEdit();
  else if (TASKS.id && TASKS.id !== id) readFormInto(currentTask());
  const t = TASKS.list.find((x) => x.id === id);
  if (!t) return;
  const same = TASKS.id === id && wasReport;
  TASKS.id = id;
  applyTask(t);
  go('report');
  if (wasReport && !same) kickSwap();
}

function requestNewTask() {
  flushDraft();
  const page = document.getElementById('page-report');
  const wasReport = page && page.classList.contains('on');
  blankForm({ focus: true });
  if (wasReport) kickSwap();
}

function createTask(partial) {
  partial = partial || {};
  const incoming = {
    title: partial.title || '',
    cred: partial.cred || '',
    detail: partial.detail || '',
    extra: partial.extra || '',
    markdown: partial.markdown || '',
    // 之前截的图挂到这条任务上，别让它跟着 pendingShots 丢掉
    images: Array.isArray(partial.images) && partial.images.length
      ? partial.images.slice()
      : S.pendingShots.splice(0, S.pendingShots.length)
  };
  if (!hasContent(incoming)) return requestNewTask();
  flushDraft();
  const now = Date.now();
  const t = {
    id: 't' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    title: incoming.title,
    templateId: partial.templateId || (($('#rTemplate') && $('#rTemplate').value) || ''),
    cred: incoming.cred,
    detail: incoming.detail,
    extra: incoming.extra,
    markdown: incoming.markdown,
    images: incoming.images,
    exported: partial.exported || '',
    archived: false,
    pinned: false,
    workspaceId: partial.workspaceId || ensureWorkspaces(),
    updatedAt: now,
    createdAt: now
  };
  TASKS.list.unshift(t);
  TASKS.id = t.id;
  const page = document.getElementById('page-report');
  const wasReport = page && page.classList.contains('on');
  applyTask(t);
  go('report');
  if (wasReport) kickSwap();
  saveTasksNow();
  return t;
}

function archiveTask(id) {
  const t = TASKS.list.find((x) => x.id === id);
  if (!t || t.archived) return;
  if (TASKS.id === id) readFormInto(t);
  if (!hasContent(t)) return;
  t.archived = true;
  t.updatedAt = Date.now();
  if (TASKS.id === id) {
    const next = activeTasks()[0] || null;
    if (next) {
      TASKS.id = next.id;
      applyTask(next);
    } else blankForm();
  }
  renderTaskList();
  saveTasksNow();
  toast('已放入已归档会话', false, { label: '撤销', run: () => unarchiveTask(id) });
}

function unarchiveTask(id) {
  const t = TASKS.list.find((x) => x.id === id);
  if (!t) return;
  t.archived = false;
  t.updatedAt = Date.now();
  TASKS.showArchived = false;
  saveTasksNow();
  renderTaskList();
  selectTask(id);
  toast('已恢复');
}

function removeTask(id) {
  const idx = TASKS.list.findIndex((t) => t.id === id);
  if (idx < 0) return;
  if (TASKS.id && TASKS.id !== id) readFormInto(currentTask());
  stopRun(id);
  TASKS.list.splice(idx, 1);
  if (TASKS.id === id) {
    const next = activeTasks()[0] || null;
    if (next) {
      TASKS.id = next.id;
      applyTask(next);
      if (document.getElementById('page-report').classList.contains('on')) kickSwap();
    } else blankForm();
  }
  renderTaskList();
  saveTasksNow();
  toast('已删除');
}

function clearTasks() {
  const viewing = currentTask();
  TASKS.list.forEach((t) => {
    if (t.archived || !hasContent(t)) return;
    stopRun(t.id);
    t.archived = true;
  });
  setClearArm(false);
  TASKS.showArchived = true;
  if (!viewing || !viewing.archived) blankForm();
  else renderTaskList();
  saveTasksNow();
  toast('已放入已归档会话');
}

function closeTaskMenu() {
  const menu = $('#taskMenu');
  if (!menu || menu.hidden) return;
  menu.classList.add('out');
  clearTimeout(menu._t);
  menu._t = setTimeout(() => {
    menu.hidden = true;
    menu.classList.remove('out');
  }, 150);
}

function openTaskMenu(id, x, y) {
  const t = TASKS.list.find((item) => item.id === id);
  const menu = $('#taskMenu');
  if (!t || !menu) return;
  const rows = [];
  const gap = () => { if (rows.length && !rows[rows.length - 1].sep) rows.push({ sep: true }); };
  if (!t.archived) {
    rows.push({ id: 'pin', label: t.pinned ? '取消置顶' : '置顶' });
    rows.push({ id: 'rename', label: '重命名' });
    gap();
  }
  rows.push({ id: 'archive', label: t.archived ? '恢复' : '归档' });
  gap();
  rows.push({ id: 'del', label: t.archived ? '彻底删除' : '放入已归档', danger: !!t.archived });
  menu.innerHTML = rows.map((item) => item.sep
    ? '<div class="sep"></div>'
    : `<button type="button" role="menuitem" data-menu="${item.id}" class="${item.danger ? 'danger' : ''}">${esc(item.label)}</button>`
  ).join('');
  menu.hidden = false;
  menu.classList.remove('out');
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(12, Math.min(x, window.innerWidth - rect.width - 12)) + 'px';
  menu.style.top = Math.max(12, Math.min(y, window.innerHeight - rect.height - 12)) + 'px';
  menu.onclick = (e) => {
    const btn = e.target.closest('[data-menu]');
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.menu;
    closeTaskMenu();
    if (act === 'pin') {
      t.pinned = !t.pinned;
      saveTasksNow();
      renderTaskList();
      return;
    }
    if (act === 'rename') {
      selectTask(id);
      const field = $('#rTitle');
      if (field) {
        field.focus();
        field.select();
      }
      return;
    }
    if (act === 'archive') {
      if (t.archived) unarchiveTask(id);
      else archiveTask(id);
      return;
    }
    if (act === 'del') {
      if (!t.archived) {
        archiveTask(id);
        return;
      }
      openConfirm({
        title: '从已归档会话删除',
        text: '这份报告会从已归档会话里去掉。',
        ok: '删除',
        run: () => removeTask(id)
      });
    }
  };
}

function openWorkspaceDialog() {
  const modal = $('#nameModal');
  const input = $('#nameInput');
  if (!modal || !input) return;
  input.value = '';
  clearTimeout(modal._t);
  modal.classList.remove('out');
  modal.hidden = false;
  setTimeout(() => input.focus(), 30);
  const close = () => {
    modal.classList.add('out');
    modal._t = setTimeout(() => { modal.hidden = true; modal.classList.remove('out'); }, 160);
  };
  const ok = () => {
    const name = input.value.trim();
    if (!name) return;
    ensureWorkspaces();
    const id = 'ws' + Date.now().toString(36);
    TASKS.workspaces.unshift({ id, name, open: true, createdAt: Date.now() });
    TASKS.wsId = id;
    saveTasksNow();
    renderTaskList();
    close();
  };
  $('#nameOk').onclick = ok;
  $('#nameCancel').onclick = close;
  $('#nameX').onclick = close;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') ok();
    if (e.key === 'Escape') close();
  };
}

function openConfirm(opts) {
  const modal = $('#confirmModal');
  const ok = $('#confirmOk');
  const ack = $('#confirmAck');
  if (!modal || !ok || !ack) {
    if (opts.run) opts.run();
    return;
  }
  $('#confirmTitle').textContent = opts.title || '确认';
  $('#confirmText').textContent = opts.text || '';
  ok.textContent = opts.ok || '确认';
  ack.checked = false;
  ok.disabled = true;
  clearTimeout(modal._t);
  modal.classList.remove('out');
  modal.hidden = false;
  const close = () => {
    modal.classList.add('out');
    modal._t = setTimeout(() => {
      modal.hidden = true;
      modal.classList.remove('out');
    }, 160);
    ok.onclick = null;
    $('#confirmCancel').onclick = null;
    $('#confirmX').onclick = null;
    ack.onchange = null;
  };
  ack.onchange = () => { ok.disabled = !ack.checked; };
  ok.onclick = () => {
    if (!ack.checked) return;
    close();
    if (opts.run) opts.run();
  };
  $('#confirmCancel').onclick = close;
  $('#confirmX').onclick = close;
}

function setClearArm(on) {
  clearArmed = !!on;
  const b = $('#btnTasksClear');
  if (!b) return;
  b.textContent = clearArmed ? '确认清空' : '清空';
  b.classList.toggle('arm', clearArmed);
}

function bindTasks() {
  const box = $('#taskList');
  if (!box || box._bound) return;
  box._bound = true;
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-arch-toggle]')) {
      TASKS.showArchived = !TASKS.showArchived;
      renderTaskList();
      return;
    }
    const addHere = e.target.closest('[data-ws-new]');
    if (addHere) {
      e.stopPropagation();
      TASKS.wsId = addHere.dataset.wsNew;
      const space = TASKS.workspaces.find((w) => w.id === TASKS.wsId);
      if (space) space.open = true;
      saveTasksNow();
      requestNewTask();
      return;
    }
    const ws = e.target.closest('.ws');
    if (ws) {
      const space = TASKS.workspaces.find((w) => w.id === ws.dataset.ws);
      if (!space) return;
      if (TASKS.wsId === space.id) space.open = space.open === false;
      else {
        TASKS.wsId = space.id;
        space.open = true;
      }
      saveTasksNow();
      renderTaskList();
      return;
    }
    const arch = e.target.closest('[data-arch]');
    if (arch) {
      e.stopPropagation();
      archiveTask(arch.dataset.arch);
      return;
    }
    const back = e.target.closest('[data-unarch]');
    if (back) {
      e.stopPropagation();
      unarchiveTask(back.dataset.unarch);
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      const id = del.dataset.del;
      openConfirm({
        title: '删除报告',
        text: '这份报告会从列表消失。',
        ok: '删除',
        run: () => removeTask(id)
      });
      return;
    }
    const row = e.target.closest('.task');
    if (row) selectTask(row.dataset.id);
  });
  const placeArchTip = (btn) => {
    let tip = document.getElementById('archTip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'archTip';
      tip.className = 'arch-tip';
      tip.textContent = '归档任务';
      tip.hidden = true;
      document.body.appendChild(tip);
    }
    if (!btn) { tip.hidden = true; return; }
    const r = btn.getBoundingClientRect();
    tip.hidden = false;
    tip.style.left = (r.left + r.width / 2) + 'px';
    tip.style.top = (r.top - 6) + 'px';
  };
  box.addEventListener('mouseover', (e) => placeArchTip(e.target.closest('.task-arch')));
  box.addEventListener('mouseleave', () => placeArchTip(null));
  box.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.task');
    if (!row) return;
    e.preventDefault();
    openTaskMenu(row.dataset.id, e.clientX, e.clientY);
  });
  if (!bindTasks._menuDoc) {
    bindTasks._menuDoc = true;
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest || !e.target.closest('#taskMenu')) closeTaskMenu();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeTaskMenu();
    });
  }
  box.addEventListener('keydown', (e) => {
    const row = e.target.closest('.task');
    if (!row) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      selectTask(row.dataset.id);
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const rows = Array.from(box.querySelectorAll('.task'));
    const i = rows.indexOf(row);
    const n = rows[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!n) return;
    n.focus();
    selectTask(n.dataset.id);
  });

  const neu = $('#btnTaskNew');
  if (neu) neu.addEventListener('click', () => requestNewTask());
  const neuTask = $('#btnNewTask');
  if (neuTask) neuTask.addEventListener('click', () => requestNewTask());
  const wsNew = $('#btnWsNew');
  if (wsNew) wsNew.addEventListener('click', () => openWorkspaceDialog());
  const label = $('#btnReports');
  if (label) label.addEventListener('click', () => go('report'));

  const clr = $('#btnTasksClear');
  if (clr) {
    clr.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!activeTasks().length) return;
      openConfirm({
        title: '清空报告',
        text: '未归档的报告会放进已归档会话。正在生成的那一份会停掉。',
        ok: '归档',
        run: clearTasks
      });
    });
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('#btnTasksClear')) setClearArm(false);
  });

  ['rTitle', 'rCred', 'rDetail', 'rExtra'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', onTaskEdit);
  });
  const tpl = $('#rTemplate');
  if (tpl) tpl.addEventListener('change', onTaskEdit);
  window.addEventListener('blur', () => {
    const t = currentTask();
    if (t) readFormInto(t);
    saveTasksNow();
  });
}

async function loadTasks() {
  if (!window.api.tasks) {
    blankForm();
    return;
  }
  try {
    const data = await window.api.tasks.list();
    TASKS.list = (data && data.tasks) || [];
    TASKS.workspaces = (data && data.workspaces) || [];
  } catch (e) {
    TASKS.list = [];
    TASKS.workspaces = [];
  }
  ensureWorkspaces();
  const first = activeTasks()[0];
  if (first) selectTask(first.id);
  else blankForm();
}

/* ---------------- 模板 ---------------- */

function renderTplList() {
  const box = $('#tplList');
  if (!S.templates.length) {
    box.innerHTML = '<div class="task-empty">还没有模板</div>';
    return;
  }
  box.innerHTML = S.templates
    .map((t) => `<div class="item ${t.id === S.tplId ? 'on' : ''}" data-id="${t.id}">
        <span class="grow">${esc(t.name)}</span><small>${esc(t.platform)}</small></div>`)
    .join('');
  box.querySelectorAll('.item').forEach((el) => {
    el.addEventListener('click', () => selectTpl(el.dataset.id));
  });
}

function templateNameFrom(filePath, fileName) {
  const raw = fileName || '';
  const stem = raw.replace(/\.(md|markdown|txt)$/i, '').trim();
  const generic = /^(漏洞提交模板|漏洞模板|提交模板|模板|template)$/i.test(stem);
  if (generic && filePath) {
    const parts = String(filePath).split(/[/\\]/).filter(Boolean);
    const parent = parts.length >= 2 ? parts[parts.length - 2] : '';
    if (parent) return parent;
  }
  return stem || '未命名模板';
}

async function importTemplateFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => /\.(md|markdown|txt)$/i.test(f.name));
  if (!files.length) return toast('请拖入 .md 文件', true);
  let last = null;
  for (const file of files) {
    let full = '';
    try { full = window.api.filePath ? window.api.filePath(file) : (file.path || ''); } catch (e) { full = ''; }
    const name = templateNameFrom(full, file.name);
    const body = (await file.text()).replace(/^\uFEFF/, '');
    last = await window.api.templates.upsert({ name, platform: name, body });
  }
  S.templates = await window.api.templates.list();
  if (last) selectTpl(last.id);
  fillTemplateSelect();
  toast(files.length > 1 ? '已导入 ' + files.length + ' 个模板' : '已导入 ' + (last && last.name));
}

function selectTpl(id) {
  S.tplId = id;
  const t = S.templates.find((x) => x.id === id);
  if (!t) return;
  $('#tplName').value = t.name;
  $('#tplPlatform').value = t.platform;
  $('#tplBody').value = t.body;
  renderTplList();
  refreshTplCheck();
}

async function tplIssues(body) {
  if (!window.api.templates.check) return null;
  return window.api.templates.check(body);
}

function showTplIssues(r) {
  const el = $('#tplCheck');
  if (!el) return;
  if (!r || r.ok) { el.textContent = ''; return; }
  el.textContent = r.unclosed ? '占位符没有闭合' : '未知占位符：' + (r.unknown || []).join('、');
}

const refreshTplCheck = debounce(async () => {
  showTplIssues(await tplIssues($('#tplBody').value));
}, 180);

async function saveTpl() {
  const t = {
    id: S.tplId,
    name: $('#tplName').value.trim() || '未命名',
    platform: $('#tplPlatform').value.trim() || '自定义',
    body: $('#tplBody').value
  };
  const issues = await tplIssues(t.body);
  showTplIssues(issues);
  await window.api.templates.upsert(t);
  S.templates = await window.api.templates.list();
  if (!S.tplId) S.tplId = S.templates[S.templates.length - 1].id;
  renderTplList();
  fillTemplateSelect();
  toast(issues && !issues.ok ? '已保存，占位符需要再看一眼' : '模板已保存');
}

$('#btnTplSave').addEventListener('click', saveTpl);
$('#tplBody').addEventListener('input', refreshTplCheck);
$('#btnTplNew').addEventListener('click', () => {
  S.tplId = null;
  $('#tplName').value = '';
  $('#tplPlatform').value = '';
  $('#tplBody').value = '';
  renderTplList();
  $('#tplName').focus();
});
$('#btnTplImport').addEventListener('click', () => $('#tplFile').click());
$('#tplFile').addEventListener('change', (e) => {
  importTemplateFiles(e.target.files);
  e.target.value = '';
});
const tplDrop = $('#tplDrop');
const tplPage = $('#page-templates');
if (tplDrop && tplPage) {
  ['dragenter', 'dragover'].forEach((ev) => tplPage.addEventListener(ev, (e) => {
    if (![...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files')) return;
    e.preventDefault();
    tplDrop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => tplPage.addEventListener(ev, (e) => {
    e.preventDefault();
    tplDrop.classList.remove('over');
  }));
  tplPage.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) importTemplateFiles(e.dataTransfer.files);
  });
}
$('#btnTplDel').addEventListener('click', () => {
  if (!S.tplId) return;
  const id = S.tplId;
  openConfirm({
    title: '删除模板',
    text: '这个模板会从列表消失。',
    ok: '删除',
    run: async () => {
      await window.api.templates.remove(id);
      S.templates = await window.api.templates.list();
      S.tplId = S.templates[0] && S.templates[0].id;
      if (S.tplId) selectTpl(S.tplId);
      else {
        if ($('#tplName')) $('#tplName').value = '';
        if ($('#tplPlatform')) $('#tplPlatform').value = '';
        if ($('#tplBody')) $('#tplBody').value = '';
      }
      renderTplList();
      fillTemplateSelect();
      toast('已删除');
    }
  });
});

/* ---------------- 设置 ---------------- */

const LLM = { detail: null, models: {} };

function maskKey(k) {
  if (!k) return '未填 Key';
  if (!S.settings.ui.maskKeys) return k;
  return k.length > 10 ? k.slice(0, 3) + '…' + k.slice(-4) : '••••';
}

function provSummary(p) {
  const n = (p.models || []).length;
  const key = providerKey(p);
  return `${key ? '已填 ' + maskKey(key) : '未填 Key'} · ${n} 个模型`;
}

function providerListHTML() {
  const list = S.settings.providers || [];
  if (!list.length) {
    return '<div class="lc-empty">还没有模型配置。点「新建」添加。</div>';
  }
  const activeId = S.settings.activeProviderId;
  return `<div class="llm-grid">${list
    .map((p) => {
      const on = p.id === activeId;
      const key = providerKey(p);
      return `<div class="prov-row ${on ? 'on' : ''}" data-id="${p.id}">
        <b class="prov-name">${esc(p.name)}</b>
        <span class="prov-tag">${p.kind === 'anthropic' ? '自定义' : 'OpenAI 兼容'}</span>
        <span class="prov-dot ${p.enabled === false ? 'off' : ''}"></span>
        <span class="prov-model">${esc(p.activeModel || '未选模型')}</span>
        <span class="spacer"></span>
        ${on ? '<span class="prov-now">当前</span>' : '<button class="btn ghost" data-act="star">设为当前</button>'}
        <button class="btn ghost" data-act="edit">编辑</button>
        <button class="btn ghost danger" data-act="del">删除</button>
      </div>`;
    })
    .join('')}<button class="prov-add" type="button" data-act="add">＋ 添加模型提供商</button></div>`;
}

function providerDetailHTML(id) {
  const p = S.settings.providers.find((x) => x.id === id);
  if (!p) return providerListHTML();

  const accs = p.accounts || [];
  const mine = p.models || [];
  const fetched = LLM.models[id] || [];
  const all = Array.from(new Set([...mine, ...fetched]));

  return `
  <div class="pd-head">
    <button class="btn ghost" id="pdBack">‹ 返回</button>
    <b>${esc(p.name)}</b>
    <span class="spacer"></span>
    <label class="switch"><input type="checkbox" id="pdEnabled" ${p.enabled ? 'checked' : ''}/><span></span></label>
  </div>

  <div class="klist">
    <div class="krow"><div class="klabel">名称</div><input class="inp kin" id="pdName" value="${esc(p.name)}" /></div>
    <div class="krow"><div class="klabel">接口协议</div>
      <select class="inp kin" id="pdKind">
        <option value="openai"${p.kind === 'openai' ? ' selected' : ''}>OpenAI 兼容</option>
        <option value="anthropic"${p.kind === 'anthropic' ? ' selected' : ''}>Anthropic 兼容</option>
      </select>
    </div>
    <div class="krow"><div class="klabel">Base URL</div><input class="inp kin" id="pdBase" value="${esc(p.baseURL)}" /></div>
    <div class="krow"><div class="klabel">模型列表地址<small>留空按协议猜</small></div><input class="inp kin" id="pdModelsURL" value="${esc(p.modelsURL || '')}" /></div>
    <div class="krow"><div class="klabel">代理<small>http 或 socks5，留空直连</small></div><input class="inp kin" id="pdProxy" value="${esc(p.proxy || '')}" placeholder="http://127.0.0.1:8080" /></div>
    <div class="krow"><div class="klabel">自定义会话头<small>留空则不发送</small></div><input class="inp kin" id="pdSession" value="${esc(p.sessionHeader || '')}" placeholder="如 x-session-id" /></div>
    <div class="krow"><div class="klabel">每秒<small>0 表示不限</small></div><input class="inp kin" id="pdSec" type="number" min="0" value="${Number(p.limitSec) || 0}" /></div>
    <div class="krow"><div class="klabel">每分钟<small>0 表示不限</small></div><input class="inp kin" id="pdMin" type="number" min="0" value="${Number(p.limitMin) || 0}" /></div>
    <div class="krow"><div class="klabel">上下文 K<small>0 表示不限</small></div><input class="inp kin" id="pdCtx" type="number" min="0" value="${Number(p.contextK) || 0}" /></div>
  </div>

  <div class="pd-sec">
    <h4>账号</h4>
    <div id="pdAccounts">
      ${accs.map((a) => `
        <div class="acc-item" data-aid="${a.id}">
          <label class="f">名称<input class="inp aname" data-a="name" value="${esc(a.name)}" placeholder="名称" /></label>
          <label class="f">API Key<input class="inp" data-a="apiKey" type="password" value="${esc(a.apiKey)}" placeholder="API Key" /></label>
          <div class="row actions">
            <button class="btn ghost" data-act="use">${a.id === p.activeAccountId ? '首选' : '设为首选'}</button>
            <button class="btn ghost" data-act="del">删除</button>
          </div>
        </div>`).join('')}
    </div>
    <button class="btn ghost" id="pdAddAcc">+ 添加账号</button>
  </div>

  <div class="pd-sec">
    <h4>模型</h4>
    <div class="chips" id="pdChips">
      ${all.map((m) => `<span class="mchip ${mine.includes(m) ? 'on' : ''} ${m === p.activeModel ? 'cur' : ''}" data-m="${esc(m)}">${esc(m)}</span>`).join('')}
    </div>
    <label class="f">添加模型 ID
      <input class="inp" id="pdModelInput" placeholder="模型 ID" />
    </label>
    <div class="row actions">
      <button class="btn" id="pdAddModel">添加</button>
      <button class="btn" id="pdFetch">重新获取</button>
      <button class="btn" id="pdTest">测试</button>
      <span class="muted" id="pdModelCount">${mine.length} 个已选</span>
    </div>
    <label class="f">当前使用
      <select class="inp" id="pdActiveModel">
        ${mine.map((m) => `<option${m === p.activeModel ? ' selected' : ''}>${esc(m)}</option>`).join('')}
      </select>
    </label>
  </div>

  <div class="row actions" style="margin-top:18px">
    <button class="btn primary" id="pdSave">保存</button>
    <button class="btn ghost" id="pdRemove">移除</button>
  </div>`;
}

function bindProviderDetail(id) {
  const p = S.settings.providers.find((x) => x.id === id);
  if (!p) return;

  const rerender = () => renderLLM();

  $('#pdBack').addEventListener('click', () => { LLM.detail = null; renderLLM(); });
  $('#pdEnabled').addEventListener('change', (e) => { p.enabled = e.target.checked; persist(); renderLLM(); });
  $('#pdName').addEventListener('input', (e) => { p.name = e.target.value; persist(); });
  $('#pdKind').addEventListener('change', (e) => { p.kind = e.target.value; persist(); });
  $('#pdBase').addEventListener('input', (e) => { p.baseURL = e.target.value; persist(); });
  $('#pdModelsURL').addEventListener('input', (e) => { p.modelsURL = e.target.value; persist(); });
  $('#pdProxy').addEventListener('input', (e) => { p.proxy = e.target.value; persist(); });
  $('#pdSession').addEventListener('input', (e) => { p.sessionHeader = e.target.value; persist(); });
  $('#pdSec').addEventListener('input', (e) => { p.limitSec = Number(e.target.value) || 0; persist(); });
  $('#pdMin').addEventListener('input', (e) => { p.limitMin = Number(e.target.value) || 0; persist(); });
  $('#pdCtx').addEventListener('input', (e) => { p.contextK = Number(e.target.value) || 0; persist(); });

  document.querySelectorAll('#pdAccounts .acc-item').forEach((el) => {
    const aid = el.dataset.aid;
    const acc = (p.accounts || []).find((a) => a.id === aid);
    if (!acc) return;
    el.querySelectorAll('[data-a]').forEach((inp) => {
      inp.addEventListener('input', () => { acc[inp.dataset.a] = inp.value; persist(); });
    });
    el.querySelector('[data-act="use"]').addEventListener('click', () => {
      p.activeAccountId = aid;
      persist();
      rerender();
    });
    el.querySelector('[data-act="del"]').addEventListener('click', () => {
      if ((p.accounts || []).length <= 1) return toast('至少留一个账号', true);
      p.accounts = p.accounts.filter((a) => a.id !== aid);
      if (p.activeAccountId === aid) p.activeAccountId = p.accounts[0].id;
      persist();
      rerender();
    });
  });

  $('#pdAddAcc').addEventListener('click', () => {
    p.accounts = p.accounts || [];
    p.accounts.push({ id: 'acc' + Date.now().toString(36), name: '账号 ' + (p.accounts.length + 1), apiKey: '' });
    persist();
    rerender();
  });

  document.querySelectorAll('#pdChips .mchip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const m = chip.dataset.m;
      const has = (p.models || []).includes(m);
      p.models = has ? p.models.filter((x) => x !== m) : [...(p.models || []), m];
      if (!p.models.length) p.models = [m];
      if (!p.models.includes(p.activeModel)) p.activeModel = p.models[0];
      persist();
      rerender();
    });
  });

  $('#pdAddModel').addEventListener('click', () => {
    const v = $('#pdModelInput').value.trim();
    if (!v) return;
    if (!(p.models || []).includes(v)) p.models = [...(p.models || []), v];
    p.activeModel = p.activeModel || v;
    $('#pdModelInput').value = '';
    persist();
    rerender();
    toast('已添加 ' + v);
  });

  $('#pdFetch').addEventListener('click', async () => {
    toast('拉取中…');
    const r = await window.api.models(flattenProvider(p));
    if (r.ok) {
      LLM.models[id] = r.models;
      renderLLM();
      toast(`拉到 ${r.models.length} 个模型`);
    } else {
      toast('拉取失败：' + r.error, true);
    }
  });

  $('#pdTest').addEventListener('click', async () => {
    toast('测试中…');
    const r = await window.api.models(flattenProvider(p));
    if (r.ok) toast(`连接成功，${r.models.length} 个模型`);
    else toast('连接失败：' + r.error, true);
  });

  $('#pdActiveModel').addEventListener('change', (e) => { p.activeModel = e.target.value; persist(); });

  $('#pdSave').addEventListener('click', () => {
    persist();
    toast('已保存');
  });

  $('#pdRemove').addEventListener('click', () => {
    S.settings.providers = S.settings.providers.filter((x) => x.id !== id);
    if (S.settings.activeProviderId === id) {
      const first = S.settings.providers[0];
      S.settings.activeProviderId = first ? first.id : '';
    }
    LLM.detail = null;
    persist();
    renderLLM();
    toast('已移除');
  });
}

function bindProviderList() {
  const add = document.querySelector('.prov-add');
  if (add) {
    add.addEventListener('click', () => {
      if (typeof openProvModal === 'function') openProvModal();
    });
  }
  document.querySelectorAll('.prov-row').forEach((card) => {
    const id = card.dataset.id;
    const p = S.settings.providers.find((x) => x.id === id);
    if (!p) return;

    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      LLM.detail = id;
      renderLLM();
    });

    const edit = card.querySelector('[data-act="edit"]');
    if (edit) {
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        LLM.detail = id;
        renderLLM();
      });
    }

    const star = card.querySelector('[data-act="star"]');
    if (star) {
      star.addEventListener('click', (e) => {
        e.stopPropagation();
        S.settings.activeProviderId = id;
        p.enabled = true;
        persist();
        renderLLM();
        syncModelPill();
        toast('已激活 ' + p.name);
      });
    }

    const act = card.querySelector('[data-act="activate"]');
    if (act) {
      act.addEventListener('click', (e) => {
        e.stopPropagation();
        if (S.settings.activeProviderId === id) return;
        S.settings.activeProviderId = id;
        p.enabled = true;
        persist();
        renderLLM();
        syncModelPill();
        toast('已激活 ' + p.name);
      });
    }

    const del = card.querySelector('[data-act="del"]');
    if (del) {
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        S.settings.providers = S.settings.providers.filter((x) => x.id !== id);
        if (S.settings.activeProviderId === id) {
          S.settings.activeProviderId = S.settings.providers[0] ? S.settings.providers[0].id : '';
        }
        persist();
        renderLLM();
        syncModelPill();
        toast('已删除');
      });
    }
  });
}

function renderLLM() {
  const box = $('#llmPanel');
  if (!box) return;
  box.innerHTML = LLM.detail ? providerDetailHTML(LLM.detail) : providerListHTML();
  if (LLM.detail) bindProviderDetail(LLM.detail);
  else bindProviderList();
}

function renderProviders() {
  renderLLM();
}

const persist = debounce(() => window.api.settings.set(S.settings), 200);

$('#btnProvTest') && $('#btnProvTest').addEventListener('click', async () => {
  const p = activeProvider();
  if (!p) return toast('没有可用服务', true);
  toast('测试中…');
  const r = await window.api.models(p);
  if (r.ok) toast(`连接成功，${r.models.length} 个模型`);
  else toast('连接失败：' + r.error, true);
});


$('#btnDataDir').addEventListener('click', () => window.api.openPath(S.info.userData));




/* ---------------- 新建模型配置 ---------------- */

// 内置 GLM 便利项：协议、模型、地址与 store 里的预设保持一致。名称留给用户填。
const GLM_FORM = {
  kind: 'anthropic',
  model: 'glm-4.6',
  baseURL: 'https://open.bigmodel.cn/api/anthropic',
  modelsURL: 'https://open.bigmodel.cn/api/paas/v4/models'
};

function openProvModal() {
  const m = $('#provModal');
  m.hidden = false;
  $('#pmStatus').textContent = '';
  $('#pmName').value = '';
  $('#pmKind').value = GLM_FORM.kind;
  $('#pmModel').value = GLM_FORM.model;
  $('#pmBase').value = GLM_FORM.baseURL;
  $('#pmKey').value = '';
  $('#pmProxy').value = '';
  $('#pmSession').value = '';
  $('#pmSec').value = '0';
  $('#pmMin').value = '0';
  $('#pmCtx').value = '0';
  $('#pmName').focus();
}

function closeProvModal() {
  $('#provModal').hidden = true;
}

function draftProvider() {
  const baseURL = $('#pmBase').value.trim();
  return {
    id: 'p' + Date.now().toString(36),
    name: $('#pmName').value.trim() || '未命名服务',
    kind: $('#pmKind').value,
    baseURL,
    modelsURL: baseURL === GLM_FORM.baseURL ? GLM_FORM.modelsURL : '',
    enabled: true,
    accounts: [{ id: 'acc' + Date.now().toString(36), name: '默认', apiKey: $('#pmKey').value.trim() }],
    activeAccountId: '',
    models: $('#pmModel').value.trim() ? [$('#pmModel').value.trim()] : [],
    activeModel: $('#pmModel').value.trim(),
    proxy: $('#pmProxy').value.trim(),
    sessionHeader: $('#pmSession').value.trim(),
    limitSec: Number($('#pmSec').value) || 0,
    limitMin: Number($('#pmMin').value) || 0,
    contextK: Number($('#pmCtx').value) || 0
  };
}

function bindProvModal() {
  $('#pmClose').addEventListener('click', closeProvModal);
  $('#provModal').addEventListener('click', (e) => {
    if (e.target.id === 'provModal') closeProvModal();
  });

  $('#pmTest').addEventListener('click', async () => {
    const d = draftProvider();
    d.activeAccountId = d.accounts[0].id;
    if (!d.baseURL) return ($('#pmStatus').textContent = '先填 Base URL');
    $('#pmStatus').textContent = '测试中…';
    const r = await window.api.models(flattenProvider(d));
    $('#pmStatus').textContent = r.ok ? `连接成功，拉到 ${r.models.length} 个模型` : '连接失败：' + r.error;
    if (r.ok && !$('#pmModel').value && r.models.length) $('#pmModel').value = r.models[0];
  });

  $('#pmModelFetch').addEventListener('click', async () => {
    const d = draftProvider();
    d.activeAccountId = d.accounts[0].id;
    $('#pmStatus').textContent = '拉取中…';
    const r = await window.api.models(flattenProvider(d));
    if (!r.ok) return ($('#pmStatus').textContent = '拉取失败：' + r.error);
    if (r.models.length) $('#pmModel').value = r.models[0];
    $('#pmStatus').textContent = `拉到 ${r.models.length} 个模型，已填入第一个`;
  });

  $('#pmCreate').addEventListener('click', () => {
    const d = draftProvider();
    d.activeAccountId = d.accounts[0].id;
    S.settings.providers.push(d);
    persist();
    closeProvModal();
    renderLLM();
    syncModelPill();
    toast('已添加');
  });
}

/* ---------------- 云端同步 ---------------- */

const SYNC_KIND_TEXT = { off: '关闭', webdav: 'WebDAV', github: 'GitHub' };

function syncSummaryText() {
  const sy = S.settings.sync || {};
  const kind = SYNC_KIND_TEXT[sy.kind] || '关闭';
  const last = sy.lastAt ? ' · ' + new Date(sy.lastAt).toLocaleString() : '';
  return kind + last;
}

function bindSyncPanel() {
  const sy = S.settings.sync;
  const rerender = () => renderSync();

  const kind = $('#syncKind');
  if (kind) {
    kind.addEventListener('change', (e) => {
      sy.kind = e.target.value;
      persist();
      rerender();
    });
  }

  const bind = (id, obj, key) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => { obj[key] = el.value; persist(); });
  };
  bind('#wdUrl', sy.webdav, 'url');
  bind('#wdUser', sy.webdav, 'user');
  bind('#wdPass', sy.webdav, 'pass');
  bind('#wdPath', sy.webdav, 'path');
  bind('#ghRepo', sy.github, 'repo');
  bind('#ghBranch', sy.github, 'branch');
  bind('#ghPath', sy.github, 'path');
  bind('#ghToken', sy.github, 'token');

  const setStatus = (t, bad) => {
    const el = $('#syncStatus');
    el.textContent = t;
    el.style.color = bad ? '#c0392b' : '';
  };

  $('#btnSyncTest').addEventListener('click', async () => {
    setStatus('测试中…');
    const r = await window.api.sync.test();
    setStatus(r.ok ? r.message || '连接成功' : '失败：' + r.error, !r.ok);
  });

  $('#btnSyncPush').addEventListener('click', async () => {
    setStatus('上传中…');
    const r = await window.api.sync.push();
    if (r.ok) {
      setStatus('已上传 · ' + new Date().toLocaleTimeString());
      $('#syncSummary').textContent = syncSummaryText();
      S.settings.sync.lastAt = new Date().toISOString();
      toast('已同步到云端');
    } else {
      setStatus('失败：' + r.error, true);
    }
  });

  $('#btnSyncPull').addEventListener('click', async () => {
    setStatus('下载中…');
    const r = await window.api.sync.pull();
    if (!r.ok) return setStatus('失败：' + r.error, true);
    S.settings = r.settings;
    renderLLM();
    fillTemplateSelect();
    renderSync();
    toast('已拉取远端设置，重启后全部生效');
  });
}

function renderSync() {
  const summary = $('#syncSummary');
  if (!summary) return;
  summary.textContent = syncSummaryText();

  const panel = $('#syncPanel');
  if (!panel || panel.hidden) return;
  const sy = S.settings.sync;
  const w = sy.webdav;
  const g = sy.github;

  panel.innerHTML = `
    <div class="klist">
      <div class="krow">
        <div class="klabel">方式</div>
        <select class="inp kin" id="syncKind">
          <option value="off"${sy.kind === 'off' ? ' selected' : ''}>关闭</option>
          <option value="webdav"${sy.kind === 'webdav' ? ' selected' : ''}>WebDAV</option>
          <option value="github"${sy.kind === 'github' ? ' selected' : ''}>GitHub</option>
        </select>
      </div>
      ${sy.kind === 'webdav' ? `
      <div class="krow"><div class="klabel">地址</div><input class="inp kin" id="wdUrl" value="${esc(w.url)}" placeholder="https://dav.example.com/dav/files/me" /></div>
      <div class="krow"><div class="klabel">用户名</div><input class="inp kin" id="wdUser" value="${esc(w.user)}" /></div>
      <div class="krow"><div class="klabel">密码</div><input class="inp kin" type="password" id="wdPass" value="${esc(w.pass)}" /></div>
      <div class="krow"><div class="klabel">远端文件名</div><input class="inp kin" id="wdPath" value="${esc(w.path)}" /></div>` : ''}
      ${sy.kind === 'github' ? `
      <div class="krow"><div class="klabel">仓库<small>owner/repo</small></div><input class="inp kin" id="ghRepo" value="${esc(g.repo)}" placeholder="me/dotfiles" /></div>
      <div class="krow"><div class="klabel">分支</div><input class="inp kin" id="ghBranch" value="${esc(g.branch)}" /></div>
      <div class="krow"><div class="klabel">路径</div><input class="inp kin" id="ghPath" value="${esc(g.path)}" /></div>
      <div class="krow"><div class="klabel">Token<small>只存本机</small></div><input class="inp kin" type="password" id="ghToken" value="${esc(g.token)}" /></div>` : ''}
    </div>
    ${sy.kind === 'off' ? '' : `
    <div class="row actions" style="margin-top:12px">
      <button class="btn" id="btnSyncTest">测试连接</button>
      <button class="btn primary" id="btnSyncPush">上传</button>
      <button class="btn" id="btnSyncPull">下载</button>
      <span class="spacer"></span>
      <span class="muted" id="syncStatus">${esc(sy.lastResult || '')}</span>
    </div>`}`;

  bindSyncPanel();
}

/* ---------------- 设置页 ---------------- */

function renderBackupList(items) {
  const box = $('#backupList');
  if (!box) return;
  if (!items.length) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = items
    .map(
      (it) => `<div class="vrow" data-path="${esc(it.path)}">
        <span>${esc(new Date(it.mtime).toLocaleString())} · ${Math.round(it.size / 1024)} KB</span>
        <button class="btn ghost" data-act="restore">恢复…</button>
      </div>`
    )
    .join('');
  box.querySelectorAll('[data-act="restore"]').forEach((b) => {
    b.addEventListener('click', async () => {
      const file = b.closest('.vrow').dataset.path;
      const r = await window.api.backup.restore(file);
      if (!r.ok) return toast('恢复失败：' + r.error, true);
      S.settings = r.settings;
      renderLLM();
      fillTemplateSelect();
      toast('已恢复，重启后全部生效');
    });
  });
}

async function refreshBackup() {
  const r = await window.api.backup.list();
  if (r.ok) {
    renderBackupList(r.items);
    $('#backupLast').textContent = r.items.length ? `${r.items.length} 份` : '还没有备份';
  }
  const d = await window.api.backup.dir();
  const dir = (d && d.ok !== false && typeof d === 'string') ? d : '';
  $('#backupDirText').textContent = S.settings.backup.dir || (dir ? '默认 · ' + dir : '默认');
  $('#backupDirText').title = dir;
}

async function bindSettingsPage(ri) {
  const ui = S.settings.ui;
  const bk = S.settings.backup;

  // 开关：状态放在 aria-checked 上，样式跟着走
  const sw = (id, on) => $('#' + id).setAttribute('aria-checked', on ? 'true' : 'false');
  const swOn = (id) => $('#' + id).getAttribute('aria-checked') === 'true';
  const bindSwitch = (id, apply) => {
    const el = $('#' + id);
    el.addEventListener('click', () => {
      const next = !swOn(id);
      sw(id, next);
      apply(next);
      persist();
    });
  };

  $('#setWidth').value = ui.shotWidth || 1600;
  sw('setAutoShot', ui.autoShot !== false);
  $('#setProtocol').value = ui.protocol || 'auto';
  sw('setConfirmQuit', !!ui.confirmQuit);
  sw('setWithKeys', !!bk.withKeys);
  $('#setBackupAuto').value = bk.auto || 'off';
  $('#setBackupKeep').value = String(bk.keep || 7);
  $('#setPort').value = ui.remotePort || 8765;
  $('#setProxy').value = ui.proxy || '';

  $('#setWidth').addEventListener('input', (e) => {
    S.settings.ui.shotWidth = Number(e.target.value) || 1600;
    persist();
  });
  const paintShotDir = async () => {
    if (!window.api.shots) return;
    const d = await window.api.shots.dir();
    const el = $('#shotDirText');
    if (!el) return;
    const shown = (typeof d === 'string' && d) ? d : '';
    el.textContent = S.settings.ui.shotDir ? shown : (shown ? '默认 · ' + shown : '默认');
    el.title = shown;
  };
  if (window.api.shots) {
    $('#btnShotDir').addEventListener('click', async () => {
      const r = await window.api.shots.choose();
      if (!r || r.canceled) return;
      S.settings.ui.shotDir = r.dir || '';
      persist();
      paintShotDir();
    });
    $('#btnShotShow').addEventListener('click', () => window.api.shots.show());
    paintShotDir();
  }
  bindSwitch('setAutoShot', (on) => { S.settings.ui.autoShot = on; });
  $('#setProtocol').addEventListener('change', (e) => {
    S.settings.ui.protocol = e.target.value;
    $('#protocol').value = e.target.value;
    persist();
  });
  bindSwitch('setConfirmQuit', (on) => { S.settings.ui.confirmQuit = on; });
  bindSwitch('setWithKeys', (on) => { S.settings.backup.withKeys = on; });
  $('#setBackupAuto').addEventListener('change', (e) => {
    S.settings.backup.auto = e.target.value;
    persist();
    toast(e.target.value === 'off' ? '已关闭自动备份' : '已开启自动备份');
  });
  $('#setBackupKeep').addEventListener('change', (e) => {
    S.settings.backup.keep = Number(e.target.value) || 7;
    persist();
  });
  $('#setProxy').addEventListener('change', (e) => {
    S.settings.ui.proxy = e.target.value.trim();
    persist();
    toast(S.settings.ui.proxy ? '代理已保存' : '已关闭代理');
  });
  $('#setPort').addEventListener('change', (e) => {
    S.settings.ui.remotePort = Number(e.target.value) || 8765;
    persist();
    toast('端口已保存，重启后生效');
  });

  // 开机自启
  try {
    const auto = await window.api.app.loginItem();
    sw('setLogin', !!auto);
  } catch (e) {
    sw('setLogin', false);
  }
  bindSwitch('setLogin', async (on) => {
    const r = await window.api.app.loginItem(on);
    S.settings.ui.launchAtLogin = !!r;
    sw('setLogin', !!r);
    persist();
    toast(r ? '已设置开机自启' : '已关闭开机自启');
  });

  // 网络
  if (ri && ri.url) {
    $('#remoteText').textContent = ri.url;
    $('#remoteText').title = ri.url;
    $('#remoteText').onclick = () => window.api.clipboard(ri.url);
  } else if (ri && ri.error) {
    $('#remoteText').textContent = '未启动：' + ri.error;
  }
  $('#btnCopyRemote').addEventListener('click', async () => {
    const txt = (ri && ri.url) || '';
    if (!txt) return toast('还没有地址', true);
    try { await navigator.clipboard.writeText(txt); } catch (e) { await window.api.clipboard(txt); }
    toast('已复制');
  });

  // 备份
  $('#btnBackupNow').addEventListener('click', async () => {
    const r = await window.api.backup.now();
    if (!r.ok) return toast('备份失败：' + r.error, true);
    toast('已备份');
    refreshBackup();
  });
  $('#btnBackupDir').addEventListener('click', async () => {
    const r = await window.api.backup.choose();
    if (r.canceled) return;
    S.settings.backup.dir = r.dir || '';
    persist();
    refreshBackup();
  });
  $('#btnBackupShow').addEventListener('click', () => window.api.backup.show());
  refreshBackup();

  $('#btnProvNew').addEventListener('click', openProvModal);
  bindProvModal();

  $('#btnSyncSetup').addEventListener('click', () => {
    const panel = $('#syncPanel');
    panel.hidden = !panel.hidden;
    if (!panel.hidden) renderSync();
  });
  renderSync();

  // 导出 / 导入
  $('#btnExport').addEventListener('click', async () => {
    const withKeys = $('#setWithKeys').value === '1';
    const r = await window.api.settings.export(withKeys);
    if (r.canceled) return;
    if (r.ok) toast('已导出到 ' + r.path);
    else toast('导出失败：' + r.error, true);
  });
  $('#btnImport').addEventListener('click', async () => {
    const r = await window.api.settings.import();
    if (r.canceled) return;
    if (!r.ok) return toast('导入失败：' + r.error, true);
    S.settings = r.settings;
    renderLLM();
    fillTemplateSelect();
    toast('已导入，重启后全部生效');
  });

  // 关于
  $('#aboutVer').textContent = 'v' + S.info.version;
  $('#aboutDir').textContent = S.info.userData || '-';
  $('#aboutDir').title = S.info.userData || '';
  $('#btnRepo').addEventListener('click', () => window.api.openExternal('https://github.com/VVen1F/refract'));
}

/* ---------------- 更新 ---------------- */

$('#btnCheckUpdate').addEventListener('click', async () => {
  $('#updateText').textContent = '检查中…';
  const r = await window.api.update.check();
  if (!r.ok) {
    $('#updateText').textContent = '检查失败：' + r.error;
    return;
  }
  S.updating = r;
  if (!r.hasUpdate) {
    $('#updateText').textContent = `已是最新（v${r.current}）`;
    return;
  }
  $('#updateText').textContent = `发现 v${r.latest}，可下载安装`;
  $('#btnDoUpdate').disabled = false;
});

$('#btnDoUpdate').addEventListener('click', async () => {
  if (!S.updating || !S.updating.asset) return;
  $('#btnDoUpdate').disabled = true;
  $('#updateText').textContent = '下载中 0%';
  const d = await window.api.update.download(S.updating.asset.url, (p) => {
    $('#updateText').textContent = `下载中 ${p.percent}%`;
  });
  if (!d.ok) {
    $('#updateText').textContent = '下载失败：' + d.error;
    $('#btnDoUpdate').disabled = false;
    return;
  }
  $('#updateText').textContent = '安装中…';
  const ins = await window.api.update.install(d.file);
  if (!ins.ok) {
    $('#updateText').textContent = '安装失败：' + ins.error;
    $('#btnDoUpdate').disabled = false;
    return;
  }
  $('#updateText').textContent = '安装完成，正在重启…';
  setTimeout(() => window.api.update.relaunch(), 600);
});


/* ---------------- 权限 ---------------- */

const PERM_TEXT = {
  granted: '已授权',
  denied: '被拒绝，需要到系统设置里手动打开',
  'not-determined': '还没授权',
  restricted: '被系统策略限制',
  unknown: '读不到状态'
};

async function refreshPerm() {
  const el = $('#permText');
  if (!el || !window.api.perm) return;
  applyPermStatus(await window.api.perm.screen());
}

function openPermModal(info) {
  const modal = $('#permModal');
  if (!modal) return;
  const black = info && info.black;
  $('#permTitle').textContent = black ? '截图是黑的' : '需要屏幕录制权限';
  $('#permBody').textContent = (info && info.message) || (black
    ? '画面是黑的。退出 Refract 再打开，授权才会生效。'
    : '整屏截图和弹窗取证要读取屏幕。到系统设置勾上 Refract，回到窗口后会自动再拍一次。');
  $('#permGo').hidden = !!black;
  $('#permModalStatus').textContent = black ? '' : '尚未授权';
  modal.hidden = false;
}

function closePermModal() {
  const modal = $('#permModal');
  if (modal) modal.hidden = true;
}

function applyPermStatus(r) {
  const el = $('#permText');
  if (!el || !r) return;
  el.classList.remove('ok', 'bad');
  if (r.platform && r.platform !== 'darwin') {
    el.textContent = '当前平台不需要单独授权';
    const ask = $('#btnPermAsk');
    if (ask) ask.disabled = true;
    return;
  }
  el.textContent = PERM_TEXT[r.status] || r.status || '';
  el.classList.add(r.status === 'granted' ? 'ok' : 'bad');
  const note = $('#permModalStatus');
  const modal = $('#permModal');
  if (note && modal && !modal.hidden && r.status) {
    note.textContent = r.status === 'granted' ? '已授权，正在重新截图' : (PERM_TEXT[r.status] || r.status);
  }
}

function bindPerm() {
  if (!window.api.perm) return;
  $('#btnPermAsk').addEventListener('click', async () => {
    const r = await window.api.perm.screen();
    if (r.status === 'granted') {
      await refreshPerm();
      return toast('已经有权限了');
    }
    openPermModal(r);
  });
  $('#btnPermCheck').addEventListener('click', async () => {
    await refreshPerm();
    toast('权限：' + $('#permText').textContent);
  });
  const go = $('#permGo');
  if (go) {
    go.addEventListener('click', async () => {
      await window.api.perm.open();
      await window.api.perm.request();
      $('#permModalStatus').textContent = '到系统设置勾上 Refract，回到这里会自动再拍';
    });
  }
  const later = $('#permLater');
  if (later) later.addEventListener('click', closePermModal);
  const x = $('#permClose');
  if (x) x.addEventListener('click', closePermModal);
  if (window.api.perm.onNeed) window.api.perm.onNeed((p) => openPermModal(p));
  if (window.api.perm.onStatus) window.api.perm.onStatus((p) => applyPermStatus(p));
  if (window.api.perm.onRetry) {
    window.api.perm.onRetry((r) => {
      if (r && r.ok && r.path) {
        showBrowserShot(r.path, '整屏截图');
        $('#bwLog').textContent = '已保存 ' + r.path;
        rememberShot(r.path);
        closePermModal();
        toast('已重新截图');
        return;
      }
      if (r && r.code === 'BLACK_FRAME') {
        $('#bwLog').textContent = r.error || '';
        openPermModal({ black: true, message: r.error });
        return;
      }
      if (r && r.ok) closePermModal();
      else if (r && r.error) {
        const note = $('#permModalStatus');
        if (note) note.textContent = r.error;
      }
    });
  }
}


/* ---------------- 归档管理 ---------------- */

function wsNameOf(id) {
  const w = (TASKS.workspaces || []).find((x) => x.id === id);
  return w ? w.name : '未归类';
}

function archivedForList() {
  const q = (($('#archSearch') && $('#archSearch').value) || '').trim().toLowerCase();
  let list = (TASKS.list || []).filter((t) => t.archived && hasContent(t));
  if (q) list = list.filter((t) => String(t.title || '').toLowerCase().includes(q));
  const byName = $('#archSort') && $('#archSort').value === 'name';
  list.sort(byName
    ? (a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'zh')
    : (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return list;
}

function renderArchive() {
  const box = $('#archList');
  if (!box) return;
  const list = archivedForList();
  if (!list.length) {
    box.innerHTML = '<div class="arch-empty">还没有归档的会话</div>';
    return;
  }
  const groups = new Map();
  list.forEach((t) => {
    const k = t.workspaceId || 'ws-default';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  });
  let html = '';
  groups.forEach((items, wsId) => {
    html += '<div class="arch-group" data-ws="' + esc(wsId) + '">' +
      '<div class="arch-head"><span>' + esc(wsNameOf(wsId)) + '</span>' +
      '<span class="arch-count">' + items.length + ' 个会话</span><span class="spacer"></span>' +
      '<button class="btn ghost" type="button" data-act="unarchive-all">全部取消归档</button>' +
      '<button class="btn ghost danger" type="button" data-act="delete-all">全部删除</button></div>';
    items.forEach((t) => {
      html += '<div class="arch-row" data-id="' + esc(t.id) + '">' +
        '<span class="arch-title">' + esc(t.title || '未命名') + '</span>' +
        '<span class="arch-date">' + esc(dayGroup(t.updatedAt || t.createdAt || Date.now())) + '</span>' +
        '<button class="btn" type="button" data-act="restore">恢复</button>' +
        '<button class="btn danger" type="button" data-act="delete">删除</button>' +
        '</div>';
    });
    html += '</div>';
  });
  box.innerHTML = html;
}

function openArchive() {
  showSettingsSection('archive');
  go('settings');
  renderArchive();
}

function bindArchive() {

  if ($('#archSearch')) $('#archSearch').addEventListener('input', renderArchive);
  if ($('#archSort')) $('#archSort').addEventListener('change', renderArchive);

  const list = $('#archList');
  if (!list) return;
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const group = btn.closest('.arch-group');
    const wsId = group ? group.dataset.ws : '';
    const row = btn.closest('.arch-row');
    const id = row ? row.dataset.id : '';

    if (act === 'restore' && id) {
      unarchiveTask(id);
    } else if (act === 'delete' && id) {
      TASKS.list = TASKS.list.filter((t) => t.id !== id);
      saveTasksNow();
    } else if (act === 'unarchive-all' && wsId) {
      TASKS.list.forEach((t) => { if (t.archived && (t.workspaceId || 'ws-default') === wsId) t.archived = false; });
      saveTasksNow();
    } else if (act === 'delete-all' && wsId) {
      TASKS.list = TASKS.list.filter((t) => !(t.archived && (t.workspaceId || 'ws-default') === wsId));
      saveTasksNow();
    }
    renderArchive();
    renderTaskList();
  });
}

/* ---------------- 设置菜单 ---------------- */

function resolvedDark(pref) {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

function applyTheme(pref) {
  const mode = pref === 'light' || pref === 'dark' ? pref : 'system';
  document.documentElement.toggleAttribute('data-ds-dark-theme', resolvedDark(mode));
  document.querySelectorAll('[data-theme-choice]').forEach((b) => {
    const on = b.dataset.themeChoice === mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function bindTheme() {
  const ui = (S.settings && S.settings.ui) || {};
  applyTheme(ui.theme || 'system');
  document.querySelectorAll('[data-theme-choice]').forEach((b) => {
    if (b._themeBound) return;
    b._themeBound = true;
    b.addEventListener('click', () => {
      const mode = b.dataset.themeChoice || 'system';
      S.settings.ui.theme = mode;
      applyTheme(mode);
      persist();
    });
  });
  if (!bindTheme._media) {
    bindTheme._media = true;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (!S.settings || !S.settings.ui || !S.settings.ui.theme || S.settings.ui.theme === 'system') applyTheme('system');
    };
    if (media.addEventListener) media.addEventListener('change', onChange);
  }
}

function showSettingsSection(key) {
  const keys = ['general', 'network', 'llm', 'backup', 'archive', 'about'];
  if (keys.indexOf(key) < 0) key = 'general';
  keys.forEach((k) => {
    const sec = document.getElementById('sect-' + k);
    if (sec) sec.hidden = k !== key;
  });
  document.querySelectorAll('#settingsPop button[data-sec]').forEach((b) => {
    b.classList.toggle('on', b.dataset.sec === key);
  });
  if (key === 'llm' && typeof renderLLM === 'function') renderLLM();
  if (key === 'archive' && typeof renderArchive === 'function') renderArchive();
  document.querySelectorAll('#settingsNav button[data-sec]').forEach((b) => {
    b.classList.toggle('on', b.dataset.sec === key);
  });
  const sc = $('#settingsScroll');
  if (sc) sc.scrollTop = 0;
}

function bindSettingsMenu() {
  const pop = $('#settingsPop');
  const btn = $('#navSettings');
  if (!btn) return;

  const close = () => {
    if (pop) pop.hidden = true;
    btn.classList.remove('open');
  };
  const open = () => {
    if (!pop) return;
    pop.hidden = false;
    btn.classList.add('open');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop && pop.hidden) open();
    else close();
  });
  if (pop) {
    pop.addEventListener('click', (e) => e.stopPropagation());
    pop.querySelectorAll('button[data-sec]').forEach((b) => {
      b.addEventListener('click', () => {
        showSettingsSection(b.dataset.sec);
        go('settings');
        close();
      });
    });
  }
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  showSettingsSection('general');
}

function renderGateway(ri) {
  const dot = $('#gwDot');
  const text = $('#gwText');
  if (!ri || !ri.url) {
    dot.classList.add('off');
    text.textContent = '服务未启动';
    return;
  }
  const port = (String(ri.url).match(/:(\d+)\/?$/) || [])[1] || '8765';
  const shown = 'http://127.0.0.1:' + port;
  dot.classList.remove('off');
  text.innerHTML = '网关 <b>127.0.0.1:' + esc(port) + '</b>';
  $('#gateway').onclick = async () => {
    try { await navigator.clipboard.writeText(shown); } catch (e) { await window.api.clipboard(shown); }
    toast('已复制 ' + shown);
  };
}


/* ---------------- 首页动效与模型选择 ---------------- */

function motionOff() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function setChatting(on) {
  const home = $('#home');
  const ta = $('#chatInput');
  if (ta) ta.placeholder = on ? '补充' : '粘贴请求，或说明要写的报告';
  if (!home || home.classList.contains('chatting') === on) return;
  const wrap = $('#composerWrap');
  const before = wrap.getBoundingClientRect();
  home.classList.toggle('chatting', on);
  const after = wrap.getBoundingClientRect();
  const dy = before.top - after.top;
  const dx = before.left - after.left;
  if (!motionOff() && (Math.abs(dy) > 1 || Math.abs(dx) > 1)) {
    wrap.style.transition = 'none';
    wrap.style.transform = `translate(${dx}px, ${dy}px)`;
    void wrap.offsetHeight;
    wrap.style.transition = 'transform .22s cubic-bezier(.2, .8, .2, 1)';
    wrap.style.transform = 'translate(0, 0)';
    setTimeout(() => {
      wrap.style.transition = '';
      wrap.style.transform = '';
    }, 240);
  }
}

function syncModelPill() {
  const p = activeProvider();
  const el = $('#modelPillText');
  if (el) el.textContent = p && p.model ? p.model : '选择模型';
  const all = document.querySelectorAll('.mp-item');
  if (all.length) renderModelPop();
}

function renderModelPop() {
  const pop = $('#modelPop');
  if (!pop || pop.hidden) return;
  const cfg = S.settings;
  const prov = cfg.providers.find((x) => x.id === cfg.activeProviderId) || cfg.providers[0];
  if (!prov) {
    pop.innerHTML = '<div class="mp-models"><div class="mp-empty">还没有配置模型</div></div>';
    return;
  }
  const models = Array.from(new Set([...(prov.models || []), prov.activeModel].filter(Boolean)));
  const provs = cfg.providers.filter((x) => x.enabled !== false);
  const q = (pop._q || '').trim().toLowerCase();
  const shown = q ? models.filter((m) => m.toLowerCase().indexOf(q) >= 0) : models;
  const check = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';

  pop.innerHTML = `
    ${provs.length > 1 ? `<div class="mp-list mp-provs">${provs.map((x) => `<div class="mp-item ${x.id === prov.id ? 'on' : ''}" data-p="${x.id}"><span>${esc(x.name)}</span>${x.id === prov.id ? check : ''}</div>`).join('')}</div>` : ''}
    <input class="mp-search" id="mpSearch" placeholder="搜索" value="${esc(pop._q || '')}" spellcheck="false" />
    <div class="mp-list">
      ${shown.length
        ? shown.map((m) => `<div class="mp-item ${m === prov.activeModel ? 'on' : ''}" data-m="${esc(m)}"><span>${esc(m)}</span>${m === prov.activeModel ? check : ''}</div>`).join('')
        : '<div class="mp-empty">没有匹配的模型</div>'}
    </div>
    <div class="mp-foot" id="mpManage">管理模型</div>`;

  pop.querySelectorAll('[data-m]').forEach((el) => {
    el.addEventListener('click', () => {
      prov.activeModel = el.dataset.m;
      persist();
      syncModelPill();
      closeModelPop();
    });
  });
  pop.querySelectorAll('[data-p]').forEach((el) => {
    el.addEventListener('click', () => {
      S.settings.activeProviderId = el.dataset.p;
      persist();
      syncModelPill();
    });
  });
  const search = $('#mpSearch');
  if (search) {
    search.addEventListener('input', () => {
      pop._q = search.value;
      const caret = search.selectionStart;
      renderModelPop();
      const again = $('#mpSearch');
      if (again) {
        again.focus();
        again.setSelectionRange(caret, caret);
      }
    });
    search.addEventListener('click', (e) => e.stopPropagation());
    search.addEventListener('keydown', (e) => e.stopPropagation());
  }
  const manage = $('#mpManage');
  if (manage) {
    manage.addEventListener('click', () => {
      closeModelPop();
      showSettingsSection('llm');
      go('settings');
    });
  }
}

function closeModelPop() {
  const pop = $('#modelPop');
  if (pop) {
    pop.hidden = true;
    pop._q = '';
  }
  const pill = $('#btnModelPick');
  if (pill) pill.classList.remove('on');
}

function placeModelPop() {
  const pop = $('#modelPop');
  const pill = $('#btnModelPick');
  if (!pop || !pill) return;
  const r = pill.getBoundingClientRect();
  const width = 260;
  const left = Math.max(12, Math.min(r.left, window.innerWidth - width - 12));
  const below = window.innerHeight - r.bottom - 12;
  const above = r.top - 12;
  pop.style.left = left + 'px';
  pop.style.width = width + 'px';
  pop.style.right = 'auto';
  if (below >= 160 || below >= above) {
    pop.style.top = (r.bottom + 6) + 'px';
    pop.style.bottom = 'auto';
    pop.style.maxHeight = Math.min(360, Math.max(160, below)) + 'px';
    pop.classList.add('down');
    pop.classList.remove('up');
  } else {
    pop.style.top = 'auto';
    pop.style.bottom = (window.innerHeight - r.top + 6) + 'px';
    pop.style.maxHeight = Math.min(360, Math.max(160, above)) + 'px';
    pop.classList.add('up');
    pop.classList.remove('down');
  }
}

function toggleModelPop() {
  const pop = $('#modelPop');
  const pill = $('#btnModelPick');
  if (!pop) return;
  if (pop.hidden) {
    pop.hidden = false;
    pill.classList.add('on');
    renderModelPop();
    placeModelPop();
  } else {
    closeModelPop();
  }
}

function bindComposer() {
  if (!$('#btnModelPick')) return;
  $('#btnModelPick').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleModelPop();
  });
  document.addEventListener('click', (e) => {
    if (e.target.closest('#modelPop') || e.target.closest('#btnModelPick')) return;
    closeModelPop();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModelPop();
  });

  const ta = $('#chatInput');
  const send = $('#btnChatSend');
  const refresh = () => {
    send.disabled = !ta.value.trim() || HOME.busy;
  };
  ta.addEventListener('input', refresh);
  refresh();
  syncModelPill();
}

/* ---------------- 浏览器 ---------------- */

function showBrowserShot(path, note) {
  const img = $('#bwImg');
  const base = window.api.imageUrl ? window.api.imageUrl(path) : 'file://' + path;
  img.src = base + (base.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
  img.hidden = false;
  $('#bwEmpty').style.display = 'none';
  if (note) $('#bwInfo').textContent = note;
}

async function bwPageShot() {
  $('#bwLog').textContent = '截图中…';
  const r = await window.api.browser.shot();
  if (r.ok) {
    showBrowserShot(r.path, '页面截图');
    $('#bwLog').textContent = '已保存 ' + r.path;
  } else {
    $('#bwLog').textContent = '截图失败：' + r.error;
  }
}

function rememberShot(p) {
  if (!p) return;
  const page = document.getElementById('page-report');
  const t = page && page.classList.contains('on') ? currentTask() : null;
  if (t) {
    t.images = Array.isArray(t.images) ? t.images : [];
    if (t.images.indexOf(p) < 0) t.images.push(p);
    S.images = t.images;
    saveTasksSoon();
    return;
  }
  if (S.pendingShots.indexOf(p) < 0) S.pendingShots.push(p);
}

async function bwScreenShot() {
  $('#bwLog').textContent = '整屏截图中…';
  const r = await window.api.browser.screen();
  if (r.ok) {
    showBrowserShot(r.path, '整屏截图');
    $('#bwLog').textContent = '已保存 ' + r.path;
    rememberShot(r.path);
    return;
  }
  if (r.code === 'NO_PERM' || r.waiting) {
    $('#bwLog').textContent = '等待屏幕录制权限';
    return;
  }
  if (r.code === 'BLACK_FRAME') {
    $('#bwLog').textContent = r.error;
    openPermModal({ black: true, message: r.error });
    return;
  }
  $('#bwLog').textContent = '截图失败：' + (r.error || '');
}

function bindBrowser() {
  if (!window.api.browser || !$('#bwGo')) return;
  $('#bwGo').addEventListener('click', async () => {
    const url = $('#bwUrl').value.trim();
    if (!url) return;
    $('#bwLog').textContent = '打开中…';
    const r = await window.api.browser.go(url);
    if (!r.ok) {
      $('#bwLog').textContent = '打开失败：' + r.error;
      return;
    }
    $('#bwLog').textContent = '已打开 · ' + (r.ready || '');
    await bwPageShot();
  });
  $('#bwUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#bwGo').click();
  });
  $('#bwShot').addEventListener('click', bwPageShot);
  $('#bwScreen').addEventListener('click', bwScreenShot);
  $('#bwClose').addEventListener('click', async () => {
    await window.api.browser.close();
    $('#bwLog').textContent = '已关闭';
  });

  if (window.api.browser && window.api.browser.onDialog) {
    window.api.browser.onDialog((d) => {
      if (d.phase === 'open') {
        $('#bwLog').textContent = `捕获弹窗（${d.type || 'alert'}）：${d.message} · 连拍中…`;
        return;
      }
      const how = d.method === 'ai' ? 'AI 挑图' : d.frames > 1 ? `按画面挑（${d.frames} 张）` : '';
      $('#bwLog').textContent = `捕获弹窗（${d.type || 'alert'}）：${d.message}` + (how ? ' · ' + how : '');
      if (d.shot) showBrowserShot(d.shot, '弹窗截图');
      if (d.shot) rememberShot(d.shot);
      if (d.error) {
        $('#bwLog').textContent += ' · ' + d.error;
        if (d.code === 'BLACK_FRAME' || /黑/.test(d.error)) openPermModal({ black: true, message: d.error });
      } else if (d.shot) {
        closePermModal();
      }
    });
  }
}

/* ---------------- 统计 ---------------- */

function renderStats() {
  const st = S.settings.stats || { shots: 0, reports: 0 };
  const el = $('#homeStats');
  if (el) el.textContent = `截图 ${st.shots || 0} · 报告 ${st.reports || 0} · 模板 ${S.templates.length}`;
}


/* ---------------- 启动 ---------------- */

async function boot() {
  S.info = await window.api.info();
  const ver = $('#ver');
  if (ver) ver.textContent = 'v' + S.info.version;
  S.settings = await window.api.settings.get();
  bindTheme();
  bindArchive();
  S.templates = await window.api.templates.list();

  $('#req').value = SAMPLE;
  $('#res').innerHTML = '<div class="empty">发送后显示响应</div>';
  $('#scheme').value = 'https';

  renderProviders();
  renderTplList();
  fillTemplateSelect();
  if (S.templates.length) selectTpl(S.templates[0].id);
  bindTasks();
  await loadTasks();
  $('#btnReveal').disabled = true;
  $('#updateText').textContent = `当前版本 v${S.info.version}`;
  $('#protocol').value = (S.settings.ui && S.settings.ui.protocol) || 'auto';
  const ri = await window.api.remoteInfo();
  bindSettingsMenu();
  bindPerm();
  refreshPerm();
  renderGateway(ri);
  await bindSettingsPage(ri);
  $('#protocol').addEventListener('change', (e) => {
    S.settings.ui.protocol = e.target.value;
    persist();
  });
  bindBrowser();
  renderStats();
}

boot();
