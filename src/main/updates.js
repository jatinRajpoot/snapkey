'use strict';

const { app, Notification } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/**
 * Auto-update, deliberately kept to "ask before doing anything".
 *
 * `autoDownload` and `autoInstallOnAppQuit` are both off, so Snapkey never
 * fetches an update or restarts itself unless the user clicks the matching
 * button. The state machine below is the single source of truth the renderer
 * mirrors; every event funnels through `setState` so there is exactly one
 * place that broadcasts.
 */

let updater = null;
let host = { broadcast: () => {}, onAvailable: () => {} };
let ready = false;

const state = {
  status: 'idle',
  currentVersion: app.getVersion(),
  version: null,
  percent: 0,
  message: '',
  checkedAt: null,
  canCheck: true,
  canDownload: false,
  canInstall: false,
};

/** Why updates are unavailable, or null when they should work. */
function unsupportedReason() {
  if (!app.isPackaged) return 'Updates are only available in an installed build of Snapkey.';
  // The portable build unpacks to a temp directory, so there is nothing on
  // disk for the updater to replace.
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return 'This portable copy cannot update itself. Install Snapkey to get automatic updates.';
  }
  if (!fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'))) {
    return 'This build was not published with update information.';
  }
  return null;
}

/** Recompute the derived buttons the renderer keys off. */
function flagsFor(status) {
  return {
    canCheck: ['idle', 'not-available', 'error', 'unsupported'].includes(status),
    canDownload: status === 'available',
    canInstall: status === 'downloaded',
  };
}

function setState(patch) {
  Object.assign(state, patch);
  Object.assign(state, flagsFor(state.status));
  host.broadcast('updates:changed', snapshot());
  return snapshot();
}

function snapshot() {
  return { ...state };
}

function fail(err) {
  const message = (err && err.message) || String(err) || 'The update could not be completed.';
  console.error('[snapkey] updates:', message);
  return setState({ status: 'error', message, percent: 0 });
}

function wire() {
  updater.on('checking-for-update', () => setState({ status: 'checking', message: '' }));

  updater.on('update-available', (info) => {
    setState({ status: 'available', version: info.version, percent: 0, message: '' });
    notify(info.version);
  });

  updater.on('update-not-available', () =>
    setState({ status: 'not-available', version: null, percent: 0, message: '' }),
  );

  updater.on('download-progress', (progress) =>
    setState({ status: 'downloading', percent: Math.round(progress.percent || 0) }),
  );

  updater.on('update-downloaded', (info) =>
    setState({ status: 'downloaded', version: info.version, percent: 100, message: '' }),
  );

  updater.on('error', fail);
}

/** A tray app often has no window open, so the OS notification is the only
 *  thing that can tell the user an update exists. */
function notify(version) {
  try {
    if (!Notification.isSupported()) return;
    const note = new Notification({
      title: `Snapkey ${version} is available`,
      body: 'Open About to download it.',
    });
    note.on('click', () => host.onAvailable());
    note.show();
  } catch (err) {
    console.error('[snapkey] updates: could not show notification:', err.message);
  }
}

function init(next = {}) {
  host = { ...host, ...next };
  if (ready) return snapshot();

  const reason = unsupportedReason();
  if (reason) {
    return setState({ status: 'unsupported', message: reason });
  }

  try {
    // Loaded lazily so development runs never touch the updater package.
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    updater = autoUpdater;
    wire();
    ready = true;
  } catch (err) {
    return setState({
      status: 'unsupported',
      message: `The updater could not be loaded: ${err.message}`,
    });
  }

  return snapshot();
}

async function check() {
  if (!ready) return snapshot();
  if (['checking', 'downloading', 'downloaded'].includes(state.status)) return snapshot();
  try {
    await updater.checkForUpdates();
  } catch (err) {
    fail(err);
  }
  return setState({ checkedAt: new Date().toISOString() });
}

async function download() {
  if (!ready) return snapshot();
  if (state.status !== 'available') {
    throw new Error('There is no update ready to download.');
  }
  setState({ status: 'downloading', percent: 0, message: '' });
  try {
    await updater.downloadUpdate();
  } catch (err) {
    fail(err);
  }
  return snapshot();
}

function install() {
  if (!ready) return snapshot();
  if (state.status !== 'downloaded') {
    throw new Error('There is no downloaded update to install.');
  }
  // Not silent, and relaunch afterwards — Snapkey lives in the tray, so the
  // user expects it to still be running when the installer finishes.
  updater.quitAndInstall(false, true);
  return snapshot();
}

module.exports = { init, state: snapshot, check, download, install };
