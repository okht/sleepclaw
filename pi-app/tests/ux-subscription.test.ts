import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createServer } from 'node:net';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, type AuthInteraction, type Credential, type CredentialStore, type LoginOptions } from '@earendil-works/pi-ai';
import { SubscriptionCredentialStore, SubscriptionService } from '../src/subscription.js';
import { readSubscriptionCredential, serializeSubscriptionCredential, SUBSCRIPTION_PROVIDER, subscriptionCredential, subscriptionLoginUrl } from '../src/subscription-credentials.js';
import type { SubscriptionState } from '../src/shared/types.js';
import { SleepApp } from '../src/controller.js';

// Credentials and callback input are synthetic. The native integration starts
// OAuth only as far as its local callback listener and cancels before token exchange.
const token = (version = 1): Credential => ({ type: 'oauth', access: `SYNTHETIC_ACCESS_${version}`, refresh: `SYNTHETIC_REFRESH_${version}`, expires: 4_000_000_000_000 + version, clientId: 'SYNTHETIC_CLIENT', scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'], accountId: 'SYNTHETIC_ACCOUNT' });
const authUrl = 'https://auth.openai.com/api/accounts/authorize?client_id=SYNTHETIC_CLIENT&state=SYNTHETIC_STATE&agent_name_hint=Pi';
const brandedAuthUrl = 'https://auth.openai.com/api/accounts/authorize?client_id=SYNTHETIC_CLIENT&state=SYNTHETIC_STATE&agent_name_hint=SleepClaw';
const callback = 'http://127.0.0.1:1455/auth/callback?code=SYNTHETIC_CODE&state=SYNTHETIC_STATE&client_id=SYNTHETIC_CLIENT';
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(options: { credential?: Credential; persist?: (credential?: Credential) => Promise<void>; login?: (interaction: AuthInteraction, credentials: CredentialStore) => Promise<Credential> } = {}) {
  const browser: string[] = [], states: SubscriptionState[] = [], persisted: Array<Credential | undefined> = [];
  const calls: string[] = [];
  const loginOptions: Array<LoginOptions | undefined> = [];
  const loginHandler = options.login;
  let service!: SubscriptionService;
  service = await SubscriptionService.create({ credential: options.credential,
    persist: async credential => { if (options.persist) await options.persist(credential); persisted.push(credential && structuredClone(credential)); },
    changed: () => { if (service) states.push(service.snapshot()); }, browser: url => { browser.push(url); },
    runtimeFactory: async credentials => ({
      getModels(provider: string) {
        assert.equal(provider, SUBSCRIPTION_PROVIDER);
        return [{ id: 'synthetic-text', name: 'Synthetic text model', input: ['text', 'image'] }, { id: 'synthetic-image-only', name: 'Synthetic image model', input: ['image'] }];
      },
      async login(provider: string, kind: string, interaction: AuthInteraction, options?: LoginOptions) {
        assert.equal(provider, SUBSCRIPTION_PROVIDER); assert.equal(kind, 'oauth'); calls.push('login');
        loginOptions.push(options);
        if (loginHandler) return loginHandler(interaction, credentials);
        await credentials.modify(provider, async () => token()); return token();
      },
      async logout(provider: string) { assert.equal(provider, SUBSCRIPTION_PROVIDER); calls.push('logout'); await credentials.delete(provider); },
    }) as unknown as ModelRuntime,
  });
  return { service, browser, states, persisted, calls, loginOptions };
}

test('UX subscription native Pi 1.0 runtime has an offline openai ChatGPT text-model catalog', async () => {
  assert.equal(SUBSCRIPTION_PROVIDER, 'openai');
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  assert.ok(runtime.getProvider(SUBSCRIPTION_PROVIDER));
  const models = runtime.getModels(SUBSCRIPTION_PROVIDER).filter(model => model.input.includes('text'));
  assert.ok(models.length > 0);
  assert.ok(models.every(model => model.provider === SUBSCRIPTION_PROVIDER && model.id && model.name));
  assert.equal((await runtime.listCredentials()).length, 0);
});

test('UX subscription browser login and manual callback expose only app-owned prompt/status text', async () => {
  const prompted = deferred();
  let supplied: string | undefined;
  const f = await fixture({ login: async (interaction, credentials) => {
    interaction.notify({ type: 'progress', message: 'SYNTHETIC_SECRET_PROVIDER_PROGRESS' });
    interaction.notify({ type: 'auth_url', url: authUrl, instructions: 'SYNTHETIC_SECRET_INSTRUCTIONS' });
    const pending = interaction.prompt({ type: 'manual_code', message: 'SYNTHETIC_SECRET_MANUAL_PROMPT', placeholder: 'SYNTHETIC_SECRET_PLACEHOLDER' });
    prompted.resolve(); supplied = await pending;
    await credentials.modify(SUBSCRIPTION_PROVIDER, async () => token()); return token();
  } });
  assert.equal(f.service.ready(), false);
  assert.deepEqual(f.service.snapshot().models, [{ id: 'synthetic-text', name: 'Synthetic text model' }]);
  const pending = f.service.login(new AbortController().signal);
  await prompted.promise;
  assert.equal(f.service.snapshot().status, 'signing-in');
  assert.equal(f.service.snapshot().prompt?.message, 'callback-url');
  assert.equal(f.service.snapshot().canOpenBrowser, true);
  assert.deepEqual(f.browser, [brandedAuthUrl]);
  f.service.openBrowser(); assert.deepEqual(f.browser, [brandedAuthUrl, brandedAuthUrl]);
  f.service.submit(callback); await pending;
  assert.equal(supplied, callback);
  assert.equal(f.service.ready(), true);
  assert.equal(f.service.snapshot().status, 'signed-in');
  assert.equal(f.service.snapshot().prompt, undefined);
  assert.equal(f.service.snapshot().canOpenBrowser, undefined);
  assert.equal(f.service.snapshot().progress, undefined);
  assert.deepEqual(f.persisted, [token()]);
  assert.doesNotMatch(JSON.stringify(f.states), /SYNTHETIC_SECRET|SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|SYNTHETIC_ACCOUNT|SYNTHETIC_CODE|SYNTHETIC_STATE/);
  assert.throws(() => f.service.openBrowser(), /AUTH_INPUT_REQUIRED/);
  assert.throws(() => f.service.submit(callback), /AUTH_INPUT_REQUIRED/);
});

test('UX subscription login cancellation removes the manual prompt and preserves the previous signed-out state', async () => {
  const prompted = deferred(), abort = new AbortController();
  const f = await fixture({ login: async interaction => {
    const response = interaction.prompt({ type: 'manual_code', message: 'Synthetic prompt' });
    prompted.resolve(); await response; return token();
  } });
  const outcome = f.service.login(abort.signal).then(() => undefined, error => error);
  await prompted.promise; abort.abort();
  assert.match(String(await outcome), /CANCELLED/);
  assert.deepEqual(f.persisted, []);
  assert.equal(f.service.snapshot().status, 'signed-out');
  assert.equal(f.service.snapshot().prompt, undefined);
  assert.equal(f.service.ready(), false);
});

test('UX subscription an automatic callback can abort only the manual prompt and still finish native login', async () => {
  const f = await fixture({ login: async (interaction, credentials) => {
    const promptAbort = new AbortController();
    const manual = interaction.prompt({ type: 'manual_code', message: 'Synthetic manual fallback', signal: promptAbort.signal });
    promptAbort.abort(); await assert.rejects(manual, /CANCELLED/);
    await credentials.modify(SUBSCRIPTION_PROVIDER, async () => token()); return token();
  } });
  await f.service.login(new AbortController().signal);
  assert.equal(f.service.ready(), true); assert.equal(f.service.snapshot().prompt, undefined);
});

test('UX subscription cancelling a failed re-login preserves an existing account and expired state stays visible', async () => {
  const f = await fixture({ credential: token(), login: async () => { throw new Error('Synthetic login failure'); } });
  assert.equal(f.service.ready(), true);
  await assert.rejects(f.service.login(new AbortController().signal), /Synthetic login failure/);
  assert.equal(f.service.snapshot().status, 'signed-in');
  f.service.expire(); assert.equal(f.service.ready(), false);
  assert.equal(f.service.snapshot().status, 'expired');
  await assert.rejects(f.service.login(new AbortController().signal), /Synthetic login failure/);
  assert.equal(f.service.snapshot().status, 'expired');
  await f.service.logout(); assert.equal(f.service.snapshot().status, 'signed-out');
});

test('UX subscription rejects unsupported provider prompts without echoing prompt content', async () => {
  for (const prompt of [{ type: 'text', message: 'SYNTHETIC_SECRET_TEXT' }, { type: 'secret', message: 'SYNTHETIC_SECRET_TEXT' }, { type: 'select', message: 'SYNTHETIC_SECRET_TEXT', options: [{ id: 'device', label: 'Device' }] }] as const) {
    const f = await fixture({ login: async interaction => { await interaction.prompt(prompt); return token(); } });
    await assert.rejects(f.service.login(new AbortController().signal), /AUTH_UNAVAILABLE/);
    assert.equal(f.service.snapshot().status, 'signed-out');
    assert.doesNotMatch(JSON.stringify(f.states), /SYNTHETIC_SECRET_TEXT/);
  }
});

test('UX subscription brands only the native OAuth agent name while preserving authorization parameters', () => {
  const upstream = new URL('https://auth.openai.com/api/accounts/authorize');
  const fields = [
    ['agent_name_hint', 'Pi'], ['client_id', 'SYNTHETIC_CLIENT'], ['state', 'SYNTHETIC_STATE+/='],
    ['nonce', 'SYNTHETIC_NONCE&='], ['code_challenge', 'SYNTHETIC_PKCE-_'], ['code_challenge_method', 'S256'],
    ['redirect_uri', 'http://127.0.0.1:1455/auth/callback'], ['resource', 'https://api.openai.com/v1'],
    ['scope', 'resource.invoke chatgpt.tokens.use.direct'], ['ext_agent_host_id', 'urn:uuid:11111111-2222-3333-4444-555555555555'],
  ];
  for (const [key, value] of fields) upstream.searchParams.append(key, value);
  const branded = subscriptionLoginUrl(upstream.href);
  assert.equal(branded, upstream.href.replace('agent_name_hint=Pi', 'agent_name_hint=SleepClaw'));
  assert.deepEqual([...new URL(branded).searchParams.entries()].filter(([key]) => key !== 'agent_name_hint'), fields.filter(([key]) => key !== 'agent_name_hint'));
  assert.equal(subscriptionLoginUrl(branded), branded, 'service and main-process validation must keep branding stable');
});

test('UX subscription rejects untrusted authorization URLs before opening the browser', async () => {
  for (const url of ['http://auth.openai.com/api/accounts/authorize', 'https://auth.openai.com.evil.test/api/accounts/authorize', 'https://evil.test/api/accounts/authorize', 'https://auth.openai.com:8443/api/accounts/authorize', 'https://user:password@auth.openai.com/api/accounts/authorize', 'https://auth.openai.com/other', 'https://auth.openai.com/api/accounts/authorize#fragment', 'https://auth.openai.com/oauth/authorize', 'javascript:alert(1)', 'file:///tmp/synthetic', 'not a url']) {
    assert.throws(() => subscriptionLoginUrl(url), /AUTH_INPUT_INVALID/);
    const f = await fixture({ login: async interaction => { interaction.notify({ type: 'auth_url', url }); return token(); } });
    await assert.rejects(f.service.login(new AbortController().signal), /AUTH_INPUT_INVALID/);
    assert.deepEqual(f.browser, []); assert.equal(f.service.snapshot().status, 'signed-out');
  }
});

test('UX subscription invalid pasted callbacks stay editable and only a valid localhost callback reaches Pi', async () => {
  const prompted = deferred(); let supplied: string | undefined;
  const f = await fixture({ login: async (interaction, credentials) => {
    const pending = interaction.prompt({ type: 'manual_code', message: 'Synthetic callback' }); prompted.resolve(); supplied = await pending;
    await credentials.modify(SUBSCRIPTION_PROVIDER, async () => token()); return token();
  } });
  const pending = f.service.login(new AbortController().signal); await prompted.promise;
  for (const value of [null, '', '   ', 'SYNTHETIC_RAW_CODE', 'x'.repeat(8193), 'https://localhost:1455/auth/callback?code=x&state=y',
    'http://evil.test:1455/auth/callback?code=x&state=y', 'http://localhost:1456/auth/callback?code=x&state=y',
    'http://localhost:1455/wrong?code=x&state=y', 'http://user:secret@localhost:1455/auth/callback?code=x&state=y',
    'http://localhost:1455/auth/callback?code=x', 'http://localhost:1455/auth/callback?state=y', 'http://127.0.0.1:1455/auth/callback?code=x&state=y']) {
    assert.throws(() => f.service.submit(value), /AUTH_INPUT_INVALID/);
    assert.ok(f.service.snapshot().prompt); assert.equal(supplied, undefined);
  }
  f.service.submit(callback); await pending;
  assert.equal(supplied, callback);
});

test('UX subscription snapshots and model selection expose no mutable runtime or credential data', async () => {
  const f = await fixture({ credential: token() });
  const state = f.service.snapshot(); state.status = 'expired'; state.models[0].name = 'Synthetic mutation';
  assert.equal(f.service.snapshot().status, 'signed-in');
  assert.equal(f.service.snapshot().models[0].name, 'Synthetic text model');
  assert.equal(f.service.model('synthetic-text'), 'synthetic-text');
  for (const id of [undefined, null, '', 'synthetic-image-only', 'foreign-provider/model', 123, 'constructor']) assert.throws(() => f.service.model(id), /MODEL_NOT_FOUND/);
  assert.doesNotMatch(JSON.stringify(f.service.snapshot()), /SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|SYNTHETIC_ACCOUNT/);
});

test('UX subscription durable login failure never marks the account signed in', async () => {
  const f = await fixture({ persist: async () => { throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE'); } });
  await assert.rejects(f.service.login(new AbortController().signal), /CREDENTIAL_STORAGE_UNAVAILABLE/);
  assert.equal(f.service.ready(), false); assert.equal(f.service.snapshot().status, 'signed-out');
  assert.equal(await f.service.credentials.read(SUBSCRIPTION_PROVIDER), undefined);
  assert.deepEqual(f.persisted, []);
});

test('UX subscription logout succeeds only when deletion is durable and storage failure keeps the existing account', async () => {
  let fail = true;
  const f = await fixture({ credential: token(), persist: async credential => { if (!credential && fail) throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE'); } });
  await assert.rejects(f.service.logout(), /CREDENTIAL_STORAGE_UNAVAILABLE/);
  assert.equal(f.service.ready(), true); assert.deepEqual(await f.service.credentials.read(SUBSCRIPTION_PROVIDER), token());
  fail = false; await f.service.logout();
  assert.equal(f.service.snapshot().status, 'signed-out');
  assert.equal(await f.service.credentials.read(SUBSCRIPTION_PROVIDER), undefined);
  assert.deepEqual(f.persisted, [undefined]);
});

test('UX subscription native Pi logout preserves the app storage error code and the existing account', async () => {
  const service = await SubscriptionService.create({ credential: token(), persist: async () => { throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE'); } });
  await assert.rejects(service.logout(), (error: unknown) => error instanceof Error && error.message === 'CREDENTIAL_STORAGE_UNAVAILABLE');
  assert.equal(service.snapshot().status, 'signed-in');
  assert.deepEqual(await service.credentials.read(SUBSCRIPTION_PROVIDER), token());
});

test('UX subscription logout after durable deletion stays signed out even if native model synchronization fails', async () => {
  const persisted: Array<Credential | undefined> = [];
  const service = await SubscriptionService.create({ credential: token(), persist: async credential => { persisted.push(credential); },
    runtimeFactory: async credentials => ({ getModels: () => [], logout: async (provider: string) => {
      await credentials.delete(provider); throw new Error('SYNTHETIC_MODEL_SYNC_FAILURE');
    } }) as unknown as ModelRuntime,
  });
  await assert.rejects(service.logout(), /SYNTHETIC_MODEL_SYNC_FAILURE/);
  assert.equal(service.snapshot().status, 'signed-out');
  assert.equal(await service.credentials.read(SUBSCRIPTION_PROVIDER), undefined);
  assert.deepEqual(persisted, [undefined]);
});

test('UX subscription credential serialization is provider-bound, versioned and validates only synthetic OAuth payloads', () => {
  assert.deepEqual(readSubscriptionCredential(serializeSubscriptionCredential(token())), token());
  const original = token(); const copied = subscriptionCredential(original); (copied as { access: string }).access = 'SYNTHETIC_CHANGED';
  assert.deepEqual(original, token());
  for (const value of [null, {}, { ...token(), type: 'api_key' }, { ...token(), access: '' }, { ...token(), refresh: 1 }, { ...token(), expires: NaN }, { ...token(), expires: Infinity }, { ...token(), extra: 'x'.repeat(65536) }]) assert.throws(() => subscriptionCredential(value), /CREDENTIAL_STORAGE_UNAVAILABLE/);
  for (const text of ['not json', '{}', 'null', JSON.stringify(token()), JSON.stringify({ version: 2, provider: SUBSCRIPTION_PROVIDER, credential: token() }), JSON.stringify({ version: 1, provider: 'openai-codex', credential: token() })]) assert.throws(() => readSubscriptionCredential(text), /CREDENTIAL_STORAGE_UNAVAILABLE/);
});

test('UX subscription credential reads and no-op modifiers cannot mutate stored credentials without persistence', async () => {
  const persisted: Array<Credential | undefined> = [];
  const store = new SubscriptionCredentialStore(async credential => { persisted.push(credential); });
  await store.seed(token());
  const value = await store.read(SUBSCRIPTION_PROVIDER); (value as { access: string }).access = 'SYNTHETIC_MUTATION';
  assert.deepEqual(await store.read(SUBSCRIPTION_PROVIDER), token());
  await store.modify(SUBSCRIPTION_PROVIDER, async current => { (current as { access: string }).access = 'SYNTHETIC_CALLBACK_MUTATION'; return undefined; });
  assert.deepEqual(await store.read(SUBSCRIPTION_PROVIDER), token());
  assert.deepEqual(persisted, []);
  assert.deepEqual(await store.list(), [{ providerId: SUBSCRIPTION_PROVIDER, type: 'oauth' }]);
});

test('UX subscription refresh acknowledges durable storage before publishing the rotated credential', async () => {
  const entered = deferred(), release = deferred();
  const persisted: Credential[] = [];
  const store = new SubscriptionCredentialStore(async credential => { entered.resolve(); await release.promise; persisted.push(credential!); });
  await store.seed(token());
  const rotated = store.modify(SUBSCRIPTION_PROVIDER, async current => { assert.deepEqual(current, token()); return token(2); });
  await entered.promise;
  assert.deepEqual(await store.read(SUBSCRIPTION_PROVIDER), token(), 'unacknowledged token must not be used');
  release.resolve(); await rotated;
  assert.deepEqual(persisted, [token(2)]); assert.deepEqual(await store.read(SUBSCRIPTION_PROVIDER), token(2));
});

test('UX subscription failed rotation preserves the old in-memory credential and does not poison later operations', async () => {
  let fail = true;
  const store = new SubscriptionCredentialStore(async () => { if (fail) throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE'); });
  await store.seed(token());
  await assert.rejects(store.modify(SUBSCRIPTION_PROVIDER, async () => token(2)), /CREDENTIAL_STORAGE_UNAVAILABLE/);
  assert.deepEqual(await store.read(SUBSCRIPTION_PROVIDER), token());
  fail = false; await store.modify(SUBSCRIPTION_PROVIDER, async current => { assert.deepEqual(current, token()); return token(3); });
  assert.deepEqual(await store.read(SUBSCRIPTION_PROVIDER), token(3));
});

test('UX subscription arbitrary storage failures remain safe through refresh and wrapped native login errors', async () => {
  const privateFailure = () => { throw new Error('SYNTHETIC_PRIVATE_STORAGE_DETAILS'); };
  const store = new SubscriptionCredentialStore(async () => privateFailure());
  await store.seed(token());
  await assert.rejects(store.modify(SUBSCRIPTION_PROVIDER, async () => token(2)),
    (error: unknown) => error instanceof Error && error.message === 'CREDENTIAL_STORAGE_UNAVAILABLE');
  assert.deepEqual(await store.read(SUBSCRIPTION_PROVIDER), token());
  let writes = 0;
  const f = await fixture({ persist: async () => { writes++; privateFailure(); }, login: async (_interaction, credentials) => {
    try { await credentials.modify(SUBSCRIPTION_PROVIDER, async () => token()); }
    catch (cause) { throw new Error('SYNTHETIC_WRAPPED_NATIVE_MODELS_ERROR', { cause }); }
    return token();
  } });
  await assert.rejects(f.service.login(new AbortController().signal),
    (error: unknown) => error instanceof Error && error.message === 'CREDENTIAL_STORAGE_UNAVAILABLE');
  assert.equal(writes, 1); assert.equal(f.service.snapshot().status, 'signed-out');
  assert.equal(await f.service.credentials.read(SUBSCRIPTION_PROVIDER), undefined);
  assert.doesNotMatch(JSON.stringify(f.states), /SYNTHETIC_PRIVATE_STORAGE_DETAILS|SYNTHETIC_WRAPPED_NATIVE_MODELS_ERROR/);
});

test('UX subscription refresh and logout serialize durable writes and finish signed out', async () => {
  const entered = deferred(), release = deferred();
  const persisted: Array<Credential | undefined> = [];
  const store = new SubscriptionCredentialStore(async credential => { if (credential) { entered.resolve(); await release.promise; } persisted.push(credential); });
  await store.seed(token());
  const refresh = store.modify(SUBSCRIPTION_PROVIDER, async () => token(2)); await entered.promise;
  const logout = store.delete(SUBSCRIPTION_PROVIDER); release.resolve();
  await Promise.all([refresh, logout]);
  assert.deepEqual(persisted, [token(2), undefined]); assert.equal(await store.read(SUBSCRIPTION_PROVIDER), undefined);
});

test('UX subscription login queued behind logout cannot be erased after its credential is persisted', async () => {
  const entered = deferred(), release = deferred();
  let disk: Credential | undefined = token();
  const store = new SubscriptionCredentialStore(async credential => { if (!credential) { entered.resolve(); await release.promise; } disk = credential && structuredClone(credential); });
  await store.seed(token());
  const logout = store.delete(SUBSCRIPTION_PROVIDER); await entered.promise;
  const login = store.modify(SUBSCRIPTION_PROVIDER, async current => { assert.equal(current, undefined, 'logout must finish before a subsequent login writes'); return token(2); });
  release.resolve(); await Promise.all([logout, login]);
  assert.deepEqual(await store.read(SUBSCRIPTION_PROVIDER), token(2)); assert.deepEqual(disk, token(2));
});

test('UX subscription cancellation after durable rotation cannot leave disk and memory with different tokens', async () => {
  const entered = deferred(), release = deferred(), abort = new AbortController();
  let disk: Credential | undefined = token();
  const store = new SubscriptionCredentialStore(async credential => { entered.resolve(); await release.promise; disk = credential && structuredClone(credential); });
  await store.seed(token());
  const outcome = store.modify(SUBSCRIPTION_PROVIDER, async () => token(2), { signal: abort.signal }).then(() => undefined, error => error);
  await entered.promise; abort.abort(); release.resolve(); await outcome;
  // Queue a no-op as a barrier, including implementations that deliver abort to
  // callers before the already-started persistence operation has completed.
  await store.modify(SUBSCRIPTION_PROVIDER, async () => undefined);
  assert.deepEqual(await store.read(SUBSCRIPTION_PROVIDER), disk);
});

test('UX subscription rejected provider IDs, invalid rotations and pre-aborted operations never persist', async () => {
  let writes = 0;
  const store = new SubscriptionCredentialStore(async () => { writes++; }); await store.seed(token());
  await assert.rejects(store.modify('other-provider', async () => token()), /AUTH_UNAVAILABLE/);
  await assert.rejects(store.delete('other-provider'), /AUTH_UNAVAILABLE/);
  await assert.rejects(store.modify(SUBSCRIPTION_PROVIDER, async () => ({ type: 'api_key', key: 'synthetic' })), /CREDENTIAL_STORAGE_UNAVAILABLE/);
  const abort = new AbortController(); abort.abort();
  let callbacks = 0;
  await assert.rejects(store.modify(SUBSCRIPTION_PROVIDER, async () => { callbacks++; return token(2); }, { signal: abort.signal }));
  await assert.rejects(store.delete(SUBSCRIPTION_PROVIDER, { signal: abort.signal }));
  assert.equal(callbacks, 0); assert.equal(writes, 0); assert.deepEqual(await store.read(SUBSCRIPTION_PROVIDER), token());
});

test('UX subscription controller prevents concurrent login/logout while allowing cancellation of the pending prompt', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-ux-auth-controller-'));
  const app = new SleepApp(home), prompted = deferred(); let logins = 0;
  try {
    await app.initializeSubscription({ persist: async () => {}, runtimeFactory: async () => ({
      getModels: () => [{ id: 'synthetic-text', name: 'Synthetic', input: ['text'] }],
      login: async (_provider: string, _kind: string, interaction: AuthInteraction) => {
        logins++;
        const pending = interaction.prompt({ type: 'manual_code', message: 'Synthetic pending callback' }); prompted.resolve(); await pending; return token();
      },
    }) as unknown as ModelRuntime });
    const pending = app.request('loginSubscription', { model: 'synthetic-text' }).then(() => undefined, error => error);
    await prompted.promise;
    assert.equal(app.snapshot().busy, true); assert.equal(app.snapshot().task?.kind, 'auth');
    await assert.rejects(app.request('loginSubscription', { model: 'synthetic-text' }), /BUSY/);
    await assert.rejects(app.request('logoutSubscription'), /BUSY/);
    await assert.rejects(app.request('submitSubscriptionCode', { code: 'bad callback' }), /AUTH_INPUT_INVALID/);
    assert.equal(logins, 1); assert.ok(app.snapshot().subscription?.prompt);
    await app.request('cancel'); assert.match(String(await pending), /CANCELLED/);
    assert.equal(app.snapshot().busy, false); assert.equal(app.snapshot().task, undefined);
    assert.equal(app.snapshot().subscription?.status, 'signed-out');
    assert.equal(app.snapshot().subscription?.prompt, undefined);
  } finally {
    await app.close(); assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true });
  }
});

test('UX subscription cancellation after a completed durable login keeps account state consistent with saved credentials', async () => {
  const abort = new AbortController();
  const f = await fixture({ login: async (_interaction, credentials) => {
    await credentials.modify(SUBSCRIPTION_PROVIDER, async () => token());
    abort.abort();
    return token();
  } });
  await assert.rejects(f.service.login(abort.signal), /CANCELLED/);
  assert.deepEqual(await f.service.credentials.read(SUBSCRIPTION_PROVIDER), token());
  assert.equal(f.service.snapshot().status, 'signed-in', 'the account was saved; UI must not claim signed-out until a deliberate logout succeeds');
  assert.equal(f.service.snapshot().prompt, undefined);
});

test('UX subscription Pi 1.0 login receives a stable installation UUID through native LoginOptions', async () => {
  const f = await fixture();
  await f.service.login(new AbortController().signal);
  await f.service.login(new AbortController().signal);
  const ids = f.loginOptions.map(options => options?.getDeviceId?.());
  assert.ok(ids.every(id => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)), 'native ChatGPT OAuth requires a UUID before it can show an authorization URL');
  assert.equal(ids[0], ids[1]);
});

test('UX subscription Pi 1.0 credentials require issued client ID and direct-token scope for a refreshable account', () => {
  const credential = token() as Record<string, unknown>;
  for (const changed of [
    { ...credential, clientId: undefined }, { ...credential, clientId: '' }, { ...credential, clientId: '   ' },
    { ...credential, scopes: undefined }, { ...credential, scopes: [] }, { ...credential, scopes: ['resource.invoke'] },
    { ...credential, scopes: 'chatgpt.tokens.use.direct' }, { ...credential, access: '   ' }, { ...credential, refresh: '   ' },
  ]) assert.throws(() => subscriptionCredential(changed), /CREDENTIAL_STORAGE_UNAVAILABLE/);
  assert.deepEqual(readSubscriptionCredential(serializeSubscriptionCredential(credential)), credential);
});

test('UX subscription controller reuses its installation UUID after closing and reopening without storing tokens', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-ux-auth-installation-'));
  let app: SleepApp | undefined = new SleepApp(home);
  const ids: Array<string | undefined> = [];
  try {
    for (let iteration = 0; iteration < 2; iteration++) {
      assert.ok(app);
      const prompted = deferred();
      await app.initializeSubscription({ persist: async () => { assert.fail('cancelled synthetic login must not persist a token'); }, runtimeFactory: async () => ({
        getModels: () => [{ id: 'synthetic-text', name: 'Synthetic', input: ['text'] }],
        login: async (_provider: string, _kind: string, interaction: AuthInteraction, options?: LoginOptions) => {
          ids.push(options?.getDeviceId?.());
          const manual = interaction.prompt({ type: 'manual_code', message: 'Synthetic callback' }); prompted.resolve(); await manual; return token();
        },
      }) as unknown as ModelRuntime });
      const pending = app.request('loginSubscription', { model: 'synthetic-text' }).then(() => undefined, error => error);
      await prompted.promise; await app.request('cancel'); assert.match(String(await pending), /CANCELLED/);
      await app.close(); app = undefined;
      if (iteration === 0) app = new SleepApp(home);
    }
    assert.match(ids[0] ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(ids[1], ids[0], 'the installation identity survives restart without a completed login');
  } finally { await app?.close(); assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true }); }
});

test('UX subscription real native Pi 1.0 login reaches its authorization URL and cancels before any token request', { timeout: 10_000 }, async () => {
  const abort = new AbortController(), reached = deferred<string>();
  let service!: SubscriptionService;
  service = await SubscriptionService.create({
    deviceId: '11111111-2222-3333-4444-555555555555',
    persist: async () => { assert.fail('this test cancels before supplying any authorization code'); },
    browser: url => { assert.equal(service.snapshot().status, 'signing-in'); reached.resolve(url); abort.abort(); },
  });
  const pending = service.login(abort.signal).then(() => undefined, error => error);
  const result = await pending;
  assert.ok(result instanceof Error, 'native login should reject cancellation');
  const url = new URL(await reached.promise);
  assert.equal(url.origin, 'https://auth.openai.com');
  assert.equal(url.pathname, '/api/accounts/authorize');
  assert.equal(url.searchParams.get('agent_name_hint'), 'SleepClaw');
  assert.equal(url.searchParams.get('ext_agent_host_id'), 'urn:uuid:11111111-2222-3333-4444-555555555555');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('scope')!.includes('chatgpt.tokens.use.direct'));
  assert.equal(service.snapshot().status, 'signed-out');
  assert.equal(service.snapshot().prompt, undefined);
  assert.equal(await service.credentials.read(SUBSCRIPTION_PROVIDER), undefined);
  const callbackPort = createServer();
  await new Promise<void>((resolve, reject) => {
    callbackPort.once('error', reject);
    callbackPort.listen(1455, '127.0.0.1', () => resolve());
  });
  await new Promise<void>((resolve, reject) => callbackPort.close(error => error ? reject(error) : resolve()));
});
