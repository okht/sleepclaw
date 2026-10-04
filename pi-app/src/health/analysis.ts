import { createHash } from 'node:crypto';
import type { Analysis, HealthRecord, Metric, SleepCandidate } from '../shared/types.js';

type Interval = { start: number; end: number };
const ASLEEP = new Set(['core', 'deep', 'rem', 'unspecified']);
export const CANDIDATE_GAP_MINUTES = 90;
const minutes = (ms: number) => Math.round(ms / 600) / 100;

function union(intervals: Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const item of intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = result.at(-1);
    if (last && item.start <= last.end) last.end = Math.max(last.end, item.end);
    else result.push({ ...item });
  }
  return result;
}
const duration = (intervals: Interval[]) => union(intervals).reduce((sum, item) => sum + item.end - item.start, 0);
const unique = (records: HealthRecord[]) => [...new Map(records.map((record) => [record.id, record])).values()];

/** Padding may extend one sleep episode, but must never join two episodes. */
function extendEpisodeBounds(episodes: Interval[], bounds: Interval[], padding: Interval[], touching: boolean): void {
  let first = 0;
  for (const interval of union(padding)) {
    while (first < episodes.length && (touching ? episodes[first].end < interval.start : episodes[first].end <= interval.start)) first++;
    const owner = episodes[first], next = episodes[first + 1];
    if (!owner || (touching ? owner.start > interval.end : owner.start >= interval.end)) continue;
    if (next && (touching ? next.start <= interval.end : next.start < interval.end)) continue;
    bounds[first].start = Math.min(bounds[first].start, interval.start);
    bounds[first].end = Math.max(bounds[first].end, interval.end);
  }
}

export function identifyCandidates(records: HealthRecord[]): SleepCandidate[] {
  const grouped = new Map<string, { asleep: Interval[]; awake: Interval[]; inBed: Interval[] }>();
  for (const record of unique(records)) {
    if (record.type !== 'sleep') continue;
    const kind = ASLEEP.has(String(record.value)) ? 'asleep' : record.value === 'awake' ? 'awake' : record.value === 'inBed' ? 'inBed' : undefined;
    const start = Date.parse(record.start), end = Date.parse(record.end);
    if (!kind || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const group = grouped.get(record.source) ?? { asleep: [], awake: [], inBed: [] };
    group[kind].push({ start, end });
    grouped.set(record.source, group);
  }
  const candidates: SleepCandidate[] = [];
  for (const [source, group] of grouped) {
    const episodes: Array<Interval & { asleepMs: number }> = [];
    for (const interval of union(group.asleep)) {
      const last = episodes.at(-1);
      if (last && interval.start - last.end <= CANDIDATE_GAP_MINUTES * 60_000) {
        last.end = interval.end;
        last.asleepMs += interval.end - interval.start;
      } else episodes.push({ ...interval, asleepMs: interval.end - interval.start });
    }
    const bounds = episodes.map(({ start, end }) => ({ start, end }));
    extendEpisodeBounds(episodes, bounds, group.inBed, false);
    extendEpisodeBounds(episodes, bounds, group.awake, true);
    // Conflicting padding from different kinds can overlap even when each has one owner.
    // Keep both original episodes in that case; clipped in-bed metrics stay unknown below.
    const ambiguous = new Set<number>();
    for (let i = 1; i < bounds.length; i++) if (bounds[i - 1].end > bounds[i].start) { ambiguous.add(i - 1); ambiguous.add(i); }
    for (const [index, episode] of episodes.entries()) {
      const range = ambiguous.has(index) ? episode : bounds[index];
      const start = new Date(range.start).toISOString();
      const end = new Date(range.end).toISOString();
      const id = createHash('sha256').update(JSON.stringify([source, start, end])).digest('hex');
      candidates.push({ id, source, start, end, asleepMinutes: minutes(episode.asleepMs) });
    }
  }
  return candidates.sort((a, b) => Date.parse(b.start) - Date.parse(a.start) || a.source.localeCompare(b.source));
}

function stageDurations(records: Array<HealthRecord & { clipped: Interval }>): Record<string, number> {
  const events: Array<{ time: number; stage: string; change: number }> = [];
  for (const record of records) if (ASLEEP.has(String(record.value))) {
    events.push({ time: record.clipped.start, stage: String(record.value), change: 1 }, { time: record.clipped.end, stage: String(record.value), change: -1 });
  }
  events.sort((a, b) => a.time - b.time);
  const active = new Map<string, number>();
  const totals: Record<string, number> = {};
  let previous = events[0]?.time;
  for (const event of events) {
    if (event.time > previous) {
      const detailed = ['core', 'deep', 'rem'].filter((key) => (active.get(key) ?? 0) > 0);
      const stage = detailed.length > 1 ? 'unknown' : detailed[0] ?? ((active.get('unspecified') ?? 0) > 0 ? 'unspecified' : undefined);
      if (stage) totals[stage] = (totals[stage] ?? 0) + event.time - previous;
    }
    active.set(event.stage, (active.get(event.stage) ?? 0) + event.change);
    previous = event.time;
  }
  return Object.fromEntries(Object.entries(totals).map(([key, ms]) => [key, minutes(ms)]));
}

export function analyzeRecords(records: HealthRecord[], options: { start?: string; end?: string; source?: string } = {}): Analysis {
  const warnings: string[] = [];
  const from = options.start === undefined ? -Infinity : Date.parse(options.start);
  const to = options.end === undefined ? Infinity : Date.parse(options.end);
  if (Number.isNaN(from) || Number.isNaN(to) || from >= to) throw new Error('分析时间范围无效。');
  const window = unique(records).filter((r) => {
    const start = Date.parse(r.start);
    const end = Date.parse(r.end);
    return start === end ? start >= from && start < to : end > from && start < to;
  });
  const sleepSources = new Set(window.filter((r) => r.type === 'sleep' && ASLEEP.has(String(r.value))).map((r) => r.source));
  const ambiguous = !options.source && sleepSources.size > 1;
  const source = options.source ?? (sleepSources.size === 1 ? [...sleepSources][0] : undefined);
  if (ambiguous) warnings.push('发现多个睡眠数据来源，请选择一个来源后再计算，避免重复计时。');
  const selected = window.filter((r) => !source || r.source === source);
  const sleep = (ambiguous ? [] : selected.filter((r) => r.type === 'sleep')).map((r) => ({ ...r, clipped: { start: Math.max(from, Date.parse(r.start)), end: Math.min(to, Date.parse(r.end)) } })).filter((r) => r.clipped.end > r.clipped.start);
  const asleep = sleep.filter((r) => ASLEEP.has(String(r.value))).map((r) => r.clipped);
  const awake = sleep.filter((r) => r.value === 'awake').map((r) => r.clipped);
  const inBed = sleep.filter((r) => r.value === 'inBed').map((r) => r.clipped);
  const asleepMs = duration(asleep);
  const awakeMs = duration(awake);
  const inBedMs = duration(inBed);
  const inBedBoundaryClipped = sleep.some((r) => r.value === 'inBed' && (Date.parse(r.start) < from || Date.parse(r.end) > to));
  const conflict = asleepMs + awakeMs > duration([...asleep, ...awake]);
  if (conflict) warnings.push('同一来源的清醒与睡眠记录存在冲突，相关总时长暂不计算。');
  const stages = stageDurations(sleep);
  if (stages.unknown) warnings.push('部分睡眠阶段互相冲突，已单列为未知阶段。');
  const completeInBed = inBedMs > 0 && asleepMs > 0 && !conflict && !inBedBoundaryClipped && duration([...inBed, ...asleep, ...awake]) === inBedMs && duration([...asleep, ...awake]) === inBedMs;
  const metrics: Metric[] = [
    { key: 'totalSleepMinutes', value: asleep.length && !conflict ? minutes(asleepMs) : null, unit: 'min', source: 'derived', note: '设备标记为睡眠的区间并集；卧床和重复阶段不会重复相加。' },
    { key: 'awakeMinutes', value: awake.length && !conflict ? minutes(awakeMs) : null, unit: 'min', source: 'derived', note: '仅统计设备记录到的清醒，缺少记录不等于零清醒。' },
    { key: 'inBedMinutes', value: inBed.length ? minutes(inBedMs) : null, unit: 'min', source: 'derived' },
    { key: 'sleepEfficiencyPercent', value: completeInBed ? Math.round(asleepMs / inBedMs * 10_000) / 100 : null, unit: '%', source: 'derived', note: '需要可靠卧床范围和完整睡眠／清醒覆盖；资料不足时不计算。' },
  ];
  if (inBedBoundaryClipped) warnings.push('所选时段截断了原始卧床记录，不能据此计算完整卧床期间的睡眠效率。');
  if (!completeInBed) warnings.push('卧床范围或清醒记录不完整，暂不计算睡眠效率。');
  const physiology: Array<[HealthRecord['type'], string, string, string[]]> = [
    ['heartRate', 'heartRateMean', 'bpm', ['count/min', 'bpm']],
    ['hrv', 'hrvMean', 'ms', ['ms']],
    ['respiratoryRate', 'respiratoryRateMean', 'count/min', ['count/min']],
    ['oxygenSaturation', 'oxygenSaturationMean', '%', ['%']],
  ];
  for (const [type, key, unit, acceptedUnits] of physiology) {
    const available = selected.filter((r) => r.type === type);
    const mixed = new Set(available.map((r) => r.source)).size > 1;
    const compatible = available.filter((r) => typeof r.value === 'number' && acceptedUnits.includes(r.unit ?? '') && (type !== 'oxygenSaturation' || r.value <= 1));
    if (available.length !== compatible.length) warnings.push(`${key} 的部分记录数值或单位不兼容，已排除。`);
    if (mixed) warnings.push(`${key} 存在多个来源，暂不合并平均值。`);
    // HealthKit percent is a 0..1 fraction; display percentages as 0..100.
    // https://developer.apple.com/documentation/healthkit/hkunit/percent()
    const scale = type === 'oxygenSaturation' ? 100 : 1;
    const value = !ambiguous && !mixed && compatible.length ? Math.round(compatible.reduce((sum, r) => sum + Number(r.value), 0) / compatible.length * scale * 100) / 100 : null;
    metrics.push({ key, value, unit, source: 'derived', note: '已记录样本的算术平均；无法代表缺失时段，不用于诊断。' });
  }
  if (!asleep.length && !ambiguous) warnings.push('所选范围没有可用的睡眠阶段记录。');
  warnings.push('本次未计算个人历史基线，设备阶段属于估计结果。');
  const observed = selected.length ? selected : window;
  let start = options.start;
  let end = options.end;
  for (const r of observed) {
    if (!options.start && (!start || Date.parse(r.start) < Date.parse(start))) start = r.start;
    if (!options.end && (!end || Date.parse(r.end) > Date.parse(end))) end = r.end;
  }
  return { start, end, source, metrics, stages, warnings, recordCount: selected.length, inBedBoundaryClipped };
}
