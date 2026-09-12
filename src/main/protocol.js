'use strict';

const { protocol } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const SCHEME = 'app';
const ROOT = path.join(__dirname, '..', '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/**
 * A real, standard, secure scheme for the renderer bundles. Loading the UI over
 * `app://` instead of `file://` is what makes ES modules, fetch and workers
 * behave the way they do on the web.
 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

function resolveTarget(requestUrl) {
  const url = new URL(requestUrl);
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const target = path.resolve(ROOT, relative);
  // Refuse anything that climbs out of the app directory.
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;
  return target;
}

function handle() {
  protocol.handle(SCHEME, async (request) => {
    const target = resolveTarget(request.url);
    if (!target) return new Response('Forbidden', { status: 403 });
    try {
      const body = await fs.readFile(target);
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      return new Response(body, { status: 200, headers: { 'content-type': type } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

/** `app://snapkey/renderer/editor/index.html` */
function url(relativePath) {
  return `${SCHEME}://snapkey/${relativePath.replace(/^\/+/, '')}`;
}

module.exports = { SCHEME, registerScheme, handle, url };
