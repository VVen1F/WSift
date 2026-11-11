'use strict';
// 极简 LLM 客户端：OpenAI 兼容 + Anthropic 兼容，支持流式。
const httpc = require('./http');
const DEFAULT_TIMEOUT = 120000;
const IDLE_TIMEOUT = 90000;
const HARD_TIMEOUT = 10 * 60 * 1000;

function joinURL(base, suffix) {
  return String(base || '').replace(/\/+$/, '') + suffix;
}

const SESSION_ID = 'refract-' + Math.random().toString(36).slice(2, 10);
const queues = new Map();

/** 自定义会话头：值固定为本次进程的 session id，便于网关做粘性/缓存。 */
function headersFor(p) {
  const h = authHeaders(p);
  if (p.sessionHeader) h[String(p.sessionHeader).toLowerCase()] = SESSION_ID;
  return h;
}

/** 每秒 / 每分钟限速，服务级共享。 */
async function throttle(p) {
  const sec = Number(p.limitSec) || 0;
  const min = Number(p.limitMin) || 0;
  if (!sec && !min) return;
  const key = p.id || 'default';
  const now = Date.now();
  const q = queues.get(key) || { sec: [], min: [] };
  q.sec = q.sec.filter((t) => now - t < 1000);
  q.min = q.min.filter((t) => now - t < 60000);
  let wait = 0;
  if (sec && q.sec.length >= sec) wait = Math.max(wait, 1000 - (now - q.sec[0]));
  if (min && q.min.length >= min) wait = Math.max(wait, 60000 - (now - q.min[0]));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const t = Date.now();
  q.sec.push(t);
  q.min.push(t);
  queues.set(key, q);
}

/** 上下文窗口（K token）超了就从最早的消息开始丢，系统提示保留。 */
function trimMessages(messages, contextK) {
  if (!contextK) return messages;
  const budget = contextK * 1000 * 3;
  const size = (m) => String(m.content || '').length;
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= budget) return messages;
  const out = messages.slice();
  const sys = out[0] && out[0].role === 'system' ? out.shift() : null;
  while (out.length > 1 && total > budget) total -= size(out.shift());
  return sys ? [sys, ...out] : out;
}

function authHeaders(p) {
  if (p.kind === 'anthropic') {
    return {
      'content-type': 'application/json',
      'x-api-key': p.apiKey || '',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
  }
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${p.apiKey || ''}`
  };
}

/**
 * 走代理时用项目里的 raw HTTP 通道（fetch 不认代理）。
 * 代价是不能流式，整段回来再一次性丢给 onDelta。
 */
async function proxyJSON(provider, url, bodyObj, method = 'POST') {
  const u = new URL(url);
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const h = headersFor(provider);
  const head =
    `${method} ${u.pathname}${u.search} HTTP/1.1\r\n` +
    `Host: ${u.host}\r\n` +
    Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
    (body ? `\r\nContent-Length: ${Buffer.byteLength(body)}` : '') +
    '\r\n\r\n' + body;

  const r = await httpc.send(head, { scheme: 'https', protocol: 'http1.1', proxy: provider.proxy, timeout: DEFAULT_TIMEOUT });
  const idx = r.text.indexOf('\r\n\r\n');
  const payload = idx >= 0 ? r.text.slice(idx + 4) : '';
  if (r.status >= 400) {
    let msg = payload.slice(0, 200);
    try { const j = JSON.parse(payload); msg = (j.error && (j.error.message || j.error)) || msg; } catch (e) { /* ignore */ }
    throw new Error(`HTTP ${r.status}：${msg}`);
  }
  try {
    return JSON.parse(payload);
  } catch (e) {
    throw new Error('返回不是 JSON：' + payload.slice(0, 120));
  }
}

async function chatViaProxy(provider, messages, maxTokens = 4096) {
  if (provider.kind === 'anthropic') {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const rest = messages.filter((m) => m.role !== 'system');
    const body = { model: provider.model, max_tokens: maxTokens, messages: rest, thinking: { type: 'disabled' } };
    if (system) body.system = system;
    const j = await proxyJSON(provider, joinURL(provider.baseURL, '/v1/messages'), body);
    if (j.error) throw new Error(j.error.message || '请求失败');
    return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  const j = await proxyJSON(provider, joinURL(provider.baseURL, '/chat/completions'), { model: provider.model, messages });
  if (j.error) throw new Error(j.error.message || '请求失败');
  return (j.choices && j.choices[0] && j.choices[0].message.content) || '';
}

/** 从一条流式事件里取出正文或思考片段。思考不写进报告。 */
function takeStreamEvent(ev) {
  if (!ev || typeof ev !== 'object') return {};
  if (ev.type === 'content_block_delta' && ev.delta) {
    if (typeof ev.delta.text === 'string' && ev.delta.text) return { text: ev.delta.text };
    if (typeof ev.delta.thinking === 'string' && ev.delta.thinking) return { note: ev.delta.thinking };
  }
  const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
  if (d) {
    if (typeof d.content === 'string' && d.content) return { text: d.content };
    if (typeof d.reasoning_content === 'string' && d.reasoning_content) return { note: d.reasoning_content };
  }
  return {};
}

function textFromJSON(kind, data) {
  if (data && data.error) {
    const msg = data.error.message || data.error;
    throw new Error(typeof msg === 'string' ? msg : '请求失败');
  }
  if (kind === 'anthropic') {
    return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join('');
  }
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
}

function notePump(onNote) {
  let buf = '';
  let timer = null;
  return {
    push(s) {
      if (!s || !onNote) return;
      buf = (buf + s).slice(-240);
      if (timer) return;
      timer = setTimeout(() => { timer = null; onNote(buf); }, 100);
    },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (buf && onNote) onNote(buf);
    }
  };
}

async function readSSE(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        onEvent(JSON.parse(data));
      } catch (e) {
        /* 忽略非 JSON 心跳 */
      }
    }
  }
}

function anthropicPayload(provider, system, rest, temperature, maxTokens) {
  return {
    model: provider.model,
    system,
    messages: rest,
    stream: true,
    temperature,
    max_tokens: maxTokens,
    // 这些模型默认先写很长的思考。思考会计入 max_tokens，超限后正文为空。
    thinking: { type: 'disabled' }
  };
}

async function chat({ provider, messages, onDelta, onNote, signal, temperature = 0.4, maxTokens = 8192 }) {
  if (!provider) throw new Error('未配置模型');
  messages = trimMessages(messages, provider.contextK);
  await throttle(provider);

  if (provider.proxy) {
    const text = await chatViaProxy(provider, messages, maxTokens);
    if (onDelta && text) onDelta(text);
    return text;
  }

  const controller = new AbortController();
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  // 原来的写法是「整条请求 120 秒」，正文长的报告写不完就被掐掉；
  // 改成看有没有新数据：IDLE 秒没动静才停，总时长兜到 10 分钟。
  let lastAt = Date.now();
  const startedAt = Date.now();
  let idleHit = false;
  let hardHit = false;
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - lastAt > IDLE_TIMEOUT) { idleHit = true; controller.abort(); return; }
    if (now - startedAt > HARD_TIMEOUT) { hardHit = true; controller.abort(); }
  }, 2000);
  const touch = () => { lastAt = Date.now(); };
  const delta = (d) => { touch(); if (onDelta) onDelta(d); };
  const note = (n) => { touch(); if (onNote) onNote(n); };

  try {
    if (provider.kind === 'anthropic') {
      return await chatAnthropic(provider, messages, delta, note, controller.signal, temperature, maxTokens);
    }
    return await chatOpenAI(provider, messages, delta, note, controller.signal, temperature, maxTokens);
  } catch (err) {
    if ((signal && signal.aborted)) {
      const e = new Error('已停止');
      e.code = 'ABORT';
      throw e;
    }
    if (idleHit) {
      const e = new Error('模型 ' + Math.round(IDLE_TIMEOUT / 1000) + ' 秒没有返回数据，已停止');
      e.code = 'IDLE';
      throw e;
    }
    if (hardHit) {
      const e = new Error('超过 ' + Math.round(HARD_TIMEOUT / 60000) + ' 分钟还没写完，已停止');
      e.code = 'TIMEOUT';
      throw e;
    }
    if (controller.signal.aborted || err.name === 'AbortError') {
      const e = new Error('已停止');
      e.code = 'ABORT';
      throw e;
    }
    throw err;
  } finally {
    clearInterval(watchdog);
  }
}

async function chatOpenAI(provider, messages, onDelta, onNote, signal, temperature, maxTokens) {
  const res = await fetch(joinURL(provider.baseURL, '/chat/completions'), {
    method: 'POST',
    headers: headersFor(provider),
    body: JSON.stringify({ model: provider.model, messages, stream: true, temperature, max_tokens: maxTokens }),
    signal
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`模型返回 ${res.status}: ${t.slice(0, 300)}`);
  }
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('application/json') && !ctype.includes('event-stream')) {
    const text = textFromJSON('openai', await res.json());
    if (text && onDelta) onDelta(text);
    return text;
  }
  const notes = notePump(onNote);
  let text = '';
  await readSSE(res, (ev) => {
    const part = takeStreamEvent(ev);
    if (part.text) {
      text += part.text;
      if (onDelta) onDelta(part.text);
    }
    if (part.note) notes.push(part.note);
  });
  notes.flush();
  return text;
}

async function postAnthropic(provider, body, signal) {
  const send = (payload) => fetch(joinURL(provider.baseURL, '/v1/messages'), {
    method: 'POST',
    headers: headersFor(provider),
    body: JSON.stringify(payload),
    signal
  });
  let res = await send(body);
  if (res.status === 400 && body.thinking) {
    const t = await res.text().catch(() => '');
    if (/thinking/i.test(t)) {
      const next = { ...body };
      delete next.thinking;
      res = await send(next);
    } else {
      throw new Error(`模型返回 400: ${t.slice(0, 300)}`);
    }
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`模型返回 ${res.status}: ${t.slice(0, 300)}`);
  }
  return res;
}

async function chatAnthropic(provider, messages, onDelta, onNote, signal, temperature, maxTokens) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const res = await postAnthropic(provider, anthropicPayload(provider, system, rest, temperature, maxTokens), signal);
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (ctype.includes('application/json') && !ctype.includes('event-stream')) {
    const text = textFromJSON('anthropic', await res.json());
    if (text && onDelta) onDelta(text);
    return text;
  }
  const notes = notePump(onNote);
  let text = '';
  let stop = '';
  await readSSE(res, (ev) => {
    if (ev && ev.type === 'message_delta' && ev.delta && ev.delta.stop_reason) stop = ev.delta.stop_reason;
    const part = takeStreamEvent(ev);
    if (part.text) {
      text += part.text;
      if (onDelta) onDelta(part.text);
    }
    if (part.note) notes.push(part.note);
  });
  notes.flush();
  if (!text) {
    throw new Error(stop === 'max_tokens' ? '输出被长度上限截断，没有正文' : '模型没有返回正文');
  }
  return text;
}

async function listModels(provider) {
  const url = provider.modelsURL ||
    (provider.kind === 'anthropic' ? joinURL(provider.baseURL, '/v1/models') : joinURL(provider.baseURL, '/models'));
  // 单独配了 modelsURL 时，模型列表走 OpenAI 风格的 Bearer 鉴权
  const headers = provider.modelsURL
    ? { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey || ''}` }
    : headersFor(provider);
  if (provider.proxy) {
    // 自定义模型列表地址走 OpenAI 风格的 Bearer 鉴权
    const p2 = provider.modelsURL ? { ...provider, kind: 'openai' } : provider;
    const j = await proxyJSON(p2, url, null, 'GET');
    const list = j.data || j.models || [];
    return list.map((m) => m.id || m.name).filter(Boolean);
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`获取模型失败 ${res.status}`);
  const json = await res.json();
  const arr = json.data || json.models || [];
  return arr.map((m) => m.id || m.name).filter(Boolean);
}

const VISION_PROMPT = `下面几张图是同一块屏幕在不同时刻的截图。
判断哪一张里出现了浏览器弹出的 JavaScript 对话框（alert / confirm / prompt），
特征是屏幕中间浮着一个小方块，里面有文字和按钮，周围页面被压暗。
只回复一个数字：图片编号（从 1 开始）。都没有就回复 0。不要解释。`;

function imagePart(provider, img) {
  return provider.kind === 'anthropic'
    ? { type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }
    : { type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } };
}

/** 让带视觉的模型看几张图，返回原始文本。 */
async function vision({ provider, images, prompt = VISION_PROMPT, maxTokens = 8, timeout = 8000 }) {
  const url = provider.kind === 'anthropic'
    ? joinURL(provider.baseURL, '/v1/messages')
    : joinURL(provider.baseURL, '/chat/completions');

  const parts = images.map((i) => imagePart(provider, i));
  const body = provider.kind === 'anthropic'
    ? {
        model: provider.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: [...parts, { type: 'text', text: prompt }] }]
      }
    : {
        model: provider.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, ...parts] }]
      };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headersFor(provider),
      body: JSON.stringify(body),
      signal: ac.signal
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || '视觉请求失败');
    if (provider.kind === 'anthropic') {
      return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
    }
    return (data.choices && data.choices[0] && data.choices[0].message.content) || '';
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chat, listModels, joinURL, vision, VISION_PROMPT, SESSION_ID, trimMessages, takeStreamEvent, anthropicPayload };
