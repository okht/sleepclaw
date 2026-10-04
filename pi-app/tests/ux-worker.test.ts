import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';
import { SubscriptionService } from '../src/subscription.js';
import { SUBSCRIPTION_PROVIDER } from '../src/subscription-credentials.js';
import type { AppEvent, AppSnapshot } from '../src/shared/types.js';

// This exercises the actual worker port and acknowledged credential store using
// synthetic credentials only. The OS-encryption implementation remains in main.
const token = (version: number): Credential => ({ type: 'oauth', access: `SYNTHETIC_WORKER_ACCESS_${version}`, refresh: `SYNTHETIC_WORKER_REFRESH_${version}`, expires: 4_000_000_000_000 + version, clientId: 'SYNTHETIC_WORKER_CLIENT', scopes: ['chatgpt.tokens.use.direct'] });
type Message = { id?: string; method?: string; params?: Record<string, unknown>; credentialAckId?: string; ok?: boolean };
type Reply = { id?: string; value?: unknown; error?: string; event?: AppEvent; credentialUpdate?: { id: string; credential?: Credential } };

test('UX worker private credential persistence and acknowledgement protocol', async t => {
  const home = mkdtempSync(join(tmpdir(), 'sleepclaw-ux-worker-'));
  const runtime = process as unknown as { parentPort?: unknown };
  const previousPort = runtime.parentPort;
  const create = SubscriptionService.create;
  let credentials!: CredentialStore;
  let receive!: (event: { data: Message }) => Promise<void>;
  const replies: Reply[] = [];
  let onUpdate: ((update: NonNullable<Reply['credentialUpdate']>) => void) | undefined;
  runtime.parentPort = {
    on: (_name: string, callback: typeof receive) => { receive = callback; },
    postMessage(reply: Reply) { replies.push(reply); if (reply.credentialUpdate) onUpdate?.(reply.credentialUpdate); },
  };
  SubscriptionService.create = options => create({ ...options, runtimeFactory: async store => {
    credentials = store;
    return ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  } });
  const invoke = (id: string, method: string, params?: Record<string, unknown>) => receive({ data: { id, method, params } });
  const ack = (id: string, ok: boolean) => receive({ data: { credentialAckId: id, ok } });
  const nextWrite = () => new Promise<NonNullable<Reply['credentialUpdate']>>(resolve => { onUpdate = update => { onUpdate = undefined; resolve(update); }; });
  const safeTraffic = () => replies.filter(reply => !reply.credentialUpdate);
  let closed = false;
  try {
    await import('../src/worker.js');
    await invoke('boot', 'boot', { home, subscriptionCredential: token(1) });
    assert.equal(replies.find(reply => reply.id === 'boot')?.error, undefined, JSON.stringify(replies));

    await t.test('boot state carries account status but no credential material', async () => {
      const boot = replies.find(reply => reply.id === 'boot');
      assert.ok(boot && !boot.error);
      assert.equal((boot.value as AppSnapshot).subscription?.status, 'signed-in');
      assert.doesNotMatch(JSON.stringify(safeTraffic()), /SYNTHETIC_WORKER_ACCESS|SYNTHETIC_WORKER_REFRESH/);
    });

    await t.test('rotation stays pending until its own successful private acknowledgement', async () => {
      const posted = nextWrite(); let settled = false;
      const rotation = credentials.modify(SUBSCRIPTION_PROVIDER, async () => token(2)).then(value => { settled = true; return value; });
      const update = await posted;
      assert.deepEqual(update.credential, token(2)); assert.ok(update.id);
      assert.equal(settled, false);
      assert.deepEqual(await credentials.read(SUBSCRIPTION_PROVIDER), token(1));
      await ack('synthetic-unrelated-ack', true);
      assert.equal(settled, false, 'an unrelated acknowledgement cannot release the write');
      await invoke('state-during-write', 'state');
      assert.doesNotMatch(JSON.stringify(safeTraffic()), /SYNTHETIC_WORKER_ACCESS|SYNTHETIC_WORKER_REFRESH/);
      await ack(update.id, true);
      assert.deepEqual(await rotation, token(2));
      assert.deepEqual(await credentials.read(SUBSCRIPTION_PROVIDER), token(2));
      const count = replies.length; await ack(update.id, true);
      assert.equal(replies.length, count, 'duplicate acknowledgements create no user reply or event');
    });

    await t.test('negative acknowledgement preserves the previous in-memory credential and returns a safe code', async () => {
      const posted = nextWrite();
      const rotation = credentials.modify(SUBSCRIPTION_PROVIDER, async () => token(3));
      const rejected = assert.rejects(rotation, /^Error: CREDENTIAL_STORAGE_UNAVAILABLE$/);
      const update = await posted; await ack(update.id, false); await rejected;
      assert.deepEqual(await credentials.read(SUBSCRIPTION_PROVIDER), token(2));
    });

    await t.test('missing acknowledgement times out safely and a late acknowledgement cannot resurrect the rejected rotation', async () => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        const posted = nextWrite();
        const rotation = credentials.modify(SUBSCRIPTION_PROVIDER, async () => token(4));
        const rejected = assert.rejects(rotation, /^Error: CREDENTIAL_STORAGE_UNAVAILABLE$/);
        const update = await posted; t.mock.timers.tick(10_000); await rejected;
        await ack(update.id, true);
        assert.deepEqual(await credentials.read(SUBSCRIPTION_PROVIDER), token(2));
      } finally { t.mock.timers.reset(); }
    });

    await t.test('failed logout remains signed in; successful logout waits for deletion acknowledgement', async () => {
      let posted = nextWrite();
      let logout = invoke('logout-failed', 'logoutSubscription');
      let update = await posted;
      assert.equal(update.credential, undefined); await ack(update.id, false); await logout;
      assert.equal(replies.find(reply => reply.id === 'logout-failed')?.error, 'CREDENTIAL_STORAGE_UNAVAILABLE');
      await invoke('state-after-failed-logout', 'state');
      assert.equal((replies.find(reply => reply.id === 'state-after-failed-logout')!.value as AppSnapshot).subscription?.status, 'signed-in');
      assert.deepEqual(await credentials.read(SUBSCRIPTION_PROVIDER), token(2));
      posted = nextWrite(); logout = invoke('logout-success', 'logoutSubscription'); update = await posted;
      assert.equal(replies.some(reply => reply.id === 'logout-success'), false);
      await ack(update.id, true); await logout;
      assert.equal((replies.find(reply => reply.id === 'logout-success')!.value as AppSnapshot).subscription?.status, 'signed-out');
      assert.equal(await credentials.read(SUBSCRIPTION_PROVIDER), undefined);
      assert.doesNotMatch(JSON.stringify(safeTraffic()), /SYNTHETIC_WORKER_ACCESS|SYNTHETIC_WORKER_REFRESH/);
    });

    await t.test('local workflow remains usable after logout and all private writes stay outside AppEvent traffic', async () => {
      await invoke('new-local', 'new', { goal: 'Synthetic worker local report after logout' });
      await invoke('report-local', 'reportLocal');
      const state = replies.find(reply => reply.id === 'report-local')!.value as AppSnapshot;
      assert.equal(state.reports.length, 1); assert.equal(state.configured, false);
      assert.ok(replies.filter(reply => reply.credentialUpdate).every(reply => !reply.id && !reply.event && !reply.value && !reply.error));
      assert.doesNotMatch(JSON.stringify(safeTraffic()), /SYNTHETIC_WORKER_ACCESS|SYNTHETIC_WORKER_REFRESH|credentialUpdate/);
    });
    await invoke('close', 'close'); closed = true;
  } finally {
    t.mock.timers.reset();
    if (!closed) await invoke('cleanup', 'close');
    SubscriptionService.create = create;
    if (previousPort === undefined) delete runtime.parentPort; else runtime.parentPort = previousPort;
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); rmSync(home, { recursive: true, force: true });
  }
});
