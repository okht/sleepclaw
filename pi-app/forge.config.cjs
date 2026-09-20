const path = require('node:path');
const iconDirectory = path.join(__dirname, 'assets', 'icons');
const windowsIcon = path.join(iconDirectory, 'sleepclaw.ico');
module.exports = {
  packagerConfig: {
    asar: true,
    icon: windowsIcon,
    executableName: 'sleepclaw',
    appBundleId: 'org.sleepclaw.desktop',
    extraResource: [path.join(__dirname, 'runtime-bundle', 'runtime.asar'), path.join(__dirname, 'runtime-bundle', 'runtime.asar.unpacked'), path.join(__dirname, 'NOTICE.md'), path.join(__dirname, 'LICENSE'), iconDirectory],
  },
  rebuildConfig: {},
  makers: [{ name: '@electron-forge/maker-squirrel', config: { name: 'SleepClaw', setupExe: 'SleepClaw-Setup.exe', setupIcon: windowsIcon, iconUrl: 'https://raw.githubusercontent.com/okht/sleepclaw/main/pi-app/assets/icons/sleepclaw.ico' } }],
  plugins: [{ name: '@electron-forge/plugin-webpack', config: {
    mainConfig: './webpack.main.cjs',
    renderer: { config: './webpack.renderer.cjs', entryPoints: [{ html: './src/renderer/index.html', js: './src/renderer/index.tsx', name: 'main_window', preload: { js: './src/preload.ts' } }] }
  } }],
  hooks: {
    prePackage: async () => { const runtime = require('./scripts/runtime.cjs'); await runtime.prepare(); await runtime.archive(); }
  }
};
