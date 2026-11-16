// Draws the logo of the app from one description of the artwork: the app icon and the tray icon (resources/), and the
// logo for the README (docs/media/logo.svg and logo.png). Run it when the design changes:
//   node scripts/make-icons.ts
// The logo is a closed book with a ribbon, and two linked rings on its cover. No image library: a tiny PNG encoder and
// supersampling are enough for these simple shapes, and the SVG is written from the same numbers.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { brand } from '../../../packages/brand/src/index.ts';

type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];
/** Whether a point is inside a shape. The coordinates are artwork units. */
type Inside = (x: number, y: number) => boolean;

const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = (table[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function png(width: number, height: number, pixel: (x: number, y: number) => Rgba): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const offset = y * (width * 4 + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Shapes

const roundedRect =
  (x0: number, y0: number, x1: number, y1: number, r: number): Inside =>
  (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const dx = Math.max(x0 + r - x, 0, x - (x1 - r));
    const dy = Math.max(y0 + r - y, 0, y - (y1 - r));
    return dx * dx + dy * dy <= r * r;
  };

const rect = (x0: number, y0: number, x1: number, y1: number): Inside => roundedRect(x0, y0, x1, y1, 0);

/** A ring with the outer radius `r` and the width `w`. */
const ring =
  (cx: number, cy: number, r: number, w: number): Inside =>
  (x, y) => {
    const d = Math.hypot(x - cx, y - cy);
    return d <= r && d >= r - w;
  };

/** The even-odd rule, as SVG does it for a path without holes. */
const polygon =
  (points: readonly (readonly [number, number])[]): Inside =>
  (x, y) => {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i] ?? [0, 0];
      const [xj, yj] = points[j] ?? [0, 0];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

const both =
  (a: Inside, b: Inside): Inside =>
  (x, y) =>
    a(x, y) && b(x, y);
const either =
  (a: Inside, b: Inside): Inside =>
  (x, y) =>
    a(x, y) || b(x, y);
const without =
  (a: Inside, b: Inside): Inside =>
  (x, y) =>
    a(x, y) && !b(x, y);

// ---------------------------------------------------------------------------------------------------------------------
// The artwork, in a square of 1024 units. The tile is a rounded square with a margin, as macOS icons have.

const CANVAS = 1024;
const color = {
  tileTop: '#4A7BF7',
  tileBottom: '#2154DC',
  pages: '#BED0FA',
  cover: '#FFFFFF',
  spine: '#E1E9FC',
  groove: '#C3D2F6',
  rings: '#2D5FE6',
  ribbon: '#FFB020',
} as const;

const tile = { x: 100, y: 100, size: 824, radius: 184 };
/** The numbers below are drawn for a book of 336 × 448 units, and scaled by this factor. */
const scale = 1.1;
const u = (n: number): number => Math.round(n * scale);
/** The front cover. The pages show a little to the right and below it. */
const book = { width: u(336), height: u(448), radius: u(30), pages: u(20) };
const spineWidth = u(60);
const grooveWidth = u(8);
/** The ribbon hangs out of the bottom of the pages, with a notch. */
const ribbon = { width: 56, tail: 56, notch: 24 };
const rings = { outer: u(62), width: u(22), offset: u(19) };
const titleLine = { widths: [u(124), u(84)], height: u(14) };

// The cover, the pages and the ribbon together are centered in the tile.
const left = Math.round(CANVAS / 2 - (book.width + book.pages) / 2);
const top = Math.round(CANVAS / 2 - (book.height + book.pages + ribbon.tail) / 2);
const right = left + book.width;
const bottom = top + book.height;
const faceLeft = left + spineWidth + grooveWidth;
const faceCenter = Math.round((faceLeft + right) / 2);
const ribbonLeft = faceCenter - ribbon.width / 2;
const ribbonRight = faceCenter + ribbon.width / 2;
const ribbonTop = top + book.pages;
const ribbonBottom = bottom + book.pages + ribbon.tail;
const ringsY = Math.round(top + book.height * 0.4);
const lineTop = Math.round(top + book.height * 0.68);
const lineGap = titleLine.height + u(16);

const rgb = (hex: string): Rgb => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];
const mix = (from: Rgb, to: Rgb, t: number): Rgb => [
  Math.round(from[0] + (to[0] - from[0]) * t),
  Math.round(from[1] + (to[1] - from[1]) * t),
  Math.round(from[2] + (to[2] - from[2]) * t),
];

interface Layer {
  readonly inside: Inside;
  readonly color: (x: number, y: number) => Rgb;
}
const flat = (inside: Inside, hex: string): Layer => ({ inside, color: () => rgb(hex) });

const coverShape = roundedRect(left, top, right, bottom, book.radius);
const lineShape = (index: number, width: number): Inside =>
  roundedRect(
    faceCenter - width / 2,
    lineTop + index * lineGap,
    faceCenter + width / 2,
    lineTop + index * lineGap + titleLine.height,
    titleLine.height / 2,
  );

/** The layers, from the back to the front. */
const layers: readonly Layer[] = [
  {
    inside: roundedRect(tile.x, tile.y, tile.x + tile.size, tile.y + tile.size, tile.radius),
    color: (_x, y) => mix(rgb(color.tileTop), rgb(color.tileBottom), (y - tile.y) / tile.size),
  },
  flat(
    roundedRect(left + book.pages, top + book.pages, right + book.pages, bottom + book.pages, book.radius),
    color.pages,
  ),
  flat(
    polygon([
      [ribbonLeft, ribbonTop],
      [ribbonRight, ribbonTop],
      [ribbonRight, ribbonBottom],
      [faceCenter, ribbonBottom - ribbon.notch],
      [ribbonLeft, ribbonBottom],
    ]),
    color.ribbon,
  ),
  flat(coverShape, color.cover),
  flat(both(coverShape, rect(left, top, left + spineWidth, bottom)), color.spine),
  flat(rect(left + spineWidth, top, faceLeft, bottom), color.groove),
  flat(
    either(
      ring(faceCenter - rings.offset, ringsY, rings.outer, rings.width),
      ring(faceCenter + rings.offset, ringsY, rings.outer, rings.width),
    ),
    color.rings,
  ),
  ...titleLine.widths.map((width, index) => flat(lineShape(index, width), color.groove)),
];

/** The same artwork as SVG, drawn only inside the tile. */
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${tile.x} ${tile.y} ${tile.size} ${tile.size}" width="${tile.size}" height="${tile.size}" role="img" aria-labelledby="title">
  <title id="title">${brand.displayName}</title>
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${color.tileTop}"/>
      <stop offset="1" stop-color="${color.tileBottom}"/>
    </linearGradient>
    <clipPath id="cover"><rect x="${left}" y="${top}" width="${book.width}" height="${book.height}" rx="${book.radius}"/></clipPath>
  </defs>
  <rect x="${tile.x}" y="${tile.y}" width="${tile.size}" height="${tile.size}" rx="${tile.radius}" fill="url(#tile)"/>
  <rect x="${left + book.pages}" y="${top + book.pages}" width="${book.width}" height="${book.height}" rx="${book.radius}" fill="${color.pages}"/>
  <path d="M${ribbonLeft} ${ribbonTop}H${ribbonRight}V${ribbonBottom}L${faceCenter} ${ribbonBottom - ribbon.notch}L${ribbonLeft} ${ribbonBottom}Z" fill="${color.ribbon}"/>
  <rect x="${left}" y="${top}" width="${book.width}" height="${book.height}" rx="${book.radius}" fill="${color.cover}"/>
  <rect x="${left}" y="${top}" width="${spineWidth}" height="${book.height}" fill="${color.spine}" clip-path="url(#cover)"/>
  <rect x="${left + spineWidth}" y="${top}" width="${grooveWidth}" height="${book.height}" fill="${color.groove}"/>
  <g fill="none" stroke="${color.rings}" stroke-width="${rings.width}">
    <circle cx="${faceCenter - rings.offset}" cy="${ringsY}" r="${rings.outer - rings.width / 2}"/>
    <circle cx="${faceCenter + rings.offset}" cy="${ringsY}" r="${rings.outer - rings.width / 2}"/>
  </g>
${titleLine.widths
  .map(
    (width, index) =>
      `  <rect x="${faceCenter - width / 2}" y="${lineTop + index * lineGap}" width="${width}" height="${titleLine.height}" rx="${titleLine.height / 2}" fill="${color.groove}"/>`,
  )
  .join('\n')}
</svg>
`;

// ---------------------------------------------------------------------------------------------------------------------
// Drawing

interface View {
  readonly left: number;
  readonly top: number;
  readonly size: number;
}

/** The layers as a PNG of `size` pixels, for the part of the artwork in `view`. Each pixel takes n × n samples. */
function drawLayers(size: number, view: View, n: number): Buffer {
  const reversed = [...layers].reverse();
  return png(size, size, (px, py) => {
    let r = 0;
    let g = 0;
    let b = 0;
    let hits = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const x = view.left + ((px + (i + 0.5) / n) * view.size) / size;
        const y = view.top + ((py + (j + 0.5) / n) * view.size) / size;
        const layer = reversed.find((candidate) => candidate.inside(x, y));
        if (!layer) continue;
        const [lr, lg, lb] = layer.color(x, y);
        r += lr;
        g += lg;
        b += lb;
        hits++;
      }
    }
    return hits === 0
      ? [0, 0, 0, 0]
      : [Math.round(r / hits), Math.round(g / hits), Math.round(b / hits), Math.round((255 * hits) / (n * n))];
  });
}

/** A black shape with alpha, for the tray: `inside` takes the units of a square of 16. */
function drawMask(size: number, inside: Inside, n: number): Buffer {
  return png(size, size, (px, py) => {
    let hits = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (inside(((px + (i + 0.5) / n) * 16) / size, ((py + (j + 0.5) / n) * 16) / size)) hits++;
      }
    }
    return [0, 0, 0, Math.round((255 * hits) / (n * n))];
  });
}

/**
 * The tray icon is a template image on macOS: black with alpha. It is the book alone, with a groove for the spine and
 * the ribbon below. The numbers are whole pixels at 16, so the edges stay sharp.
 */
const trayBook = without(roundedRect(3, 1, 12, 13, 1), rect(5, 0, 6, 14));
const trayRibbon = polygon([
  [8, 13],
  [10, 13],
  [10, 15],
  [9, 14.25],
  [8, 15],
]);
const trayShape = either(trayBook, trayRibbon);

const resources = path.join(import.meta.dirname, '..', 'resources');
const media = path.join(import.meta.dirname, '..', '..', '..', 'docs', 'media');
mkdirSync(media, { recursive: true });

const whole: View = { left: 0, top: 0, size: CANVAS };
const tileOnly: View = { left: tile.x, top: tile.y, size: tile.size };

writeFileSync(path.join(resources, 'icon.png'), drawLayers(1024, whole, 6));
writeFileSync(path.join(resources, 'trayTemplate.png'), drawMask(16, trayShape, 8));
writeFileSync(path.join(resources, 'trayTemplate@2x.png'), drawMask(32, trayShape, 8));
writeFileSync(path.join(media, 'logo.svg'), svg);
writeFileSync(path.join(media, 'logo.png'), drawLayers(512, tileOnly, 6));
process.stdout.write('icons written to resources/, the logo to docs/media/\n');
