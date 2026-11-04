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

$$('.nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.page)));

/* ---------------- 复测 ---------------- */

const SAMPLE = 'GET / HTTP/1.1\nHost: example.com\nUser-Agent: Mozilla/5.0\nAccept: */*\n\n';

async function doSend() {
  const raw = $('#req').value;
  if (!raw.trim()) return toast('请求为空', true);
  const scheme = $('#scheme').value;
  $('#statusText').textContent = '发送中…';
  const r = await window.api.send({ raw, scheme });
  S.lastReq = raw;
  S.lastRes = r.text || '';
  $('#res').innerHTML = highlight(S.lastRes);
  $('#statusText').innerHTML = r.ok
    ? `<span class="ok">${r.status}</span> · ${r.ms} ms`
    : `<span class="bad">失败</span> · ${esc(r.error || '')}`;
  $('#resMeta').textContent = r.ok ? `${r.ms} ms` : '';
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
  $('#rMaterial').value =
    '请求：\n```http\n' + (S.lastReq || $('#req').value) + '\n```\n\n响应：\n```http\n' + S.lastRes + '\n```';
  go('report');
  toast('已作为材料放入报告页');
});

/* ---------------- 报告 ---------------- */

function activeProvider() {
  const s = S.settings;
  return (s.providers || []).find((p) => p.id === s.activeProviderId) || (s.providers || [])[0];
}

function fillTemplateSelect() {
  const sel = $('#rTemplate');
  sel.innerHTML = S.templates.map((t) => `<option value="${t.id}">${esc(t.name)}（${esc(t.platform)}）</option>`).join('');
}

async function generateReport() {
  const prov = activeProvider();
  if (!prov || !prov.apiKey) return toast('先在设置里配置模型和 API Key', true);

  const tpl = S.templates.find((t) => t.id === $('#rTemplate').value) || S.templates[0];
  const extra = $('#rExtra').value.trim();
  const material = $('#rMaterial').value + (extra ? '\n\n补充要求：' + extra : '');

  const messages = await window.api.compose({
    material,
    template: tpl ? tpl.body : '',
    meta: {
      product: $('#rProduct').value,
      url: $('#rUrl').value,
      type: $('#rType').value,
      level: $('#rLevel').value
    }
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
  const title = ($('#rProduct').value || 'report').slice(0, 40);
  const md = S.reportMd.replace(/\s+$/, '') + imagesSection();
  const r = await window.api.saveReport({ markdown: md, images: S.images, title });
  S.reportDir = r.dir;
  toast('已保存到 ' + r.dir);
  $('#btnReveal').disabled = false;
  return r;
}

$('#btnGen').addEventListener('click', generateReport);
$('#btnSave').addEventListener('click', saveReport);
$('#btnCopy').addEventListener('click', async () => {
  if (!S.reportMd) return toast('还没有报告', true);
  await navigator.clipboard.writeText(S.reportMd);
  toast('已复制');
});
$('#btnReveal').addEventListener('click', () => {
  if (!S.reportDir) return toast('先保存一次', true);
  window.api.showItem(S.reportDir + '/report.md');
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
}

async function saveTpl() {
  const t = {
    id: S.tplId,
    name: $('#tplName').value.trim() || '未命名',
    platform: $('#tplPlatform').value.trim() || '自定义',
    body: $('#tplBody').value
  };
  await window.api.templates.upsert(t);
  S.templates = await window.api.templates.list();
  if (!S.tplId) S.tplId = S.templates[S.templates.length - 1].id;
  renderTplList();
  fillTemplateSelect();
  toast('模板已保存');
}

$('#btnTplSave').addEventListener('click', saveTpl);
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

function renderProviders() {
  const box = $('#provList');
  box.innerHTML = S.settings.providers
    .map(
      (p, i) => `<div class="prov" data-i="${i}">
      <div class="row">
        <label class="f">名称<input class="inp" data-k="name" value="${esc(p.name)}" /></label>
        <label class="f">协议
          <select class="inp" data-k="kind">
            <option value="openai"${p.kind === 'openai' ? ' selected' : ''}>OpenAI 兼容</option>
            <option value="anthropic"${p.kind === 'anthropic' ? ' selected' : ''}>Anthropic 兼容</option>
          </select>
        </label>
      </div>
      <div class="row">
        <label class="f">Base URL<input class="inp" data-k="baseURL" value="${esc(p.baseURL)}" /></label>
        <label class="f">模型<input class="inp" data-k="model" value="${esc(p.model)}" /></label>
      </div>
      <label class="f">API Key（只存本机）
        <input class="inp" data-k="apiKey" type="password" value="${esc(p.apiKey)}" />
      </label>
      <div class="row" style="max-width:220px">
        <button class="btn ghost" data-act="use">设为默认</button>
        <button class="btn ghost" data-act="del">删除</button>
      </div>
    </div>`
    )
    .join('');

  box.querySelectorAll('.prov').forEach((el) => {
    const i = Number(el.dataset.i);
    el.querySelectorAll('[data-k]').forEach((inp) => {
      inp.addEventListener('input', () => {
        S.settings.providers[i][inp.dataset.k] = inp.value;
        persist();
      });
    });
    el.querySelector('[data-act="use"]').addEventListener('click', () => {
      S.settings.activeProviderId = S.settings.providers[i].id;
      persist();
      renderProviders();
      toast('已设为默认');
    });
    el.querySelector('[data-act="del"]').addEventListener('click', () => {
      S.settings.providers.splice(i, 1);
      persist();
      renderProviders();
    });
  });
}

async function testProvider() {
  const p = activeProvider();
  if (!p) return toast('没有可用服务', true);
  toast('测试中…');
  const r = await window.api.models(p);
  if (r.ok) toast(`连接成功，${r.models.length} 个模型`);
  else toast('连接失败：' + r.error, true);
}

const persist = debounce(() => window.api.settings.set(S.settings), 200);

$('#btnProvAdd').addEventListener('click', () => {
  S.settings.providers.push({
    id: 'p' + Date.now().toString(36),
    name: '新服务',
    kind: 'openai',
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini'
  });
  persist();
  renderProviders();
});
$('#btnProvTest').addEventListener('click', testProvider);

$('#setWidth').addEventListener('input', (e) => {
  S.settings.ui.shotWidth = Number(e.target.value) || 1600;
  persist();
});
$('#setAutoShot').addEventListener('change', (e) => {
  S.settings.ui.autoShot = e.target.value === '1';
  persist();
});

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

/* ---------------- 启动 ---------------- */

async function boot() {
  S.info = await window.api.info();
  $('#ver').textContent = 'v' + S.info.version;
  S.settings = await window.api.settings.get();
  S.templates = await window.api.templates.list();

  $('#req').value = SAMPLE;
  $('#res').innerHTML = '<div class="empty">发送后显示响应</div>';
  $('#scheme').value = 'https';
  $('#setWidth').value = S.settings.ui.shotWidth || 1600;
  $('#setAutoShot').value = S.settings.ui.autoShot ? '1' : '0';

  renderProviders();
  renderTplList();
  fillTemplateSelect();
  if (S.templates.length) selectTpl(S.templates[0].id);

  $('#btnReveal').disabled = true;
  $('#updateText').textContent = `当前版本 v${S.info.version}`;
  $('#rLevel').value = '中';
}

boot();
