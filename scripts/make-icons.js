/**
 * Generates the app icons with zero dependencies.
 * Writes assets/icon.png (256x256) which electron-builder converts to .ico.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = path.join(__dirname, '..', 'assets');

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const S = size / 256; // design is authored at 256
  const cx = size / 2;
  const cy = size / 2;
  const radius = 56 * S;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const fx = x + 0.5;
      const fy = y + 0.5;

      // Rounded-square signed distance
      const qx = Math.abs(fx - cx) - (size / 2 - 10 * S - radius);
      const qy = Math.abs(fy - cy) - (size / 2 - 10 * S - radius);
      const dist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      const inside = 1 - smooth(-1 * S, 1 * S, dist);

      // Diagonal gradient, indigo -> violet -> cyan
      const t = clamp01((fx / size) * 0.45 + (fy / size) * 0.55);
      let r = lerp(96, 56, t);
      let g = lerp(78, 189, t);
      let b = lerp(240, 248, t);
      const glow = Math.pow(clamp01(1 - Math.hypot(fx - size * 0.32, fy - size * 0.24) / (size * 0.75)), 2);
      r = clamp01((r + glow * 90) / 255);
      g = clamp01((g + glow * 70) / 255);
      b = clamp01((b + glow * 40) / 255);

      let a = inside;

      // Crop-mark glyph: four corner brackets + crosshair, knocked out of the tile
      const m = 74 * S; // margin from center
      const arm = 30 * S; // bracket arm length
      const thick = 11 * S;
      const bar = (v, from, to) => smooth(from - thick / 2, from + thick / 2, v) * (1 - smooth(to - thick / 2, to + thick / 2, v));
      const hx = bar(fx, cx - m, cx - m + arm) + bar(fx, cx + m - arm, cx + m);
      const vy = bar(fy, cy - m, cy - m + arm) + bar(fy, cy + m - arm, cy + m);
      const bracketH = clamp01(hx) * clamp01(bar(fy, cy - m - thick, cy - m + thick) + bar(fy, cy + m - thick, cy + m + thick));
      const bracketV = clamp01(vy) * clamp01(bar(fx, cx - m - thick, cx - m + thick) + bar(fx, cx + m - thick, cx + m + thick));

      const dot = 1 - smooth(3 * S, 6 * S, Math.hypot(fx - cx, fy - cy));
      const cross = clamp01(bar(fx, cx - 44 * S, cx - 22 * S)) * (1 - smooth(3.5 * S, 5 * S, Math.abs(fy - cy)))
        + clamp01(bar(fx, cx + 22 * S, cx + 44 * S)) * (1 - smooth(3.5 * S, 5 * S, Math.abs(fy - cy)))
        + clamp01(bar(fy, cy - 44 * S, cy - 22 * S)) * (1 - smooth(3.5 * S, 5 * S, Math.abs(fx - cx)))
        + clamp01(bar(fy, cy + 22 * S, cy + 44 * S)) * (1 - smooth(3.5 * S, 5 * S, Math.abs(fx - cx)));

      const glyph = clamp01(bracketH + bracketV + cross + dot);
      if (glyph > 0) {
        // Blend toward near-white where the glyph is, so the mark reads on any backdrop
        const k = glyph * inside;
        r = lerp(r, 0.98, k);
        g = lerp(g, 0.99, k);
        b = lerp(b, 1.0, k);
      }

      const i = (y * size + x) * 4;
      px[i] = Math.round(clamp01(r) * 255);
      px[i + 1] = Math.round(clamp01(g) * 255);
      px[i + 2] = Math.round(clamp01(b) * 255);
      px[i + 3] = Math.round(a * 255);
    }
  }
  return px;
}

function main() {
  fs.mkdirSync(ASSETS, { recursive: true });
  for (const [name, size] of [['icon.png', 256], ['tray.png', 32]]) {
    const file = path.join(ASSETS, name);
    fs.writeFileSync(file, encodePNG(size, size, drawIcon(size)));
    console.log('wrote', path.relative(process.cwd(), file));
  }
}

main();
