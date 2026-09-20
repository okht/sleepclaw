import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, DesktopBridge } from './shared/types';
const bridge: DesktopBridge = {
  request: (method, params) => ipcRenderer.invoke('sleepclaw:request', method, params),
  chooseFile: () => ipcRenderer.invoke('sleepclaw:choose-file'),
  onEvent(callback) {
    const handler = (_event: unknown, payload: AppEvent) => callback(payload);
    ipcRenderer.on('sleepclaw:event', handler);
    return () => { ipcRenderer.removeListener('sleepclaw:event', handler); };
  },
};
contextBridge.exposeInMainWorld('sleepclaw', bridge);
