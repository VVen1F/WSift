'use strict';
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

function newId(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 8);
}

const DEFAULTS = {
  providers: [
    {
      id: 'glm',
      name: 'GLM',
      kind: 'anthropic',
      baseURL: 'https://open.bigmodel.cn/api/anthropic',
      modelsURL: 'https://open.bigmodel.cn/api/paas/v4/models',
      enabled: true,
      proxy: '',
      sessionHeader: '',
      limitSec: 0,
      limitMin: 0,
      contextK: 0,
      accounts: [{ id: 'glm-a1', name: '默认', apiKey: '' }],
      activeAccountId: 'glm-a1',
      models: ['glm-4.6'],
      activeModel: 'glm-4.6'
    },
    {
      id: 'openai',
      name: 'OpenAI 兼容',
      kind: 'openai',
      baseURL: 'https://api.openai.com/v1',
      enabled: false,
      accounts: [{ id: 'openai-a1', name: '默认', apiKey: '' }],
      activeAccountId: 'openai-a1',
      models: ['gpt-4o-mini'],
      activeModel: 'gpt-4o-mini'
    }
  ],
  activeProviderId: 'glm',
  report: { author: '', platform: '通用', language: 'zh' },
  ui: {
    theme: 'system',
    shotWidth: 1600,
    shotDir: '',
    autoShot: false,
    protocol: 'auto',
    remotePort: 8765,
    proxy: '',
    maskKeys: true,
    confirmQuit: false,
    launchAtLogin: false
  },
  backup: {
    auto: 'off',
    keep: 7,
    dir: '',
    withKeys: false,
    lastAt: ''
  },
  sync: {
    kind: 'off',
    webdav: { url: '', user: '', pass: '', path: 'refract-settings.json' },
    github: { repo: '', branch: 'main', path: 'refract-settings.json', token: '' },
    lastAt: '',
    lastResult: ''
  },
  stats: { shots: 0, reports: 0 }
};

function file() {
  return path.join(dataDir(), 'settings.json');
}

/** 老版本的扁平结构迁移成「服务 + 多账号 + 多模型」。 */
function migrateProvider(p) {
  if (!p || typeof p !== 'object') return null;
  const legacyKey = typeof p.apiKey === 'string' ? p.apiKey : '';
  const legacyModel = typeof p.model === 'string' ? p.model : '';

  let accounts = Array.isArray(p.accounts) ? p.accounts.filter(Boolean) : [];
  if (!accounts.length) {
    accounts = [{ id: newId(p.id || 'acc'), name: '默认', apiKey: legacyKey }];
  }
  accounts = accounts.map((a) => ({
    id: a.id || newId('acc'),
    name: a.name || '默认',
    apiKey: typeof a.apiKey === 'string' ? a.apiKey : ''
  }));

  let models = Array.isArray(p.models) ? p.models.filter(Boolean) : [];
  if (!models.length && legacyModel) models = [legacyModel];

  const activeAccountId = accounts.some((a) => a.id === p.activeAccountId)
    ? p.activeAccountId
    : accounts[0].id;

  let name = p.name || '未命名服务';
  // 只改内置预设当年的默认名。用户后来自己起的名字保留。
  if (p.id === 'glm' && /^(智谱 GLM|智普 GLM|zhipu glm)$/i.test(String(name).trim())) name = 'GLM';

  return {
    id: p.id || newId('prov'),
    name,
    kind: p.kind === 'anthropic' ? 'anthropic' : 'openai',
    baseURL: p.baseURL || '',
    modelsURL: p.modelsURL || '',
    enabled: p.enabled !== false,
    proxy: typeof p.proxy === 'string' ? p.proxy : '',
    sessionHeader: p.sessionHeader || '',
    limitSec: Math.max(0, Number(p.limitSec) || 0),
    limitMin: Math.max(0, Number(p.limitMin) || 0),
    contextK: Math.max(0, Number(p.contextK) || 0),
    accounts,
    activeAccountId,
    models,
    activeModel: models.includes(p.activeModel) ? p.activeModel : models[0] || legacyModel || ''
  };
}

function load() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
  const providers = (Array.isArray(raw.providers) && raw.providers.length ? raw.providers : DEFAULTS.providers)
    .map(migrateProvider)
    .filter(Boolean);

  return {
    ...DEFAULTS,
    ...raw,
    report: { ...DEFAULTS.report, ...(raw.report || {}) },
    ui: { ...DEFAULTS.ui, ...(raw.ui || {}) },
    backup: { ...DEFAULTS.backup, ...(raw.backup || {}) },
    sync: {
      ...DEFAULTS.sync,
      ...(raw.sync || {}),
      webdav: { ...DEFAULTS.sync.webdav, ...((raw.sync && raw.sync.webdav) || {}) },
      github: { ...DEFAULTS.sync.github, ...((raw.sync && raw.sync.github) || {}) }
    },
    stats: { ...DEFAULTS.stats, ...(raw.stats || {}) },
    providers,
    activeProviderId: providers.some((p) => p.id === raw.activeProviderId) ? raw.activeProviderId : providers[0].id
  };
}

function save(next) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const clean = {
    ...next,
    providers: (next.providers || []).map(migrateProvider).filter(Boolean)
  };
  fs.writeFileSync(file(), JSON.stringify(clean, null, 2), 'utf8');
  return clean;
}

/** 把「服务 + 当前账号 + 当前模型」压平成调用大模型要的形状。 */
function resolveProvider(cfg, id) {
  const list = (cfg && cfg.providers) || [];
  const p = list.find((x) => x.id === (id || (cfg && cfg.activeProviderId))) || list[0];
  if (!p) return null;
  const accounts = p.accounts || [];
  const acc = accounts.find((a) => a.id === p.activeAccountId) || accounts[0] || { apiKey: '', name: '' };
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
    proxy: typeof p.proxy === 'string' ? p.proxy : '',
    proxy: p.proxy || '',
    sessionHeader: p.sessionHeader || '',
    limitSec: p.limitSec || 0,
    limitMin: p.limitMin || 0,
    contextK: p.contextK || 0
  };
}

module.exports = { load, save, DEFAULTS, file, resolveProvider, newId, migrateProvider };
