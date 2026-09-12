import { TOOLS, TOOL_ORDER } from '../shared/drawing.js';
import { icon, iconHTML } from '../shared/icons.js';

const api = window.snapkey;
const el = {
  content: document.getElementById('content'),
  toasts: document.getElementById('toasts'),
  libCount: document.getElementById('libCount'),
  shortcutHealth: document.getElementById('shortcutHealth'),
};

let settings = null;
/** Latest shortcut registration outcome, straight from the main process. */
let health = { failed: {}, duplicates: [] };
let libraryCache = [];
/** Mirrored updater state. Lives here so it survives route changes. */
let updateState = null;

const SHORTCUT_ROWS = [
  { action: 'region', title: 'Capture area', desc: 'Drag out a rectangle, then annotate or copy.' },
  { action: 'screen', title: 'Capture screen', desc: 'The display under the pointer, straight to the editor.' },
  { action: 'allScreens', title: 'Capture all screens', desc: 'Every display stitched into one image.' },
  { action: 'directCopy', title: 'Quick copy', desc: 'Straight to the clipboard, no editor, no annotation step.' },
];

// ---------------------------------------------------------------------------
// Accelerator formatting

const MOD_LABEL = navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl';

function acceleratorToKeys(accelerator) {
  if (!accelerator) return [];
  return accelerator
    .split('+')
    .map((part) => {
      switch (part) {
        case 'CommandOrControl':
        case 'CmdOrCtrl':
        case 'Control':
        case 'Ctrl':
          return MOD_LABEL;
        case 'Command':
        case 'Cmd':
          return '⌘';
        case 'Super':
        case 'Meta':
          return 'Win';
        case 'Shift':
          return '⇧';
        case 'Alt':
          return navigator.platform.toLowerCase().includes('mac') ? '⌥' : 'Alt';
        case 'Space':
          return 'Space';
        case 'Return':
        case 'Enter':
          return '↵';
        default:
          return part.length === 1 ? part.toUpperCase() : part;
      }
    });
}

function keysHTML(accelerator) {
  const keys = acceleratorToKeys(accelerator);
  if (!keys.length) return '<span class="kbd">—</span>';
  return keys.map((k) => `<span class="kbd">${escapeHTML(k)}</span>`).join('');
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Turn a KeyboardEvent into an Electron accelerator, or null if unusable. */
function eventToAccelerator(event) {
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('CommandOrControl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const key = event.key;
  const ignored = ['Control', 'Shift', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock', 'Dead', 'Unidentified'];
  if (ignored.includes(key)) return null;

  let name = null;
  if (/^[a-zA-Z]$/.test(key)) name = key.toUpperCase();
  else if (/^[0-9]$/.test(key)) name = key;
  else if (/^F[1-9]|^F1[0-9]|^F2[0-4]$/.test(key)) name = key;
  else if (key === ' ') name = 'Space';
  else if (key === 'Enter') name = 'Return';
  else if (key === 'Escape') name = 'Escape';
  else if (key === 'Backspace') name = 'Backspace';
  else if (key === 'Delete') name = 'Delete';
  else if (key === 'Tab') name = 'Tab';
  else if (key === 'Home' || key === 'End' || key === 'PageUp' || key === 'PageDown') name = key;
  else if (key.startsWith('Arrow')) name = key.replace('Arrow', '');
  else if (key === '`' || key === '-' || key === '=' || key === '[' || key === ']' || key === '\\' || key === ';' || key === "'" || key === ',' || key === '.' || key === '/') name = key;
  else return null;

  // A bare letter or number would swallow normal typing system-wide.
  if (!parts.length && name.length === 1) return null;
  if (!parts.length && !name.startsWith('F')) return null;

  parts.push(name);
  return parts.join('+');
}

// ---------------------------------------------------------------------------
// Shared fragments

function pageHead(title, subtitle, actions = '') {
  return `
    <header class="page-head">
      <div>
        <h1>${escapeHTML(title)}</h1>
        <p>${subtitle}</p>
      </div>
      <div class="page-actions">${actions}</div>
    </header>`;
}

function shortcutTile(action, title, sub, iconName) {
  const accel = settings?.shortcuts?.[action] || '';
  return `
    <button class="tile" data-capture="${action}" type="button">
      <span class="tile-icon">${iconHTML(iconName, 20)}</span>
      <span class="tile-title">${escapeHTML(title)}</span>
      <span class="tile-sub">${escapeHTML(sub)}</span>
      <span class="tile-key">${keysHTML(accel)}</span>
    </button>`;
}

// ---------------------------------------------------------------------------
// Routes

const routes = {};

routes.capture = () => {
  const failed = Object.entries(health.failed || {});
  const warning = failed.length
    ? `<div class="card" style="border-color: rgba(255,214,10,0.35)">
         <h2>Some shortcuts could not be registered</h2>
         <p>${failed
           .map(([action, info]) => {
             const row = SHORTCUT_ROWS.find((r) => r.action === action);
             const reason =
               info.reason === 'taken'
                 ? 'already used by another application'
                 : info.reason === 'duplicate'
                   ? 'assigned to two actions'
                   : 'empty';
             return `${escapeHTML(row?.title || action)} — <strong>${escapeHTML(info.accelerator)}</strong> is ${reason}.`;
           })
           .join('<br>')}</p>
         <button class="btn" data-route="shortcuts" type="button">Change shortcuts</button>
       </div>`
    : '';

  el.content.innerHTML = `
    ${pageHead(
      'Capture',
      'Everything here is reachable from the keyboard, from anywhere on the desktop.',
      `<button class="btn primary" data-capture="region" type="button">${iconHTML('plus', 16)} New capture</button>
       <button class="btn" data-action="openImage" type="button">${iconHTML('image', 16)} Annotate a file</button>`,
    )}

    <div class="tile-grid">
      ${shortcutTile('region', 'Capture area', 'Drag out exactly what you need, then annotate or copy.', 'crop')}
      ${shortcutTile('screen', 'Capture screen', 'The display under the pointer, opened in the editor.', 'window')}
      ${shortcutTile('allScreens', 'Capture all screens', 'Every display stitched into a single image.', 'screens')}
      ${shortcutTile('directCopy', 'Quick copy', 'Straight to the clipboard. No editor, no fuss.', 'copy')}
    </div>

    ${warning}

    <div class="card">
      <h2>The capture flow</h2>
      <p>Once a region or screen is frozen, these keys finish the job.</p>
      <div class="shortcut-cheatsheet">
        ${[
          ['Move the selection', ['arrows']],
          ['Annotate the selection', ['Space']],
          ['Copy to clipboard', ['↵']],
          ['Open in the editor', ['E']],
          ['Select the whole screen', ['F']],
          ['Undo the last change', ['Ctrl', 'Z']],
          ['Cancel the capture', ['Esc']],
        ]
          .map(
            ([label, keys]) =>
              `<div class="help-row" style="display:flex;justify-content:space-between;gap:12px;padding:5px 0;font-size:13px;color:var(--text-secondary)">
                 <span>${escapeHTML(label)}</span>
                 <span style="display:flex;gap:4px">${keys.map((k) => `<span class="kbd">${escapeHTML(k)}</span>`).join('')}</span>
               </div>`,
          )
          .join('')}
      </div>
    </div>`;
};

routes.library = () => {
  el.content.innerHTML = `
    ${pageHead(
      'Library',
      'Every capture from this session, newest first.',
      `<button class="btn" data-action="refreshLibrary" type="button">Refresh</button>
       <button class="btn danger" data-action="clearLibrary" type="button">${iconHTML('trash', 16)} Clear</button>`,
    )}
    <div id="libraryBody"><div class="empty">Loading…</div></div>`;

  renderLibrary();
};

async function renderLibrary() {
  const body = document.getElementById('libraryBody');
  if (!body) return;

  try {
    libraryCache = await api.recents.list();
  } catch (err) {
    body.innerHTML = `<div class="empty">${escapeHTML(err.message)}</div>`;
    return;
  }

  el.libCount.textContent = libraryCache.length ? String(libraryCache.length) : '';

  if (!libraryCache.length) {
    body.innerHTML = `
      <div class="empty">
        ${iconHTML('image', 30)}
        <div><strong>No captures yet</strong></div>
        <div style="font-size:12.5px">Press your capture shortcut to make the first one.</div>
        <button class="btn primary" data-capture="region" type="button">Capture now</button>
      </div>`;
    return;
  }

  body.innerHTML = `<div class="library-grid">${libraryCache
    .map(
      (item) => `
      <article class="shot" data-id="${escapeHTML(item.id)}">
        ${item.thumbnail ? `<img class="shot-thumb" src="${item.thumbnail}" alt="" />` : '<div class="shot-thumb"></div>'}
        <div class="shot-actions">
          <button class="btn icon" data-shot="folder" data-path="${escapeHTML(item.filePath)}" title="Show in folder">${iconHTML('folder', 15)}</button>
          <button class="btn icon" data-shot="annotate" data-path="${escapeHTML(item.filePath)}" title="Annotate">${iconHTML('pen', 15)}</button>
          <button class="btn icon danger" data-shot="delete" data-id="${escapeHTML(item.id)}" title="Remove from library">${iconHTML('trash', 15)}</button>
        </div>
        <div class="shot-meta">
          <div class="shot-name">${escapeHTML(item.filePath.split(/[\\/]/).pop() || 'Capture')}</div>
          <div class="shot-sub">${item.width} × ${item.height} · ${formatWhen(item.createdAt)}</div>
        </div>
      </article>`,
    )
    .join('')}</div>`;
}

function formatWhen(iso) {
  if (!iso) return '';
  const then = new Date(iso);
  const seconds = Math.round((Date.now() - then.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return then.toLocaleDateString();
}

routes.shortcuts = () => {
  el.content.innerHTML = `
    ${pageHead(
      'Shortcuts',
      'Click a shortcut, then press the new key combination. Escape cancels.',
      `<button class="btn" data-action="resetShortcuts" type="button">Reset to defaults</button>`,
    )}
    <div class="card">
      ${SHORTCUT_ROWS.map(
        (row) => `
        <div class="setting-row">
          <div class="setting-text">
            <div class="setting-title">${escapeHTML(row.title)}</div>
            <div class="setting-desc">${escapeHTML(row.desc)}</div>
          </div>
          <div class="setting-control">
            <button class="recorder" data-record="${row.action}" type="button" data-accel="${escapeHTML(
              settings.shortcuts[row.action] || '',
            )}">${keysHTML(settings.shortcuts[row.action])}</button>
            <button class="btn ghost icon" data-clear="${row.action}" type="button" title="Clear">${iconHTML('close', 15)}</button>
          </div>
        </div>`,
      ).join('')}
    </div>`;
};

routes.editor = () => {
  el.content.innerHTML = `
    ${pageHead('Editor', 'Default tool and size for new annotations. Each capture remembers its own settings too.')}
    <div class="card">
      <h2>Annotation defaults</h2>
      <p>Applied the next time a capture opens in the editor.</p>
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">Default tool</div>
          <div class="setting-desc">${TOOL_ORDER.map((id) => TOOLS[id].label).join(' · ')}</div>
        </div>
        <div class="setting-control">
          <select class="select" id="defaultTool">
            ${TOOL_ORDER.map(
              (id) =>
                `<option value="${id}" ${settings.editor.tool === id ? 'selected' : ''}>${TOOLS[id].label}</option>`,
            ).join('')}
          </select>
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">Default colour</div>
          <div class="setting-desc">Used for new shapes.</div>
        </div>
        <div class="setting-control">
          <input class="color-input" type="color" id="defaultColor" value="${escapeHTML(settings.editor.color)}" />
        </div>
      </div>
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">Default size</div>
          <div class="setting-desc">Stroke width for shapes, font size for text.</div>
        </div>
        <div class="setting-control">
          <input class="size-slider" type="range" id="defaultSize" min="1" max="40" value="${Number(settings.editor.size) || 5}" />
          <span class="size-value" id="defaultSizeValue">${Number(settings.editor.size) || 5}</span>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Capture overlay</h2>
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">Pixel magnifier</div>
          <div class="setting-desc">Follows the pointer while you aim a selection. Toggle with I.</div>
        </div>
        <button class="switch" id="magnifierToggle" role="switch" aria-checked="${settings.magnifier ? 'true' : 'false'}" type="button"></button>
      </div>
    </div>`;
};

routes.saving = () => {
  const dir = settings.saveDirectory || '';
  el.content.innerHTML = `
    ${pageHead('Saving', 'Where your captures land when you press Ctrl + S.')}
    <div class="card">
      <h2>Destination folder</h2>
      <p>${dir ? 'Captures are saved here with a timestamped filename.' : 'You will be asked where to save each time.'}</p>
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title" style="font-family: var(--font-mono); font-size: 12.5px">${escapeHTML(
            dir || 'Ask me every time',
          )}</div>
          <div class="setting-desc">${dir ? '' : 'No default folder is set.'}</div>
        </div>
        <div class="setting-control">
          <button class="btn" data-action="chooseFolder" type="button">Choose…</button>
          ${dir ? '<button class="btn ghost danger" data-action="clearFolder" type="button">Clear</button>' : ''}
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Startup</h2>
      <div class="setting-row">
        <div class="setting-text">
          <div class="setting-title">Keep Snapkey in the tray</div>
          <div class="setting-desc">Snapkey always stays resident so its shortcuts keep working.</div>
        </div>
        <button class="switch" role="switch" aria-checked="true" type="button" disabled></button>
      </div>
    </div>`;
};

// ---------------------------------------------------------------------------
// Updates

/** One branch per updater status. Keeps the markup with the state machine. */
function updateCardHTML(state) {
  if (!state) {
    return `<h2>Updates</h2><p>Checking…</p>`;
  }

  const version = state.version ? escapeHTML(state.version) : '';

  switch (state.status) {
    case 'unsupported':
      return `
        <h2>Updates</h2>
        <p>${escapeHTML(state.message || 'Updates are not available in this build.')}</p>`;

    case 'checking':
      return `
        <h2>Updates</h2>
        <p>Checking for updates…</p>
        <button class="btn" type="button" disabled>${iconHTML('refresh', 16)} Checking…</button>`;

    case 'available':
      return `
        <h2>Updates</h2>
        <p>Version <strong>${version}</strong> is available. Snapkey will not download it until you ask.</p>
        <button class="btn primary" data-action="downloadUpdate" type="button">${iconHTML('download', 16)} Download</button>`;

    case 'downloading':
      return `
        <h2>Updates</h2>
        <p>Downloading version <strong>${version}</strong>…</p>
        <div class="progress" role="progressbar" aria-valuenow="${state.percent}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-bar" style="width: ${state.percent}%"></div>
        </div>
        <p class="muted">${state.percent}%</p>`;

    case 'downloaded':
      return `
        <h2>Updates</h2>
        <p>Version <strong>${version}</strong> is ready. Snapkey will restart to finish installing.</p>
        <button class="btn primary" data-action="installUpdate" type="button">${iconHTML('download', 16)} Restart &amp; install</button>`;

    case 'not-available':
      return `
        <h2>Updates</h2>
        <p>You're up to date — Snapkey ${escapeHTML(state.currentVersion)} is the latest version.</p>
        <button class="btn" data-action="checkUpdates" type="button">${iconHTML('refresh', 16)} Check again</button>`;

    case 'error':
      return `
        <h2>Updates</h2>
        <p class="error-text">${escapeHTML(state.message || 'The update could not be completed.')}</p>
        <button class="btn" data-action="checkUpdates" type="button">${iconHTML('refresh', 16)} Try again</button>`;

    case 'idle':
    default:
      return `
        <h2>Updates</h2>
        <p>Snapkey only checks for updates when you ask it to.</p>
        <button class="btn" data-action="checkUpdates" type="button">${iconHTML('refresh', 16)} Check for updates</button>`;
  }
}

function renderUpdateCard() {
  const host = document.getElementById('updateCard');
  if (!host) return;
  host.innerHTML = updateCardHTML(updateState);
}

routes.about = async () => {
  let info = { name: 'Snapkey', version: '—', electron: '—', chrome: '—', node: '—', platform: '—' };
  try {
    info = await api.app.info();
  } catch {
    /* fall back to placeholders */
  }

  el.content.innerHTML = `
    <div class="about-hero">
      <div class="about-logo">${iconHTML('crop', 34)}</div>
      <h1>${escapeHTML(info.name)}</h1>
      <p>A keyboard-first screenshot tool. Capture, annotate, copy — without ever touching the mouse.</p>
      <span class="version">Version ${escapeHTML(info.version)}</span>
    </div>

    <div class="card" id="updateCard">${updateCardHTML(updateState)}</div>

    <div class="card">
      <h2>Under the hood</h2>
      <p>Versions of the runtimes this build is running on.</p>
      <dl class="kv">
        <dt>Electron</dt><dd>${escapeHTML(info.electron)}</dd>
        <dt>Chromium</dt><dd>${escapeHTML(info.chrome)}</dd>
        <dt>Node</dt><dd>${escapeHTML(info.node)}</dd>
        <dt>Platform</dt><dd>${escapeHTML(info.platform)}</dd>
      </dl>
    </div>

    <div class="card">
      <h2>Quit Snapkey</h2>
      <p>Closing this window leaves Snapkey running in the tray so your shortcuts stay live.</p>
      <button class="btn danger" data-action="quit" type="button">Quit Snapkey</button>
    </div>`;

  // A broadcast can fire before this window finished loading, so pull once.
  try {
    updateState = await api.updates.state();
    renderUpdateCard();
  } catch {
    /* the push channel is still the source of truth */
  }
};

// ---------------------------------------------------------------------------
// Routing

function currentRoute() {
  const hash = location.hash.replace(/^#\/?/, '');
  return routes[hash] ? hash : 'capture';
}

async function navigate(route = currentRoute()) {
  if (document.querySelector('.recorder.recording')) stopRecording(false);
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.setAttribute('aria-current', item.dataset.route === route ? 'page' : 'false');
  });
  await routes[route]();
}

// ---------------------------------------------------------------------------
// Shortcut recording

let recording = null;

function stopRecording(commit) {
  if (!recording) return;
  const { button, action, original } = recording;
  recording = null;
  button.classList.remove('recording');
  button.classList.remove('conflict');
  document.removeEventListener('keydown', onRecordKey, true);
  api.shortcuts.resume();

  if (!commit) {
    button.dataset.accel = original;
    button.innerHTML = keysHTML(original);
    button.classList.toggle('unset', !original);
  }
}

async function onRecordKey(event) {
  if (!recording) return;
  event.preventDefault();
  event.stopPropagation();

  if (event.key === 'Escape') {
    stopRecording(false);
    return;
  }
  if (event.key === 'Backspace' || event.key === 'Delete') {
    // Clearing is handled by the adjacent × button; ignore here so a stray
    // press does not silently unbind the action.
    return;
  }

  const accelerator = eventToAccelerator(event);
  if (!accelerator) {
    flashRecorder('Needs a modifier', 'conflict');
    return;
  }

  const { button, action, original } = recording;
  const taken = await api.shortcuts.check(accelerator);
  // check() only fails when registered elsewhere; our own bindings are released
  // while recording, so a true here means the accelerator is free.

  recording = null;
  button.classList.remove('recording');
  document.removeEventListener('keydown', onRecordKey, true);
  api.shortcuts.resume();

  if (action === null) return;

  const next = { ...settings.shortcuts, [action]: accelerator };
  const duplicates = Object.entries(next).filter(([key, value]) => key !== action && value === accelerator);
  if (duplicates.length) {
    button.classList.add('conflict');
    flashRecorder('Already assigned', 'conflict');
    button.innerHTML = keysHTML(original);
    settings.shortcuts[action] = original;
    toast('That combination is already used by another Snapkey action.', 'error');
    return;
  }

  settings.shortcuts = next;
  button.dataset.accel = accelerator;
  button.innerHTML = keysHTML(accelerator);
  button.classList.remove('unset');

  if (!taken) {
    toast(`${accelerator} is already used by another application.`, 'error');
  }
  await persistShortcuts();
}

let recorderTimer = null;
function flashRecorder(message, className) {
  const button = recording?.button;
  if (!button) return;
  button.classList.add(className);
  button.textContent = message;
  clearTimeout(recorderTimer);
  recorderTimer = setTimeout(() => {
    if (!recording) return;
    button.classList.remove(className);
    button.innerHTML = keysHTML(button.dataset.accel);
  }, 1100);
}

async function persistShortcuts() {
  try {
    const result = await api.settings.update({ shortcuts: settings.shortcuts });
    health = result.shortcuts || health;
    renderHealth();
    const failed = Object.entries(health.failed || {});
    if (failed.length) {
      const [action, info] = failed[0];
      const row = SHORTCUT_ROWS.find((r) => r.action === action);
      toast(`${row?.title || action}: ${info.accelerator} could not be registered.`, 'error');
    } else {
      toast('Shortcut saved', 'success');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderHealth() {
  const failed = Object.entries(health.failed || {});
  if (!settings) return;
  if (failed.length) {
    el.shortcutHealth.className = 'pill warn';
    el.shortcutHealth.textContent = `${failed.length} shortcut${failed.length > 1 ? 's' : ''} unavailable`;
  } else {
    el.shortcutHealth.className = 'pill ok';
    el.shortcutHealth.textContent = 'Shortcuts active';
  }
}

// ---------------------------------------------------------------------------
// Toasts

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.append(icon(kind === 'success' ? 'check' : kind === 'error' ? 'info' : 'sparkle', 16));
  const text = document.createElement('span');
  text.textContent = message;
  node.append(text);
  el.toasts.append(node);
  setTimeout(() => node.remove(), 3000);
}

// ---------------------------------------------------------------------------
// Event wiring

el.content.addEventListener('click', async (event) => {
  const routeButton = event.target.closest('[data-route]');
  if (routeButton) {
    location.hash = `#/${routeButton.dataset.route}`;
    return;
  }

  const captureButton = event.target.closest('[data-capture]');
  if (captureButton) {
    await api.capture.start(captureButton.dataset.capture);
    return;
  }

  const recordButton = event.target.closest('[data-record]');
  if (recordButton) {
    if (recording) stopRecording(false);
    const action = recordButton.dataset.record;
    recording = { button: recordButton, action, original: recordButton.dataset.accel || '' };
    recordButton.classList.add('recording');
    recordButton.textContent = 'Press keys…';
    // Release global bindings so the new combination can be typed.
    await api.shortcuts.suspend();
    document.addEventListener('keydown', onRecordKey, true);
    return;
  }

  const clearButton = event.target.closest('[data-clear]');
  if (clearButton) {
    const action = clearButton.dataset.clear;
    settings.shortcuts[action] = '';
    const button = document.querySelector(`[data-record="${action}"]`);
    if (button) {
      button.dataset.accel = '';
      button.classList.add('unset');
      button.innerHTML = keysHTML('');
    }
    await persistShortcuts();
    return;
  }

  const shotButton = event.target.closest('[data-shot]');
  if (shotButton) {
    const { shot, path, id } = shotButton.dataset;
    if (shot === 'folder') await api.shell.showItemInFolder(path);
    if (shot === 'annotate') {
      // Hand the file's bytes to the main process, which opens the editor.
      const file = await api.capture.readImage(path);
      await api.capture.editImage(file);
    }
    if (shot === 'delete') {
      await api.recents.remove(id);
      renderLibrary();
    }
    return;
  }

  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;

  switch (action) {
    case 'openImage':
      await api.capture.start('openImage');
      break;
    case 'refreshLibrary':
      renderLibrary();
      break;
    case 'clearLibrary':
      await api.recents.clear();
      renderLibrary();
      toast('Library cleared', 'success');
      break;
    case 'resetShortcuts': {
      const defaults = {
        region: 'CommandOrControl+Shift+S',
        screen: 'CommandOrControl+Shift+F',
        allScreens: 'CommandOrControl+Shift+A',
        directCopy: 'CommandOrControl+Shift+D',
      };
      settings.shortcuts = defaults;
      await persistShortcuts();
      routes.shortcuts();
      break;
    }
    case 'chooseFolder': {
      const chosen = await api.dialog.chooseSaveDirectory();
      if (chosen) {
        settings = await api.settings.update({ saveDirectory: chosen });
        routes.saving();
        toast('Folder saved', 'success');
      }
      break;
    }
    case 'clearFolder':
      settings = await api.settings.update({ saveDirectory: '' });
      routes.saving();
      break;
    case 'checkUpdates':
      try {
        updateState = await api.updates.check();
        renderUpdateCard();
      } catch (err) {
        toast(err.message, 'error');
      }
      break;
    case 'downloadUpdate':
      try {
        updateState = await api.updates.download();
        renderUpdateCard();
      } catch (err) {
        toast(err.message, 'error');
        renderUpdateCard();
      }
      break;
    case 'installUpdate':
      // The process exits here; the card does not need to re-render.
      await api.updates.install();
      break;
    case 'quit':
      await api.app.quit();
      break;
    default:
      break;
  }
});

el.content.addEventListener('change', async (event) => {
  const target = event.target;

  if (target.id === 'defaultTool') {
    settings = await api.settings.update({ editor: { ...settings.editor, tool: target.value } });
    toast('Default tool saved', 'success');
  }
  if (target.id === 'defaultColor') {
    settings = await api.settings.update({ editor: { ...settings.editor, color: target.value.toUpperCase() } });
  }
  if (target.id === 'defaultSize') {
    document.getElementById('defaultSizeValue').textContent = target.value;
    settings = await api.settings.update({ editor: { ...settings.editor, size: Number(target.value) } });
  }
});

el.content.addEventListener('input', (event) => {
  if (event.target.id === 'defaultSize') {
    document.getElementById('defaultSizeValue').textContent = event.target.value;
  }
});

el.content.addEventListener('click', async (event) => {
  const toggle = event.target.closest('#magnifierToggle');
  if (!toggle) return;
  const next = toggle.getAttribute('aria-checked') !== 'true';
  toggle.setAttribute('aria-checked', String(next));
  settings = await api.settings.update({ magnifier: next });
});

window.addEventListener('hashchange', () => navigate());

api.on('capture:recorded', () => {
  if (currentRoute() === 'library') renderLibrary();
});

api.on('shortcuts:changed', (result) => {
  health = result || health;
  renderHealth();
});

api.on('app:navigate', ({ section }) => {
  if (section && routes[section]) location.hash = `#/${section}`;
});

api.on('updates:changed', (state) => {
  updateState = state;
  renderUpdateCard();
});

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  document.querySelectorAll('[data-icon]').forEach((node) => {
    node.replaceChildren(icon(node.dataset.icon, 17));
  });

  try {
    settings = await api.settings.get();
  } catch (err) {
    el.content.innerHTML = `<div class="empty">${escapeHTML(err.message)}</div>`;
    return;
  }

  renderHealth();
  await navigate();

  api.recents
    .list()
    .then((items) => {
      el.libCount.textContent = items.length ? String(items.length) : '';
    })
    .catch(() => {});
}

boot();
