import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron';

export type WindowTheme = 'dark' | 'light';

/** Keep this in sync with the renderer's title-bar safe area. */
export const WINDOW_TITLEBAR_HEIGHT = 40;

const palette = {
  dark: { color: '#080b0e', symbolColor: '#e8e7e4' },
  light: { color: '#f8f7f4', symbolColor: '#242529' },
} satisfies Record<WindowTheme, TitleBarOverlayOptions>;

export function titleBarOverlay(theme: WindowTheme): TitleBarOverlayOptions {
  return { ...palette[theme], height: WINDOW_TITLEBAR_HEIGHT };
}

/** Hide only the native title strip; retain native controls, resize and snap. */
export function windowChromeOptions(theme: WindowTheme, platform: NodeJS.Platform = process.platform): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'backgroundColor' | 'frame' | 'resizable'> {
  return {
    titleBarStyle: 'hidden',
    ...(platform !== 'darwin' ? { titleBarOverlay: titleBarOverlay(theme) } : {}),
    backgroundColor: palette[theme].color,
    frame: true,
    resizable: true,
  };
}

/** This IPC accepts a fixed theme name, never renderer-supplied window options. */
export function parseWindowTheme(params: unknown): WindowTheme {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('INVALID_WINDOW_THEME');
  const record = params as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'theme') || (record.theme !== 'dark' && record.theme !== 'light')) throw new Error('INVALID_WINDOW_THEME');
  return record.theme;
}
