/**
 * Shape model and canvas painting shared by the overlay and the editor.
 *
 * Geometry is plain JSON — `{ a: [x, y], b: [x, y] }` for two-point tools and
 * `{ points: [[x, y], ...] }` for freehand ones — so shapes survive the trip
 * through IPC and can be re-rendered at any scale.
 *
 * Coordinates are always "image space": pixels of the bitmap being annotated.
 * The overlay works in display DIPs and the editor in image pixels, and each
 * converts on the way in.
 */

export const TOOLS = {
  select: { id: 'select', label: 'Select', icon: 'select', key: 'v', hint: 'Move or delete annotations' },
  pen: { id: 'pen', label: 'Pen', icon: 'pen', key: 'p', hint: 'Freehand drawing' },
  highlight: { id: 'highlight', label: 'Highlight', icon: 'highlight', key: 'h', hint: 'Translucent marker' },
  line: { id: 'line', label: 'Line', icon: 'line', key: 'l', hint: 'Straight line' },
  arrow: { id: 'arrow', label: 'Arrow', icon: 'arrow', key: 'a', hint: 'Point at something' },
  rect: { id: 'rect', label: 'Rectangle', icon: 'rect', key: 'r', hint: 'Box (hold Shift to fill)' },
  ellipse: { id: 'ellipse', label: 'Ellipse', icon: 'ellipse', key: 'o', hint: 'Circle or oval' },
  text: { id: 'text', label: 'Text', icon: 'text', key: 't', hint: 'Click and type' },
  step: { id: 'step', label: 'Step', icon: 'step', key: 'n', hint: 'Numbered marker' },
  blur: { id: 'blur', label: 'Blur', icon: 'blur', key: 'b', hint: 'Hide sensitive details' },
};

export const TOOL_ORDER = ['select', 'pen', 'highlight', 'line', 'arrow', 'rect', 'ellipse', 'text', 'step', 'blur'];

export const PRESET_COLORS = [
  '#ff453a',
  '#ff9f0a',
  '#ffd60a',
  '#32d74b',
  '#0a84ff',
  '#bf5af2',
  '#ffffff',
  '#0b0d14',
];

let shapeSeq = 0;
export const nextId = () => `s${Date.now().toString(36)}${(shapeSeq++).toString(36)}`;

/** Build a shape from a completed gesture. */
export function makeShape({ tool, color, size, filled, from, to, points, text }) {
  const base = { id: nextId(), tool, color, size: Math.max(1, size), filled: !!filled };
  switch (tool) {
    case 'pen':
    case 'highlight':
      return { ...base, points: points || [from, to] };
    case 'text':
      return { ...base, at: from, text: text ?? '' };
    case 'step':
      return { ...base, at: to || from };
    default:
      return { ...base, a: from, b: to };
  }
}

// ---------------------------------------------------------------------------
// Geometry

export function boundsOf(shape) {
  if (shape.points) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [x, y] of shape.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  if (shape.at) {
    const r = (shape.size || 4) * (shape.tool === 'step' ? 1.6 : 0.6);
    return { x: shape.at[0] - r, y: shape.at[1] - r, width: r * 2, height: r * 2 };
  }
  const [ax, ay] = shape.a;
  const [bx, by] = shape.b;
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

export function translateShape(shape, dx, dy) {
  const move = ([x, y]) => [x + dx, y + dy];
  const next = { ...shape };
  if (shape.points) next.points = shape.points.map(move);
  if (shape.a) next.a = move(shape.a);
  if (shape.b) next.b = move(shape.b);
  if (shape.at) next.at = move(shape.at);
  return next;
}

export function scaleShape(shape, sx, sy) {
  const grow = ([x, y]) => [x * sx, y * sy];
  const next = { ...shape, size: shape.size * Math.max(sx, sy) };
  if (shape.points) next.points = shape.points.map(grow);
  if (shape.a) next.a = grow(shape.a);
  if (shape.b) next.b = grow(shape.b);
  if (shape.at) next.at = grow(shape.at);
  return next;
}

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Is `pt` on or near `shape`, allowing `slop` pixels of forgiveness? */
export function hitTest(shape, [px, py], slop = 6) {
  const reach = slop + (shape.size || 4) / 2;

  if (shape.points) {
    const pts = shape.points;
    if (pts.length === 1) return Math.hypot(px - pts[0][0], py - pts[0][1]) <= reach;
    for (let i = 1; i < pts.length; i += 1) {
      if (distanceToSegment(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) {
        return true;
      }
    }
    return false;
  }

  if (shape.at) {
    if (shape.tool === 'text') {
      const b = boundsOf({ ...shape, points: textExtent(shape) });
      return (
        px >= b.x - slop && px <= b.x + b.width + slop && py >= b.y - slop && py <= b.y + b.height + slop
      );
    }
    return Math.hypot(px - shape.at[0], py - shape.at[1]) <= reach + (shape.size || 4);
  }

  const { x, y, width, height } = boundsOf(shape);
  switch (shape.tool) {
    case 'line':
    case 'arrow':
      return distanceToSegment(px, py, shape.a[0], shape.a[1], shape.b[0], shape.b[1]) <= reach;
    case 'rect':
      if (shape.filled) {
        return px >= x - slop && px <= x + width + slop && py >= y - slop && py <= y + height + slop;
      }
      return (
        distanceToSegment(px, py, x, y, x + width, y) <= reach ||
        distanceToSegment(px, py, x + width, y, x + width, y + height) <= reach ||
        distanceToSegment(px, py, x + width, y + height, x, y + height) <= reach ||
        distanceToSegment(px, py, x, y + height, x, y) <= reach
      );
    case 'ellipse': {
      const rx = Math.max(width / 2, 0.001);
      const ry = Math.max(height / 2, 0.001);
      const cx = x + rx;
      const cy = y + ry;
      const norm = Math.hypot((px - cx) / rx, (py - cy) / ry);
      return shape.filled ? norm <= 1 + slop / Math.min(rx, ry) : Math.abs(norm - 1) <= reach / Math.min(rx, ry);
    }
    default:
      return px >= x - slop && px <= x + width + slop && py >= y - slop && py <= y + height + slop;
  }
}

/** Rough bounding box of a text shape's rendered lines. */
function textExtent(shape) {
  const lines = String(shape.text ?? '').split('\n');
  const lineHeight = shape.size * 1.3;
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, measureTextWidth(line, shape.size));
  return [
    [shape.at[0], shape.at[1] - shape.size],
    [shape.at[0] + widest, shape.at[1] - shape.size + lineHeight * lines.length],
  ];
}

/**
 * Text metrics need a canvas. Keeping one module-level scratch context avoids
 * allocating per measurement and keeps hit-testing allocation-free.
 */
let scratch = null;
function measureTextWidth(text, size) {
  if (!scratch) scratch = document.createElement('canvas').getContext('2d');
  scratch.font = `600 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  return scratch.measureText(text).width;
}

export function textMetrics(shape) {
  const lines = String(shape.text ?? '').split('\n');
  return { lines, lineHeight: shape.size * 1.3, width: measureTextWidth(String(shape.text ?? ''), shape.size) };
}

// ---------------------------------------------------------------------------
// Painting

function applyStroke(ctx, shape) {
  ctx.strokeStyle = shape.color;
  ctx.fillStyle = shape.color;
  ctx.lineWidth = shape.size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function arrowHead(ctx, ax, ay, bx, by, size) {
  const angle = Math.atan2(by - ay, bx - ax);
  const len = Math.max(11, size * 3.4);
  const spread = 0.42;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(bx - len * Math.cos(angle - spread), by - len * Math.sin(angle - spread));
  ctx.lineTo(bx - len * 0.72 * Math.cos(angle), by - len * 0.72 * Math.sin(angle));
  ctx.lineTo(bx - len * Math.cos(angle + spread), by - len * Math.sin(angle + spread));
  ctx.closePath();
  ctx.fill();
}

function strokePath(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i += 1) {
    // Quadratic smoothing through midpoints keeps freehand strokes from looking
    // like polygons without the cost of a full spline fit.
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    ctx.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last[0], last[1]);
  ctx.stroke();
}

/** Downsample-then-upsample a region to obscure it. Reads from the untouched source. */
function pixelate(ctx, source, x, y, width, height, block) {
  if (!source || width < 2 || height < 2) return;
  const cols = Math.max(1, Math.round(width / block));
  const rows = Math.max(1, Math.round(height / block));

  const small = document.createElement('canvas');
  small.width = cols;
  small.height = rows;
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(source, x, y, width, height, 0, 0, cols, rows);

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, cols, rows, x, y, width, height);
  ctx.restore();
}

/**
 * Paint a single shape. `options.base` is the untouched bitmap, required only
 * by the blur tool.
 */
export function drawShape(ctx, shape, options = {}) {
  ctx.save();
  applyStroke(ctx, shape);

  switch (shape.tool) {
    case 'pen':
      strokePath(ctx, shape.points);
      break;

    case 'highlight': {
      const previous = ctx.globalCompositeOperation;
      ctx.globalAlpha = 0.42;
      ctx.globalCompositeOperation = 'multiply';
      ctx.lineWidth = shape.size * 3.2;
      strokePath(ctx, shape.points);
      ctx.globalCompositeOperation = previous;
      break;
    }

    case 'line':
      ctx.beginPath();
      ctx.moveTo(shape.a[0], shape.a[1]);
      ctx.lineTo(shape.b[0], shape.b[1]);
      ctx.stroke();
      break;

    case 'arrow': {
      const [ax, ay] = shape.a;
      const [bx, by] = shape.b;
      const angle = Math.atan2(by - ay, bx - ax);
      // Stop the shaft short so the head reads as a solid triangle, not a blob.
      const inset = Math.max(10, shape.size * 3.1);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx - inset * Math.cos(angle), by - inset * Math.sin(angle));
      ctx.stroke();
      arrowHead(ctx, ax, ay, bx, by, shape.size);
      break;
    }

    case 'rect': {
      const { x, y, width, height } = boundsOf(shape);
      const r = Math.min(4, width / 2, height / 2);
      ctx.beginPath();
      ctx.roundRect(x, y, width, height, r);
      if (shape.filled) ctx.fill();
      else ctx.stroke();
      break;
    }

    case 'ellipse': {
      const { x, y, width, height } = boundsOf(shape);
      ctx.beginPath();
      ctx.ellipse(x + width / 2, y + height / 2, Math.max(width / 2, 0.1), Math.max(height / 2, 0.1), 0, 0, Math.PI * 2);
      if (shape.filled) ctx.fill();
      else ctx.stroke();
      break;
    }

    case 'text': {
      const { lines, lineHeight } = textMetrics(shape);
      ctx.font = `600 ${shape.size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textBaseline = 'alphabetic';
      // A dark halo keeps light text readable on light backgrounds and vice versa.
      ctx.lineWidth = Math.max(3, shape.size / 7);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.42)';
      ctx.lineJoin = 'round';
      lines.forEach((line, index) => {
        const y = shape.at[1] + index * lineHeight;
        ctx.strokeText(line, shape.at[0], y);
        ctx.fillText(line, shape.at[0], y);
      });
      break;
    }

    case 'step': {
      const radius = Math.max(11, shape.size * 2.4);
      ctx.beginPath();
      ctx.arc(shape.at[0], shape.at[1], radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
      ctx.lineWidth = Math.max(1.5, radius / 7);
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = `700 ${radius * 1.15}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(shape.n ?? 1), shape.at[0], shape.at[1] + radius * 0.04);
      break;
    }

    case 'blur': {
      const { x, y, width, height } = boundsOf(shape);
      pixelate(ctx, options.base, x, y, width, height, Math.max(8, shape.size * 2.4));
      break;
    }

    default:
      break;
  }

  ctx.restore();
}

export function drawAnnotations(ctx, annotations, options = {}) {
  for (const shape of annotations) drawShape(ctx, shape, options);
}

/** Marching-ants outline that reads on any background. */
export function drawMarchingAnts(ctx, rect, dashOffset = 0, scale = 1) {
  const { x, y, width, height } = rect;
  const inset = 0.5 * scale;
  ctx.save();
  ctx.lineWidth = Math.max(1, 1 * scale);
  ctx.setLineDash([5 * scale, 4 * scale]);
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.strokeRect(x + inset, y + inset, width - inset * 2, height - inset * 2);
  ctx.lineDashOffset = -dashOffset;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
  ctx.strokeRect(x + inset, y + inset, width - inset * 2, height - inset * 2);
  ctx.restore();
}

/** Eight resize handles around `rect`, in drawing order. */
export function handlePoints(rect) {
  const { x, y, width, height } = rect;
  const mx = x + width / 2;
  const my = y + height / 2;
  return [
    ['nw', x, y],
    ['n', mx, y],
    ['ne', x + width, y],
    ['e', x + width, my],
    ['se', x + width, y + height],
    ['s', mx, y + height],
    ['sw', x, y + height],
    ['w', x, my],
  ];
}

export function cursorForHandle(name, rotation = 0) {
  const base = { n: 'ns', s: 'ns', e: 'ew', w: 'ew', nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw' };
  return `${base[name] || 'move'}-resize`;
}
