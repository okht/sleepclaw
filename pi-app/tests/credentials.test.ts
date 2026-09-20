import assert from 'node:assert/strict';
import test from 'node:test';
import { readCredentialPayload, serializeCredentialPayload } from '../src/credentials.js';
import type { ModelConfig } from '../src/shared/types.js';

const syntheticKey = 'synthetic-secret-never-a-real-api-key';
const model: ModelConfig = { provider: 'openai', model: 'synthetic-model', baseUrl: 'https://api.example.test/v1', protocol: 'openai-completions', apiKey: syntheticKey };

test('versioned credential payload roundtrips only for its associated model identity', () => {
  const serialized = serializeCredentialPayload(model);
  const decoded = JSON.parse(serialized);
  assert.equal(decoded.version, 1);
  assert.equal(readCredentialPayload(serialized, model), syntheticKey);
  assert.ok(!JSON.stringify(decoded.identity).includes(syntheticKey));
});

test('provider, endpoint, model and protocol mismatch cannot reuse a saved secret', () => {
  const serialized = serializeCredentialPayload(model);
  const mismatches: ModelConfig[] = [
    { ...model, provider: 'another-provider' },
    { ...model, baseUrl: 'https://untrusted.example.test/v1' },
    { ...model, baseUrl: 'https://api.example.test/other-api' },
    { ...model, model: 'another-model' },
    { ...model, protocol: 'anthropic-messages' },
  ];
  for (const changed of mismatches) assert.equal(readCredentialPayload(serialized, changed), undefined);
  assert.equal(readCredentialPayload(serialized, undefined), undefined);
});

test('normalization accepts equivalent URL spelling and explicit/default protocols', () => {
  const serialized = serializeCredentialPayload({ ...model, provider: ' openai ', model: ' synthetic-model ', baseUrl: 'https://API.EXAMPLE.TEST:443/v1/', apiKey: ` ${syntheticKey} ` });
  assert.equal(readCredentialPayload(serialized, { ...model, protocol: undefined }), syntheticKey);
  assert.equal(readCredentialPayload(serializeCredentialPayload({ provider: 'openai', model: 'test', apiKey: syntheticKey }), { provider: 'openai', model: 'test', baseUrl: 'https://api.openai.com/v1', protocol: 'openai-completions' }), syntheticKey);
});

test('old bare keys, corrupt data, unknown payload versions and malformed identities require reconnecting', () => {
  for (const plaintext of [syntheticKey, JSON.stringify(syntheticKey), '{broken', 'null', '{}', JSON.stringify({ ...JSON.parse(serializeCredentialPayload(model)), version: 2 }), JSON.stringify({ version: 1, identity: null, apiKey: syntheticKey }), JSON.stringify({ version: 1, identity: { provider: 42 }, apiKey: syntheticKey })]) {
    assert.equal(readCredentialPayload(plaintext, model), undefined);
  }
});

test('invalid payload serialization emits a fixed code without echoing credentials or URLs', () => {
  for (const invalid of [{ ...model, apiKey: '' }, { ...model, baseUrl: `https://user:${syntheticKey}@example.test` }, { ...model, baseUrl: `invalid-${syntheticKey}` }]) {
    assert.throws(() => serializeCredentialPayload(invalid), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, 'CREDENTIAL_PAYLOAD_INVALID');
      assert.ok(!error.message.includes(syntheticKey));
      return true;
    });
  }
});

test('tampered encrypted contents with empty or non-string keys are not accepted', () => {
  const payload = JSON.parse(serializeCredentialPayload(model));
  for (const apiKey of ['', ' ', null, {}, 'x'.repeat(4097)]) assert.equal(readCredentialPayload(JSON.stringify({ ...payload, apiKey }), model), undefined);
});
