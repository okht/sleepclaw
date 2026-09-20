import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

type SquirrelAction = 'create-shortcut' | 'remove-shortcut' | 'quit';
export interface SquirrelStartupPlan { handled: boolean; action?: SquirrelAction; executable?: string; args?: string[]; cwd?: string; timeoutMs: number }
interface StartupChild { once(event: 'exit' | 'error', listener: () => void): unknown; kill(): unknown }
type Launch = (file: string, args: string[], options: { cwd: string; windowsHide: true; shell: false; stdio: 'ignore' }) => StartupChild;
const EVENTS = new Set(['--squirrel-install', '--squirrel-updated', '--squirrel-uninstall', '--squirrel-obsolete']);

/** Squirrel invokes the installed app before normal startup. No arguments become shell commands. */
export function planSquirrelStartup(argv: string[], execPath: string, platform: NodeJS.Platform = process.platform): SquirrelStartupPlan {
  const events = argv.filter((argument) => EVENTS.has(argument));
  if (platform !== 'win32' || events.length === 0) return { handled: false, timeoutMs: 10_000 };
  const quit: SquirrelStartupPlan = { handled: true, action: 'quit', timeoutMs: 10_000 };
  if (events.length !== 1 || events[0] === '--squirrel-obsolete') return quit;
  // Only trust the standard installed app-<version>/sleepclaw.exe layout.
  if (!win32.isAbsolute(execPath) || win32.basename(execPath).toLowerCase() !== 'sleepclaw.exe') return quit;
  const versionDirectory = win32.dirname(execPath);
  if (!/^app-[\w.+-]+$/i.test(win32.basename(versionDirectory))) return quit;
  const installRoot = win32.dirname(versionDirectory);
  if (installRoot === win32.parse(installRoot).root) return quit;
  const remove = events[0] === '--squirrel-uninstall';
  return {
    handled: true, action: remove ? 'remove-shortcut' : 'create-shortcut',
    executable: win32.join(installRoot, 'Update.exe'),
    args: [`--${remove ? 'remove' : 'create'}Shortcut=sleepclaw.exe`],
    cwd: installRoot, timeoutMs: 10_000,
  };
}

/** Runs only the installed Squirrel helper; no update check, download, window, or network action. */
export async function runSquirrelStartup(plan: SquirrelStartupPlan, quit: () => void, launch: Launch = spawn): Promise<void> {
  if (!plan.handled) return;
  if (plan.action === 'quit' || !plan.executable || !plan.args || !plan.cwd) { quit(); return; }
  await new Promise<void>((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      quit(); resolve();
    };
    try {
      const child = launch(plan.executable!, plan.args!, { cwd: plan.cwd!, windowsHide: true, shell: false, stdio: 'ignore' });
      child.once('exit', finish);
      child.once('error', finish);
      timer = setTimeout(() => {
        try { child.kill(); } catch { /* Quit even when child termination fails. */ }
        finish();
      }, plan.timeoutMs);
    } catch { finish(); }
  });
}
