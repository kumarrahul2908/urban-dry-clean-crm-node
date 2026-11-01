'use strict';
/** Preload for the setup/splash windows only - the main window loads the backend's own
 *  server-rendered pages and gets no preload (no Node access needed or wanted there). */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('udcSetup', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  testConnection: (cfg) => ipcRenderer.invoke('config:test', cfg),
  saveAndContinue: (cfg) => ipcRenderer.invoke('config:save', cfg),
  cancel: () => ipcRenderer.invoke('config:cancel'),
});

contextBridge.exposeInMainWorld('udcSplash', {
  onStatus: (cb) => ipcRenderer.on('splash:status', (_e, text) => cb(text)),
});
