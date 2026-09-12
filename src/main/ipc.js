'use strict';

const { app, ipcMain, clipboard, shell, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const settings = require('./settings');
const saver = require('./saver');
const shortcuts = require('./shortcuts');
const updates = require('./updates');
const { defaultName, picturesDir } = require('./saver');

/** Filled in by main.js once the windows exist. */
const host = {
  openSettings: () => {},
  openAbout: () => {},
  quit: () => {},
  mainWindow: () => null,
  applyShortcuts: () => ({ failed: {}, duplicates: [] }),
};

function configure(next) {
  Object.assign(host, next);
}

function handle(channel, fn) {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, value: await fn(event, ...args) };
    } catch (err) {
      console.error(`[snapkey] ipc ${channel} failed:`, err);
      return { ok: false, error: err.message || String(err) };
    }
  });
}

function register() {
  handle('settings:get', () => settings.get());
  handle('settings:update', (event, patch) => {
    const next = settings.update(patch);
    const result = host.applyShortcuts();
    return { settings: next, shortcuts: result };
  });

  handle('shortcuts:bindings', () => shortcuts.bindings());
  handle('shortcuts:suspend', () => {
    shortcuts.suspend();
    return true;
  });
  handle('shortcuts:resume', () => shortcuts.resume());
  handle('shortcuts:check', (event, accelerator) => shortcuts.isAvailable(accelerator));

  handle('dialog:chooseSaveDirectory', (event) =>
    saver.chooseDirectory(host.mainWindow() || undefined),
  );

  handle('clipboard:writeText', (event, text) => {
    clipboard.writeText(String(text ?? ''));
    return true;
  });

  handle('shell:openPath', async (event, targetPath) => {
    const resolved = path.resolve(String(targetPath));
    const err = await shell.openPath(resolved);
    if (err) throw new Error(err);
    return true;
  });
  handle('shell:showItemInFolder', (event, targetPath) => {
    shell.showItemInFolder(path.resolve(String(targetPath)));
    return true;
  });
  handle('path:defaultName', (event, ext) => defaultName(ext));
  handle('path:pictures', () => picturesDir());

  handle('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
  }));
  handle('app:quit', () => {
    host.quit();
    return true;
  });

  // Auto-update. Each call returns the current snapshot straight away; the
  // authoritative state arrives on the "updates:changed" push channel.
  handle('updates:state', () => updates.state());
  handle('updates:check', () => updates.check());
  handle('updates:download', () => updates.download());
  handle('updates:install', () => updates.install());

  handle('window:openSettings', () => {
    host.openSettings();
    return true;
  });
  handle('window:openAbout', () => {
    host.openAbout();
    return true;
  });

  // Persist an annotated/edited capture straight out of the editor.
  handle('capture:save', async (event, payload) => {
    const buffer = Buffer.from(payload.data, 'base64');
    // Persist whatever tools/colours the user last worked with.
    if (payload.prefs) settings.update({ editor: payload.prefs });
    const result = await saver.write(buffer, {
      fileName: payload.fileName || undefined,
      forceDialog: !!payload.forceDialog,
    });
    return result;
  });

  handle('capture:copy', async (event, payload) => {
    const buffer = Buffer.from(payload.data, 'base64');
    const ok = await saver.copyToClipboard(buffer);
    return { ...(ok ? { copied: true } : {}), bytes: buffer.length };
  });

  // The renderer has no filesystem access, so reading a library image back in
  // for annotation goes through here.
  handle('capture:readImage', async (event, filePath) => {
    const resolved = path.resolve(String(filePath));
    const data = await fs.readFile(resolved);
    const image = nativeImage.createFromBuffer(data);
    if (image.isEmpty()) throw new Error('That file is not an image Snapkey can read.');
    const { width, height } = image.getSize();
    return { data: image.toPNG().toString('base64'), width, height };
  });
}

/** Read a PNG off disk for the "open an image to annotate" flow. */
async function readImage(filePath) {
  const buffer = await fs.readFile(filePath);
  return buffer.toString('base64');
}

module.exports = { register, configure, readImage };
