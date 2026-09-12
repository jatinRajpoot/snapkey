'use strict';

const { app } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { thumbnail } = require('./compose');

const MAX_ITEMS = 60;
const THUMB_DIR = 'thumbnails';

function storePath() {
  return path.join(app.getPath('userData'), 'recents.json');
}

function thumbDir() {
  return path.join(app.getPath('userData'), THUMB_DIR);
}

function read() {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRaw(items) {
  try {
    await fsp.mkdir(path.dirname(storePath()), { recursive: true });
    await fsp.writeFile(storePath(), `${JSON.stringify(items, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.error('[snapkey] could not persist recents:', err.message);
  }
}

/** Newest first, de-duplicated by id. */
async function add(entry) {
  const items = read().filter((item) => item.id !== entry.id);
  items.unshift(entry);
  const trimmed = items.slice(0, MAX_ITEMS);
  await writeRaw(trimmed);
  return trimmed;
}

/** Strip the derived thumbnail field before anything is written back to disk. */
function strip(items) {
  return items.map(({ thumbnail: _thumbnail, ...rest }) => rest);
}

async function remove(id) {
  const remaining = read().filter((item) => item.id !== id);
  await writeRaw(remaining);
  try {
    await fsp.rm(path.join(thumbDir(), `${id}.txt`), { force: true });
  } catch {
    /* ignore */
  }
  return remaining;
}

async function clear() {
  await writeRaw([]);
  try {
    await fsp.rm(thumbDir(), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return [];
}

/** Build a thumbnail for a saved PNG, cached on disk by id. */
async function makeThumbnail(id, pngOrPath) {
  try {
    const buffer = Buffer.isBuffer(pngOrPath) ? pngOrPath : await fsp.readFile(pngOrPath);
    const dataUrl = thumbnail(buffer, 360);
    if (!dataUrl) return null;
    await fsp.mkdir(thumbDir(), { recursive: true });
    await fsp.writeFile(path.join(thumbDir(), `${id}.txt`), dataUrl, 'utf8');
    return dataUrl;
  } catch {
    return null;
  }
}

async function readThumbnail(id) {
  try {
    return await fsp.readFile(path.join(thumbDir(), `${id}.txt`), 'utf8');
  } catch {
    return null;
  }
}

function exists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/** Lazily backfill thumbnails and drop entries whose file has gone away. */
async function list() {
  const items = read();
  const out = [];
  let dirty = false;

  for (const item of items) {
    if (!exists(item.filePath)) {
      dirty = true;
      continue;
    }
    let thumb = await readThumbnail(item.id);
    if (!thumb) {
      thumb = await makeThumbnail(item.id, item.filePath);
      dirty = !!thumb;
    }
    out.push({ ...item, thumbnail: thumb });
  }

  // Drop entries whose file has gone away.
  if (out.length !== items.length) await writeRaw(strip(out));
  return out;
}

module.exports = { add, list, remove, clear, makeThumbnail, thumbDir, storePath };
