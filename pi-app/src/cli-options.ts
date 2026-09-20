import type { AppSnapshot, Report } from './shared/types.js';

/** An explicit SleepClaw key wins; provider keys are never sent to another provider. */
export function cliApiKey(provider: string | undefined, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = environment.SLEEPCLAW_API_KEY?.trim();
  if (explicit) return explicit;
  if (provider === 'anthropic') return environment.ANTHROPIC_API_KEY?.trim() || undefined;
  if (provider === 'openai') return environment.OPENAI_API_KEY?.trim() || undefined;
  return undefined;
}

export function latestActiveReport(snapshot: Pick<AppSnapshot, 'active' | 'reports'>): Report | undefined {
  if (!snapshot.active) return undefined;
  return snapshot.reports.filter(report => report.investigationId === snapshot.active!.id && report.status === 'complete' && report.factRevision === snapshot.active!.revision).sort((a, b) => b.revision - a.revision)[0];
}
