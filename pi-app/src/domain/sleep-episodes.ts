import type { SleepScope } from '../shared/types.js';

/** The first selected range is an immutable identity anchor, independent of the device. */
export interface SleepEpisode { id: string; investigationId: string; scope: SleepScope; start?: string; end?: string }
export interface SleepTarget { start: string; end: string; source: string; scope: SleepScope }

export function matchesSleepEpisode(episode: SleepEpisode, target: SleepTarget): boolean {
  if (episode.scope !== target.scope || !episode.start || !episode.end) return false;
  const a = Date.parse(episode.start), b = Date.parse(episode.end);
  const c = Date.parse(target.start), d = Date.parse(target.end);
  // A strict majority of BOTH intervals must overlap. This is an attribution policy,
  // not a clinical threshold. Tiny overlaps, half-window bridges and large changes
  // start a separate context; small boundary corrections can retain recollections.
  return Math.min(b, d) - Math.max(a, c) > Math.max(b - a, d - c) / 2;
}

export function selectSleepEpisode(episodes: SleepEpisode[], target: SleepTarget): SleepEpisode | undefined {
  const sameScope = episodes.filter(e => e.scope === target.scope);
  const exact = sameScope.find(e => e.start === target.start && e.end === target.end);
  if (exact) return exact;
  const matches = sameScope.filter(e => matchesSleepEpisode(e, target));
  if (matches.length === 1) return matches[0];
  // An ambiguous bridge must not inherit either episode's facts.
  return matches.length ? undefined : sameScope.find(e => !e.start && !e.end);
}
