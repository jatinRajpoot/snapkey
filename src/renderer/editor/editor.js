import {
  TOOLS,
  TOOL_ORDER,
  makeShape,
  boundsOf,
  hitTest,
  translateShape,
  drawAnnotations,
  drawShape,
  drawMarchingAnts,
  textMetrics,
} from '../shared/drawing.js';
import { icon } from '../shared/icons.js';
import { createToolbar } from '../shared/toolbar.js';

const payload = window.snapkey.payload || {};
const api = window.snapkey;

const el = {
  wrap: document.getElementById('canvasWrap'),
  canvas: document.getElementById('canvas'),
  toolbarHost: document.getElementById('toolbarHost'),
  dims: document.getElementById('dims'),
  sourcePill: document.getElementById('sourcePill'),
  inspectorHint: document.getElementById('inspectorHint'),
  statCount: document.getElementById('statCount'),
  statCursor: document.getElementById('statCursor'),
  statZoom: document.getElementById('statZoom'),
  statusLeft: document.getElementById('statusLeft'),
  toasts: document.getElementById('toasts'),
  help: document.getElementById('helpOverlay'),
  helpGrid: document.getElementById('helpGrid'),
  saveSub: document.getElementById('saveSub'),
};

const ctx = el.canvas.getContext('2d');

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// State

const state = {
  image: null,
  width: 0,
  height: 0,
  annotations: [],
  draft: null,
  redoStack: [],
  selectedId: null,
  editingTextId: null,
  textFontSize: 28,
  tool: payload.toolbar?.tool || 'pen',
  color: payload.toolbar?.color || '#ff453a',
  size: payload.toolbar?.size ?? 5,
  filled: !!payload.toolbar?.filled,
  zoom: 1,
  pan: { x: 0, y: 0 },
  pointer: { x: 0, y: 0 },
  gesture: null,
  spaceDown: false,
  /** Set once the image has been saved or copied, so closing is never a surprise. */
  clean: false,
};

const TOOL_KEYS = new Map(TOOL_ORDER.map((id) => [TOOLS[id].key, id]));
const RESIZE_HANDLES = new Set(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);

// ---------------------------------------------------------------------------
// Image loading

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be decoded.'));
    img.src = src;
  });
}

/**
 * Adopt the shapes handed over from the overlay. They are already in image
 * space at the display's device pixel ratio, so no conversion is needed.
 */
function adoptPendingAnnotations() {
  const pending = payload.pending || [];
  for (const shape of pending) {
    if (!shape || !shape.tool) continue;
    state.annotations.push({ ...shape });
  }
  if (payload.toolbar) {
    state.tool = payload.toolbar.tool || state.tool;
    state.color = payload.toolbar.color || state.color;
    state.size = payload.toolbar.size ?? state.size;
    state.filled = !!payload.toolbar.filled;
  }
}

// ---------------------------------------------------------------------------
// Rendering

function fitZoom() {
  if (!state.width || !state.height) return 1;
  const box = el.wrap.getBoundingClientRect();
  const availableW = box.width - 44;
  const availableH = box.height - 44;
  return Math.min(1, availableW / state.width, availableH / state.height);
}

function applyZoom() {
  const displayW = Math.max(1, Math.round(state.width * state.zoom));
  const displayH = Math.max(1, Math.round(state.height * state.zoom));
  el.canvas.style.width = `${displayW}px`;
  el.canvas.style.height = `${displayH}px`;
  el.statZoom.textContent = `${Math.round(state.zoom * 100)}%`;
}

function render() {
  if (!state.image) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);

  // Draw the bitmap 1:1 in image space; CSS scales the element.
  ctx.drawImage(state.image, 0, 0, state.width, state.height);

  ctx.restore();
  ctx.save();

  drawAnnotations(ctx, state.annotations, { base: el.canvas, scale: 1 });
  if (state.draft) drawShape(ctx, state.draft, { base: el.canvas, scale: 1 });

  if (state.editingTextId) {
    const shape = state.annotations.find((s) => s.id === state.editingTextId);
    if (shape) {
      const { lines, lineHeight, width } = textMetrics(shape);
      ctx.fillStyle = 'rgba(8, 10, 16, 0.72)';
      ctx.fillRect(
        shape.at[0] - 6,
        shape.at[1] - shape.size * 1.15,
        Math.max(40, width + 16),
        lineHeight * lines.length + 12,
      );
    }
  }

  if (state.selectedId) {
    const shape = state.annotations.find((s) => s.id === state.selectedId);
    if (shape) {
      const b = boundsOf(shape);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1.5 / state.zoom;
      ctx.strokeStyle = 'rgba(111, 123, 255, 0.95)';
      ctx.strokeRect(b.x - 5, b.y - 5, b.width + 10, b.height + 10);
      ctx.restore();
    }
  }

  ctx.restore();
  updateStats();
}

let antsOffset = 0;
function tick() {
  if (state.selectedId) {
    antsOffset = (antsOffset + 0.4) % 9;
    render();
  }
  requestAnimationFrame(tick);
}

function updateStats() {
  el.statCount.textContent = String(state.annotations.length);
  el.statCursor.textContent = state.image
    ? `${Math.round(clamp(state.pointer.x, 0, state.width))}, ${Math.round(clamp(state.pointer.y, 0, state.height))}`
    : '—';
}

// ---------------------------------------------------------------------------
// Coordinate conversion

/** Screen point → image pixel. */
function toImage(event) {
  const box = el.canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - box.left) / box.width) * state.width,
    y: ((event.clientY - box.top) / box.height) * state.height,
  };
}

// ---------------------------------------------------------------------------
// Toolbar

function buildToolbar() {
  const toolbar = createToolbar(
    { tool: state.tool, color: state.color, size: state.size, filled: state.filled },
    (next) => {
      if (next.command === 'undo') return undo();
      if (next.command === 'redo') return redo();

      const entering = next.tool !== state.tool;
      state.color = next.color;
      state.filled = next.filled;
      if (entering) setTool(next.tool);
      else setSize(next.size);
      persistPrefs();
    },
  );
  el.toolbarHost.append(toolbar.el);
  state.toolbar = toolbar;
  syncToolbar();
  return toolbar;
}

function syncToolbar() {
  if (!state.toolbar) return;
  state.toolbar.set({
    tool: state.tool,
    color: state.color,
    size: state.size,
    filled: state.filled,
    canUndo: state.annotations.length > 0,
    canRedo: state.redoStack.length > 0,
  });

  const hint = state.tool === 'select' ? 'Click a shape to select it. Drag to move, Delete to remove.' : TOOLS[state.tool]?.hint || '';
  el.inspectorHint.textContent = hint;
  el.wrap.className = `canvas-wrap tool-${state.tool === 'select' ? 'select' : state.tool === 'text' ? 'text' : 'draw'}`;
}

let prefsTimer = null;
function persistPrefs() {
  // Debounced: the size slider fires on every pixel of drag.
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    api.rememberPrefs?.({
      tool: state.tool,
      color: state.color,
      size: state.size,
      fontSize: state.textFontSize,
      filled: state.filled,
    });
  }, 150);
}

function setTool(tool) {
  if (state.editingTextId) commitText();
  if (tool !== 'select') state.selectedId = null;
  state.tool = tool;
  if (tool === 'text') state.size = clamp(state.textFontSize > 40 ? state.textFontSize : 28, 12, 96);
  else if (state.size > 40) state.size = payload.toolbar?.size ?? 5;
  syncToolbar();
  render();
}

function setSize(size) {
  state.size = clamp(Math.round(size), 1, state.tool === 'text' ? 96 : 40);
  if (state.tool === 'text') state.textFontSize = state.size;
  syncToolbar();
  render();
}

function cycleTool(direction) {
  const index = TOOL_ORDER.indexOf(state.tool);
  setTool(TOOL_ORDER[(index + direction + TOOL_ORDER.length) % TOOL_ORDER.length]);
}

// ---------------------------------------------------------------------------
// History

function undo() {
  if (state.editingTextId) commitText();
  const shape = state.annotations.pop();
  if (!shape) {
    setStatus('Nothing to undo');
    return;
  }
  state.redoStack.push(shape);
  if (state.selectedId === shape.id) state.selectedId = null;
  syncToolbar();
  render();
}

function redo() {
  const shape = state.redoStack.pop();
  if (!shape) {
    setStatus('Nothing to redo');
    return;
  }
  state.annotations.push(shape);
  syncToolbar();
  render();
}

function deleteSelected() {
  if (!state.selectedId) return;
  state.annotations = state.annotations.filter((s) => s.id !== state.selectedId);
  state.selectedId = null;
  syncToolbar();
  render();
}

function clearAll() {
  if (!state.annotations.length) return;
  state.redoStack = [];
  state.annotations = [];
  state.selectedId = null;
  state.editingTextId = null;
  el.textEditor?.remove();
  syncToolbar();
  render();
  setStatus('Cleared all annotations');
}

// ---------------------------------------------------------------------------
// Text editing overlay

let textarea = null;

function openTextEditor(shape) {
  if (!textarea) {
    textarea = document.createElement('textarea');
    textarea.spellcheck = false;
    textarea.rows = 1;
    Object.assign(textarea.style, {
      position: 'absolute',
      zIndex: '40',
      padding: '4px 8px',
      borderRadius: '7px',
      background: 'rgba(8, 10, 16, 0.78)',
      border: '1px dashed rgba(255,255,255,0.6)',
      color: '#fff',
      fontWeight: '600',
      lineHeight: '1.3',
      resize: 'none',
      overflow: 'hidden',
      whiteSpace: 'pre',
      caretColor: '#8b95ff',
      pointerEvents: 'auto',
    });
    textarea.addEventListener('input', autoGrow);
    textarea.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        commitText();
      }
      event.stopPropagation();
    });
    el.wrap.append(textarea);
  }

  const box = el.canvas.getBoundingClientRect();
  const wrapBox = el.wrap.getBoundingClientRect();
  textarea.value = shape.text || '';
  textarea.placeholder = 'Type…';
  textarea.style.font = `600 ${shape.size * state.zoom}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  textarea.style.left = `${box.left - wrapBox.left + shape.at[0] * state.zoom - 8}px`;
  textarea.style.top = `${box.top - wrapBox.top + shape.at[1] * state.zoom - shape.size * state.zoom * 1.05}px`;
  textarea.hidden = false;
  textarea.focus();
  textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  autoGrow();
  state.editingTextId = shape.id;
  render();
}

function autoGrow() {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${textarea.scrollHeight}px`;
  textarea.style.width = 'auto';
  textarea.style.width = `${Math.max(160, textarea.scrollWidth + 30)}px`;
}

function commitText() {
  if (!state.editingTextId) return;
  const shape = state.annotations.find((s) => s.id === state.editingTextId);
  const value = textarea ? textarea.value : '';
  state.editingTextId = null;
  if (textarea) textarea.hidden = true;
  if (!shape) return;

  if (!value.trim()) state.annotations = state.annotations.filter((s) => s.id !== shape.id);
  else shape.text = value.replace(/\s+$/, '');
  syncToolbar();
  render();
}

// ---------------------------------------------------------------------------
// Pointer interaction

el.canvas.addEventListener('pointerdown', (event) => {
  if (event.button === 1 || (event.button === 0 && state.spaceDown)) {
    state.gesture = { type: 'pan', start: { x: event.clientX, y: event.clientY }, origin: { ...state.pan } };
    el.canvas.setPointerCapture(event.pointerId);
    el.wrap.classList.add('panning');
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;

  el.canvas.setPointerCapture(event.pointerId);
  const point = toImage(event);

  if (state.editingTextId) {
    commitText();
    return;
  }

  if (state.tool === 'select') {
    const shape = [...state.annotations].reverse().find((s) => hitTest(s, point, 7 / state.zoom));
    state.selectedId = shape ? shape.id : null;
    if (shape) {
      state.gesture = { type: 'dragShape', id: shape.id, start: point, origin: { ...shape } };
    }
    syncToolbar();
    render();
    return;
  }

  if (state.tool === 'text') {
    const shape = makeShape({
      tool: 'text',
      color: state.color,
      size: state.textFontSize,
      from: point,
      text: '',
    });
    state.annotations.push(shape);
    openTextEditor(shape);
    return;
  }

  if (state.tool === 'step') {
    const used = state.annotations.filter((s) => s.tool === 'step').map((s) => s.n || 0);
    const shape = makeShape({ tool: 'step', color: state.color, size: state.size, from: point, to: point });
    shape.n = used.length ? Math.max(...used) + 1 : 1;
    state.annotations.push(shape);
    state.redoStack = [];
    syncToolbar();
    render();
    return;
  }

  const isShape = state.tool === 'rect' || state.tool === 'ellipse';
  const shape = makeShape({
    tool: state.tool,
    color: state.color,
    size: state.size,
    filled: isShape ? event.shiftKey || state.filled : false,
    from: point,
    to: point,
    points: state.tool === 'pen' || state.tool === 'highlight' ? [point] : undefined,
  });
  state.draft = shape;
  state.gesture = { type: 'draw', shape, shiftKey: event.shiftKey };
});

el.canvas.addEventListener('pointermove', (event) => {
  state.pointer = toImage(event);
  const gesture = state.gesture;

  if (!gesture) {
    updateStats();
    return;
  }

  if (gesture.type === 'pan') {
    state.pan = {
      x: gesture.origin.x + (event.clientX - gesture.start.x),
      y: gesture.origin.y + (event.clientY - gesture.start.y),
    };
    // Panning translates the canvas element rather than re-rendering.
    el.canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px)`;
    return;
  }

  if (gesture.type === 'draw') {
    const shape = gesture.shape;
    if (shape.points) {
      const last = shape.points[shape.points.length - 1];
      if (Math.hypot(state.pointer.x - last.x, state.pointer.y - last.y) > 1.5 / state.zoom) {
        shape.points.push(state.pointer);
      }
    } else {
      shape.b = state.pointer;
      if (event.shiftKey && (shape.tool === 'rect' || shape.tool === 'ellipse')) shape.filled = true;
      // Shift constrains lines and arrows to 15° increments.
      if (event.shiftKey && (shape.tool === 'line' || shape.tool === 'arrow')) {
        const dx = shape.b[0] - shape.a[0];
        const dy = shape.b[1] - shape.a[1];
        const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
        const length = Math.hypot(dx, dy);
        shape.b = [shape.a[0] + Math.cos(angle) * length, shape.a[1] + Math.sin(angle) * length];
      }
    }
    state.draft = shape;
    render();
    return;
  }

  if (gesture.type === 'dragShape') {
    const index = state.annotations.findIndex((s) => s.id === gesture.id);
    if (index !== -1) {
      state.annotations[index] = translateShape(
        gesture.origin,
        state.pointer.x - gesture.start.x,
        state.pointer.y - gesture.start.y,
      );
    }
    render();
  }
});

el.canvas.addEventListener('pointerup', () => {
  const gesture = state.gesture;
  state.gesture = null;
  el.wrap.classList.remove('panning');
  if (!gesture) return;

  if (gesture.type === 'draw') {
    const shape = gesture.shape;
    state.draft = null;
    const degenerate = shape.points
      ? shape.points.length < 3
      : Math.hypot(shape.b[0] - shape.a[0], shape.b[1] - shape.a[1]) < 3;
    if (!degenerate) {
      state.annotations.push(shape);
      state.redoStack = [];
    }
  }
  syncToolbar();
  render();
});

el.canvas.addEventListener('pointercancel', () => {
  state.gesture = null;
  state.draft = null;
  el.wrap.classList.remove('panning');
  render();
});

el.canvas.addEventListener('dblclick', (event) => {
  const point = toImage(event);
  const shape = [...state.annotations].reverse().find((s) => hitTest(s, point, 8 / state.zoom));
  if (shape?.tool === 'text') {
    if (state.editingTextId) commitText();
    state.selectedId = null;
    openTextEditor(shape);
  }
});

// ---------------------------------------------------------------------------
// Wheel: scroll to zoom, Ctrl+wheel to pan
// ---------------------------------------------------------------------------

el.wrap.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      state.pan.x -= event.deltaX / 2;
      state.pan.y -= event.deltaY / 2;
      el.canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px)`;
      return;
    }
    const factor = Math.exp(-event.deltaY * 0.0016);
    zoomBy(factor, { x: event.clientX, y: event.clientY });
  },
  { passive: false },
);

function zoomBy(factor, screenPoint) {
  const before = state.zoom;
  const next = clamp(state.zoom * factor, 0.05, 8);
  if (next === before) return;

  if (screenPoint) {
    // Keep the pixel under the cursor pinned in place.
    const box = el.canvas.getBoundingClientRect();
    const localX = screenPoint.x - box.left;
    const localY = screenPoint.y - box.top;
    state.pan.x -= localX * (next / before - 1);
    state.pan.y -= localY * (next / before - 1);
    el.canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px)`;
  }
  state.zoom = next;
  applyZoom();
  render();
}

function resetView() {
  state.pan = { x: 0, y: 0 };
  el.canvas.style.transform = '';
}

// ---------------------------------------------------------------------------
// Saving and copying

async function exportPNG() {
  if (!state.image) return null;
  // Bake onto a fresh canvas so annotations are flattened at full resolution.
  const out = document.createElement('canvas');
  out.width = state.width;
  out.height = state.height;
  const octx = out.getContext('2d');
  octx.drawImage(state.image, 0, 0, state.width, state.height);
  drawAnnotations(octx, state.annotations, { base: out, scale: 1 });
  return out.toDataURL('image/png').split(',')[1];
}

async function copyToClipboard() {
  try {
    const data = await exportPNG();
    if (!data) throw new Error('Nothing to copy.');
    await api.copy(data);
    setStatus('Copied to clipboard', 'ok');
    toast('Copied to clipboard', 'success');
    state.clean = true;
  } catch (err) {
    setStatus(err.message, 'error');
    toast(err.message, 'error');
  }
}

async function save({ copy = false } = {}) {
  try {
    const data = await exportPNG();
    if (!data) throw new Error('Nothing to save.');
    // "Save a copy" always writes a new timestamped file; plain save honours
    // the configured directory and only prompts when none is set.
    const result = await api.save(data, copy ? { forceDialog: true } : undefined);
    if (result?.canceled) {
      setStatus('Save cancelled');
      return;
    }
    state.clean = true;
    setStatus(`Saved to ${result.filePath}`, 'ok');
    toast('Saved', 'success');
  } catch (err) {
    setStatus(err.message, 'error');
    toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Status and toasts

let statusTimer = null;
function setStatus(message, kind = '') {
  el.statusLeft.textContent = message;
  el.statusLeft.className = `status-left ${kind}`;
  clearTimeout(statusTimer);
  if (kind) {
    statusTimer = setTimeout(() => {
      el.statusLeft.textContent = 'Ready';
      el.statusLeft.className = 'status-left';
    }, 5000);
  }
}

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.append(icon(kind === 'success' ? 'check' : kind === 'error' ? 'info' : 'sparkle', 16));
  const text = document.createElement('span');
  text.textContent = message;
  node.append(text);
  el.toasts.append(node);
  setTimeout(() => node.remove(), 2600);
}

// ---------------------------------------------------------------------------
// Keyboard

const HELP = [
  {
    title: 'Tools',
    rows: [
      ['Pen', ['P']],
      ['Highlight', ['H']],
      ['Line', ['L']],
      ['Arrow', ['A']],
      ['Rectangle', ['R']],
      ['Ellipse', ['O']],
      ['Text', ['T']],
      ['Step marker', ['N']],
      ['Blur', ['B']],
      ['Select / move', ['V']],
      ['Cycle tools', ['Tab']],
      ['Select tool by number', ['1', '…', '9']],
    ],
  },
  {
    title: 'Editing',
    rows: [
      ['Undo', ['Ctrl', 'Z']],
      ['Redo', ['Ctrl', 'Shift', 'Z']],
      ['Delete selection', ['Del']],
      ['Clear everything', ['Ctrl', 'Shift', 'Backspace']],
      ['Bigger / smaller', ['[', ']']],
      ['Toggle fill', ['Shift']],
      ['Constrain to 15°', ['Shift', 'drag']],
    ],
  },
  {
    title: 'Finish',
    rows: [
      ['Copy to clipboard', ['Enter']],
      ['Save as PNG', ['Ctrl', 'S']],
      ['Save a copy', ['Ctrl', 'Shift', 'S']],
      ['Annotate more', ['Space']],
      ['Fit to window', ['Ctrl', '0']],
      ['Actual size', ['Ctrl', '1']],
      ['Pan canvas', ['Space', 'drag']],
      ['Zoom', ['Ctrl', 'wheel']],
      ['Close', ['Esc']],
    ],
  },
];

function renderHelp() {
  el.helpGrid.replaceChildren();
  for (const group of HELP) {
    const box = document.createElement('div');
    box.className = 'help-group';
    const heading = document.createElement('h3');
    heading.textContent = group.title;
    box.append(heading);
    for (const [label, keys] of group.rows) {
      const row = document.createElement('div');
      row.className = 'help-row';
      const name = document.createElement('span');
      name.textContent = label;
      const keyBox = document.createElement('span');
      keyBox.className = 'help-keys';
      for (const key of keys) {
        const kbd = document.createElement('span');
        kbd.className = 'kbd';
        kbd.textContent = key;
        keyBox.append(kbd);
      }
      row.append(name, keyBox);
      box.append(row);
    }
    el.helpGrid.append(box);
  }
}

function toggleHelp(force) {
  el.help.hidden = force === undefined ? !el.help.hidden : !force;
}

window.addEventListener('keydown', (event) => {
  // The help dialog swallows everything except its own dismissal.
  if (!el.help.hidden) {
    if (event.key === 'Escape' || event.key === 'Enter' || event.key === '?') {
      event.preventDefault();
      toggleHelp(false);
    }
    return;
  }

  if (event.target === textarea) return;

  const mod = event.ctrlKey || event.metaKey;
  const key = event.key;
  const lower = key.toLowerCase();

  if (key === ' ') {
    state.spaceDown = true;
    return;
  }
  if (key === 'Escape') {
    event.preventDefault();
    window.close();
    return;
  }
  if (key === '?' || (key === '/' && event.shiftKey)) {
    event.preventDefault();
    toggleHelp(true);
    return;
  }

  if (mod && lower === 'z') {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if (mod && lower === 'y') {
    event.preventDefault();
    redo();
    return;
  }
  if (mod && lower === 's') {
    event.preventDefault();
    save({ copy: event.shiftKey });
    return;
  }
  if (mod && lower === 'c') {
    event.preventDefault();
    copyToClipboard();
    return;
  }
  if (mod && lower === '0') {
    event.preventDefault();
    resetView();
    state.zoom = fitZoom();
    applyZoom();
    render();
    return;
  }
  if (mod && lower === '1') {
    event.preventDefault();
    resetView();
    state.zoom = 1;
    applyZoom();
    render();
    return;
  }
  if (mod && key === 'Backspace') {
    event.preventDefault();
    clearAll();
    return;
  }
  if (mod) return;

  if (key === 'Enter') {
    event.preventDefault();
    copyToClipboard();
    return;
  }
  if (key === 'Delete' || key === 'Backspace') {
    event.preventDefault();
    deleteSelected();
    return;
  }
  if (key === 'Tab') {
    event.preventDefault();
    cycleTool(event.shiftKey ? -1 : 1);
    return;
  }
  if (key === '[') {
    event.preventDefault();
    setSize(state.size - (state.size > 12 ? 2 : 1));
    return;
  }
  if (key === ']') {
    event.preventDefault();
    setSize(state.size + (state.size >= 12 ? 2 : 1));
    return;
  }
  if (lower === 'f') {
    event.preventDefault();
    state.zoom = fitZoom();
    resetView();
    applyZoom();
    render();
    return;
  }

  // Number keys jump straight to a tool.
  if (/^[1-9]$/.test(key)) {
    const tool = TOOL_ORDER[Number(key) - 1];
    if (tool) {
      event.preventDefault();
      setTool(tool);
    }
    return;
  }

  const tool = TOOL_KEYS.get(lower);
  if (tool) {
    event.preventDefault();
    setTool(tool);
  }
});

window.addEventListener('keyup', (event) => {
  if (event.key === ' ') state.spaceDown = false;
});

// ---------------------------------------------------------------------------
// Wiring

document.getElementById('actCopy').addEventListener('click', copyToClipboard);
document.getElementById('actSave').addEventListener('click', () => save());
document.getElementById('actSaveCopy').addEventListener('click', () => save({ copy: true }));
document.getElementById('actFit').addEventListener('click', () => {
  resetView();
  state.zoom = fitZoom();
  applyZoom();
  render();
});
document.getElementById('actActual').addEventListener('click', () => {
  resetView();
  state.zoom = 1;
  applyZoom();
  render();
});
document.getElementById('actClear').addEventListener('click', clearAll);
document.getElementById('btnHelp').addEventListener('click', () => toggleHelp(true));
document.getElementById('helpClose').addEventListener('click', () => toggleHelp(false));
document.getElementById('helpDone').addEventListener('click', () => toggleHelp(false));
document.getElementById('btnSettings').addEventListener('click', () => api.window.openSettings('editor'));
el.help.addEventListener('click', (event) => {
  if (event.target === el.help) toggleHelp(false);
});

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  renderHelp();

  try {
    state.image = await loadImage(payload.image);
  } catch (err) {
    setStatus(err.message, 'error');
    return;
  }

  state.width = payload.naturalWidth || state.image.naturalWidth;
  state.height = payload.naturalHeight || state.image.naturalHeight;

  // Match the backing store to the image so annotations render at full detail.
  el.canvas.width = state.width;
  el.canvas.height = state.height;

  el.dims.textContent = `${state.width} × ${state.height}`;
  if (payload.source && payload.source !== 'region') {
    el.sourcePill.hidden = false;
    el.sourcePill.textContent = payload.source === 'screen' ? 'Current screen' : payload.source === 'allScreens' ? 'All screens' : payload.source;
  }

  adoptPendingAnnotations();
  buildToolbar();

  state.zoom = fitZoom();
  applyZoom();
  render();
  setStatus(`${state.annotations.length ? 'Annotations loaded — ' : ''}Enter copies · Ctrl+S saves`);
  requestAnimationFrame(tick);
}

boot();
