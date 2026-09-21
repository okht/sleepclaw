const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const runtimeDependencies = ['@earendil-works/pi-coding-agent','@earendil-works/pi-ai','typebox','sax','yauzl','simple-statistics'];
exports.dependencies = runtimeDependencies;
async function prepare() {
  const dir = path.join(root, 'runtime'); fs.mkdirSync(dir, { recursive: true });
  const source = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const names = runtimeDependencies;
  const manifest = JSON.stringify({ name: 'sleepclaw-runtime', version: source.version, private: true, type: 'module', dependencies: Object.fromEntries(names.map(n => [n, source.dependencies[n]])) }, null, 2);
  const manifestFile = path.join(dir, 'package.json');
  const changed = !fs.existsSync(manifestFile) || fs.readFileSync(manifestFile, 'utf8') !== manifest;
  const lock = fs.readFileSync(path.join(root, 'runtime-lock.json'), 'utf8');
  const lockFile = path.join(dir, 'package-lock.json');
  const lockChanged = !fs.existsSync(lockFile) || fs.readFileSync(lockFile, 'utf8') !== lock;
  fs.writeFileSync(manifestFile, manifest);
  fs.writeFileSync(lockFile, lock);
  await require('esbuild').build({ absWorkingDir: root, entryPoints: { worker: 'src/worker.ts', cli: 'src/cli.ts' }, outdir: dir, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', sourcemap: false });
  if (changed || lockChanged || !fs.existsSync(path.join(dir, 'node_modules'))) {
    const npmCli = process.env.npm_execpath;
    const args = ['ci', '--omit=dev', '--no-audit', '--no-fund'];
    const result = npmCli && npmCli.endsWith('.js') ? spawnSync(process.execPath, [npmCli, ...args], { cwd: dir, stdio: 'inherit' }) : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.status !== 0) throw new Error('Runtime dependency installation failed');
  }
  // Webpack embeds UI packages. Keep their original license texts alongside runtime licenses.
  const packages = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;
  const notices = ['SleepClaw production dependency license texts. Runtime packages also retain their own licenses.'];
  for (const [relative, metadata] of Object.entries(packages)) {
    if (!relative.startsWith('node_modules/') || metadata.dev) continue;
    const pkgDir = path.resolve(root, relative);
    if (!pkgDir.startsWith(path.join(root, 'node_modules') + path.sep) || !fs.existsSync(pkgDir)) continue;
    const files = fs.readdirSync(pkgDir, { withFileTypes: true }).filter(file => file.isFile() && /^(licen[sc]e|copying)([._-].*)?$/i.test(file.name));
    for (const file of files) notices.push(`\n--- ${relative} ${metadata.version ?? ''} / ${file.name} ---\n${fs.readFileSync(path.join(pkgDir, file.name), 'utf8')}`);
  }
  notices.push(`\n--- SleepClaw design system ---\n${fs.readFileSync(path.join(root, 'src/renderer/assets/DESIGN-SYSTEM-LICENSE'), 'utf8')}`);
  fs.writeFileSync(path.join(dir, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
  // Pi ships bundled esbuild binaries for every platform. This artifact targets Windows x64 only.
  // Prune only generated runtime copies, never the project's source/dependency cache.
  if (process.platform === 'win32' && process.arch === 'x64') {
    const scope = path.join(dir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules', '@esbuild');
    const rootReal = fs.realpathSync(dir);
    if (fs.existsSync(path.join(scope, 'win32-x64'))) {
      for (const item of fs.readdirSync(scope, { withFileTypes: true })) {
        if (!item.isDirectory() || item.name === 'win32-x64') continue;
        const target = fs.realpathSync(path.join(scope, item.name));
        if (!target.startsWith(rootReal + path.sep)) throw new Error('Refusing to prune outside generated runtime');
        fs.rmSync(target, { recursive: true });
      }
    }
  }
}
exports.prepare = prepare;
exports.archive = async () => {
  const directory = path.join(root, 'runtime-bundle'); fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, 'runtime.asar');
  // Preserve native executables outside ASAR; JavaScript and static assets remain readable by Electron.
  await require('@electron/asar').createPackageWithOptions(path.join(root, 'runtime'), archive, { unpack: '**/*.{node,exe,dll}' });
  fs.mkdirSync(`${archive}.unpacked`, { recursive: true });
};
if (require.main === module) prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
