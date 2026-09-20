/*
 * Rebuild the existing owl SVG as transparent Windows icons, without new dependencies:
 *   node scripts/icons.cjs          Generate the committed PNG/ICO and provenance manifest.
 *   node scripts/icons.cjs --check  Re-render and verify committed assets byte for byte.
 * Uses this project's pinned Electron canvas in a hidden, isolated, network-disabled
 * helper. No SleepClaw window, health data, model, or debugging port is involved.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } = require('node:fs');
const { join, resolve, sep } = require('node:path');

const root = resolve(__dirname, '..');
const sourceRelative = 'src/renderer/assets/owl-mark.svg';
const output = join(root, 'assets', 'icons');
const ICO_SIZES = Object.freeze([16, 20, 24, 32, 40, 48, 64, 128, 256]);
const PNG_SIZE = 512;
const ICON_FILL_RATIO = 0.92;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const hash = value => createHash('sha256').update(value).digest('hex');

/** Uniformly fit the complete visible owl, preserving a 4% margin on its longest axis. */
function fitIconViewBox(bounds) {
  assert.ok(['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key])) && bounds.width > 0 && bounds.height > 0, 'Visible SVG bounds must be finite and nonempty.');
  const side = Math.max(bounds.width, bounds.height) / ICON_FILL_RATIO;
  return { x: bounds.x + bounds.width / 2 - side / 2, y: bounds.y + bounds.height / 2 - side / 2, width: side, height: side };
}

/** ICO directory plus independent RGBA PNG images, one at each Windows DPI size. */
function buildIco(images) {
  assert.deepEqual(images.map(image => image.size), ICO_SIZES, 'Every required icon size must be supplied exactly once.');
  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(1, 2); directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  for (const [index, { size, png }] of images.entries()) {
    assert.ok(Buffer.isBuffer(png) && png.subarray(0, 8).equals(PNG_SIGNATURE), 'Icon payload must be PNG.');
    assert.ok(png.readUInt32BE(16) === size && png.readUInt32BE(20) === size && png[24] === 8 && png[25] === 6, 'Icon payload must match its RGBA dimensions.');
    const entry = 6 + index * 16;
    directory[entry] = directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4); directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(png.length, entry + 8); directory.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  }
  return Buffer.concat([directory, ...images.map(image => image.png)]);
}

async function render() {
  const { app, BrowserWindow, nativeImage } = require('electron');
  const userData = resolve(process.env.SLEEPCLAW_ICON_HOME || '');
  assert.ok(userData.startsWith(`${join(root, '.smoke')}${sep}icons-`) && !lstatSync(userData).isSymbolicLink(), 'Icon rendering requires an isolated helper home.');
  app.setName('SleepClaw Icon Generator'); app.setPath('userData', userData);
  app.disableHardwareAcceleration(); app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('force-color-profile', 'srgb');
  // Keep output provenance stable across Git's Windows/Unix line-ending conversion.
  const source = readFileSync(join(root, sourceRelative), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!/(?:<script|<foreignObject|<!ENTITY|\b(?:href|src)\s*=|\bon[a-z]+\s*=)/i.test(source), 'Only a self-contained static SVG may be rendered.');
  await app.whenReady();
  let window;
  try {
    window = new BrowserWindow({ width: 16, height: 16, show: false, transparent: true, frame: false, skipTaskbar: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, partition: 'sleepclaw-icon-render' } });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, done) => done(false));
    window.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: !details.url.startsWith('data:') }));
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; connect-src \'none\'"><title>Isolated icon renderer</title>'));
    // Measure all nontransparent pixels at the original vector dimensions. Only
    // the exported icon viewBox is tightened; the UI source SVG stays untouched.
    const measured = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(source).toString('base64')}`)};
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d', { alpha: true }); context.drawImage(image, 0, 0);
      const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let left = canvas.width; let top = canvas.height; let right = -1; let bottom = -1;
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        if (rgba[(y * canvas.width + x) * 4 + 3] > 0) {
          left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
      }
      if (right < left || bottom < top) throw new Error('The SVG must contain a visible owl.');
      return { x: left, y: top, width: right - left + 1, height: bottom - top + 1, canvasWidth: canvas.width, canvasHeight: canvas.height };
    })()`);
    const originalViewBox = source.match(/\bviewBox="([^"]+)"/)[1].trim().split(/\s+/).map(Number);
    assert.ok(originalViewBox.length === 4 && originalViewBox.every(Number.isFinite) && originalViewBox[2] > 0 && originalViewBox[3] > 0, 'The source must have a valid viewBox.');
    const bounds = { x: originalViewBox[0] + measured.x * originalViewBox[2] / measured.canvasWidth,
      y: originalViewBox[1] + measured.y * originalViewBox[3] / measured.canvasHeight,
      width: measured.width * originalViewBox[2] / measured.canvasWidth, height: measured.height * originalViewBox[3] / measured.canvasHeight };
    const iconViewBox = fitIconViewBox(bounds);
    const iconSource = source.replace(/\bviewBox="[^"]+"/, `viewBox="${iconViewBox.x} ${iconViewBox.y} ${iconViewBox.width} ${iconViewBox.height}"`);
    const rendered = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image();
      image.src = ${JSON.stringify(`data:image/svg+xml;base64,${Buffer.from(iconSource).toString('base64')}`)};
      await image.decode();
      return ${JSON.stringify([...ICO_SIZES, PNG_SIZE])}.map(size => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        const context = canvas.getContext('2d', { alpha: true });
        context.drawImage(image, 0, 0, size, size);
        const rgba = context.getImageData(0, 0, size, size).data;
        const corners = [3, (size - 1) * 4 + 3, (size - 1) * size * 4 + 3, rgba.length - 1];
        if (!corners.every(offset => rgba[offset] === 0) || rgba[(Math.floor(size / 2) * size + Math.floor(size / 2)) * 4 + 3] !== 255) throw new Error('Expected a transparent background and an opaque owl.');
        return { size, png: canvas.toDataURL('image/png').split(',')[1] };
      });
    })()`);
    const images = rendered.map(({ size, png }) => ({ size, png: Buffer.from(png, 'base64') }));
    const ico = buildIco(images.filter(image => image.size <= 256));
    const png = images.find(image => image.size === PNG_SIZE).png;
    // Verify with Electron's native decoder as well as the directory checks.
    assert.deepEqual(nativeImage.createFromBuffer(png).getSize(), { width: PNG_SIZE, height: PNG_SIZE });
    const manifest = Buffer.from(JSON.stringify({ source: sourceRelative, sourceSha256: hash(source), renderer: `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`, framing: { method: 'nontransparent-source-bounds', fillRatio: ICON_FILL_RATIO, sourceBounds: bounds, viewBox: iconViewBox }, icoSizes: ICO_SIZES, pngSize: PNG_SIZE, sha256: { 'sleepclaw.ico': hash(ico), 'sleepclaw.png': hash(png) } }, null, 2) + '\n');
    const files = [['sleepclaw.ico', ico], ['sleepclaw.png', png], ['manifest.json', manifest]];
    if (process.argv.includes('--check')) {
      for (const [name, content] of files) assert.ok(readFileSync(join(output, name)).equals(content), `${name} differs from the current SVG rendering. Regenerate with node scripts/icons.cjs.`);
    } else {
      mkdirSync(output, { recursive: true });
      for (const [name, content] of files) writeFileSync(join(output, name), content);
    }
    if (process.platform === 'win32') assert.ok(!nativeImage.createFromPath(join(output, 'sleepclaw.ico')).isEmpty(), 'Windows must decode the generated ICO.');
    console.log(`${process.argv.includes('--check') ? 'Verified' : 'Generated'} transparent owl icons: ${ICO_SIZES.join(', ')} px ICO; ${PNG_SIZE} px PNG.`);
  } finally { window?.destroy(); app.quit(); }
}

async function launchRenderer() {
  const smoke = join(root, '.smoke');
  if (existsSync(smoke)) assert.ok(!lstatSync(smoke).isSymbolicLink(), 'Helper root must not be a link.');
  mkdirSync(smoke, { recursive: true });
  assert.equal(realpathSync(smoke), join(realpathSync(root), '.smoke'));
  const home = mkdtempSync(join(smoke, 'icons-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/(?:API.?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|(?:^|_)PROXY$|^NODE_OPTIONS$|^ELECTRON_RUN_AS_NODE$|^SLEEPCLAW_)/i.test(key)));
  const child = spawn(require('electron'), [__filename, '--render', ...(process.argv.includes('--check') ? ['--check'] : [])], {
    windowsHide: true, cwd: root, env: { ...env, SLEEPCLAW_ICON_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
  const timer = setTimeout(stop, 45_000);
  process.once('exit', stop); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try { await new Promise((done, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error('Isolated icon renderer failed.'))); }); }
  finally { clearTimeout(timer); stop(); process.removeListener('exit', stop); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

module.exports = { ICO_SIZES, PNG_SIZE, ICON_FILL_RATIO, fitIconViewBox, buildIco };
// Electron's default-app bootstrap can load its main script without require.main.
if (require.main === module || (process.versions.electron && process.argv.includes('--render'))) {
  const operation = process.versions.electron ? render : launchRenderer;
  operation().catch(error => { console.error(error.message); if (process.versions.electron) require('electron').app.exit(1); else process.exitCode = 1; });
}
