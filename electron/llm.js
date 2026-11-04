'use strict';
// 极简 LLM 客户端：OpenAI 兼容 + Anthropic 兼容，支持流式。
const DEFAULT_TIMEOUT = 120000;

function joinURL(base, suffix) {
  return String(base || '').replace(/\/+$/, '') + suffix;
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

async function chat({ provider, messages, onDelta, signal, temperature = 0.4, maxTokens = 4096 }) {
  if (!provider) throw new Error('未配置模型');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT);
  if (signal) signal.addEventListener('abort', () => controller.abort());

  try {
    if (provider.kind === 'anthropic') {
      return await chatAnthropic(provider, messages, onDelta, controller.signal, temperature, maxTokens);
    }
    return await chatOpenAI(provider, messages, onDelta, controller.signal, temperature, maxTokens);
  } finally {
    clearTimeout(timer);
  }
}

async function chatOpenAI(provider, messages, onDelta, signal, temperature, maxTokens) {
  const res = await fetch(joinURL(provider.baseURL, '/chat/completions'), {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify({ model: provider.model, messages, stream: true, temperature, max_tokens: maxTokens }),
    signal
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`模型返回 ${res.status}: ${t.slice(0, 300)}`);
  }
  let text = '';
  await readSSE(res, (ev) => {
    const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
    if (d && d.content) {
      text += d.content;
      onDelta && onDelta(d.content);
    }
  });
  return text;
}

async function chatAnthropic(provider, messages, onDelta, signal, temperature, maxTokens) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system');
  const res = await fetch(joinURL(provider.baseURL, '/v1/messages'), {
    method: 'POST',
    headers: authHeaders(provider),
    body: JSON.stringify({
      model: provider.model,
      system,
      messages: rest,
      stream: true,
      temperature,
      max_tokens: maxTokens
    }),
    signal
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`模型返回 ${res.status}: ${t.slice(0, 300)}`);
  }
  let text = '';
  await readSSE(res, (ev) => {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.text) {
      text += ev.delta.text;
      onDelta && onDelta(ev.delta.text);
    }
  });
  return text;
}

async function listModels(provider) {
  const url = provider.kind === 'anthropic'
    ? joinURL(provider.baseURL, '/v1/models')
    : joinURL(provider.baseURL, '/models');
  const res = await fetch(url, { headers: authHeaders(provider) });
  if (!res.ok) throw new Error(`获取模型失败 ${res.status}`);
  const json = await res.json();
  const arr = json.data || json.models || [];
  return arr.map((m) => m.id || m.name).filter(Boolean);
}

module.exports = { chat, listModels, joinURL };
