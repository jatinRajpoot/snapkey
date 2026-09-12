'use strict';

const { globalShortcut } = require('electron');
const settings = require('./settings');

// accelerator -> action, as actually registered with the OS
const active = new Map();
let suspended = false;

const ACTIONS = ['region', 'screen', 'allScreens', 'directCopy'];

/**
 * Verify an accelerator without leaving it registered. globalShortcut has no
 * "is available?" query, so we register and immediately release.
 */
function isAvailable(accelerator) {
  if (active.has(accelerator)) return true;
  try {
    if (!globalShortcut.register(accelerator, () => {})) return false;
    globalShortcut.unregister(accelerator);
    return true;
  } catch {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      /* ignore */
    }
    return false;
  }
}

function unregisterAll() {
  for (const accelerator of active.keys()) {
    try {
      globalShortcut.unregister(accelerator);
    } catch {
      /* ignore */
    }
  }
  active.clear();
}

/**
 * Re-read settings and rebind. Returns a map of action -> accelerator for the
 * ones that could not be claimed, plus a map of duplicate collisions.
 */
function apply() {
  if (suspended) return { failed: {}, duplicates: [] };
  unregisterAll();

  const wanted = settings.get().shortcuts;
  const failed = {};
  const duplicates = [];
  const seen = new Map();

  for (const action of ACTIONS) {
    const accelerator = (wanted[action] || '').trim();
    if (!accelerator) {
      failed[action] = { accelerator, reason: 'empty' };
      continue;
    }
    if (seen.has(accelerator)) {
      duplicates.push({ accelerator, actions: [seen.get(accelerator), action] });
      failed[action] = { accelerator, reason: 'duplicate' };
      continue;
    }

    let ok = false;
    try {
      ok = globalShortcut.register(accelerator, () => {
        // Late-bound so main can wire the handler after this module loads.
        module.exports.onTrigger(action);
      });
    } catch {
      ok = false;
    }

    if (ok) {
      seen.set(accelerator, action);
      active.set(accelerator, action);
    } else {
      failed[action] = { accelerator, reason: 'taken' };
    }
  }

  return { failed, duplicates };
}

/** Release every binding so the settings recorder can capture raw key presses. */
function suspend() {
  suspended = true;
  unregisterAll();
}

function resume() {
  suspended = false;
  return apply();
}

/** accelerator -> action for everything currently held. */
function bindings() {
  return Object.fromEntries(active);
}

module.exports = {
  ACTIONS,
  apply,
  suspend,
  resume,
  isAvailable,
  bindings,
  unregisterAll,
  onTrigger: () => {},
};
