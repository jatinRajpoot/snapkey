'use strict';

const { app, BrowserWindow, ipcMain, dialog, nativeImage, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const protocol = require('./protocol');
const settings = require('./settings');
const shortcuts = require('./shortcuts');
const saver = require('./saver');
const recents = require('./recents');
const compose = require('./compose');
const tray = require('./tray');
const overlay = require('./overlay');
const ipc = require('./ipc');
const appmenu = require('./appmenu');
const updates = require('./updates');
const { warmUp, delay } = require('./capture');

protocol.registerScheme();

const isDev = process.argv.includes('--dev');
app.setAppUserModelId('dev.snapkey.app');
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow = null;
let settingsWindow = null;
let aboutWindow = null;
let aboutImage = null;
/** Set while a capture is mid-flight so a second hotkey press cancels instead. */
let capturing = false;

// ---------------------------------------------------------------------------
// Windows

function preload(name) {
  return path.join(__dirname, '..', 'preload', name);
}

function baseWebPreferences(name) {
  return {
    preload: preload(name),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    spellcheck: false,
  };
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0b0d14',
    title: 'Snapkey',
    autoHideMenuBar: true,
    webPreferences: baseWebPreferences('app.js'),
  });

  mainWindow.loadURL(protocol.url('src/renderer/app/index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  return mainWindow;
}

function createSettingsWindow(section = 'shortcuts') {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    settingsWindow.webContents.send('app:navigate', { section });
    return settingsWindow;
  }
  settingsWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 820,
    minHeight: 560,
    show: false,
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    backgroundColor: '#0b0d14',
    title: 'Snapkey Settings',
    autoHideMenuBar: true,
    webPreferences: baseWebPreferences('app.js'),
  });
  settingsWindow.loadURL(protocol.url(`src/renderer/app/index.html#/${section}`));
  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
    settingsWindow.focus();
  });
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
  return settingsWindow;
}

function createAboutWindow() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.show();
    aboutWindow.focus();
    return aboutWindow;
  }
  aboutWindow = new BrowserWindow({
    width: 460,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    show: false,
    backgroundColor: '#0b0d14',
    title: 'About Snapkey',
    autoHideMenuBar: true,
    webPreferences: baseWebPreferences('app.js'),
  });
  aboutWindow.loadURL(protocol.url('src/renderer/app/index.html#/about'));
  aboutWindow.once('ready-to-show', () => aboutWindow.show());
  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });
  return aboutWindow;
}

/** The editor is a normal window: full keyboard support, no overlay quirks. */
function createEditorWindow(pngBuffer, meta = {}) {
  const win = new BrowserWindow({
    width: Math.min(1500, Math.max(880, Math.round((meta.naturalWidth || 1200) * 0.72))),
    height: Math.min(1000, Math.max(620, Math.round((meta.naturalHeight || 800) * 0.72))),
    minWidth: 860,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0d14',
    title: 'Snapkey Editor',
    autoHideMenuBar: true,
    webPreferences: baseWebPreferences('editor.js'),
  });

  const payload = {
    image: `data:image/png;base64,${pngBuffer.toString('base64')}`,
    pending: meta.pending || [],
    toolbar: settings.get().editor,
    naturalWidth: meta.naturalWidth || 0,
    naturalHeight: meta.naturalHeight || 0,
    source: meta.source || 'capture',
  };
  const query = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  win.loadURL(`${protocol.url('src/renderer/editor/index.html')}?payload=${encodeURIComponent(query)}`);
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });
  win.on('closed', () => {
    if (aboutImage) aboutImage = null;
  });
  return win;
}

/** Push an event to every window that happens to be open. */
function broadcast(channel, payload) {
  for (const win of [mainWindow, settingsWindow, aboutWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

function flashError(message) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  if (win) {
    win.show();
    win.webContents.send('app:toast', { kind: 'error', message });
  }
  dialog.showErrorBox('Snapkey', message);
}

// ---------------------------------------------------------------------------
// Capture pipeline

async function captureCursorDisplay() {
  const { grabDisplays } = require('./capture');
  const target = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const fresh = await grabDisplays();
  const display = fresh.displays.find((d) => String(d.id) === String(target.id)) || fresh.displays[0];
  if (!display) throw new Error('No display could be captured.');
  if (fresh.displays.length === 1) return display.png;
  return compose.composite([display], display.bounds, fresh.scale);
}

async function compositeAllScreens() {
  const { grabDisplays } = require('./capture');
  const fresh = await grabDisplays();
  return compose.composite(fresh.displays, fresh.virtualBounds, fresh.scale);
}

/** Record a finished capture in the history backlog. */
async function rememberCapture(pngBuffer, { filePath, source }) {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let thumbnail = null;
  try {
    thumbnail = await recents.makeThumbnail(id, pngBuffer);
  } catch {
    /* thumbnails are best-effort */
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('capture:recorded', {
      id,
      filePath,
      source,
      thumbnail,
      width: nativeImage.createFromBuffer(pngBuffer).getSize().width,
      height: nativeImage.createFromBuffer(pngBuffer).getSize().height,
      createdAt: new Date().toISOString(),
    });
  }
  return { id, thumbnail };
}

async function runCapture(action) {
  // A hotkey press while the overlay is up means "never mind".
  if (capturing) {
    overlay.cancel();
    return;
  }

  if (!['library', 'openImage'].includes(action)) {
    capturing = true;
  }

  try {
    switch (action) {
      case 'library': {
        createMainWindow();
        return;
      }
      case 'openImage': {
        const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
          title: 'Open an image to annotate',
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
        });
        if (canceled || !filePaths.length) return;
        const data = await fs.readFile(filePaths[0]);
        const image = nativeImage.createFromBuffer(data);
        if (image.isEmpty()) throw new Error('That file is not an image Snapkey can read.');
        const { width, height } = image.getSize();
        createEditorWindow(image.toPNG(), {
          naturalWidth: width,
          naturalHeight: height,
          source: filePaths[0],
        });
        return;
      }
      case 'directCopy': {
        await delay(60);
        const png = await compositeAllScreens();
        await saver.copyToClipboard(png);
        await rememberCapture(png, { source: 'quick-copy' });
        return;
      }
      case 'screen':
      case 'allScreens': {
        // "Screen" means the display under the cursor; "all screens" is the
        // whole virtual desktop stitched together.
        const png = action === 'screen' ? await captureCursorDisplay() : await compositeAllScreens();
        const size = nativeImage.createFromBuffer(png).getSize();
        createEditorWindow(png, {
          naturalWidth: size.width,
          naturalHeight: size.height,
          source: action,
        });
        await rememberCapture(png, { source: action });
        return;
      }
      case 'region':
      default: {
        // The overlay owns the pixels: it already holds a frozen copy of the
        // screen, so re-capturing here would race against window teardown.
        const result = await overlay.present({ mode: 'region' });
        if (!result || result.action === 'cancel') return;

        if (result.action === 'allScreens') {
          const png = await compositeAllScreens();
          const size = nativeImage.createFromBuffer(png).getSize();
          createEditorWindow(png, {
            naturalWidth: size.width,
            naturalHeight: size.height,
            source: 'allScreens',
          });
          await rememberCapture(png, { source: 'allScreens' });
          return;
        }

        const png = Buffer.from(result.data, 'base64');
        if (!png.length) throw new Error('The selection produced an empty image.');

        if (result.action === 'copy') {
          await saver.copyToClipboard(png);
          await rememberCapture(png, { source: 'region-copy' });
          return;
        }

        if (result.action === 'edit') {
          createEditorWindow(png, {
            naturalWidth: result.width,
            naturalHeight: result.height,
            pending: result.annotations || [],
            source: 'region',
          });
          await rememberCapture(png, { source: 'region' });
        }
        return;
      }
    }
  } catch (err) {
    console.error('[snapkey] capture failed:', err);
    flashError(err.message || 'The capture could not be completed.');
  } finally {
    capturing = false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle

function applyShortcuts() {
  const result = shortcuts.apply();
  tray.refresh({
    onCapture: runCapture,
    onOpenSettings: () => createSettingsWindow(),
    onOpenAbout: () => createAboutWindow(),
    onCheckUpdates: checkForUpdates,
    bindings: shortcuts.bindings,
    onQuit: () => app.quit(),
  });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shortcuts:changed', result);
  }
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('shortcuts:changed', result);
  }
  return result;
}

shortcuts.onTrigger = (action) => {
  runCapture(action);
};

/**
 * Check for updates from the menus. The renderer pulls the current state when
 * it renders, so opening About first is enough for the result to be visible.
 */
function checkForUpdates() {
  createAboutWindow();
  return updates.check();
}

ipc.configure({
  openSettings: (section) => createSettingsWindow(section),
  openAbout: () => createAboutWindow(),
  quit: () => app.quit(),
  mainWindow: () => mainWindow,
  applyShortcuts,
});

// Recents live behind their own small handler set.
ipcMain.removeHandler('recents:list');
ipcMain.handle('recents:list', async () => ({ ok: true, value: await recents.list() }));
ipcMain.removeHandler('recents:clear');
ipcMain.handle('recents:clear', async () => ({ ok: true, value: await recents.clear() }));
ipcMain.removeHandler('recents:delete');
ipcMain.handle('recents:delete', async (event, id) => ({
  ok: true,
  value: await recents.remove(id),
}));

// The editor reports its last-used tool/colour/size so the next capture opens
// with the same settings.
ipcMain.removeAllListeners('editor:prefs');
ipcMain.on('editor:prefs', (event, prefs) => {
  if (prefs && typeof prefs === 'object') settings.update({ editor: prefs });
});

// Full-screen or region capture requested straight from the renderer UI.
ipcMain.removeHandler('capture:start');
ipcMain.handle('capture:start', async (event, action) => {
  runCapture(action);
  return { ok: true, value: true };
});

// The overlay is only shown for region selection; a seeded image goes straight
// to the editor window instead.
ipcMain.removeHandler('capture:editImage');
ipcMain.handle('capture:editImage', async (event, payload) => {
  try {
    const buffer = Buffer.from(payload.data, 'base64');
    createEditorWindow(buffer, {
      naturalWidth: payload.width,
      naturalHeight: payload.height,
      source: 'editor',
    });
    return { ok: true, value: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

app.whenReady().then(async () => {
  protocol.handle();
  ipc.register();
  updates.init({ broadcast, onAvailable: () => createAboutWindow() });

  appmenu.build({
    onCapture: runCapture,
    onOpenSettings: () => createSettingsWindow(),
    onOpenAbout: () => createAboutWindow(),
    onOpenImage: () => runCapture('openImage'),
    onCheckUpdates: checkForUpdates,
  });

  tray.create({
    onCapture: runCapture,
    onOpenSettings: () => createSettingsWindow(),
    onOpenAbout: () => createAboutWindow(),
    onCheckUpdates: checkForUpdates,
    bindings: shortcuts.bindings,
    onQuit: () => app.quit(),
  });

  const result = applyShortcuts();
  if (result.duplicates.length) {
    console.warn('[snapkey] duplicate shortcuts:', result.duplicates);
  }
  for (const [action, info] of Object.entries(result.failed)) {
    console.warn(`[snapkey] shortcut "${action}" (${info.accelerator}) not bound: ${info.reason}`);
  }

  createMainWindow();
  warmUp();
});

app.on('second-instance', () => {
  createMainWindow();
});

app.on('window-all-closed', () => {
  // Snapkey lives in the tray; closing the windows must not quit it.
});

app.on('will-quit', () => {
  shortcuts.unregisterAll();
  tray.destroy();
});
