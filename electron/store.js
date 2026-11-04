'use strict';
const fs = require('fs');
const path = require('path');
const { dataDir } = require('./paths');

const DEFAULTS = {
  providers: [
    {
      id: 'default',
      name: 'OpenAI 兼容',
      kind: 'openai',
      baseURL: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4o-mini'
    }
  ],
  activeProviderId: 'default',
  report: {
    author: '',
    platform: '通用',
    language: 'zh'
  },
  ui: {
    theme: 'system',
    shotWidth: 1600,
    autoShot: false
  }
};

function file() {
  return path.join(dataDir(), 'settings.json');
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    return {
      ...DEFAULTS,
      ...raw,
      report: { ...DEFAULTS.report, ...(raw.report || {}) },
      ui: { ...DEFAULTS.ui, ...(raw.ui || {}) },
      providers: Array.isArray(raw.providers) && raw.providers.length ? raw.providers : DEFAULTS.providers
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}

function save(next) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { load, save, DEFAULTS, file };
