'use strict';

const { app, dialog, shell, clipboard, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const settings = require('./settings');

let lastDirectory = '';

/** `Snapkey 2026-09-12 at 14.03.07.png` */
function defaultName(ext = 'png') {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  return `Snapkey ${date} at ${time}.${ext}`;
}

function picturesDir() {
  try {
    return app.getPath('pictures');
  } catch {
    return app.getPath('home');
  }
}

/** Pick a free filename so rapid-fire captures never overwrite each other. */
async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.join(dir, i === 1 ? name : `${stem} (${i})${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

async function copyToClipboard(pngBuffer) {
  const image = nativeImage.createFromBuffer(pngBuffer);
  if (image.isEmpty()) throw new Error('Captured image was empty.');
  clipboard.writeImage(image);
  return true;
}

/**
 * Write the PNG, asking the user where if no default directory is configured.
 * Returns { saved, filePath, canceled }.
 */
async function write(pngBuffer, { fileName, forceDialog = false } = {}) {
  const configured = (settings.get().saveDirectory || '').trim();
  const name = fileName || defaultName();

  let targetDir = forceDialog ? '' : configured || lastDirectory;
  if (!targetDir) {
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: 'Save screenshot',
      defaultPath: path.join(picturesDir(), name),
      filters: [{ name: 'PNG image', extensions: ['png'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (canceled || !filePath) return { saved: false, canceled: true };
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, pngBuffer);
    return { saved: true, filePath, canceled: false };
  }

  try {
    await fs.mkdir(targetDir, { recursive: true });
  } catch {
    // Directory vanished or is unwritable; fall back to asking.
    lastDirectory = '';
    return write(pngBuffer, { fileName: name });
  }

  const filePath = await uniquePath(targetDir, name);
  lastDirectory = targetDir;
  await fs.writeFile(filePath, pngBuffer);
  return { saved: true, filePath, canceled: false };
}

function reveal(filePath) {
  if (filePath) shell.showItemInFolder(filePath);
}

async function chooseDirectory(parentWindow) {
  const result = await dialog.showOpenDialog(parentWindow, {
    title: 'Choose a folder for saved screenshots',
    defaultPath: settings.get().saveDirectory || picturesDir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
}

module.exports = { copyToClipboard, write, reveal, chooseDirectory, defaultName, picturesDir };
