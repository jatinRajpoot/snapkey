'use strict';

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const DEFAULTS = {
  shortcuts: {
    region: 'CommandOrControl+Shift+S',
    screen: 'CommandOrControl+Shift+F',
    allScreens: 'CommandOrControl+Shift+A',
    directCopy: 'CommandOrControl+Shift+D',
  },
  // Empty string means "ask where to save every time".
  saveDirectory: '',
  // Keep the tray icon visible after the last window closes.
  launchAtLogin: false,
  magnifier: true,
  editor: {
    tool: 'pen',
    color: '#ff453a',
    size: 5,
    fontSize: 28,
    filled: false,
  },
};

let cache = null;
let file = null;

function settingsPath() {
  if (!file) file = path.join(app.getPath('userData'), 'settings.json');
  return file;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Deep-merge `patch` onto `base`, ignoring unknown keys and type mismatches. */
function mergeDefaults(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue;
    if (isPlainObject(out[key]) && isPlainObject(value)) out[key] = mergeDefaults(out[key], value);
    else if (typeof value === typeof out[key]) out[key] = value;
  }
  return out;
}

function load() {
  if (cache) return cache;
  let onDisk = {};
  try {
    onDisk = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    onDisk = {};
  }
  cache = mergeDefaults(DEFAULTS, onDisk);
  return cache;
}

function get() {
  return load();
}

function update(patch) {
  cache = mergeDefaults(load(), patch);
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error('[snapkey] could not persist settings:', err.message);
  }
  return cache;
}

module.exports = { DEFAULTS, get, update, settingsPath };
