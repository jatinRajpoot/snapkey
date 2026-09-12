'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/** Unwrap the {ok, value, error} envelope the main process replies with. */
async function call(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response) return undefined;
  if (response.ok === false) throw new Error(response.error || 'The operation failed.');
  return response.ok === true ? response.value : response;
}

contextBridge.exposeInMainWorld('snapkey', {
  settings: {
    get: () => call('settings:get'),
    update: (patch) => call('settings:update', patch),
  },
  shortcuts: {
    bindings: () => call('shortcuts:bindings'),
    suspend: () => call('shortcuts:suspend'),
    resume: () => call('shortcuts:resume'),
    check: (accelerator) => call('shortcuts:check', accelerator),
  },
  dialog: {
    chooseSaveDirectory: () => call('dialog:chooseSaveDirectory'),
  },
  clipboard: {
    writeText: (text) => call('clipboard:writeText', text),
  },
  shell: {
    openPath: (target) => call('shell:openPath', target),
    showItemInFolder: (target) => call('shell:showItemInFolder', target),
  },
  paths: {
    defaultName: (ext) => call('path:defaultName', ext),
    pictures: () => call('path:pictures'),
  },
  app: {
    info: () => call('app:info'),
    quit: () => call('app:quit'),
  },
  updates: {
    state: () => call('updates:state'),
    check: () => call('updates:check'),
    download: () => call('updates:download'),
    install: () => call('updates:install'),
  },
  recents: {
    list: () => call('recents:list'),
    remove: (id) => call('recents:delete', id),
    clear: () => call('recents:clear'),
  },
  capture: {
    start: (action) => call('capture:start', action),
    editImage: (payload) => call('capture:editImage', payload),
    readImage: (filePath) => call('capture:readImage', filePath),
  },
  window: {
    openSettings: (section) => call('window:openSettings', section),
    openAbout: () => call('window:openAbout'),
  },
  on: (channel, fn) => {
    const allowed = [
      'shortcuts:changed',
      'capture:recorded',
      'app:navigate',
      'app:toast',
      'updates:changed',
    ];
    if (!allowed.includes(channel)) return () => {};
    const listener = (event, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
