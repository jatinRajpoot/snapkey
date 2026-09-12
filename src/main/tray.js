'use strict';

const { Tray, Menu, nativeImage, app } = require('electron');
const path = require('node:path');

let tray = null;

function iconPath() {
  return path.join(__dirname, '..', '..', 'assets', 'tray.png');
}

function humanize(accelerator) {
  if (!accelerator) return 'Not set';
  return accelerator
    .replace(/CommandOrControl|CmdOrCtrl|Command|Cmd/g, process.platform === 'darwin' ? '⌘' : 'Ctrl')
    .replace(/Control|Ctrl/g, 'Ctrl')
    .replace(/Shift/g, 'Shift')
    .replace(/Alt/g, 'Alt')
    .replace(/Super|Meta/g, 'Win')
    .replace(/\+/g, ' + ')
    .replace(/\b([A-Z])\b/g, '$1');
}

function create({ onCapture, onOpenSettings, onOpenAbout, onCheckUpdates, bindings, onQuit }) {
  let image = nativeImage.createFromPath(iconPath());
  if (image.isEmpty()) image = nativeImage.createEmpty();
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('Snapkey — press a shortcut to capture');
  refresh({ onCapture, onOpenSettings, onOpenAbout, onCheckUpdates, bindings, onQuit });

  // Double-clicking the tray icon is the fastest route into a region capture.
  tray.on('double-click', () => onCapture('region'));
  return tray;
}

function refresh({ onCapture, onOpenSettings, onOpenAbout, onCheckUpdates, bindings, onQuit }) {
  if (!tray) return;
  const accel = bindings();
  const label = (action, text) => {
    const key = accel[action];
    return key ? `${text}\t${humanize(key)}` : `${text}  (not bound)`;
  };

  const menu = Menu.buildFromTemplate([
    { label: label('region', 'Capture area'), click: () => onCapture('region') },
    { label: label('screen', 'Capture screen'), click: () => onCapture('screen') },
    { label: label('allScreens', 'Capture all screens'), click: () => onCapture('allScreens') },
    { type: 'separator' },
    { label: label('directCopy', 'Quick copy (no editor)'), click: () => onCapture('directCopy') },
    { type: 'separator' },
    { label: 'Annotate an image…', click: () => onCapture('openImage') },
    { label: 'Show library…', click: () => onCapture('library') },
    { type: 'separator' },
    { label: 'Settings…', click: () => onOpenSettings() },
    { label: 'Check for updates…', click: () => onCheckUpdates() },
    { label: 'About Snapkey', click: () => onOpenAbout() },
    { type: 'separator' },
    { label: 'Quit Snapkey', click: () => onQuit() },
  ]);

  tray.setContextMenu(menu);
  tray.setToolTip(`Snapkey — ${accel.region ? humanize(accel.region) : 'no shortcut'} to capture`);
}

function destroy() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
}

module.exports = { create, refresh, destroy, humanize };
