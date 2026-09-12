'use strict';

const { nativeImage } = require('electron');

/** Decode a PNG into { width, height, bgra } or null if the buffer is unusable. */
function decode(pngBuffer) {
  const image = nativeImage.createFromBuffer(pngBuffer);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const bgra = image.toBitmap();
  if (!width || !height || bgra.length !== width * height * 4) return null;
  return { width, height, bgra };
}

/**
 * Crop a display's screenshot. `rect` is in DIP relative to the display's
 * top-left; the source PNG is the same area at native pixel density, so the
 * coordinates are scaled by the ratio of the two.
 */
function crop(pngBuffer, rect) {
  const src = decode(pngBuffer);
  if (!src) return pngBuffer;

  const scaleX = src.width / rect.displayWidth;
  const scaleY = src.height / rect.displayHeight;

  const sx = Math.max(0, Math.round(rect.x * scaleX));
  const sy = Math.max(0, Math.round(rect.y * scaleY));
  const sw = Math.min(src.width - sx, Math.max(1, Math.round(rect.width * scaleX)));
  const sh = Math.min(src.height - sy, Math.max(1, Math.round(rect.height * scaleY)));

  if (sw <= 0 || sh <= 0) return pngBuffer;
  if (sx === 0 && sy === 0 && sw === src.width && sh === src.height) return pngBuffer;

  const out = Buffer.alloc(sw * sh * 4);
  for (let row = 0; row < sh; row += 1) {
    const from = ((sy + row) * src.width + sx) * 4;
    src.bgra.copy(out, row * sw * 4, from, from + sw * 4);
  }
  return nativeImage.createFromBitmap(out, { width: sw, height: sh }).toPNG();
}

/**
 * Blit every display into one image laid out in virtual-desktop space.
 * `scale` is the pixel density of the finished stage; displays captured at a
 * different density are resampled with nearest-neighbour so text stays legible
 * instead of turning to mush.
 */
function composite(displays, virtualBounds, scale) {
  const width = Math.max(1, Math.round(virtualBounds.width * scale));
  const height = Math.max(1, Math.round(virtualBounds.height * scale));
  const out = Buffer.alloc(width * height * 4);

  for (const display of displays) {
    const src = decode(display.png);
    if (!src) continue;

    const dx = Math.round((display.bounds.x - virtualBounds.x) * scale);
    const dy = Math.round((display.bounds.y - virtualBounds.y) * scale);
    const dw = Math.round(display.bounds.width * scale);
    const dh = Math.round(display.bounds.height * scale);

    const identity = src.width === dw && src.height === dh;
    for (let row = 0; row < dh; row += 1) {
      const outY = dy + row;
      if (outY < 0 || outY >= height) continue;
      const srcY = identity ? row : Math.min(src.height - 1, Math.floor((row * src.height) / dh));
      for (let col = 0; col < dw; col += 1) {
        const outX = dx + col;
        if (outX < 0 || outX >= width) continue;
        const srcX = identity ? col : Math.min(src.width - 1, Math.floor((col * src.width) / dw));
        const from = (srcY * src.width + srcX) * 4;
        const to = (outY * width + outX) * 4;
        out[to] = src.bgra[from];
        out[to + 1] = src.bgra[from + 1];
        out[to + 2] = src.bgra[from + 2];
        out[to + 3] = 255;
      }
    }
  }

  return nativeImage.createFromBitmap(out, { width, height }).toPNG();
}

/** Fill an opaque background then draw the image centred, for letterboxed previews. */
function thumbnail(pngBuffer, maxEdge = 320) {
  const image = nativeImage.createFromBuffer(pngBuffer);
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  const ratio = Math.min(1, maxEdge / Math.max(width, height));
  return image
    .resize({
      width: Math.max(1, Math.round(width * ratio)),
      height: Math.max(1, Math.round(height * ratio)),
      quality: 'good',
    })
    .toDataURL();
}

module.exports = { crop, composite, thumbnail, decode };
