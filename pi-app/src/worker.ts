import { SleepApp } from './controller';
import type { AppEvent } from './shared/types';
import type { Credential } from '@earendil-works/pi-ai';
import { randomUUID } from 'node:crypto';
type Port = { on(event: 'message', listener: (event: { data: { id: string; method: string; params?: Record<string, unknown>; credentialAckId?: string; ok?: boolean } }) => void): void; postMessage(value: unknown): void };
const port = (process as NodeJS.Process & { parentPort?: Port }).parentPort;
if (!port) throw new Error('Worker requires an Electron utility process');
let app: SleepApp | undefined;
const credentialWrites = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
function persistCredential(credential?: Credential): Promise<void> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { credentialWrites.delete(id); reject(new Error('CREDENTIAL_STORAGE_UNAVAILABLE')); }, 10_000);
    credentialWrites.set(id, { resolve, reject, timer });
    port!.postMessage({ credentialUpdate: { id, credential } });
  });
}
port.on('message', async ({ data }) => {
  if (data.credentialAckId) {
    const item = credentialWrites.get(data.credentialAckId);
    if (item) { clearTimeout(item.timer); credentialWrites.delete(data.credentialAckId); data.ok ? item.resolve() : item.reject(new Error('CREDENTIAL_STORAGE_UNAVAILABLE')); }
    return;
  }
  try {
    if (data.method === 'boot') {
      app = new SleepApp(String(data.params?.home), (event: AppEvent) => port.postMessage({ event }));
      app.setCredential(data.params?.apiKey as string | undefined);
      await app.initializeSubscription({ credential: data.params?.subscriptionCredential as Credential | undefined, persist: persistCredential, browser: url => port.postMessage({ subscriptionBrowser: url }) });
    }
    if (!app) throw new Error('NOT_READY');
    const value = data.method === 'boot' ? app.snapshot() : data.method === 'close' ? await app.close() : await app.request(data.method, data.params);
    port.postMessage({ id: data.id, value });
  } catch (error) { port.postMessage({ id: data.id, error: error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'REQUEST_FAILED' }); }
});
