import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import type { Credential, CredentialStore, AuthOperationOptions, AuthPrompt } from '@earendil-works/pi-ai';
import type { SubscriptionState } from './shared/types';
import { SUBSCRIPTION_PROVIDER, subscriptionCredential, subscriptionLoginUrl } from './subscription-credentials';

/** Native Pi owns OAuth and refresh. Every rotated token is acknowledged by OS storage before use. */
export class SubscriptionCredentialStore implements CredentialStore {
  private credential?: Credential;
  private revision = 0;
  private persistenceFailures = 0;
  get version(): number { return this.revision; }
  get failureVersion(): number { return this.persistenceFailures; }
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const operation = this.queue.then(work); this.queue = operation.catch(() => {}); return operation;
  }
  constructor(private persist: (credential?: Credential) => Promise<void>) {}
  private async persistSafely(credential?: Credential): Promise<void> {
    try { await this.persist(credential); }
    catch {
      this.persistenceFailures++;
      throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE');
    }
  }
  async seed(credential?: Credential): Promise<void> {
    if (credential) this.credential = subscriptionCredential(credential);
  }
  async read(id: string, options?: AuthOperationOptions) { options?.signal?.throwIfAborted(); return id === SUBSCRIPTION_PROVIDER && this.credential ? structuredClone(this.credential) : undefined; }
  async list(options?: AuthOperationOptions) { options?.signal?.throwIfAborted(); return this.credential ? [{ providerId: SUBSCRIPTION_PROVIDER, type: this.credential.type }] : []; }
  modify(id: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    if (id !== SUBSCRIPTION_PROVIDER) return Promise.reject(new Error('AUTH_UNAVAILABLE'));
    return this.serial(async () => {
      options?.signal?.throwIfAborted();
      const next = await fn(this.credential && structuredClone(this.credential));
      if (!next) return this.credential && structuredClone(this.credential);
      const valid = subscriptionCredential(next);
      await this.persistSafely(structuredClone(valid));
      // A durable rotation must remain the in-memory token even if cancelled meanwhile.
      this.credential = valid;
      this.revision++;
      return structuredClone(valid);
    });
  }
  async delete(id: string, options?: AuthOperationOptions): Promise<void> {
    if (id !== SUBSCRIPTION_PROVIDER) throw new Error('AUTH_UNAVAILABLE');
    await this.serial(async () => {
      options?.signal?.throwIfAborted();
      await this.persistSafely();
      // Once disk deletion succeeds, finish clearing memory even if cancellation arrives.
      this.credential = undefined;
      this.revision++;
    });
  }
}

export class SubscriptionService {
  private state: SubscriptionState = { status: 'signed-out', models: [] };
  private url?: string;
  private input?: { resolve(value: string): void; reject(error: Error): void };
  private constructor(readonly runtime: ModelRuntime, readonly credentials: SubscriptionCredentialStore,
    private changed: () => void, private browser: (url: string) => void, private deviceId: string) {
    this.state.models = runtime.getModels(SUBSCRIPTION_PROVIDER).filter(m => m.input.includes('text')).map(m => ({ id: m.id, name: m.name }));
  }
  static async create(options: { credential?: Credential; deviceId?: string; persist(credential?: Credential): Promise<void>; changed?(): void; browser?(url: string): void; runtimeFactory?: (credentials: CredentialStore) => Promise<ModelRuntime> }) {
    const credentials = new SubscriptionCredentialStore(options.persist);
    await credentials.seed(options.credential);
    const runtime = await (options.runtimeFactory ? options.runtimeFactory(credentials) : ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false }));
    const service = new SubscriptionService(runtime, credentials, options.changed ?? (() => {}), options.browser ?? (() => {}), options.deviceId ?? randomUUID());
    if (options.credential) service.state.status = 'signed-in';
    return service;
  }
  snapshot(): SubscriptionState { return structuredClone(this.state); }
  ready(): boolean { return this.state.status === 'signed-in'; }
  model(id: unknown): string {
    if (typeof id !== 'string' || !this.state.models.some(m => m.id === id)) throw new Error('MODEL_NOT_FOUND');
    return id;
  }
  expire(): void { this.state.status = 'expired'; this.changed(); }
  openBrowser(): void { if (!this.url) throw new Error('AUTH_INPUT_REQUIRED'); this.browser(this.url); }
  submit(code: unknown): void {
    if (!this.input) throw new Error('AUTH_INPUT_REQUIRED');
    if (typeof code !== 'string' || !code.trim() || code.length > 8192) throw new Error('AUTH_INPUT_INVALID');
    // Browser OAuth callback only. The SDK verifies its state/PKCE values.
    let url: URL;
    try { url = new URL(code.trim()); } catch { throw new Error('AUTH_INPUT_INVALID'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '1455' || url.pathname !== '/auth/callback'
      || url.username || url.password || !url.searchParams.get('code') || !url.searchParams.get('state') || !url.searchParams.get('client_id')) throw new Error('AUTH_INPUT_INVALID');
    this.input.resolve(url.href);
  }
  private ask(prompt: AuthPrompt, signal: AbortSignal): Promise<string> {
    if (prompt.type === 'select') {
      if (!prompt.options.some(o => o.id === 'browser')) throw new Error('AUTH_UNAVAILABLE');
      return Promise.resolve('browser');
    }
    if (prompt.type !== 'manual_code') throw new Error('AUTH_UNAVAILABLE');
    return new Promise((resolve, reject) => {
      const finish = (value?: string, error?: Error) => {
        signal.removeEventListener('abort', abort);
        prompt.signal?.removeEventListener('abort', abort);
        this.input = undefined; delete this.state.prompt; this.changed();
        error ? reject(error) : resolve(value!);
      };
      const abort = () => finish(undefined, new Error('CANCELLED'));
      this.input = { resolve: value => finish(value), reject: error => finish(undefined, error) };
      // App-owned copy: upstream prompts and arbitrary progress never cross the UI boundary.
      this.state.prompt = { message: 'callback-url', placeholder: 'http://127.0.0.1:1455/auth/callback?…' };
      signal.addEventListener('abort', abort, { once: true });
      prompt.signal?.addEventListener('abort', abort, { once: true });
      if (signal.aborted || prompt.signal?.aborted) abort(); else this.changed();
    });
  }
  async login(signal: AbortSignal): Promise<void> {
    const previous = this.state.status;
    const version = this.credentials.version;
    const failures = this.credentials.failureVersion;
    this.state.status = 'signing-in'; this.changed();
    try {
      await this.runtime.login(SUBSCRIPTION_PROVIDER, 'oauth', {
        signal, prompt: prompt => this.ask(prompt, signal),
        notify: event => {
          if (event.type === 'auth_url') { this.url = subscriptionLoginUrl(event.url); this.state.canOpenBrowser = true; this.browser(this.url); }
          this.state.progress = 'waiting-for-login'; this.changed();
        },
      }, { getDeviceId: () => this.deviceId });
      if (signal.aborted) throw new Error('CANCELLED');
      this.state.status = 'signed-in';
    } catch (error) {
      this.state.status = this.credentials.version !== version && await this.credentials.read(SUBSCRIPTION_PROVIDER) ? 'signed-in' : previous;
      if (this.credentials.failureVersion !== failures) throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE');
      throw error;
    } finally {
      this.input?.reject(new Error('CANCELLED')); this.url = undefined;
      delete this.state.prompt; delete this.state.progress; delete this.state.canOpenBrowser; this.changed();
    }
  }
  async logout(): Promise<void> {
    const failures = this.credentials.failureVersion;
    try {
      await this.runtime.logout(SUBSCRIPTION_PROVIDER);
      this.state.status = 'signed-out';
    } catch (error) {
      // Durable deletion wins even if the SDK subsequently fails to refresh its
      // model catalog. A failed deletion retains the previous account state.
      if (!await this.credentials.read(SUBSCRIPTION_PROVIDER)) this.state.status = 'signed-out';
      if (this.credentials.failureVersion !== failures) throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE');
      throw error;
    } finally { this.changed(); }
  }
}
