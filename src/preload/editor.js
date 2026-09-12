'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function parsePayload() {
  const raw = new URLSearchParams(location.search).get('payload');
  if (!raw) return {};
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (err) {
    console.error('[snapkey] bad editor payload', err);
    return {};
  }
}

async function call(channel, ...args) {
  const response = await ipcRenderer.invoke(channel, ...args);
  if (!response) return undefined;
  if (response.ok === false) throw new Error(response.error || 'The operation failed.');
  return response.ok === true ? response.value : response;
}

let savedPrefs = null;

contextBridge.exposeInMainWorld('snapkey', {
  payload: parsePayload(),
  /** options.forceDialog always prompts, even when a default folder is set. */
  save: (data, options) => call('capture:save', { data, ...(options || {}) }),
  copy: (data) => call('capture:copy', { data }),
  /** Toolbar preferences; the main process persists them when the window closes. */
  rememberPrefs: (prefs) => {
    savedPrefs = prefs;
    ipcRenderer.send('editor:prefs', prefs);
  },
  prefs: () => savedPrefs,
  paths: {
    defaultName: (ext) => call('path:defaultName', ext),
  },
  shell: {
    showItemInFolder: (target) => call('shell:showItemInFolder', target),
  },
  window: {
    openSettings: () => call('window:openSettings'),
  },
  on: (channel, fn) => {
    const allowed = ['app:toast'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (event, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
