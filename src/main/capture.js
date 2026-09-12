'use strict';

const { screen, desktopCapturer } = require('electron');

// Guard rails so a wall of 8K monitors cannot ask for a gigapixel thumbnail.
const MAX_EDGE = 7680;
const MAX_SCALE = 2;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Union of every display's bounds, in DIP, in virtual-desktop coordinates. */
function unionBounds(displays) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** The pixels-per-DIP factor we render the composite stage at. */
function stageScale(displays) {
  let max = 1;
  for (const d of displays) max = Math.max(max, d.scaleFactor || 1);
  return Math.min(MAX_SCALE, max);
}

/**
 * Grab one PNG per display. Each source is captured at (close to) native
 * resolution so the composited stage stays pixel-accurate on HiDPI screens.
 */
async function grabDisplays() {
  const displays = screen.getAllDisplays();
  const scale = stageScale(displays);

  const nativeW = Math.min(
    MAX_EDGE,
    Math.ceil(Math.max(...displays.map((d) => d.bounds.width * (d.scaleFactor || 1)))),
  );
  const nativeH = Math.min(
    MAX_EDGE,
    Math.ceil(Math.max(...displays.map((d) => d.bounds.height * (d.scaleFactor || 1)))),
  );

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: nativeW, height: nativeH },
    fetchWindowIcons: false,
  });

  const primaryId = screen.getPrimaryDisplay().id;
  const used = new Set();
  const out = [];

  for (const d of displays) {
    // Match on display_id first; fall back to "the next unused source" because
    // some Windows configurations report an empty display_id.
    let src = sources.find((s) => !used.has(s.id) && String(s.display_id) === String(d.id));
    if (!src) src = sources.find((s) => !used.has(s.id));
    if (!src) continue;
    used.add(src.id);

    const thumb = src.thumbnail;
    const size = thumb.getSize();
    if (!size.width || !size.height) continue;

    out.push({
      id: d.id,
      label: d.label || `Display ${out.length + 1}`,
      bounds: { ...d.bounds },
      scaleFactor: d.scaleFactor || 1,
      isPrimary: d.id === primaryId,
      nativeWidth: Math.round(d.bounds.width * (d.scaleFactor || 1)),
      nativeHeight: Math.round(d.bounds.height * (d.scaleFactor || 1)),
      png: thumb.toPNG(),
    });
  }

  return { displays: out, virtualBounds: unionBounds(displays), scale };
}

/**
 * Windows returns a black frame for the very first desktopCapturer call after
 * launch. Burning one call at startup keeps the first real capture correct.
 */
async function warmUp() {
  try {
    await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 2, height: 2 },
      fetchWindowIcons: false,
    });
    await delay(120);
  } catch {
    /* warm-up is best-effort */
  }
}

module.exports = { delay, unionBounds, grabDisplays, warmUp };
