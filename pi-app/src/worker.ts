import { SleepApp } from './controller';
import type { AppEvent } from './shared/types';
type Port = { on(event: 'message', listener: (event: { data: { id: string; method: string; params?: Record<string, unknown> } }) => void): void; postMessage(value: unknown): void };
const port = (process as NodeJS.Process & { parentPort?: Port }).parentPort;
if (!port) throw new Error('Worker requires an Electron utility process');
let app: SleepApp | undefined;
port.on('message', async ({ data }) => {
  try {
    if (data.method === 'boot') {
      app = new SleepApp(String(data.params?.home), (event: AppEvent) => port.postMessage({ event }));
      app.setCredential(data.params?.apiKey as string | undefined);
    }
    if (!app) throw new Error('NOT_READY');
    const value = data.method === 'boot' ? app.snapshot() : data.method === 'close' ? await app.close() : await app.request(data.method, data.params);
    port.postMessage({ id: data.id, value });
  } catch (error) { port.postMessage({ id: data.id, error: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'REQUEST_FAILED' }); }
});
