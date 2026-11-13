'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

let seq = 0;

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  remoteInfo: () => ipcRenderer.invoke('remote:info'),
  imageUrl: (p) => 'file://' + p,
  send: (payload) => ipcRenderer.invoke('http:send', payload),
  capture: (payload) => ipcRenderer.invoke('shot:capture', payload),
  shots: {
    dir: () => ipcRenderer.invoke('shots:dir'),
    choose: () => ipcRenderer.invoke('shots:choose'),
    show: () => ipcRenderer.invoke('shots:show')
  },

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (s) => ipcRenderer.invoke('settings:set', s),
    export: (withKeys) => ipcRenderer.invoke('settings:export', withKeys),
    import: () => ipcRenderer.invoke('settings:import')
  },

  filePath(file) {
    try {
      if (webUtils && webUtils.getPathForFile) return webUtils.getPathForFile(file) || '';
    } catch (e) { /* 远程页面没有本地路径 */ }
    return (file && file.path) || '';
  },

  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    upsert: (t) => ipcRenderer.invoke('templates:upsert', t),
    remove: (id) => ipcRenderer.invoke('templates:remove', id),
    reset: () => ipcRenderer.invoke('templates:reset'),
    check: (body) => ipcRenderer.invoke('templates:check', body),
    presets: () => ipcRenderer.invoke('templates:presets')
  },

  models: (provider) => ipcRenderer.invoke('llm:models', provider),

  leishen: {
    cfg: () => ipcRenderer.invoke('leishen:cfg'),
    save: (patch) => ipcRenderer.invoke('leishen:save', patch),
    accounts: () => ipcRenderer.invoke('leishen:accounts'),
    accountSave: (payload) => ipcRenderer.invoke('leishen:account:save', payload),
    accountRemove: (id) => ipcRenderer.invoke('leishen:account:remove', id),
    logout: (accountId) => ipcRenderer.invoke('leishen:logout', accountId),
    captcha: () => ipcRenderer.invoke('leishen:captcha'),
    login: (payload, onNote) => {
      const h = (_e, p) => onNote && onNote(p && p.note);
      ipcRenderer.on('leishen:progress', h);
      return ipcRenderer.invoke('leishen:login', payload).finally(() => ipcRenderer.off('leishen:progress', h));
    },
    loginAuto: (payload, onNote) => {
      const h = (_e, p) => onNote && onNote(p && p.note);
      ipcRenderer.on('leishen:progress', h);
      return ipcRenderer.invoke('leishen:loginAuto', payload).finally(() => ipcRenderer.off('leishen:progress', h));
    },
    types: (opts) => ipcRenderer.invoke('leishen:types', opts),
    project: (payload) => ipcRenderer.invoke('leishen:project', payload),
    projects: (accountId) => ipcRenderer.invoke('leishen:projects', accountId),
    projectsAll: () => ipcRenderer.invoke('leishen:projectsAll'),
    parse: (md, types) => ipcRenderer.invoke('leishen:parse', md, types),
    submit: (payload, onNote) => {
      const h = (_e, p) => onNote && onNote(p && p.note);
      ipcRenderer.on('leishen:progress', h);
      return ipcRenderer.invoke('leishen:submit', payload).finally(() => ipcRenderer.off('leishen:progress', h));
    }
  },

  chat({ provider, messages, onDelta, onNote, onDone, onError }) {
    const id = 'c' + ++seq;
    const d = (_e, p) => p.id === id && onDelta && onDelta(p.delta);
    const note = (_e, p) => p.id === id && onNote && onNote(p.note);
    const n = (_e, p) => {
      if (p.id !== id) return;
      cleanup();
      onDone && onDone(p.text);
    };
    const r = (_e, p) => {
      if (p.id !== id) return;
      cleanup();
      onError && onError(p.message, p.code);
    };
    function cleanup() {
      ipcRenderer.off('llm:delta', d);
      ipcRenderer.off('llm:note', note);
      ipcRenderer.off('llm:done', n);
      ipcRenderer.off('llm:error', r);
    }
    ipcRenderer.on('llm:delta', d);
    ipcRenderer.on('llm:note', note);
    ipcRenderer.on('llm:done', n);
    ipcRenderer.on('llm:error', r);
    ipcRenderer.send('llm:chat', { id, provider, messages });
    return {
      id,
      cancel() { ipcRenderer.send('llm:cancel', id); }
    };
  },

  saveReport: (payload) => ipcRenderer.invoke('report:save', payload),
  autoShots: (payload) => ipcRenderer.invoke('report:autoShots', payload),
  onProgress: (fn) => ipcRenderer.on('report:progress', (_e, p) => fn(p)),
  tasks: {
    list: () => ipcRenderer.invoke('tasks:list'),
    save: (list) => ipcRenderer.invoke('tasks:save', list)
  },
  compose: (payload) => ipcRenderer.invoke('report:compose', payload),
  chatMessages: (payload) => ipcRenderer.invoke('report:chat', payload),

  update: {
    check: () => ipcRenderer.invoke('update:check'),
    download: (url, onProgress) => {
      const h = (_e, p) => onProgress && onProgress(p);
      ipcRenderer.on('update:progress', h);
      return ipcRenderer.invoke('update:download', url).finally(() => ipcRenderer.off('update:progress', h));
    },
    install: (file) => ipcRenderer.invoke('update:install', file),
    relaunch: () => ipcRenderer.invoke('update:relaunch')
  },

  clipboard: (text) => ipcRenderer.invoke('clipboard:write', text),

  backup: {
    now: () => ipcRenderer.invoke('backup:now'),
    list: () => ipcRenderer.invoke('backup:list'),
    restore: (file) => ipcRenderer.invoke('backup:restore', file),
    choose: () => ipcRenderer.invoke('backup:choose'),
    show: () => ipcRenderer.invoke('backup:show'),
    dir: () => ipcRenderer.invoke('backup:dir')
  },
  sync: {
    test: () => ipcRenderer.invoke('sync:test'),
    push: () => ipcRenderer.invoke('sync:push'),
    pull: () => ipcRenderer.invoke('sync:pull')
  },
  app: {
    loginItem: (enable) => ipcRenderer.invoke('app:loginItem', enable)
  },

  perm: {
    screen: () => ipcRenderer.invoke('perm:screen'),
    request: () => ipcRenderer.invoke('perm:request'),
    open: () => ipcRenderer.invoke('perm:open'),
    onNeed(cb) {
      const h = (_e, p) => cb(p);
      ipcRenderer.on('perm:need', h);
      return () => ipcRenderer.off('perm:need', h);
    },
    onStatus(cb) {
      const h = (_e, p) => cb(p);
      ipcRenderer.on('perm:status', h);
      return () => ipcRenderer.off('perm:status', h);
    },
    onRetry(cb) {
      const h = (_e, p) => cb(p);
      ipcRenderer.on('perm:retry', h);
      return () => ipcRenderer.off('perm:retry', h);
    }
  },

  browser: {
    status: () => ipcRenderer.invoke('browser:status'),
    open: () => ipcRenderer.invoke('browser:ensure'),
    go: (url) => ipcRenderer.invoke('browser:navigate', url),
    eval: (code) => ipcRenderer.invoke('browser:eval', code),
    shot: () => ipcRenderer.invoke('browser:shot'),
    screen: () => ipcRenderer.invoke('browser:screen'),
    close: () => ipcRenderer.invoke('browser:close'),
    onDialog(cb) {
      const h = (_e, p) => cb(p);
      ipcRenderer.on('browser:dialog', h);
      return () => ipcRenderer.off('browser:dialog', h);
    }
  },
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  saveText: (payload) => ipcRenderer.invoke('dialog:saveText', payload)
});
