import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, utilityProcess, type UtilityProcess } from 'electron';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readCredentialPayload, serializeCredentialPayload } from './credentials';
import { planSquirrelStartup, runSquirrelStartup } from './squirrel-startup';
import { parseWindowTheme, titleBarOverlay, windowChromeOptions } from './window-chrome';
import { uiTestUserDataPath } from './ui-test-isolation';
import type { AppSnapshot, ModelConfig } from './shared/types';
declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

function prepareUiTestIsolation(): boolean {
  try {
    const userData = uiTestUserDataPath(process.env);
    if (userData) {
      mkdirSync(userData, { recursive: true });
      app.setPath('userData', userData);
    }
    return true;
  } catch {
    // Fail closed before acquiring the production lock or starting its data services.
    process.stderr.write('UI_TEST_STORAGE_UNAVAILABLE: set SLEEPCLAW_HOME to an absolute test directory.\n');
    app.exit(1);
    return false;
  }
}

const squirrelStartup = planSquirrelStartup(process.argv, process.execPath);
if (squirrelStartup.handled) {
  void runSquirrelStartup(squirrelStartup, () => app.quit());
} else if (!prepareUiTestIsolation()) {
  // Invalid UI automation configuration already terminated without touching production data.
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
// Match Squirrel's shortcut identity: package id + executable name without .exe.
if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.SleepClaw.sleepclaw');
const home = resolve(process.env.SLEEPCLAW_HOME || join(homedir(), '.sleepclaw-pi'));
const smoke = process.env.SLEEPCLAW_SMOKE === '1';
const uiTest = process.env.SLEEPCLAW_UI_TEST === '1';
if (uiTest) { app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1'); app.commandLine.appendSwitch('remote-debugging-port', '9337'); }
let window: BrowserWindow | undefined;
let worker: UtilityProcess | undefined;
function sendToWindow(channel: string, value: unknown): void {
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(channel, value);
}
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
const allowed = new Set(['state','language','configure','new','select','import','target','answer','fact','send','report','feedback','delete','deleteImport','deleteFact','cancel']);
function request(method: string, params?: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    if (!worker) return reject(new Error('NOT_READY'));
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('TIMEOUT')); }, method === 'import' ? 600_000 : 150_000);
    pending.set(id, { resolve: resolvePromise, reject, timer }); worker.postMessage({ id, method, params });
  });
}
function trusted(event: Electron.IpcMainInvokeEvent): boolean { return Boolean(window && event.sender.id === window.webContents.id && event.senderFrame === window.webContents.mainFrame); }

app.on('second-instance', () => { window?.show(); window?.focus(); });
app.whenReady().then(async () => {
  mkdirSync(home, { recursive: true });
  const credentialFile = join(home, 'credentials.bin');
  let apiKey: string | undefined;
  let credentialReconnectRequired = false;
  if (existsSync(credentialFile)) {
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const saved = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')) as { model?: Omit<ModelConfig, 'apiKey'> };
        apiKey = readCredentialPayload(safeStorage.decryptString(readFileSync(credentialFile)), saved.model);
      } catch { /* Ask user to reconnect; never print credentials or decrypted payloads. */ }
    }
    credentialReconnectRequired = !apiKey;
  }
  const runtime = app.isPackaged ? join(process.resourcesPath, 'runtime.asar') : resolve(__dirname, '..', '..', 'runtime');
  worker = utilityProcess.fork(join(runtime, 'worker.mjs'), [], { serviceName: 'SleepClaw Agent', stdio: 'pipe' });
  // Upstream provider diagnostics can contain response fragments. Drain without persisting or forwarding them.
  worker.stdout?.resume(); worker.stderr?.resume();
  worker.on('message', (message: { id?: string; value?: unknown; error?: string; event?: unknown }) => {
    if (message.event) sendToWindow('sleepclaw:event', message.event);
    if (message.id) { const entry = pending.get(message.id); if (!entry) return; clearTimeout(entry.timer); pending.delete(message.id); message.error ? entry.reject(new Error(message.error)) : entry.resolve(message.value); }
  });
  worker.on('exit', () => {
    worker = undefined;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('WORKER_EXITED')); } pending.clear();
    sendToWindow('sleepclaw:event', { type: 'error', code: 'WORKER_EXITED', message: 'SleepClaw needs to restart. Saved data is retained. / 请重新打开，已保存的数据会保留。' });
  });
  const state = await request('boot', { home, apiKey }) as AppSnapshot;
  if (smoke) {
    const modelUrl = process.env.SLEEPCLAW_SMOKE_MODEL_URL;
    if (modelUrl) {
      const parsed = new URL(modelUrl);
      if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('SMOKE_REQUIRES_LOOPBACK');
      await request('configure', { provider: 'openai', model: 'synthetic-packaging-model', baseUrl: modelUrl, apiKey: 'synthetic-package-key-no-real-credentials' });
    }
    await request('new', { goal: 'Synthetic packaging check' });
    await request('answer', { skip: true });
    const reportState = await request('report') as AppSnapshot;
    const ok = reportState.reports.length === 1 && reportState.question === undefined;
    writeFileSync(join(home, 'packaged-smoke.json'), JSON.stringify({ ok, sqlite: true, piLoaded: true, modelTested: Boolean(modelUrl), aiInterpretation: Boolean(reportState.reports[0]?.aiInterpretation), reportCount: reportState.reports.length, node: process.versions.node, electron: process.versions.electron }));
    await request('close'); worker?.kill(); app.exit(ok ? 0 : 1); return;
  }
  const iconFile = process.platform === 'win32' ? 'sleepclaw.ico' : 'sleepclaw.png';
  const icon = app.isPackaged ? join(process.resourcesPath, 'icons', iconFile) : resolve(__dirname, '..', '..', 'assets', 'icons', iconFile);
  window = new BrowserWindow({ width: 1200, height: 840, minWidth: 800, minHeight: 600, title: 'SleepClaw', icon, ...windowChromeOptions('dark'),
    show: false, webPreferences: { preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  window.removeMenu();
  window.on('closed', () => { window = undefined; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  if (app.isPackaged) window.webContents.session.webRequest.onHeadersReceived((details, callback) => callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-src 'none'"] } }));
  ipcMain.handle('sleepclaw:choose-file', async event => {
    if (!trusted(event)) throw new Error('FORBIDDEN');
    const picked = await dialog.showOpenDialog(window!, { properties: ['openFile'], filters: [{ name: 'Apple Health', extensions: ['zip', 'xml'] }] });
    return picked.canceled ? null : picked.filePaths[0];
  });
  ipcMain.handle('sleepclaw:request', async (event, method: string, params?: Record<string, unknown>) => {
    if (!trusted(event)) throw new Error('FORBIDDEN');
    if (method === 'windowTheme') {
      const theme = parseWindowTheme(params);
      const overlay = titleBarOverlay(theme);
      if (process.platform !== 'darwin') window!.setTitleBarOverlay(overlay);
      window!.setBackgroundColor(overlay.color!);
      return { theme };
    }
    if (method === 'capturePreview' && uiTest) {
      const preview = await window!.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
      const path = join(home, 'ui-preview.png'); writeFileSync(path, preview.toPNG()); return path;
    }
    if (method === 'openReports') return shell.openPath(join(home, 'reports'));
    if (method === 'openNotices') return shell.openPath(app.isPackaged ? join(process.resourcesPath, 'NOTICE.md') : resolve(__dirname, '..', '..', 'NOTICE.md'));
    if (!allowed.has(method)) throw new Error('UNKNOWN_METHOD');
    if (method === 'configure' && !safeStorage.isEncryptionAvailable()) throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE');
    const value = await request(method, params);
    if (method === 'configure') {
      try {
        const configured = (value as AppSnapshot).model;
        if (!configured) throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE');
        const encrypted = safeStorage.encryptString(serializeCredentialPayload({ ...configured, apiKey: String(params?.apiKey ?? '') }));
        writeFileSync(`${credentialFile}.tmp`, encrypted); renameSync(`${credentialFile}.tmp`, credentialFile);
        credentialReconnectRequired = false;
      } catch { throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE'); }
    }
    if (method === 'state' && credentialReconnectRequired) {
      // Renderer subscribes before its initial state request, so this cannot race page mounting.
      window!.webContents.send('sleepclaw:event', { type: 'error', code: 'MODEL_REQUIRED', message: 'Saved credentials do not match this model. Reconnect in settings. / 已保存的凭据无法匹配当前模型，请重新连接。' });
      credentialReconnectRequired = false;
    }
    return value;
  });
  await window.loadURL(MAIN_WINDOW_WEBPACK_ENTRY);
  if (!uiTest) window.show();
  window.webContents.send('sleepclaw:event', { type: 'state', state });
}).catch(() => { if (!smoke) dialog.showErrorBox('SleepClaw', 'Startup failed. Saved data has not been removed. / 启动失败，已保存的数据没有删除。'); app.exit(1); });
app.on('window-all-closed', () => { worker?.kill(); app.quit(); });
}
