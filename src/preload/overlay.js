'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function parsePayload() {
  const raw = new URLSearchParams(location.search).get('payload');
  if (!raw) return {};
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch (err) {
    console.error('[snapkey] bad overlay payload', err);
    return {};
  }
}

const payload = parsePayload();

contextBridge.exposeInMainWorld('snapkey', {
  payload,
  /** Send the session result back to the main process. */
  finish: (result) => ipcRenderer.send('overlay:event', { type: 'result', result }),
  cancel: () => ipcRenderer.send('overlay:event', { type: 'cancel' }),
  /** Broadcast a message to the other displays' overlays. */
  relay: (message) => ipcRenderer.send('overlay:event', { type: 'relay', message }),
  /** Tell the other displays that this one now owns the interaction. */
  claim: () => ipcRenderer.send('overlay:event', { type: 'relay', message: { type: 'claimed', displayId: payload.displayId } }),
  onRelay: (fn) => {
    const listener = (event, message) => fn(message);
    ipcRenderer.on('overlay:relay', listener);
    return () => ipcRenderer.removeListener('overlay:relay', listener);
  },
  onPrimary: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('overlay:primary', listener);
    return () => ipcRenderer.removeListener('overlay:primary', listener);
  },
  onCancel: (fn) => {
    const listener = () => fn();
    ipcRenderer.on('overlay:cancel', listener);
    return () => ipcRenderer.removeListener('overlay:cancel', listener);
  },
});
