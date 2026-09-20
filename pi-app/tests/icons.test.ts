import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join } from 'node:path';
import test from 'node:test';
import { inflateSync } from 'node:zlib';

const require = createRequire(import.meta.url);
type Bounds = { x: number; y: number; width: number; height: number };
const { ICO_SIZES, PNG_SIZE, ICON_FILL_RATIO, fitIconViewBox, buildIco } = require('../scripts/icons.cjs') as { ICO_SIZES: number[]; PNG_SIZE: number; ICON_FILL_RATIO: number; fitIconViewBox: (bounds: Bounds) => Bounds; buildIco: (images: Array<{ size: number; png: Buffer }>) => Buffer };
const assets = new URL('../assets/icons/', import.meta.url);
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

/** Decode our non-interlaced RGBA PNGs, including all five standard PNG row filters. */
function rgbaPng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const width = png.readUInt32BE(16); const height = png.readUInt32BE(20);
  assert.equal(png[24], 8); assert.equal(png[25], 6); assert.equal(png[28], 0);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset); const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks)); const stride = width * 4;
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const a = x >= 4 ? pixels[index - 4] : 0; const b = y ? pixels[index - stride] : 0; const c = y && x >= 4 ? pixels[index - stride - 4] : 0;
      const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? Math.floor((a + b) / 2) : pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      pixels[index] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, pixels };
}

function verifyTransparentOwl(png: Buffer, size: number): void {
  const { width, height, pixels } = rgbaPng(png); assert.equal(width, size); assert.equal(height, size);
  for (const index of [3, (size - 1) * 4 + 3, (size - 1) * size * 4 + 3, pixels.length - 1]) assert.equal(pixels[index], 0, 'Canvas corners must be transparent.');
  const center = (Math.floor(size / 2) * size + Math.floor(size / 2)) * 4;
  assert.equal(pixels[center + 3], 255, 'Owl body must be opaque.');
  assert.ok(pixels[center] > pixels[center + 1] * 2, 'Existing owl body must remain red.');
  let left = size; let top = size; let right = -1; let bottom = -1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (pixels[(y * size + x) * 4 + 3] > 0) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  const longest = Math.max(right - left + 1, bottom - top + 1);
  assert.ok(Math.abs(longest - size * ICON_FILL_RATIO) <= 2, 'The complete owl should fill about 92% of the icon, with at most two pixels of rasterization rounding.');
  if (size >= 128) assert.ok(longest / size >= 0.9 && longest / size <= 0.94, 'Large icons must keep the requested visible size.');
}

test('owl ICO includes independent transparent images at every supported Windows size', () => {
  const ico = readFileSync(new URL('sleepclaw.ico', assets));
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), ICO_SIZES.length);
  let next = 6 + ICO_SIZES.length * 16;
  const images = ICO_SIZES.map((size, index) => {
    const entry = 6 + index * 16;
    assert.equal(ico[entry] || 256, size); assert.equal(ico[entry + 1] || 256, size);
    assert.equal(ico.readUInt16LE(entry + 4), 1); assert.equal(ico.readUInt16LE(entry + 6), 32);
    const length = ico.readUInt32LE(entry + 8); const offset = ico.readUInt32LE(entry + 12);
    assert.equal(offset, next); assert.ok(offset + length <= ico.length); next += length;
    const png = ico.subarray(offset, offset + length); verifyTransparentOwl(png, size);
    return { size, png };
  });
  assert.equal(next, ico.length); assert.deepEqual(buildIco(images), ico);
  assert.throws(() => buildIco(images.slice(1)), /Every required icon size/);
  verifyTransparentOwl(readFileSync(new URL('sleepclaw.png', assets)), PNG_SIZE);
});

test('icon provenance matches the existing SVG and committed outputs', () => {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', assets), 'utf8'));
  assert.equal(manifest.source, 'src/renderer/assets/owl-mark.svg');
  assert.equal(manifest.sourceSha256, sha256(readFileSync(new URL('../src/renderer/assets/owl-mark.svg', import.meta.url), 'utf8').replace(/\r\n/g, '\n')));
  assert.deepEqual(manifest.icoSizes, ICO_SIZES); assert.equal(manifest.pngSize, PNG_SIZE);
  assert.equal(manifest.framing.method, 'nontransparent-source-bounds');
  assert.equal(manifest.framing.fillRatio, ICON_FILL_RATIO);
  assert.deepEqual(manifest.framing.viewBox, fitIconViewBox(manifest.framing.sourceBounds));
  for (const name of ['sleepclaw.ico', 'sleepclaw.png']) assert.equal(manifest.sha256[name], sha256(readFileSync(new URL(name, assets))));
});

test('icon framing centers the complete owl without stretching and keeps a safe transparent margin', () => {
  for (const bounds of [{ x: 166, y: 140, width: 922, height: 964 }, { x: -20, y: 10, width: 200, height: 100 }]) {
    const frame = fitIconViewBox(bounds);
    assert.equal(frame.width, frame.height);
    assert.ok(Math.abs(Math.max(bounds.width, bounds.height) / frame.width - 0.92) < 1e-12);
    assert.ok(Math.abs(frame.x + frame.width / 2 - bounds.x - bounds.width / 2) < 1e-9);
    assert.ok(Math.abs(frame.y + frame.height / 2 - bounds.y - bounds.height / 2) < 1e-9);
    for (const margin of [bounds.x - frame.x, bounds.y - frame.y, frame.x + frame.width - bounds.x - bounds.width, frame.y + frame.height - bounds.y - bounds.height]) assert.ok(margin / frame.width >= 0.04 - 1e-12);
  }
  assert.throws(() => fitIconViewBox({ x: 0, y: 0, width: 0, height: 10 }), /finite and nonempty/);
});

test('window, executable, installer and Squirrel identity consistently use the owl', () => {
  const forge = require('../forge.config.cjs');
  assert.equal(basename(forge.packagerConfig.icon), 'sleepclaw.ico');
  const iconDirectory = forge.packagerConfig.extraResource.find((path: string) => basename(path) === 'icons');
  assert.ok(iconDirectory); assert.equal(forge.packagerConfig.icon, join(iconDirectory, 'sleepclaw.ico'));
  const squirrel = forge.makers.find((maker: { name: string }) => maker.name === '@electron-forge/maker-squirrel').config;
  assert.equal(squirrel.setupIcon, forge.packagerConfig.icon);
  assert.equal(squirrel.skipUpdateIcon, undefined, 'Update.exe must retain icon stamping.');
  assert.equal(squirrel.iconUrl, 'https://raw.githubusercontent.com/okht/sleepclaw/main/pi-app/assets/icons/sleepclaw.ico');
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  assert.ok(main.includes(`app.setAppUserModelId('com.squirrel.${squirrel.name}.${forge.packagerConfig.executableName}')`));
  assert.match(main, /new BrowserWindow\(\{[^\n]+\bicon,/);
  assert.ok(main.includes("join(process.resourcesPath, 'icons', iconFile)"));
  assert.ok(main.includes("resolve(__dirname, '..', '..', 'assets', 'icons', iconFile)"));
});
