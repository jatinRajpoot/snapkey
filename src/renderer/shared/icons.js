/** Icon path data, drawn on a 24×24 grid with stroke-linecap: round. */

const S = (d, extra = '') => `<path d="${d}" ${extra}/>`;
const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
const FILL = 'fill="currentColor"';

export const ICONS = {
  select: S('M5 3.5 19 11.2l-6.1 1.6-2.6 5.8z', STROKE),
  pen: S('M4 20.2c.6-2.2 1.4-3.6 2.6-4.3M6.6 15.9 15.9 6.6a2.4 2.4 0 0 1 3.4 3.4L10 19.3l-4.2 1.2z', STROKE),
  highlight: S('M6 14.5 13.6 6.9a2 2 0 0 1 2.8 0l1.7 1.7a2 2 0 0 1 0 2.8L10.5 19H6z', STROKE) + S('M4 21h16', STROKE),
  line: S('M5 19 19 5', STROKE),
  arrow: S('M5.5 18.5 18 6', STROKE) + S('M11.4 6H18v6.6', STROKE),
  rect: S('M3.8 5.2h16.4v13.6H3.8z', STROKE),
  ellipse: S('M12 5.4c4.4 0 8 3 8 6.6s-3.6 6.6-8 6.6-8-3-8-6.6 3.6-6.6 8-6.6z', STROKE),
  text: S('M5 6.5V5h14v1.5M12 5v14M9 19h6', STROKE),
  step: S('M12 3.6a8.4 8.4 0 1 1 0 16.8 8.4 8.4 0 0 1 0-16.8z', STROKE) + S('M11 9.4l1.6-1v6.2', STROKE),
  blur: S('M4.5 9h3l1.4-2.6h6.2L16.5 9h3v9.4h-15z', STROKE) + S('M12 15.6a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z', STROKE),
  undo: S('M8.5 8.5H15a4.5 4.5 0 0 1 0 9h-4M8.5 8.5 12 5M8.5 8.5 12 12', STROKE),
  redo: S('M15.5 8.5H9a4.5 4.5 0 0 0 0 9h4M15.5 8.5 12 5M15.5 8.5 12 12', STROKE),
  copy: S('M9 9.5A1.5 1.5 0 0 1 10.5 8h7A1.5 1.5 0 0 1 19 9.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 9 16.5z', STROKE) + S('M15 5.6H6.5A1.5 1.5 0 0 0 5 7.1V16', STROKE),
  save: S('M5 4.6h10.6L19 8v11.4H5z', STROKE) + S('M8.4 4.6v5h7v-5M8.4 19.4v-5.6h7.2v5.6', STROKE),
  close: S('M6 6l12 12M18 6 6 18', STROKE),
  check: S('M5 12.8 9.6 17.4 19 6.6', STROKE),
  crop: S('M7 3v14h14', STROKE) + S('M3 7h14v14', STROKE),
  fullscreen: S('M4.5 9V4.6H9M15 4.6h4.5V9M19.5 15v4.4H15M9 19.4H4.5V15', STROKE),
  screens: S('M3.6 5.4h11.2v7.4H3.6z', STROKE) + S('M9.2 15.6h11.2V8.2', STROKE),
  folder: S('M3.6 6.6h5.1l1.8 2.2h9.9v8.8H3.6z', STROKE),
  keyboard: S('M3.4 7.4h17.2v9.2H3.4z', STROKE) + S('M7 10.5h.01M10.4 10.5h.01M13.8 10.5h.01M17.2 10.5h.01M8 13.8h8', STROKE),
  magnifier: S('M11 4.4a6.6 6.6 0 1 1 0 13.2 6.6 6.6 0 0 1 0-13.2z', STROKE) + S('M15.8 15.8 20 20', STROKE),
  image: S('M4 5.4h16v13.2H4z', STROKE) + S('M8.4 10.4a1.3 1.3 0 1 0 0-2.6 1.3 1.3 0 0 0 0 2.6z', STROKE) + S('M4.6 16.4 9.4 12l3.4 3 2.6-2.2 4 3.6', STROKE),
  trash: S('M5.4 7h13.2M9.4 7V5.2h5.2V7M7 7l.9 12.2h8.2L17 7', STROKE),
  plus: S('M12 5.4v13.2M5.4 12h13.2', STROKE),
  minus: S('M5.4 12h13.2', STROKE),
  sparkle: S('M12 3.8l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z', STROKE),
  info: S('M12 3.8a8.2 8.2 0 1 1 0 16.4 8.2 8.2 0 0 1 0-16.4z', STROKE) + S('M12 11v5.2M12 7.8h.01', STROKE),
  download: S('M12 4v10.6M7.6 10.6 12 15l4.4-4.4M5 19.4h14', STROKE),
  refresh: S('M19 12a7 7 0 0 1-12.4 4.5M5 12a7 7 0 0 1 12.4-4.5', STROKE) + S('M17.4 3.6v3.9h-3.9M6.6 20.4v-3.9h3.9', STROKE),
  window: S('M3.6 5h16.8v14H3.6z', STROKE) + S('M3.6 9h16.8M6.4 7h.01M8.8 7h.01', STROKE),
};

/**
 * Build an `<svg>` icon element. Icons are instances, never shared nodes, so
 * they can be appended in several places at once.
 */
export function icon(name, size = 18) {
  const markup = ICONS[name];
  if (!markup) return document.createComment(`missing icon: ${name}`);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = markup;
  return svg;
}

/** Same, as an HTML string — handy inside template literals. */
export function iconHTML(name, size = 18) {
  const markup = ICONS[name];
  if (!markup) return '';
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">${markup}</svg>`;
}
