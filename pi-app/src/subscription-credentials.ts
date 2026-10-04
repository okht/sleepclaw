import type { Credential } from '@earendil-works/pi-ai';

export const SUBSCRIPTION_PROVIDER = 'openai';

/** Kept out of renderer events and settings; only the main/worker private port carries this. */
export function subscriptionCredential(value: unknown): Credential {
  if (!value || typeof value !== 'object') throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE');
  const item = value as Record<string, unknown>;
  if (item.type !== 'oauth' || typeof item.access !== 'string' || !item.access.trim() || typeof item.refresh !== 'string' || !item.refresh.trim()
    || typeof item.expires !== 'number' || !Number.isFinite(item.expires) || typeof item.clientId !== 'string' || !item.clientId.trim()
    || !Array.isArray(item.scopes) || !item.scopes.every(scope => typeof scope === 'string') || !item.scopes.includes('chatgpt.tokens.use.direct')
    || JSON.stringify(item).length > 65536) throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE');
  return structuredClone(item) as Credential;
}

export function serializeSubscriptionCredential(value: unknown): string {
  return JSON.stringify({ version: 1, provider: SUBSCRIPTION_PROVIDER, credential: subscriptionCredential(value) });
}

export function readSubscriptionCredential(text: string): Credential {
  try {
    const saved = JSON.parse(text);
    if (saved.version !== 1 || saved.provider !== SUBSCRIPTION_PROVIDER) throw new Error();
    return subscriptionCredential(saved.credential);
  } catch { throw new Error('CREDENTIAL_STORAGE_UNAVAILABLE'); }
}

export function subscriptionLoginUrl(value: unknown): string {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.hostname !== 'auth.openai.com' || url.port || url.username || url.password
      || url.pathname !== '/api/accounts/authorize' || url.hash) throw new Error();
    url.searchParams.set('agent_name_hint', 'SleepClaw');
    return url.href;
  } catch { throw new Error('AUTH_INPUT_INVALID'); }
}
