'use strict';

const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('node:path');
const { grabDisplays } = require('./capture');
const settings = require('./settings');
const protocol = require('./protocol');

const PRELOAD = path.join(__dirname, '..', 'preload', 'overlay.js');
const OVERLAY_URL = protocol.url('src/renderer/overlay/index.html');

let session = null;

const isOpen = () => !!session;

/**
 * Put a frozen copy of every display on screen and let the renderer take over
 * from there. Resolves with the renderer's result, or {action:'cancel'}.
 */
async function present({ mode = 'region', annotate = false, seedImage = null } = {}) {
  if (session) {
    cancel();
    return { action: 'cancel' };
  }

  const captured = await grabDisplays();
  if (!captured.displays.length) throw new Error('No displays could be captured.');

  const current = { windows: [], resolve: null, done: false };
  session = current;

  try {
    for (const display of captured.displays) {
      const win = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        useContentSize: true,
        show: false,
        frame: false,
        backgroundColor: '#000000',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        enableLargerThanScreen: true,
        autoHideMenuBar: true,
        webPreferences: {
          preload: PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          spellcheck: false,
          backgroundThrottling: false,
        },
      });

      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      if (process.platform === 'win32') win.setMenuBarVisibility(false);

      const payload = {
        mode,
        annotate,
        displayId: display.id,
        label: display.label,
        bounds: display.bounds,
        virtualBounds: captured.virtualBounds,
        scale: captured.scale,
        isPrimary: display.isPrimary,
        displayCount: captured.displays.length,
        magnifier: settings.get().magnifier,
        toolbar: settings.get().editor,
        background: `data:image/png;base64,${display.png.toString('base64')}`,
        seed: display.isPrimary && seedImage ? seedImage : null,
      };

      const query = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      await win.loadURL(`${OVERLAY_URL}?payload=${encodeURIComponent(query)}`);

      const record = { win, display };
      current.windows.push(record);

      win.on('closed', () => finish(current, { action: 'cancel' }));
    }

    const primary = current.windows.find((r) => r.display.isPrimary) || current.windows[0];
    current.primary = primary;

    const result = new Promise((resolve) => {
      current.resolve = resolve;
    });

    const onEvent = (event, payload) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || !current.windows.some((r) => r.win === win)) return;

      if (payload?.type === 'result') finish(current, payload.result);
      else if (payload?.type === 'cancel') finish(current, { action: 'cancel' });
      else if (payload?.type === 'relay') {
        // Cross-display messages: selection started on one screen, polished on another.
        for (const other of current.windows) {
          const target = other.win;
          if (target !== win && !target.isDestroyed()) {
            target.webContents.send('overlay:relay', payload.message);
          }
        }
      }
    };
    current.onEvent = onEvent;
    ipcMain.on('overlay:event', onEvent);

    // Show everything, then hand focus to the primary display.
    for (const { win } of current.windows) {
      if (!win.isDestroyed()) win.showInactive();
    }
    if (!primary.win.isDestroyed()) {
      primary.win.show();
      primary.win.focus();
      primary.win.webContents.focus();
    }

    return await result;
  } catch (err) {
    finish(current, { action: 'cancel' });
    throw err;
  }
}

function finish(current, value) {
  if (!current || current.done) return;
  current.done = true;
  if (session === current) session = null;

  if (current.onEvent) ipcMain.removeListener('overlay:event', current.onEvent);
  if (current.resolve) current.resolve(value);

  for (const { win } of current.windows) {
    if (!win.isDestroyed()) win.destroy();
  }
  current.windows = [];
}

/** Ask the overlay to cancel, e.g. when the user hits a capture hotkey again. */
function cancel() {
  if (session) finish(session, { action: 'cancel' });
}

module.exports = { present, cancel, isOpen, screen };
