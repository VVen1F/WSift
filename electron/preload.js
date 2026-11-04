'use strict';
const { contextBridge, ipcRenderer } = require('electron');

let seq = 0;

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('app:info'),
  send: (payload) => ipcRenderer.invoke('http:send', payload),
  capture: (payload) => ipcRenderer.invoke('shot:capture', payload),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (s) => ipcRenderer.invoke('settings:set', s)
  },

  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    upsert: (t) => ipcRenderer.invoke('templates:upsert', t),
    remove: (id) => ipcRenderer.invoke('templates:remove', id),
    reset: () => ipcRenderer.invoke('templates:reset')
  },

  models: (provider) => ipcRenderer.invoke('llm:models', provider),

  chat({ provider, messages, onDelta, onDone, onError }) {
    const id = 'c' + ++seq;
    const d = (_e, p) => p.id === id && onDelta && onDelta(p.delta);
    const n = (_e, p) => {
      if (p.id !== id) return;
      cleanup();
      onDone && onDone(p.text);
    };
    const r = (_e, p) => {
      if (p.id !== id) return;
      cleanup();
      onError && onError(p.message);
    };
    function cleanup() {
      ipcRenderer.off('llm:delta', d);
      ipcRenderer.off('llm:done', n);
      ipcRenderer.off('llm:error', r);
    }
    ipcRenderer.on('llm:delta', d);
    ipcRenderer.on('llm:done', n);
    ipcRenderer.on('llm:error', r);
    ipcRenderer.send('llm:chat', { id, provider, messages });
    return id;
  },

  saveReport: (payload) => ipcRenderer.invoke('report:save', payload),
  compose: (payload) => ipcRenderer.invoke('report:compose', payload),

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
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  saveText: (payload) => ipcRenderer.invoke('dialog:saveText', payload)
});
