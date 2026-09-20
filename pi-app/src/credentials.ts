import type { ModelConfig } from './shared/types';

type ModelIdentity = Required<Pick<ModelConfig, 'provider' | 'model' | 'baseUrl' | 'protocol'>>;
interface CredentialPayload { version: 1; identity: ModelIdentity; apiKey: string }

/** Pure normalization: no provider SDK, network access, credential logging or disk writes. */
function identity(config: Omit<ModelConfig, 'apiKey'>): ModelIdentity {
  const provider = config.provider?.trim();
  const model = config.model?.trim();
  if (!provider || !model) throw new Error('CREDENTIAL_PAYLOAD_INVALID');
  const protocol = config.protocol ?? (provider === 'anthropic' ? 'anthropic-messages' : 'openai-completions');
  if (protocol !== 'anthropic-messages' && protocol !== 'openai-completions') throw new Error('CREDENTIAL_PAYLOAD_INVALID');
  const baseUrl = config.baseUrl?.trim() || (provider === 'anthropic' ? 'https://api.anthropic.com' : provider === 'openai' ? 'https://api.openai.com/v1' : '');
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('CREDENTIAL_PAYLOAD_INVALID');
  return { provider, model, baseUrl: url.href.replace(/\/$/, ''), protocol };
}

/** The return value contains a secret and must only be passed to OS encryption, never logged. */
export function serializeCredentialPayload(config: ModelConfig): string {
  try {
    const apiKey = config.apiKey?.trim();
    if (!apiKey || apiKey.length > 4096) throw new Error('CREDENTIAL_PAYLOAD_INVALID');
    const payload: CredentialPayload = { version: 1, identity: identity(config), apiKey };
    return JSON.stringify(payload);
  } catch { throw new Error('CREDENTIAL_PAYLOAD_INVALID'); }
}

/** Legacy bare keys, malformed payloads and mismatched endpoints are never silently reused. */
export function readCredentialPayload(plaintext: string, expected?: Omit<ModelConfig, 'apiKey'>): string | undefined {
  try {
    if (!expected) return undefined;
    const payload = JSON.parse(plaintext) as Partial<CredentialPayload> | null;
    if (!payload || payload.version !== 1 || !payload.identity || typeof payload.apiKey !== 'string') return undefined;
    if (!payload.apiKey.trim() || payload.apiKey.length > 4096) return undefined;
    if (JSON.stringify(identity(payload.identity)) !== JSON.stringify(identity(expected))) return undefined;
    return payload.apiKey.trim();
  } catch { return undefined; }
}
