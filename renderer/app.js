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
  updating: null,
  info: null
};

/* ---------------- 基础 ---------------- */

function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast on' + (isErr ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.className = 'toast'), 2600);
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
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

/* ---------------- 导航 ---------------- */

function go(page) {
  $$('.nav').forEach((b) => b.classList.toggle('on', b.dataset.page === page));
  $$('.page').forEach((p) => p.classList.toggle('on', p.id === 'page-' + page));
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
      width: Number(S.settings.ui.shotWidth) || 1600
    });
    S.images.push(r.path);
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
  $('#rDetail').value =
    '请求：\n```http\n' + (S.lastReq || $('#req').value) + '\n```\n\n响应：\n```http\n' + S.lastRes + '\n```';
  go('report');
  toast('已作为材料放入报告页');
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
    models: p.models || []
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
  sel.innerHTML = S.templates.map((t) => `<option value="${t.id}">${esc(t.name)}（${esc(t.platform)}）</option>`).join('');
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
  const m = /^#\s+(.+)$/m.exec(md || '');
  return (m ? m[1] : '报告').replace(/[\\/:*?"<>|]/g, '').trim().slice(0, 40) || '报告';
}

async function generateReport() {
  const prov = activeProvider();
  if (!prov || !prov.apiKey) return toast('先在设置里配置模型和 API Key', true);

  const tpl = S.templates.find((t) => t.id === $('#rTemplate').value) || S.templates[0];
  const extra = $('#rExtra').value.trim();
  const cred = $('#rCred').value.trim();
  const detail = $('#rDetail').value.trim();
  if (!detail) return toast('先把漏洞详情填上', true);

  const material = (cred ? '账号密码：\n' + cred + '\n\n' : '') + detail;

  const messages = await window.api.compose({
    material,
    template: tpl ? tpl.body : '',
    meta: deriveMeta(material),
    extra
  });

  S.reportMd = '';
  $('#mdPreview').innerHTML = '<div class="empty">生成中…</div>';
  $('#genStatus').textContent = '生成中…';
  $('#btnGen').disabled = true;

  let buf = '';
  let raf = 0;
  const paint = () => {
    raf = 0;
    $('#mdPreview').innerHTML = mdToHtml(buf);
  };

  window.api.chat({
    provider: prov,
    messages,
    onDelta: (d) => {
      buf += d;
      if (!raf) raf = setTimeout(paint, 90);
    },
    onDone: (text) => {
      S.reportMd = text || buf;
      $('#mdPreview').innerHTML = mdToHtml(S.reportMd);
      $('#genStatus').textContent = '已生成 · ' + S.reportMd.length + ' 字';
      $('#btnGen').disabled = false;
    },
    onError: (msg) => {
      $('#genStatus').textContent = '失败';
      $('#mdPreview').innerHTML = `<div class="empty">${esc(msg)}</div>`;
      $('#btnGen').disabled = false;
      toast(msg, true);
    }
  });
}

function imagesSection() {
  if (!S.images.length) return '';
  return '\n\n## 截图\n\n' + S.images.map((_, i) => `![${i + 1}](images/${String(i + 1).padStart(2, '0')}.png)`).join('\n\n') + '\n';
}

async function saveReport() {
  if (!S.reportMd) return toast('先生成报告', true);
  const title = mdTitle(S.reportMd);
  const md = S.reportMd.replace(/\s+$/, '') + imagesSection();
  const r = await window.api.saveReport({ markdown: md, images: S.images, title });
  S.reportDir = (r && (r.zip || r.dir)) || '';
  S.settings.stats.reports = (S.settings.stats.reports || 0) + 1;
  persist();
  renderStats();
  toast('已导出 ' + (r.zip || r.dir));
  $('#btnReveal').disabled = false;
  return r;
}

$('#btnGen').addEventListener('click', generateReport);
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

/* ---------------- 模板 ---------------- */

function renderTplList() {
  const box = $('#tplList');
  box.innerHTML = S.templates
    .map((t) => `<div class="item ${t.id === S.tplId ? 'on' : ''}" data-id="${t.id}">
        <span class="grow">${esc(t.name)}</span><small>${esc(t.platform)}</small></div>`)
    .join('');
  box.querySelectorAll('.item').forEach((el) => {
    el.addEventListener('click', () => selectTpl(el.dataset.id));
  });
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
  $('#tplPlatform').value = '自定义';
  $('#tplBody').value = '# {{title}}\n\n## 漏洞描述\n\n{{description}}\n';
  renderTplList();
});
$('#btnTplDel').addEventListener('click', async () => {
  if (!S.tplId) return;
  await window.api.templates.remove(S.tplId);
  S.templates = await window.api.templates.list();
  S.tplId = S.templates[0] && S.templates[0].id;
  if (S.tplId) selectTpl(S.tplId);
  renderTplList();
  fillTemplateSelect();
  toast('已删除');
});
$('#btnTplReset').addEventListener('click', async () => {
  S.templates = await window.api.templates.reset();
  S.tplId = S.templates[0].id;
  selectTpl(S.tplId);
  fillTemplateSelect();
  toast('已恢复内置模板');
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
    return '<div class="lc-empty">还没有模型配置，点右上角「+ 新建」加一个</div>';
  }
  const activeId = S.settings.activeProviderId;
  return `<div class="llm-grid">${list
    .map((p) => {
      const on = p.id === activeId;
      const key = providerKey(p);
      return `<div class="llm-card ${on ? 'on' : ''}" data-id="${p.id}">
        <div class="lc-top">
          <button class="star ${on ? 'on' : ''}" data-act="star" title="${on ? '当前激活' : '设为激活'}">${on ? '★' : '☆'}</button>
          <b>${esc(p.name)}</b>
          <span class="badge">${p.kind === 'anthropic' ? 'ANTHROPIC' : 'OPENAI'}</span>
          <span class="spacer"></span>
          <span class="lc-state ${p.enabled === false ? 'off' : ''}">${p.enabled === false ? '已关闭' : '正常'}</span>
        </div>
        <div class="lc-model">${esc(p.activeModel || '—')}</div>
        <div class="lc-meta">${key ? '…' + esc(key.slice(-4)) : '未填 Key'} · ${(p.models || []).length} 个模型</div>
        <div class="lc-actions">
          <button class="btn ${on ? '' : 'primary'}" data-act="activate">${on ? '已激活' : '设为激活'}</button>
          <button class="btn ghost" data-act="del">删除</button>
        </div>
      </div>`;
    })
    .join('')}</div>`;
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
    <div class="krow"><div class="klabel">Base URL</div><input class="inp" style="flex:1;max-width:none" id="pdBase" value="${esc(p.baseURL)}" /></div>
    <div class="krow"><div class="klabel">模型列表地址<small>留空按协议猜</small></div><input class="inp" style="flex:1;max-width:none" id="pdModelsURL" value="${esc(p.modelsURL || '')}" /></div>
    <div class="krow"><div class="klabel">代理<small>http/socks5，留空直连</small></div><input class="inp" style="flex:1;max-width:none" id="pdProxy" value="${esc(p.proxy || '')}" placeholder="http://127.0.0.1:8080" /></div>
    <div class="krow"><div class="klabel">自定义会话头<small>留空则不发送</small></div><input class="inp" style="flex:1;max-width:none" id="pdSession" value="${esc(p.sessionHeader || '')}" placeholder="如 x-session-id" /></div>
    <div class="krow">
      <div class="klabel">限速与上下文<small>0 = 不限</small></div>
      <input class="inp kin" id="pdSec" type="number" min="0" placeholder="每秒" value="${Number(p.limitSec) || 0}" />
      <input class="inp kin" id="pdMin" type="number" min="0" placeholder="每分钟" value="${Number(p.limitMin) || 0}" />
      <input class="inp kin" id="pdCtx" type="number" min="0" placeholder="上下文 K" value="${Number(p.contextK) || 0}" />
    </div>
  </div>

  <div class="pd-sec">
    <h4>账号</h4>
    <div id="pdAccounts">
      ${accs.map((a) => `
        <div class="acc-item" data-aid="${a.id}">
          <input class="inp aname" data-a="name" value="${esc(a.name)}" placeholder="名称" />
          <input class="inp" data-a="apiKey" type="password" value="${esc(a.apiKey)}" placeholder="API Key" />
          <button class="btn ghost" data-act="use">${a.id === p.activeAccountId ? '首选' : '设为首选'}</button>
          <button class="btn ghost" data-act="del">删除</button>
        </div>`).join('')}
    </div>
    <button class="btn ghost" id="pdAddAcc">+ 添加账号</button>
  </div>

  <div class="pd-sec">
    <h4>模型</h4>
    <div class="chips" id="pdChips">
      ${all.map((m) => `<span class="mchip ${mine.includes(m) ? 'on' : ''} ${m === p.activeModel ? 'cur' : ''}" data-m="${esc(m)}">${esc(m)}</span>`).join('')}
    </div>
    <div class="row actions" style="margin-top:10px">
      <input class="inp" id="pdModelInput" placeholder="添加模型 ID" style="max-width:190px" />
      <button class="btn" id="pdAddModel">添加模型</button>
      <button class="btn" id="pdFetch">重新获取模型</button>
      <button class="btn" id="pdTest">测试模型</button>
      <span class="spacer"></span>
      <span class="muted" id="pdModelCount">${mine.length} 个已选</span>
    </div>
    <div class="row actions" style="margin-top:10px">
      <select class="inp kin" id="pdActiveModel" style="max-width:220px">
        ${mine.map((m) => `<option${m === p.activeModel ? ' selected' : ''}>${esc(m)}</option>`).join('')}
      </select>
      <span class="muted">当前使用</span>
    </div>
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
  document.querySelectorAll('.llm-card').forEach((card) => {
    const id = card.dataset.id;
    const p = S.settings.providers.find((x) => x.id === id);
    if (!p) return;

    card.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      LLM.detail = id;
      renderLLM();
    });

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

function openProvModal() {
  const m = $('#provModal');
  m.hidden = false;
  $('#pmStatus').textContent = '';
  $('#pmName').value = '';
  $('#pmModel').value = '';
  $('#pmBase').value = 'https://api.openai.com/v1';
  $('#pmKey').value = '';
  $('#pmProxy').value = '';
  $('#pmSession').value = '';
  $('#pmSec').value = '0';
  $('#pmMin').value = '0';
  $('#pmCtx').value = '0';
  $('#pmKind').value = 'openai';
  $('#pmName').focus();
}

function closeProvModal() {
  $('#provModal').hidden = true;
}

function draftProvider() {
  return {
    id: 'p' + Date.now().toString(36),
    name: $('#pmName').value.trim() || '未命名服务',
    kind: $('#pmKind').value,
    baseURL: $('#pmBase').value.trim(),
    modelsURL: '',
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
    toast('已新建，点卡片上的「设为激活」启用');
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
      <div class="krow"><div class="klabel">地址</div><input class="inp" style="flex:1;max-width:none" id="wdUrl" value="${esc(w.url)}" placeholder="https://dav.example.com/dav/files/me" /></div>
      <div class="krow"><div class="klabel">用户名</div><input class="inp kin" id="wdUser" value="${esc(w.user)}" /></div>
      <div class="krow"><div class="klabel">密码</div><input class="inp kin" type="password" id="wdPass" value="${esc(w.pass)}" /></div>
      <div class="krow"><div class="klabel">远端文件名</div><input class="inp kin" id="wdPath" value="${esc(w.path)}" /></div>` : ''}
      ${sy.kind === 'github' ? `
      <div class="krow"><div class="klabel">仓库<small>owner/repo</small></div><input class="inp kin" id="ghRepo" value="${esc(g.repo)}" placeholder="me/dotfiles" /></div>
      <div class="krow"><div class="klabel">分支</div><input class="inp kin" id="ghBranch" value="${esc(g.branch)}" /></div>
      <div class="krow"><div class="klabel">路径</div><input class="inp" style="flex:1;max-width:none" id="ghPath" value="${esc(g.path)}" /></div>
      <div class="krow"><div class="klabel">Token<small>只存本机</small></div><input class="inp" style="flex:1;max-width:none" type="password" id="ghToken" value="${esc(g.token)}" /></div>` : ''}
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

  $('#setWidth').value = ui.shotWidth || 1600;
  $('#setAutoShot').value = ui.autoShot ? '1' : '0';
  $('#setProtocol').value = ui.protocol || 'auto';
  $('#setConfirmQuit').value = ui.confirmQuit ? '1' : '0';
  $('#setWithKeys').value = bk.withKeys ? '1' : '0';
  $('#setBackupAuto').value = bk.auto || 'off';
  $('#setBackupKeep').value = String(bk.keep || 7);
  $('#setPort').value = ui.remotePort || 8765;

  $('#setWidth').addEventListener('input', (e) => {
    S.settings.ui.shotWidth = Number(e.target.value) || 1600;
    persist();
  });
  $('#setAutoShot').addEventListener('change', (e) => {
    S.settings.ui.autoShot = e.target.value === '1';
    persist();
  });
  $('#setProtocol').addEventListener('change', (e) => {
    S.settings.ui.protocol = e.target.value;
    $('#protocol').value = e.target.value;
    persist();
  });
  $('#setConfirmQuit').addEventListener('change', (e) => {
    S.settings.ui.confirmQuit = e.target.value === '1';
    persist();
  });
  $('#setWithKeys').addEventListener('change', (e) => {
    S.settings.backup.withKeys = e.target.value === '1';
    persist();
  });
  $('#setBackupAuto').addEventListener('change', (e) => {
    S.settings.backup.auto = e.target.value;
    persist();
    toast(e.target.value === 'off' ? '已关闭自动备份' : '已开启自动备份');
  });
  $('#setBackupKeep').addEventListener('change', (e) => {
    S.settings.backup.keep = Number(e.target.value) || 7;
    persist();
  });
  $('#setPort').addEventListener('change', (e) => {
    S.settings.ui.remotePort = Number(e.target.value) || 8765;
    persist();
    toast('端口已保存，重启后生效');
  });

  // 开机自启
  try {
    const auto = await window.api.app.loginItem();
    $('#setLogin').value = auto ? '1' : '0';
  } catch (e) {
    $('#setLogin').value = '0';
  }
  $('#setLogin').addEventListener('change', async (e) => {
    const on = e.target.value === '1';
    const r = await window.api.app.loginItem(on);
    S.settings.ui.launchAtLogin = !!r;
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

/* ---------------- 设置菜单 ---------------- */

function bindSettingsMenu() {
  const pop = $('#settingsPop');
  const btn = $('#navSettings');
  if (!pop || !btn) return;

  const close = () => { pop.hidden = true; btn.classList.remove('open'); };
  const toggle = () => {
    pop.hidden = !pop.hidden;
    btn.classList.toggle('open', !pop.hidden);
  };

  btn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  pop.addEventListener('click', (e) => e.stopPropagation());

  pop.querySelectorAll('button[data-sec]').forEach((b) => {
    b.addEventListener('click', () => {
      const key = b.dataset.sec;
      go('settings');
      close();
      const sec = document.getElementById('sect-' + key);
      if (!sec) return;
      sec.scrollIntoView({ block: 'start', behavior: motionOff() ? 'auto' : 'smooth' });
      sec.classList.add('flash');
      setTimeout(() => sec.classList.remove('flash'), 900);
    });
  });

  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
}

function renderGateway(ri) {
  const dot = $('#gwDot');
  const text = $('#gwText');
  if (!ri || !ri.url) {
    dot.classList.add('off');
    text.textContent = '服务未启动';
    return;
  }
  const addr = ri.url.replace(/^https?:\/\//, '');
  dot.classList.remove('off');
  text.innerHTML = '网关 <b>' + esc(addr) + '</b>';
  $('#gateway').onclick = async () => {
    try { await navigator.clipboard.writeText(ri.url); } catch (e) { await window.api.clipboard(ri.url); }
    toast('已复制 ' + ri.url);
  };
}


/* ---------------- 首页动效与模型选择 ---------------- */

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 12) return '早上好';
  if (h < 18) return '下午好';
  return '晚上好';
}

function motionOff() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function setChatting(on) {
  const home = $('#home');
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
  const fetched = (LLM.models && LLM.models[prov.id]) || [];
  const models = Array.from(new Set([...(prov.models || []), ...fetched]));

  pop.innerHTML = `
    <div class="mp-models">
      <div class="mp-h">模型</div>
      ${models.length
        ? models.map((m) => `<div class="mp-item ${m === prov.activeModel ? 'on' : ''}" data-m="${esc(m)}">
            <span>${esc(m)}</span>
            ${m === prov.activeModel ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>' : ''}
          </div>`).join('')
        : '<div class="mp-empty">这个供应商还没有模型，去设置里加</div>'}
    </div>
    <div class="mp-prov">
      <div class="mp-h">供应商</div>
      ${cfg.providers
        .filter((x) => x.enabled !== false)
        .map((x) => `<div class="mp-item ${x.id === prov.id ? 'on' : ''}" data-p="${x.id}">
            <span>${esc(x.name)}</span>
            ${x.id === prov.id ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>' : ''}
          </div>`).join('')}
      <div class="mp-foot" id="mpManage">管理模型</div>
    </div>`;

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
  const manage = $('#mpManage');
  if (manage) {
    manage.addEventListener('click', () => {
      closeModelPop();
      go('settings');
      setTimeout(() => {
        const sec = document.getElementById('sect-llm');
        if (sec) sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }, 60);
    });
  }
}

function closeModelPop() {
  const pop = $('#modelPop');
  if (pop) pop.hidden = true;
  const pill = $('#btnModelPick');
  if (pill) pill.classList.remove('on');
}

function toggleModelPop() {
  const pop = $('#modelPop');
  const pill = $('#btnModelPick');
  if (!pop) return;
  if (pop.hidden) {
    pop.hidden = false;
    pill.classList.add('on');
    renderModelPop();
  } else {
    closeModelPop();
  }
}

function bindComposer() {
  const hero = $('#heroTitle');
  if (hero) hero.textContent = greeting();

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
  if (p && S.images.indexOf(p) < 0) S.images.push(p);
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
  if (!window.api.browser) return;
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

/* ---------------- 首页 ---------------- */

const HOME = { files: [], msgs: [], busy: false };
let emptyNode = null;

function renderStats() {
  const st = S.settings.stats || { shots: 0, reports: 0 };
  const el = $('#homeStats');
  if (el) el.textContent = `截图 ${st.shots || 0} · 报告 ${st.reports || 0} · 模板 ${S.templates.length}`;
}

function renderChips() {
  const box = $('#chips');
  if (!box) return;
  box.innerHTML = HOME.files
    .map((f, i) => `<span class="chip"><b>${esc(f.name)}</b><i data-i="${i}">×</i></span>`)
    .join('');
  box.querySelectorAll('i').forEach((el) => {
    el.addEventListener('click', () => {
      HOME.files.splice(Number(el.dataset.i), 1);
      renderChips();
    });
  });
}

async function addFiles(list) {
  for (const f of Array.from(list || [])) {
    if (f.size > 400 * 1024) {
      toast(f.name + ' 太大，跳过', true);
      continue;
    }
    try {
      HOME.files.push({ name: f.name, text: await f.text() });
    } catch (e) {
      toast('读取 ' + f.name + ' 失败', true);
    }
  }
  if (HOME.files.length > 3) HOME.files = HOME.files.slice(-3);
  renderChips();
}

function renderHome() {
  const log = $('#chatLog');
  if (!HOME.msgs.length) {
    if (!log.contains(emptyNode) && emptyNode) log.innerHTML = '', log.appendChild(emptyNode);
    return;
  }
  log.innerHTML = HOME.msgs
    .map((m, i) => {
      if (m.role === 'user') {
        return `<div class="msg user"><div class="who">你</div><div class="bubble">${esc(m.text)}</div></div>`;
      }
      return `<div class="msg ai"><div class="who">Refract</div><div class="bubble md">${mdToHtml(m.text || '')}</div>
        <div class="acts">
          <button class="btn ghost" data-act="copy" data-i="${i}">复制</button>
          <button class="btn ghost" data-act="save" data-i="${i}">保存为报告</button>
        </div></div>`;
    })
    .join('');
  log.scrollTop = log.scrollHeight;
}

async function sendChat(text) {
  const q = (text != null ? text : $('#chatInput').value).trim();
  if (!q || HOME.busy) return;
  const prov = activeProvider();
  if (!prov || !prov.apiKey) return toast('先在设置里配置模型和 API Key', true);

  setChatting(true);
  HOME.msgs.push({ role: 'user', text: q });
  const ai = { role: 'ai', text: '' };
  HOME.msgs.push(ai);
  if (text == null) $('#chatInput').value = '';
  autoGrow();
  $('#btnChatSend').disabled = true;
  HOME.busy = true;
  renderHome();

  const material = HOME.files.map((f) => `【${f.name}】\n${f.text}`).join('\n\n');
  const tpl = S.templates.find((t) => t.id === $('#rTemplate').value) || S.templates[0];
  const messages = await window.api.chatMessages({
    material,
    template: tpl ? tpl.body : '',
    meta: deriveMeta(material),
    question: q
  });

  let raf = 0;
  window.api.chat({
    provider: prov,
    messages,
    onDelta: (d) => {
      ai.text += d;
      if (!raf) raf = setTimeout(() => { raf = 0; renderHome(); }, 90);
    },
    onDone: (t) => { ai.text = t || ai.text; HOME.busy = false; renderHome(); },
    onError: (msg) => { ai.text = '出错了：' + msg; HOME.busy = false; renderHome(); }
  });
}

function autoGrow() {
  const ta = $('#chatInput');
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

function bindHome() {
  emptyNode = $('#chatEmpty');
  const page = $('#page-home');
  const comp = $('.composer');

  ['dragenter', 'dragover'].forEach((t) =>
    comp.addEventListener(t, (e) => { e.preventDefault(); comp.classList.add('over'); })
  );
  ['dragleave', 'drop'].forEach((t) =>
    comp.addEventListener(t, (e) => { e.preventDefault(); comp.classList.remove('over'); })
  );
  comp.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));

  // 页面别的地方拖进来也不要触发浏览器打开文件
  ['dragover', 'drop'].forEach((t) => page.addEventListener(t, (e) => e.preventDefault()));
  $('#btnAttach').addEventListener('click', () => $('#filePick').click());
  $('#filePick').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  $('#btnChatSend').addEventListener('click', () => sendChat());
  $('#chatInput').addEventListener('input', autoGrow);
  $('#chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });

  document.querySelectorAll('.quick .q-chip').forEach((b) => {
    b.addEventListener('click', () => {
      const q = b.dataset.q;
      if (q === 'test') return go('repeater');
      if (q === 'report') return sendChat('根据附件写一份完整的漏洞报告。');
      if (q === 'risk') return sendChat('看看这个请求或这段流量有没有风险，按严重程度列出来。');
    });
  });

  $('#chatLog').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const m = HOME.msgs[Number(btn.dataset.i)];
    if (!m) return;
    if (btn.dataset.act === 'copy') {
      try { await navigator.clipboard.writeText(m.text); } catch (err) { await window.api.clipboard(m.text); }
      toast('已复制');
    }
    if (btn.dataset.act === 'save') {
      const r = await window.api.saveReport({
        markdown: m.text,
        images: S.images,
        title: mdTitle(m.text)
      });
      S.reportDir = (r && (r.zip || r.dir)) || '';
      S.settings.stats.reports = (S.settings.stats.reports || 0) + 1;
      persist();
      renderStats();
      toast('已导出 ' + (r.zip || r.dir));
    }
  });
}

/* ---------------- 启动 ---------------- */

async function boot() {
  S.info = await window.api.info();
  $('#ver').textContent = 'v' + S.info.version;
  S.settings = await window.api.settings.get();
  S.templates = await window.api.templates.list();

  $('#req').value = SAMPLE;
  $('#res').innerHTML = '<div class="empty">发送后显示响应</div>';
  $('#scheme').value = 'https';

  renderProviders();
  renderTplList();
  fillTemplateSelect();
  if (S.templates.length) selectTpl(S.templates[0].id);
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
  bindHome();
  bindComposer();
  bindBrowser();
  renderStats();
}

boot();
