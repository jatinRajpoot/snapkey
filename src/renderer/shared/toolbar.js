import { TOOLS, TOOL_ORDER, PRESET_COLORS } from './drawing.js';
import { icon } from './icons.js';

/**
 * The annotation toolbar. It owns no canvas state: it reports intent through
 * `onChange` and the host decides what to redraw.
 *
 * config = { tool, color, size, filled, canUndo, canRedo, showFilled }
 */
export function createToolbar(config, onChange) {
  const el = document.createElement('div');
  el.className = 'toolbar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', 'Annotation tools');

  const state = {
    tool: config.tool || 'pen',
    color: config.color || PRESET_COLORS[0],
    size: config.size ?? 5,
    filled: !!config.filled,
    canUndo: !!config.canUndo,
    canRedo: !!config.canRedo,
    showFilled: config.showFilled !== false,
  };

  const toolButtons = new Map();
  const swatches = new Map();
  let sizeSlider;
  let sizeValue;
  let filledButton;
  let undoButton;
  let redoButton;

  function emit(patch = {}) {
    Object.assign(state, patch);
    onChange({ ...state });
    render();
  }

  function toolButton(id) {
    const meta = TOOLS[id];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tool';
    button.dataset.tool = id;
    button.setAttribute('aria-pressed', 'false');
    button.title = `${meta.label}  ·  ${meta.key.toUpperCase()}`;
    button.append(icon(meta.icon, 19));

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = meta.key.toUpperCase();
    button.append(badge);

    button.addEventListener('click', () => emit({ tool: id }));
    toolButtons.set(id, button);
    return button;
  }

  // --- tools -------------------------------------------------------------
  for (const id of TOOL_ORDER) el.append(toolButton(id));

  el.append(separator());

  // --- colour ------------------------------------------------------------
  const colorRow = document.createElement('div');
  colorRow.className = 'color-row';
  for (const color of PRESET_COLORS) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.style.background = color;
    swatch.setAttribute('aria-pressed', 'false');
    swatch.setAttribute('aria-label', `Colour ${color}`);
    swatch.title = color;
    swatch.addEventListener('click', () => emit({ color }));
    swatches.set(color, swatch);
    colorRow.append(swatch);
  }

  const custom = document.createElement('input');
  custom.type = 'color';
  custom.className = 'color-input';
  custom.title = 'Custom colour';
  custom.addEventListener('input', () => emit({ color: custom.value.toUpperCase() }));
  colorRow.append(custom);
  el.append(colorRow);

  el.append(separator());

  // --- size --------------------------------------------------------------
  const sizeControl = document.createElement('div');
  sizeControl.className = 'size-control';

  sizeSlider = document.createElement('input');
  sizeSlider.type = 'range';
  sizeSlider.className = 'size-slider';
  sizeSlider.min = '1';
  sizeSlider.max = '40';
  sizeSlider.step = '1';
  sizeSlider.title = 'Size  ·  [ and ]';
  sizeSlider.addEventListener('input', () => emit({ size: Number(sizeSlider.value) }));

  sizeValue = document.createElement('span');
  sizeValue.className = 'size-value';

  sizeControl.append(sizeSlider, sizeValue);
  el.append(sizeControl);

  if (state.showFilled) {
    filledButton = document.createElement('button');
    filledButton.type = 'button';
    filledButton.className = 'tool';
    filledButton.setAttribute('aria-pressed', 'false');
    filledButton.title = 'Fill shape  ·  Shift while dragging';
    filledButton.append(fillIcon());
    filledButton.addEventListener('click', () => emit({ filled: !state.filled }));
    el.append(filledButton);
  }

  el.append(separator());

  // --- history -----------------------------------------------------------
  undoButton = document.createElement('button');
  undoButton.type = 'button';
  undoButton.className = 'tool';
  undoButton.title = 'Undo  ·  Ctrl+Z';
  undoButton.append(icon('undo', 19));
  undoButton.addEventListener('click', () => onChange({ ...state, command: 'undo' }));
  el.append(undoButton);

  redoButton = document.createElement('button');
  redoButton.type = 'button';
  redoButton.className = 'tool';
  redoButton.title = 'Redo  ·  Ctrl+Shift+Z';
  redoButton.append(icon('redo', 19));
  redoButton.addEventListener('click', () => onChange({ ...state, command: 'redo' }));
  el.append(redoButton);

  // --- fill icon ---------------------------------------------------------
  function fillIcon() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '19');
    svg.setAttribute('height', '19');
    svg.classList.add('icon');
    svg.innerHTML = '<path d="M4.6 5.2h14.8v13.6H4.6z" fill="currentColor" opacity="0.9"/>';
    return svg;
  }

  function separator() {
    const el2 = document.createElement('div');
    el2.className = 'sep';
    return el2;
  }

  // --- render ------------------------------------------------------------
  function render() {
    for (const [id, button] of toolButtons) {
      button.setAttribute('aria-pressed', String(id === state.tool));
    }
    for (const [color, swatch] of swatches) {
      swatch.setAttribute('aria-pressed', String(color.toLowerCase() === state.color.toLowerCase()));
    }
    sizeSlider.value = String(state.size);
    sizeValue.textContent = String(state.size);
    if (filledButton) filledButton.setAttribute('aria-pressed', String(state.filled));

    undoButton.disabled = !state.canUndo;
    redoButton.disabled = !state.canRedo;
    undoButton.style.opacity = state.canUndo ? '1' : '0.35';
    redoButton.style.opacity = state.canRedo ? '1' : '0.35';
    undoButton.style.pointerEvents = state.canUndo ? 'auto' : 'none';
    redoButton.style.pointerEvents = state.canRedo ? 'auto' : 'none';

    // Size is meaningless for text; it edits the font size instead.
    sizeSlider.max = state.tool === 'text' ? '96' : '40';
  }

  render();

  return {
    el,
    get state() {
      return { ...state };
    },
    set(patch) {
      Object.assign(state, patch);
      render();
    },
  };
}
