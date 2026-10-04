import type { Investigation, Report } from './types';

/** Legacy reports have no episode ID: only an explicitly matching basis is usable. */
export function reportsForEpisode(reports: Report[], investigation?: Investigation): Report[] {
  if (!investigation) return [];
  const episodeId = investigation.sleepEpisodeId ?? investigation.id;
  return reports.filter(report => {
    if (report.investigationId !== investigation.id) return false;
    if (report.sleepEpisodeId) return report.sleepEpisodeId === episodeId;
    return episodeId === investigation.id && Boolean(report.basis)
      && report.basis?.start === investigation.start
      && report.basis?.end === investigation.end
      && report.basis?.scope === investigation.scope;
  });
}
