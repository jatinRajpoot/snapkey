import {
  TOOLS,
  TOOL_ORDER,
  makeShape,
  boundsOf,
  hitTest,
  translateShape,
  drawShape,
  drawAnnotations,
  drawMarchingAnts,
  textMetrics,
} from '../shared/drawing.js';
import { icon } from '../shared/icons.js';
import { createToolbar } from '../shared/toolbar.js';

const payload = window.snapkey.payload || {};
const bridge = window.snapkey;

const el = {
  stage: document.getElementById('stage'),
  frozen: document.getElementById('frozen'),
  cutout: document.getElementById('cutout'),
  live: document.getElementById('live'),
  handles: document.getElementById('handles'),
  chrome: document.getElementById('chrome'),
  sizeBadge: document.getElementById('sizeBadge'),
  sizeText: document.getElementById('sizeText'),
  hints: document.getElementById('hints'),
  modeBadge: document.getElementById('modeBadge'),
  modeText: document.getElementById('modeText'),
  zoomPanel: document.getElementById('zoomPanel'),
  zoomSource: document.getElementById('zoomSource'),
  zoomCoords: document.getElementById('zoomCoords'),
  mouseCoords: document.getElementById('mouseCoords'),
  toasts: document.getElementById('toasts'),
  textEditor: document.getElementById('textEditor'),
  textInput: document.getElementById('textInput'),
};

const displayBounds = payload.bounds || { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
const isPrimary = !!payload.isPrimary;
const startAnnotating = !!payload.annotate;
const toolbarPrefs = payload.toolbar || {};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ---------------------------------------------------------------------------
// State

const state = {
  /** 'idle' → 'selecting' → 'selected' → 'annotating' */
  phase: 'idle',
  rect: null,
  annotations: [],
  draft: null,
  redoStack: [],
  tool: toolbarPrefs.tool || 'pen',
  color: toolbarPrefs.color || '#ff453a',
  size: toolbarPrefs.size ?? 5,
  filled: !!toolbarPrefs.filled,
  selectedId: null,
  editingTextId: null,
  textFontSize: 28,
  pointer: { x: 0, y: 0 },
  gesture: null,
  active: isPrimary,
  toolbar: null,
};

const RESIZE_HANDLES = new Set(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
const TOOL_KEYS = new Map(TOOL_ORDER.map((id) => [TOOLS[id].key, id]));

// ---------------------------------------------------------------------------
// Canvases

const frozenCtx = el.frozen.getContext('2d');
const liveCtx = el.live.getContext('2d');
let frozenBitmap = null;
/** Cached copy of the frozen canvas, used as the blur tool's source. */
let baseCanvas = null;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The captured image could not be decoded.'));
    img.src = src;
  });
}

async function initCanvases() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(window.innerWidth));
  const h = Math.max(1, Math.round(window.innerHeight));

  for (const canvas of [el.frozen, el.live]) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  frozenCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  liveCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  baseCanvas = null;
}

function paintFrozen() {
  frozenCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (frozenBitmap) frozenCtx.drawImage(frozenBitmap, 0, 0, window.innerWidth, window.innerHeight);
}

/** Snapshot of the untouched pixels, cached until the window resizes. */
function baseSnapshot() {
  if (!baseCanvas) {
    baseCanvas = document.createElement('canvas');
    baseCanvas.width = el.frozen.width;
    baseCanvas.height = el.frozen.height;
    baseCanvas.getContext('2d').drawImage(el.frozen, 0, 0);
  }
  return baseCanvas;
}

// ---------------------------------------------------------------------------
// Selection geometry

function normalizeRect(rect) {
  const x = clamp(rect.x, 0, window.innerWidth);
  const y = clamp(rect.y, 0, window.innerHeight);
  const right = clamp(rect.x + rect.width, 0, window.innerWidth);
  const bottom = clamp(rect.y + rect.height, 0, window.innerHeight);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

const rectFromPoints = (a, b) =>
  normalizeRect({
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  });

/**
 * Nudge the selection edges onto strong pixel boundaries. Sampled from a small
 * strip around each edge rather than the whole screen, so this stays cheap
 * enough to run on every pointermove.
 */
function snapRect(rect, radius = 6) {
  if (!frozenBitmap || rect.width < 8 || rect.height < 8) return rect;

  const dpr = window.devicePixelRatio || 1;
  const iw = Math.max(1, Math.round(displayBounds.width * dpr));
  const ih = Math.max(1, Math.round(displayBounds.height * dpr));

  const sample = document.createElement('canvas');
  sample.width = iw;
  sample.height = ih;
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(frozenBitmap, 0, 0, iw, ih);
  const px = ctx.getImageData(0, 0, iw, ih).data;

  const lum = (x, y) => {
    const cx = clamp(Math.round(x), 0, iw - 1);
    const cy = clamp(Math.round(y), 0, ih - 1);
    const i = (cy * iw + cx) * 4;
    return px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
  };

  const reach = Math.round(radius);
  const scan = (value, horizontal, mid, max) => {
    let best = value;
    let bestScore = 0;
    for (let d = -reach; d <= reach; d += 1) {
      const candidate = value + d;
      if (candidate < 0 || candidate > max) continue;
      const p = candidate * dpr;
      const m = mid * dpr;
      const delta = horizontal
        ? Math.abs(lum(p - 1.5 * dpr, m) - lum(p + 1.5 * dpr, m))
        : Math.abs(lum(m, p - 1.5 * dpr) - lum(m, p + 1.5 * dpr));
      if (delta > bestScore) {
        bestScore = delta;
        best = candidate;
      }
    }
    return bestScore > 28 ? best : value;
  };

  const yMid = rect.y + rect.height / 2;
  const xMid = rect.x + rect.width / 2;
  const left = scan(rect.x, true, yMid, window.innerWidth);
  const right = scan(rect.x + rect.width, true, yMid, window.innerWidth);
  const top = scan(rect.y, false, xMid, window.innerHeight);
  const bottom = scan(rect.y + rect.height, false, xMid, window.innerHeight);

  return normalizeRect({ x: left, y: top, width: right - left, height: bottom - top });
}

/** Four panes leave a real transparent hole, so the live desktop shows through. */
function renderCutout() {
  const rect = state.rect;
  if (!rect || rect.width < 1 || rect.height < 1 || state.phase === 'annotating') {
    el.cutout.style.clipPath = 'inset(0 0 100% 0)';
    return;
  }
  const { x, y, width, height } = rect;
  const w = window.innerWidth;
  const h = window.innerHeight;
  el.cutout.style.clipPath = `polygon(evenodd, 0px 0px, ${w}px 0px, ${w}px ${h}px, 0px ${h}px, 0px 0px, ${x}px ${y}px, ${x}px ${
    y + height
  }px, ${x + width}px ${y + height}px, ${x + width}px ${y}px, ${x}px ${y}px)`;
}

function renderHandles() {
  el.handles.replaceChildren();
  const rect = state.rect;
  if (!rect || state.phase !== 'selected') return;

  const { x, y, width, height } = rect;
  const mx = x + width / 2;
  const my = y + height / 2;
  const spots = [
    ['nw', x, y],
    ['n', mx, y],
    ['ne', x + width, y],
    ['e', x + width, my],
    ['se', x + width, y + height],
    ['s', mx, y + height],
    ['sw', x, y + height],
    ['w', x, my],
  ];
  for (const [name, hx, hy] of spots) {
    const handle = document.createElement('div');
    handle.className = `handle edge-${name}`;
    handle.dataset.handle = name;
    handle.style.left = `${hx}px`;
    handle.style.top = `${hy}px`;
    el.handles.append(handle);
  }
}

function renderSelectionDecor() {
  if (!state.rect || state.phase === 'annotating') return;
  drawMarchingAnts(frozenCtx, state.rect, antsOffset, 1);
}

// ---------------------------------------------------------------------------
// Annotation rendering

const toImagePoint = (event) => ({
  x: event.clientX - state.rect.x,
  y: event.clientY - state.rect.y,
});

function renderLive() {
  liveCtx.save();
  liveCtx.setTransform(1, 0, 0, 1, 0, 0);
  liveCtx.clearRect(0, 0, el.live.width, el.live.height);
  liveCtx.restore();

  if (state.phase !== 'annotating' || !state.rect) return;

  const rect = state.rect;
  const base = baseSnapshot();

  liveCtx.save();
  liveCtx.translate(rect.x, rect.y);
  liveCtx.beginPath();
  liveCtx.rect(0, 0, rect.width, rect.height);
  liveCtx.clip();

  drawAnnotations(liveCtx, state.annotations, { base, scale: 1 });
  if (state.draft) drawShape(liveCtx, state.draft, { base, scale: 1 });

  if (state.editingTextId) {
    // The textarea shows the live text, so blank its canvas copy to avoid
    // rendering the same string twice.
    const shape = state.annotations.find((s) => s.id === state.editingTextId);
    if (shape) {
      const { lines, lineHeight, width } = textMetrics(shape);
      liveCtx.fillStyle = 'rgba(8, 10, 16, 0.6)';
      liveCtx.fillRect(
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
      liveCtx.save();
      liveCtx.setLineDash([4, 3]);
      liveCtx.lineWidth = 1.5;
      liveCtx.strokeStyle = 'rgba(139, 149, 255, 0.95)';
      liveCtx.strokeRect(b.x - 5, b.y - 5, b.width + 10, b.height + 10);
      liveCtx.restore();
    }
  }
  liveCtx.restore();

  liveCtx.save();
  liveCtx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  liveCtx.lineWidth = 1;
  liveCtx.setLineDash([5, 4]);
  liveCtx.lineDashOffset = -antsOffset;
  liveCtx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  liveCtx.restore();
}

let antsOffset = 0;

function tick() {
  antsOffset = (antsOffset + 0.35) % 9;
  if (state.active && (state.phase === 'selected' || state.phase === 'selecting')) {
    paintFrozen();
    renderSelectionDecor();
  } else if (state.phase === 'annotating') {
    renderLive();
  }
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Chrome positioning

function positionChrome() {
  const rect = state.rect;

  if (rect && state.phase !== 'annotating' && rect.width > 8) {
    el.sizeText.textContent = `${Math.round(rect.width * (window.devicePixelRatio || 1))} × ${Math.round(
      rect.height * (window.devicePixelRatio || 1),
    )}`;
    el.sizeBadge.hidden = false;
    const box = el.sizeBadge.getBoundingClientRect();
    const gap = 8;
    let bx = clamp(rect.x, gap, Math.max(gap, window.innerWidth - box.width - gap));
    let by = rect.y - box.height - gap;
    if (by < gap) by = Math.min(rect.y + gap, window.innerHeight - box.height - gap);
    el.sizeBadge.style.left = `${bx}px`;
    el.sizeBadge.style.top = `${by}px`;
  } else {
    el.sizeBadge.hidden = true;
  }

  if (state.phase === 'selected' && rect) {
    const box = el.hints.getBoundingClientRect();
    const below = rect.y + rect.height + 12;
    const top = below + box.height + 12 < window.innerHeight ? below : Math.max(12, rect.y - box.height - 12);
    el.hints.style.left = `${clamp(rect.x + rect.width / 2 - box.width / 2, 12, Math.max(12, window.innerWidth - box.width - 12))}px`;
    el.hints.style.top = `${top}px`;
  } else if (state.phase !== 'annotating') {
    const box = el.hints.getBoundingClientRect();
    el.hints.style.left = `${clamp(window.innerWidth / 2 - box.width / 2, 12, Math.max(12, window.innerWidth - box.width - 12))}px`;
    el.hints.style.top = `${window.innerHeight - box.height - 28}px`;
  }

  if (state.toolbar && !state.toolbar.el.hidden) {
    const box = state.toolbar.el.getBoundingClientRect();
    let top = window.innerHeight - box.height - 22;
    // Lift the toolbar above the selection when it would otherwise cover it.
    if (rect && rect.y < top && rect.y + rect.height > top - 20) {
      top = clamp(rect.y + rect.height + 14, 12, window.innerHeight - box.height - 12);
    }
    el.toolbar && void el.toolbar;
    state.toolbar.el.style.left = `${clamp(
      window.innerWidth / 2 - box.width / 2,
      12,
      Math.max(12, window.innerWidth - box.width - 12),
    )}px`;
    state.toolbar.el.style.top = `${clamp(top, 12, Math.max(12, window.innerHeight - box.height - 12))}px`;
  }

  if (!el.zoomPanel.hidden) {
    const zx = state.pointer.x + 24;
    const zy = state.pointer.y + 24;
    el.zoomPanel.style.left = `${zx + 130 > window.innerWidth ? Math.max(8, state.pointer.x - 138) : zx}px`;
    el.zoomPanel.style.top = `${zy + 156 > window.innerHeight ? Math.max(8, state.pointer.y - 160) : zy}px`;
  }

  el.mouseCoords.textContent = `${Math.round(state.pointer.x + displayBounds.x)}, ${Math.round(
    state.pointer.y + displayBounds.y,
  )}`;
  el.mouseCoords.style.left = `${clamp(state.pointer.x + 16, 4, Math.max(4, window.innerWidth - 84))}px`;
  el.mouseCoords.style.top = `${clamp(state.pointer.y + 18, 4, Math.max(4, window.innerHeight - 24))}px`;
}

// ---------------------------------------------------------------------------
// Magnifier

function renderMagnifier() {
  if (el.zoomPanel.hidden || !frozenBitmap) return;
  const size = 112;
  const zoom = 8;
  const ctx = el.zoomSource.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, size, size);

  const ratioX = frozenBitmap.width / window.innerWidth;
  const ratioY = frozenBitmap.height / window.innerHeight;
  const srcW = size / zoom / ratioX;
  const srcH = size / zoom / ratioY;
  const sx = state.pointer.x - srcW / 2;
  const sy = state.pointer.y - srcH / 2;
  ctx.drawImage(frozenBitmap, sx * ratioX, sy * ratioY, srcW * ratioX, srcH * ratioY, 0, 0, size, size);

  ctx.save();
  ctx.strokeStyle = 'rgba(111, 123, 255, 0.95)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2 + 0.5, size / 2 - 10);
  ctx.lineTo(size / 2 + 0.5, size / 2 + 10);
  ctx.moveTo(size / 2 - 10, size / 2 + 0.5);
  ctx.lineTo(size / 2 + 10, size / 2 + 0.5);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.strokeRect(0.5, 0.5, size - 1, size - 1);
  ctx.restore();

  el.zoomCoords.textContent = `${Math.round(state.pointer.x + displayBounds.x)}, ${Math.round(
    state.pointer.y + displayBounds.y,
  )}`;
}

// ---------------------------------------------------------------------------
// Text editing

function autoGrow() {
  const input = el.textInput;
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
  input.style.width = `${Math.max(170, Math.min(window.innerWidth * 0.5, input.scrollWidth + 30))}px`;
}

function openTextEditor(at, shape) {
  const rect = state.rect;
  state.textFontSize = shape.size;
  el.textInput.value = shape.text || '';
  el.textInput.placeholder = 'Type…';
  el.textInput.style.font = `600 ${shape.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  el.textEditor.style.left = `${rect.x + at.x - 8}px`;
  el.textEditor.style.top = `${rect.y + at.y - shape.size * 1.05}px`;
  el.textEditor.hidden = false;
  el.textInput.focus();
  el.textInput.setSelectionRange(el.textInput.value.length, el.textInput.value.length);
  autoGrow();
}

function commitText() {
  const id = state.editingTextId;
  if (!id) return;
  state.editingTextId = null;
  el.textEditor.hidden = true;

  const shape = state.annotations.find((s) => s.id === id);
  const value = el.textInput.value.replace(/\s+$/, '');
  if (!shape) return;

  if (!value.trim()) {
    state.annotations = state.annotations.filter((s) => s.id !== id);
  } else {
    shape.text = value;
  }
  syncToolbar();
  renderLive();
}

// ---------------------------------------------------------------------------
// History and tools

function undo() {
  if (state.editingTextId) commitText();
  const shape = state.annotations.pop();
  if (!shape) return;
  state.redoStack.push(shape);
  if (state.selectedId === shape.id) state.selectedId = null;
  syncToolbar();
  renderLive();
}

function redo() {
  const shape = state.redoStack.pop();
  if (!shape) return;
  state.annotations.push(shape);
  syncToolbar();
  renderLive();
}

function deleteSelected() {
  if (!state.selectedId) return;
  state.annotations = state.annotations.filter((s) => s.id !== state.selectedId);
  state.selectedId = null;
  syncToolbar();
  renderLive();
}

function setTool(tool) {
  if (state.editingTextId) commitText();
  if (tool !== 'select') state.selectedId = null;
  state.tool = tool;
  // Text is sized in points, shapes in stroke width; keep them separate.
  if (tool === 'text') state.size = clamp(state.textFontSize > 40 ? state.textFontSize : 28, 12, 96);
  else if (state.size > 40) state.size = toolbarPrefs.size ?? 5;
  syncToolbar();
  renderLive();
}

function setSize(size) {
  state.size = clamp(Math.round(size), 1, state.tool === 'text' ? 96 : 40);
  if (state.tool === 'text') state.textFontSize = state.size;
  syncToolbar();
  renderLive();
}

function cycleTool(direction) {
  const index = TOOL_ORDER.indexOf(state.tool);
  setTool(TOOL_ORDER[(index + direction + TOOL_ORDER.length) % TOOL_ORDER.length]);
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
}

// ---------------------------------------------------------------------------
// Mode transitions

function enterAnnotationMode() {
  if (state.phase === 'annotating') return;
  if (!state.rect || state.rect.width < 2 || state.rect.height < 2) {
    toast('Drag out an area first', 'error');
    return;
  }

  state.phase = 'annotating';
  document.body.classList.add('annotating');
  renderCutout();

  if (!state.toolbar) {
    state.toolbar = createToolbar(
      { tool: state.tool, color: state.color, size: state.size, filled: state.filled },
      (next) => {
        if (next.command === 'undo') return undo();
        if (next.command === 'redo') return redo();
        const entering = next.tool !== state.tool;
        state.color = next.color;
        state.filled = next.filled;
        if (entering) setTool(next.tool);
        else setSize(next.size);
      },
    );
    state.toolbar.el.style.position = 'fixed';
    state.toolbar.el.style.zIndex = '30';
    document.body.append(state.toolbar.el);
  }
  state.toolbar.el.hidden = false;

  state.textFontSize = state.tool === 'text' ? state.size : 28;
  syncToolbar();
  renderLive();

  el.hints.hidden = true;
  el.modeBadge.hidden = false;
  el.zoomPanel.hidden = true;
  el.handles.replaceChildren();
  positionChrome();
}

function exitAnnotationMode() {
  if (state.editingTextId) commitText();
  state.phase = 'selected';
  document.body.classList.remove('annotating');
  if (state.toolbar) state.toolbar.el.hidden = true;
  el.modeBadge.hidden = true;
  el.hints.hidden = false;
  renderHandles();
  paintFrozen();
  renderSelectionDecor();
  positionChrome();
}

// ---------------------------------------------------------------------------
// Finishing

/** Flatten the frozen pixels (plus optional annotations) into a PNG. */
function rasterize({ includeAnnotations }) {
  const rect = state.rect;
  if (!rect) return null;
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  const ctx = canvas.getContext('2d');

  const source = state.phase === 'annotating' ? el.frozen : el.frozen;
  ctx.drawImage(
    source,
    rect.x * dpr,
    rect.y * dpr,
    rect.width * dpr,
    rect.height * dpr,
    0,
    0,
    canvas.width,
    canvas.height,
  );

  if (includeAnnotations && state.annotations.length) {
    const base = baseSnapshot();
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(-rect.x, -rect.y);
    drawAnnotations(ctx, state.annotations, { base, scale: 1 });
    ctx.restore();
  }

  return {
    data: canvas.toDataURL('image/png').split(',')[1],
    width: canvas.width,
    height: canvas.height,
  };
}

function finish(result) {
  bridge.finish(result);
}

function copySelection() {
  const rect = state.rect;
  if (!rect || rect.width < 2 || rect.height < 2) {
    toast('Drag out an area first', 'error');
    return;
  }
  if (state.phase === 'annotating' && state.annotations.length) {
    const raster = rasterize({ includeAnnotations: true });
    flash('success', 'Copied to clipboard', {
      action: 'copy',
      displayId: payload.displayId,
      ...raster,
    });
    return;
  }
  const raster = rasterize({ includeAnnotations: false });
  flash('success', 'Copied to clipboard', {
    action: 'copy',
    displayId: payload.displayId,
    ...raster,
  });
}

function openInEditor() {
  const rect = state.rect;
  if (!rect || rect.width < 2 || rect.height < 2) {
    toast('Drag out an area first', 'error');
    return;
  }
  const raster = rasterize({ includeAnnotations: true });
  finish({
    action: 'edit',
    displayId: payload.displayId,
    // Shapes travel alongside the flattened pixels so the editor can keep
    // editing them rather than starting from a baked image.
    annotations: state.annotations.map((shape) => ({ ...shape })),
    ...raster,
  });
}

function flash(kind, message, result) {
  if (message) toast(message, kind);
  setTimeout(() => finish(result), 260);
}

// ---------------------------------------------------------------------------
// Toasts

function toast(message, kind = 'info') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.append(icon(kind === 'error' ? 'info' : kind === 'success' ? 'check' : 'sparkle', 16));
  const text = document.createElement('span');
  text.textContent = message;
  node.append(text);
  el.toasts.append(node);
  el.toasts.style.left = `${window.innerWidth / 2 - 140}px`;
  el.toasts.style.top = `${window.innerHeight - 190}px`;
  setTimeout(() => node.remove(), 2400);
}

// ---------------------------------------------------------------------------
// Pointer interaction

const localPoint = (event) => ({ x: event.clientX, y: event.clientY });
const handleUnder = (event) => event.target.closest?.('.handle')?.dataset.handle || null;

el.stage.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  if (!state.active) bridge.claim();

  el.stage.setPointerCapture(event.pointerId);
  const point = localPoint(event);

  if (state.phase === 'annotating') {
    beginAnnotation(event);
    return;
  }

  if (state.phase === 'selected' && state.rect) {
    const handle = handleUnder(event);
    if (handle && RESIZE_HANDLES.has(handle)) {
      state.gesture = { type: 'resize', handle, origin: { ...state.rect } };
      document.body.classList.add('moving');
      return;
    }
    const { x, y, width, height } = state.rect;
    if (point.x >= x && point.x <= x + width && point.y >= y && point.y <= y + height) {
      state.gesture = { type: 'move', origin: { ...state.rect }, start: point };
      document.body.classList.add('moving');
      return;
    }
  }

  state.phase = 'selecting';
  state.selectedId = null;
  state.annotations = [];
  state.redoStack = [];
  state.gesture = { type: 'select', origin: point };
  state.rect = { x: point.x, y: point.y, width: 0, height: 0 };
  el.hints.hidden = true;
  el.handles.replaceChildren();
  renderCutout();
  positionChrome();
});

el.stage.addEventListener('pointermove', (event) => {
  state.pointer = localPoint(event);
  const gesture = state.gesture;

  if (gesture) {
    if (gesture.type === 'select') {
      state.rect = rectFromPoints(gesture.origin, state.pointer);
      if (!event.shiftKey && state.rect.width > 10 && state.rect.height > 10) {
        state.rect = snapRect(state.rect);
      }
      if (state.rect.width > 140 && state.rect.height > 70) el.hints.hidden = false;
    } else if (gesture.type === 'move') {
      state.rect = normalizeRect({
        x: gesture.origin.x + (state.pointer.x - gesture.start.x),
        y: gesture.origin.y + (state.pointer.y - gesture.start.y),
        width: gesture.origin.width,
        height: gesture.origin.height,
      });
    } else if (gesture.type === 'resize') {
      state.rect = resizeRect(gesture.origin, gesture.handle, state.pointer, event.shiftKey);
    } else if (gesture.type === 'draw') {
      updateDraw(gesture, event.shiftKey);
    } else if (gesture.type === 'dragShape') {
      const image = toImagePoint(event);
      const index = state.annotations.findIndex((s) => s.id === gesture.id);
      if (index !== -1) {
        state.annotations[index] = translateShape(
          gesture.origin,
          image.x - gesture.start.x,
          image.y - gesture.start.y,
        );
      }
    }
    renderCutout();
    renderMagnifier();
    positionChrome();
    return;
  }

  if (state.phase === 'annotating') hoverAnnotation(state.pointer);
  renderMagnifier();
  positionChrome();
});

el.stage.addEventListener('pointerup', (event) => {
  const gesture = state.gesture;
  state.gesture = null;
  document.body.classList.remove('moving');
  if (!gesture) return;

  if (gesture.type === 'select') {
    state.rect = rectFromPoints(gesture.origin, state.pointer);
    if (state.rect.width < 4 || state.rect.height < 4) {
      // A click rather than a drag: take the whole display.
      state.rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
      toast(`Whole display${payload.label ? ` · ${payload.label}` : ''}`);
    }
    state.phase = 'selected';
    el.hints.hidden = false;
    el.zoomPanel.hidden = true;
    renderHandles();
    renderSelectionDecor();
    positionChrome();
    return;
  }

  if (gesture.type === 'draw') finishDraw(gesture);
  if (gesture.type === 'dragShape') syncToolbar();
  void event;
});

el.stage.addEventListener('pointercancel', () => {
  state.gesture = null;
  document.body.classList.remove('moving');
});

el.stage.addEventListener('dblclick', (event) => {
  if (state.phase !== 'annotating') return;
  event.preventDefault();
  const point = toImagePoint(event);
  const shape = [...state.annotations].reverse().find((s) => hitTest(s, point, 8));
  if (shape?.tool === 'text') {
    if (state.editingTextId) commitText();
    state.selectedId = null;
    state.editingTextId = shape.id;
    openTextEditor(shape.at, shape);
    renderLive();
  }
});

function resizeRect(origin, handle, point, keepRatio) {
  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;

  if (handle.includes('w')) left = clamp(point.x, 0, window.innerWidth);
  if (handle.includes('e')) right = clamp(point.x, 0, window.innerWidth);
  if (handle.includes('n')) top = clamp(point.y, 0, window.innerHeight);
  if (handle.includes('s')) bottom = clamp(point.y, 0, window.innerHeight);

  if (keepRatio && origin.width > 0 && origin.height > 0) {
    const ratio = origin.width / origin.height;
    if (handle === 'n' || handle === 's') {
      const width = (bottom - top) * ratio;
      const center = (left + right) / 2;
      left = center - width / 2;
      right = center + width / 2;
    } else if (handle === 'nw' || handle === 'ne') {
      top = bottom - (right - left) / ratio;
    } else {
      bottom = top + (right - left) / ratio;
    }
  }

  return normalizeRect({ x: left, y: top, width: right - left, height: bottom - top });
}

// ---------------------------------------------------------------------------
// Annotation gestures

function beginAnnotation(event) {
  const image = toImagePoint(event);

  if (state.editingTextId) {
    commitText();
    return;
  }

  if (state.tool === 'select') {
    const shape = [...state.annotations].reverse().find((s) => hitTest(s, image, 7));
    state.selectedId = shape ? shape.id : null;
    if (shape) {
      state.gesture = { type: 'dragShape', id: shape.id, start: image, origin: { ...shape } };
    }
    renderLive();
    return;
  }

  if (state.tool === 'text') {
    const shape = makeShape({
      tool: 'text',
      color: state.color,
      size: state.textFontSize,
      from: image,
      text: '',
    });
    state.annotations.push(shape);
    state.selectedId = null;
    state.editingTextId = shape.id;
    openTextEditor(image, shape);
    renderLive();
    return;
  }

  if (state.tool === 'step') {
    const used = state.annotations.filter((s) => s.tool === 'step').map((s) => s.n || 0);
    const shape = makeShape({
      tool: 'step',
      color: state.color,
      size: state.size,
      from: image,
      to: image,
    });
    shape.n = used.length ? Math.max(...used) + 1 : 1;
    state.annotations.push(shape);
    state.redoStack = [];
    syncToolbar();
    renderLive();
    return;
  }

  const isShape = state.tool === 'rect' || state.tool === 'ellipse';
  const shape = makeShape({
    tool: state.tool,
    color: state.color,
    size: state.size,
    filled: isShape ? event.shiftKey || state.filled : false,
    from: image,
    to: image,
    points: state.tool === 'pen' || state.tool === 'highlight' ? [image] : undefined,
  });
  state.draft = shape;
  state.gesture = { type: 'draw', shape };
  renderLive();
}

function updateDraw(gesture, shiftKey) {
  const shape = gesture.shape;
  const image = toImagePoint({ clientX: state.pointer.x, clientY: state.pointer.y });

  if (shape.points) {
    const last = shape.points[shape.points.length - 1];
    if (Math.hypot(image.x - last.x, image.y - last.y) > 1.5) shape.points.push(image);
  } else {
    shape.b = image;
    if (shiftKey && (shape.tool === 'rect' || shape.tool === 'ellipse')) shape.filled = true;
  }
  state.draft = shape;
  renderLive();
}

function finishDraw(gesture) {
  const shape = gesture.shape;
  state.draft = null;

  const degenerate = shape.points
    ? shape.points.length < 3
    : Math.hypot(shape.b[0] - shape.a[0], shape.b[1] - shape.a[1]) < 3;

  if (!degenerate) {
    state.annotations.push(shape);
    state.redoStack = [];
  }
  syncToolbar();
  renderLive();
}

function hoverAnnotation(point) {
  if (state.tool !== 'select') {
    if (state.selectedId) {
      state.selectedId = null;
      renderLive();
    }
    return;
  }
  const image = toImagePoint({ clientX: point.x, clientY: point.y });
  const shape = [...state.annotations].reverse().find((s) => hitTest(s, image, 7));
  const id = shape ? shape.id : null;
  if (id !== state.selectedId) {
    state.selectedId = id;
    renderLive();
  }
}

// ---------------------------------------------------------------------------
// Keyboard

window.addEventListener('keydown', onKeyDown, { capture: true });

function onKeyDown(event) {
  // The textarea owns the keyboard while it is open.
  if (event.target === el.textInput) {
    if (event.key === 'Escape' || (event.key === 'Enter' && !event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      commitText();
    }
    return;
  }

  const mod = event.ctrlKey || event.metaKey;
  const key = event.key;
  const lower = key.toLowerCase();

  if (key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    if (state.phase === 'annotating') {
      if (state.draft) {
        state.draft = null;
        renderLive();
      } else if (state.selectedId) {
        state.selectedId = null;
        renderLive();
      } else {
        exitAnnotationMode();
      }
      return;
    }
    if (state.phase === 'selected') {
      // Step back to re-select rather than abandoning the capture entirely.
      state.phase = 'idle';
      state.rect = null;
      el.hints.hidden = true;
      renderCutout();
      positionChrome();
      return;
    }
    bridge.cancel();
    return;
  }

  if (state.phase === 'annotating') {
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
    if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      deleteSelected();
      return;
    }
    if (key === ' ') {
      event.preventDefault();
      copySelection();
      return;
    }
    if (key === 'Enter') {
      event.preventDefault();
      openInEditor();
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
    if (key === 'Tab') {
      event.preventDefault();
      cycleTool(event.shiftKey ? -1 : 1);
      return;
    }
    const tool = TOOL_KEYS.get(lower);
    if (tool && !mod) {
      event.preventDefault();
      setTool(tool);
      return;
    }
    return;
  }

  if (key === ' ') {
    event.preventDefault();
    enterAnnotationMode();
    return;
  }
  if (key === 'Enter') {
    event.preventDefault();
    copySelection();
    return;
  }
  if (lower === 'e' && !mod) {
    event.preventDefault();
    openInEditor();
    return;
  }
  if (lower === 'f' && !mod) {
    event.preventDefault();
    state.phase = 'selected';
    state.rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    el.hints.hidden = false;
    renderCutout();
    renderHandles();
    renderSelectionDecor();
    positionChrome();
    return;
  }
  if (lower === 'a' && mod) {
    event.preventDefault();
    finish({ action: 'allScreens' });
    return;
  }
  if (lower === 'c' && mod) {
    event.preventDefault();
    copySelection();
    return;
  }
  if (lower === 'i' && !mod) {
    event.preventDefault();
    el.zoomPanel.hidden = !el.zoomPanel.hidden;
    renderMagnifier();
    positionChrome();
  }
}

// ---------------------------------------------------------------------------
// Cross-display coordination

bridge.onRelay((message) => {
  if (!message) return;
  if (message.type === 'claimed' && message.displayId !== payload.displayId) {
    // Another display owns the interaction now; become a passive dimmer.
    state.active = false;
    el.hints.hidden = true;
    el.zoomPanel.hidden = true;
    el.handles.style.display = 'none';
    el.sizeBadge.hidden = true;
    if (state.toolbar) state.toolbar.el.hidden = true;
    if (state.phase !== 'annotating') {
      state.phase = 'idle';
      state.rect = null;
      renderCutout();
    }
  }
});

bridge.onCancel(() => bridge.cancel());

// ---------------------------------------------------------------------------
// Boot

async function boot() {
  el.chrome.hidden = false;
  await initCanvases();

  try {
    frozenBitmap = await loadImage(payload.background);
  } catch {
    frozenBitmap = null;
  }

  window.addEventListener('resize', async () => {
    await initCanvases();
    paintFrozen();
    renderCutout();
    renderHandles();
    positionChrome();
  });

  el.zoomPanel.hidden = payload.magnifier === false;

  paintFrozen();
  renderCutout();
  positionChrome();

  if (startAnnotating) {
    state.rect = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    enterAnnotationMode();
  }

  if (!state.active) {
    el.hints.hidden = true;
    el.zoomPanel.hidden = true;
    el.handles.style.display = 'none';
  }
}

boot();
requestAnimationFrame(tick);
