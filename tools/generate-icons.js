/**
 * Renders the extension icons (a d20 silhouette) as PNGs, so the repo carries
 * no binary blobs that cannot be regenerated: `node tools/generate-icons.js`.
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 32, 48, 128];
const SAMPLES = 4; // supersampling factor for smooth edges

const BACKGROUND = [32, 38, 41, 255];
const DIE = [228, 7, 18, 255];
const FACE = [250, 248, 244, 255];

const polygon = (cx, cy, radius, sides, rotation) =>
  Array.from({ length: sides }, (_, i) => {
    const angle = rotation + (i * 2 * Math.PI) / sides;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)];
  });

function insidePolygon(points, x, y) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function blend(target, offset, color, coverage) {
  for (let c = 0; c < 3; c += 1) {
    target[offset + c] = Math.round(target[offset + c] * (1 - coverage) + color[c] * coverage);
  }
  target[offset + 3] = Math.max(target[offset + 3], Math.round(color[3] * coverage));
}

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const cornerRadius = size * 0.18;
  const die = polygon(size / 2, size / 2, size * 0.42, 6, -Math.PI / 2);
  const face = polygon(size / 2, size * 0.52, size * 0.23, 3, -Math.PI / 2);

  const insideRoundedSquare = (x, y) => {
    const inset = size * 0.02;
    const min = inset;
    const max = size - inset;
    if (x < min || y < min || x > max || y > max) return false;
    const dx = Math.max(min + cornerRadius - x, 0, x - (max - cornerRadius));
    const dy = Math.max(min + cornerRadius - y, 0, y - (max - cornerRadius));
    return dx * dx + dy * dy <= cornerRadius * cornerRadius;
  };

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let bg = 0;
      let dieHits = 0;
      let faceHits = 0;
      for (let sy = 0; sy < SAMPLES; sy += 1) {
        for (let sx = 0; sx < SAMPLES; sx += 1) {
          const x = px + (sx + 0.5) / SAMPLES;
          const y = py + (sy + 0.5) / SAMPLES;
          if (insideRoundedSquare(x, y)) bg += 1;
          if (insidePolygon(die, x, y)) dieHits += 1;
          if (insidePolygon(face, x, y)) faceHits += 1;
        }
      }
      const total = SAMPLES * SAMPLES;
      const offset = (py * size + px) * 4;
      if (bg > 0) blend(pixels, offset, BACKGROUND, bg / total);
      if (dieHits > 0) blend(pixels, offset, DIE, dieHits / total);
      if (faceHits > 0) blend(pixels, offset, FACE, faceHits / total);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

function toPng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // no per-scanline filter
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(__dirname, '..', 'src', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, toPng(size, renderIcon(size)));
  console.log(`wrote ${path.relative(path.join(__dirname, '..'), file)}`);
}
