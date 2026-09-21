import { median, quantile } from 'simple-statistics';
import { analyzeRecords } from './analysis.js';
import type { HealthRecord, Language, Metric } from '../shared/types.js';

export const HEALTH_EVIDENCE_METHOD_VERSION = 'health-evidence-v1' as const;
const LIMIT = 200;
const ASLEEP = new Set(['core', 'deep', 'rem', 'unspecified']);
const STAGES = new Set([...ASLEEP, 'awake', 'inBed']);
type PhysiologyType = Exclude<HealthRecord['type'], 'sleep'>;
type Rejection = 'invalidDate' | 'invalidInterval' | 'invalidValue' | 'negativeValue' | 'outOfRangeValue' | 'unsupportedUnit' | 'unsupportedType' | 'unsupportedStage';
type Message = { code: string; text: string };
type Interval = { start: number; end: number };
type Accepted = { record: HealthRecord; interval: Interval };

export interface HealthEvidenceOptions { start: string; end: string; source: string; language?: Language }
export interface PhysiologyEvidence {
  type: PhysiologyType; label: string; source: string; unit: string; inputUnits: string[];
  quantileMethod: 'linear-r7';
  count: number; min: number | null; max: number | null; median: number | null; p25: number | null; p75: number | null;
  firstSample: string | null; lastSample: string | null; largestGapMinutes: number | null; note: string;
}
export interface HealthEvidenceAnalysis {
  methodVersion: typeof HEALTH_EVIDENCE_METHOD_VERSION;
  source: string;
  window: { start: string; end: string; durationMinutes: number; intervalConvention: '[start,end)' };
  /** Accepted record IDs, in chronological order; calculations always use all accepted records. */
  inputRecordIds: string[];
  inputRecordIdsTruncated: boolean;
  counts: { input: number; selected: number; accepted: number; duplicates: number; outsideWindow: number; otherSource: number; rejected: Record<Rejection, number> };
  sleep: {
    metrics: Metric[]; stages: Record<string, number>;
    observedSleepMinutes: number | null; observedAwakeMinutes: number | null; observedMinutes: number | null;
    coveragePercent: number | null; unobservedMinutes: number;
    gaps: Array<{ start: string; end: string; minutes: number }>; gapCount: number; gapsTruncated: boolean;
    sleepAwakeConflictMinutes: number; stageConflictMinutes: number; stageChangeCount: number | null;
    inBedUnobservedMinutes: number | null; stageChangeNote: string;
  };
  physiology: PhysiologyEvidence[];
  warnings: Message[];
  limitations: Message[];
}

const round = (n: number) => Number(n.toFixed(2));
const minutes = (ms: number) => round(ms / 60_000);
const iso = (time: number) => new Date(time).toISOString();

/** Require an explicit offset, avoiding machine-local timezone interpretation. */
export function parseZonedTimestamp(value: string): number {
  if (typeof value !== 'string') return NaN;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return NaN;
  const [, year, month, day, hour, minute, second] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > monthDays[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) return NaN;
  return Date.parse(value);
}

const DEFINITIONS: Record<PhysiologyType, { unit: string; acceptedUnits: string[]; label: [string, string] }> = {
  heartRate: { unit: 'bpm', acceptedUnits: ['count/min', 'bpm'], label: ['心率', 'Heart rate'] },
  hrv: { unit: 'ms', acceptedUnits: ['ms'], label: ['心率变异性（SDNN）', 'HRV (SDNN)'] },
  respiratoryRate: { unit: 'count/min', acceptedUnits: ['count/min'], label: ['呼吸频率', 'Respiratory rate'] },
  oxygenSaturation: { unit: '%', acceptedUnits: ['%'], label: ['血氧饱和度', 'Oxygen saturation'] },
};

function rejection(record: HealthRecord): Rejection | undefined {
  if (record.type === 'sleep') {
    if (!STAGES.has(String(record.value))) return 'unsupportedStage';
    if (record.unit !== undefined && record.unit !== '') return 'unsupportedUnit';
    return;
  }
  if (!Object.hasOwn(DEFINITIONS, record.type)) return 'unsupportedType';
  if (typeof record.value !== 'number' || !Number.isFinite(record.value)) return 'invalidValue';
  if (record.value < 0) return 'negativeValue';
  if (!DEFINITIONS[record.type].acceptedUnits.includes(record.unit ?? '')) return 'unsupportedUnit';
  // HealthKit percent quantities use fractions, not already-scaled percentages.
  // https://developer.apple.com/documentation/healthkit/hkunit/percent()
  if (record.type === 'oxygenSaturation' && record.value > 1) return 'outOfRangeValue';
}

/** A single sweep measures coverage/conflicts without double counting or filling gaps. */
function sleepCoverage(records: Accepted[], from: number, to: number) {
  const events = new Map<number, Map<string, number>>([[from, new Map()], [to, new Map()]]);
  for (const { record, interval } of records) {
    for (const [time, delta] of [[interval.start, 1], [interval.end, -1]]) {
      const changes = events.get(time) ?? new Map<string, number>();
      const stage = String(record.value);
      changes.set(stage, (changes.get(stage) ?? 0) + delta);
      events.set(time, changes);
    }
  }
  const times = [...events.keys()].sort((a, b) => a - b);
  const active = new Map<string, number>();
  const gaps: Interval[] = [];
  let pendingGap: Interval | undefined;
  let gapCount = 0;
  let asleepMs = 0, awakeMs = 0, observedMs = 0, unobservedMs = 0;
  let sleepAwakeConflictMs = 0, stageConflictMs = 0, inBedMs = 0, inBedUnobservedMs = 0, observedOutsideInBedMs = 0;
  let stageChangeCount = 0;
  let hasStageLabels = false;
  let previousStage: string | undefined;
  const finishGap = () => {
    if (!pendingGap) return;
    gapCount++;
    if (gaps.length < LIMIT) gaps.push(pendingGap);
    pendingGap = undefined;
  };
  for (let i = 0; i < times.length - 1; i++) {
    const start = times[i], end = times[i + 1], elapsed = end - start;
    for (const [stage, delta] of events.get(start)!) active.set(stage, (active.get(stage) ?? 0) + delta);
    const has = (stage: string) => (active.get(stage) ?? 0) > 0;
    const detailed = ['core', 'deep', 'rem'].filter(has);
    const asleep = detailed.length > 0 || has('unspecified');
    const awake = has('awake'), inBed = has('inBed');
    if (asleep) asleepMs += elapsed;
    if (awake) awakeMs += elapsed;
    if (asleep || awake) { observedMs += elapsed; finishGap(); }
    else {
      unobservedMs += elapsed;
      if (pendingGap) pendingGap.end = end;
      else pendingGap = { start, end };
    }
    if (asleep && awake) sleepAwakeConflictMs += elapsed;
    if (detailed.length > 1) stageConflictMs += elapsed;
    if (inBed) { inBedMs += elapsed; if (!asleep && !awake) inBedUnobservedMs += elapsed; }
    else if (asleep || awake) observedOutsideInBedMs += elapsed;
    // Count only adjacent, unambiguous device labels. Gaps, conflicts and generic asleep break the sequence.
    const currentStage = asleep && awake || detailed.length > 1 ? undefined : awake ? 'awake' : detailed[0];
    if (currentStage) hasStageLabels = true;
    if (previousStage && currentStage && previousStage !== currentStage) stageChangeCount++;
    previousStage = currentStage;
  }
  finishGap();
  return { asleepMs, awakeMs, observedMs, unobservedMs, sleepAwakeConflictMs, stageConflictMs, inBedMs, inBedUnobservedMs, observedOutsideInBedMs, stageChangeCount, hasStageLabels, gaps, gapCount };
}

/**
 * Pure single-source, single-window evidence summary. First occurrence wins for duplicate IDs.
 * Quantity records overlapping the half-open window contribute one unweighted sample each;
 * sample timestamps are clipped starts, and gaps measure start-to-start spacing (not continuous coverage).
 * The output is descriptive only: no clinical thresholds, causal claims, baseline, HRV reconstruction or EEG staging.
 */
export function analyzeHealthEvidence(records: HealthRecord[], options: HealthEvidenceOptions): HealthEvidenceAnalysis {
  const en = options.language === 'en';
  const t = (zh: string, english: string) => en ? english : zh;
  const from = parseZonedTimestamp(options.start), to = parseZonedTimestamp(options.end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new Error(t('分析时间范围无效；请提供含时区的起止时间。', 'Invalid analysis window; provide start and end with explicit timezones.'));
  if (typeof options.source !== 'string' || !options.source.trim()) throw new Error(t('请选择一个数据来源。', 'Select one data source.'));
  const counts: HealthEvidenceAnalysis['counts'] = {
    input: records.length, selected: 0, accepted: 0, duplicates: 0, outsideWindow: 0, otherSource: 0,
    rejected: { invalidDate: 0, invalidInterval: 0, invalidValue: 0, negativeValue: 0, outOfRangeValue: 0, unsupportedUnit: 0, unsupportedType: 0, unsupportedStage: 0 },
  };
  const seen = new Set<string>();
  const accepted: Accepted[] = [];
  for (const record of records) {
    if (record.source !== options.source) { counts.otherSource++; continue; }
    counts.selected++;
    if (seen.has(record.id)) { counts.duplicates++; continue; }
    seen.add(record.id);
    const start = parseZonedTimestamp(record.start), end = parseZonedTimestamp(record.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) { counts.rejected.invalidDate++; continue; }
    if (end < start || record.type === 'sleep' && start === end) { counts.rejected.invalidInterval++; continue; }
    if (start === end ? start < from || start >= to : end <= from || start >= to) { counts.outsideWindow++; continue; }
    const reason = rejection(record);
    if (reason) { counts.rejected[reason]++; continue; }
    accepted.push({ record, interval: { start: Math.max(from, start), end: Math.min(to, end) } });
  }
  accepted.sort((a, b) => a.interval.start - b.interval.start || a.interval.end - b.interval.end || a.record.id.localeCompare(b.record.id));
  counts.accepted = accepted.length;
  const sleepRecords = accepted.filter(({ record }) => record.type === 'sleep');
  const base = analyzeRecords(sleepRecords.map(({ record }) => record), options);
  const coverage = sleepCoverage(sleepRecords, from, to);
  const metrics = base.metrics.filter((metric) => ['totalSleepMinutes', 'awakeMinutes', 'inBedMinutes', 'sleepEfficiencyPercent'].includes(metric.key)).map((metric) => ({
    ...metric,
    note: t('复用所选来源的区间并集计算；缺失或冲突保留为空。', 'Uses the selected source interval-union calculation; missing or conflicting evidence remains null.'),
  }));
  const physiology = (Object.keys(DEFINITIONS) as PhysiologyType[]).map((type): PhysiologyEvidence => {
    const definition = DEFINITIONS[type];
    const samples = accepted.filter(({ record }) => record.type === type);
    const values = samples.map(({ record }) => Number(record.value) * (type === 'oxygenSaturation' ? 100 : 1));
    const sorted = [...values].sort((a, b) => a - b);
    let largestGap: number | null = null;
    for (let i = 1; i < samples.length; i++) largestGap = Math.max(largestGap ?? 0, samples[i].interval.start - samples[i - 1].interval.start);
    return {
      type, label: definition.label[en ? 1 : 0], source: options.source, unit: definition.unit, quantileMethod: 'linear-r7',
      inputUnits: [...new Set(samples.map(({ record }) => record.unit!))].sort(), count: values.length,
      min: sorted.length ? round(sorted[0]) : null, max: sorted.length ? round(sorted.at(-1)!) : null,
      median: values.length ? round(median(values)) : null,
      p25: values.length ? round(quantile(values, 0.25)) : null, p75: values.length ? round(quantile(values, 0.75)) : null,
      firstSample: samples.length ? iso(samples[0].interval.start) : null,
      lastSample: samples.length ? iso(samples.at(-1)!.interval.start) : null,
      largestGapMinutes: largestGap === null ? null : minutes(largestGap),
      note: t('仅描述已记录样本，未按持续时间加权；时间为裁剪后的样本起点，间隔为相邻起点距离，不能代表缺失时段。', 'Describes recorded samples only, without duration weighting. Times are clipped sample starts; gaps are between adjacent starts and do not establish coverage of missing periods.'),
    };
  });
  const warnings: Message[] = [];
  const warn = (code: string, zh: string, english: string) => warnings.push({ code, text: t(zh, english) });
  if (!coverage.observedMs) warn('no_sleep_observations', '没有可用的睡眠或清醒阶段记录；卧床记录不能补齐阶段。', 'No usable sleep or awake stages; in-bed records cannot fill stage coverage.');
  if (coverage.unobservedMs) warn('unobserved_sleep_intervals', '部分时段没有睡眠或清醒记录；这些缺口保持未知，不计为清醒。', 'Some intervals have no sleep or awake records; these gaps remain unknown and are not counted as awake.');
  if (coverage.sleepAwakeConflictMs) warn('sleep_awake_conflict', '睡眠与清醒标签重叠；相关总时长及效率保持为空。', 'Sleep and awake labels overlap; corresponding totals and efficiency remain null.');
  if (coverage.stageConflictMs) warn('sleep_stage_conflict', '多个详细睡眠阶段重叠；复用计算将这部分列为未知阶段。', 'Detailed sleep stages overlap; the shared calculation reports these intervals as unknown stages.');
  if (coverage.inBedMs && (coverage.inBedUnobservedMs || coverage.observedOutsideInBedMs)) warn('in_bed_coverage_incomplete', '存在卧床记录，但卧床与睡眠／清醒覆盖不完整匹配；不据此补齐效率。', 'In-bed records exist, but in-bed and sleep/awake coverage do not fully match; efficiency is not filled in.');
  if (Object.values(counts.rejected).some(Boolean)) warn('rejected_records', '已排除无效日期、区间、数值、类型或不支持单位的记录；详见分类计数。', 'Records with invalid dates, intervals, values, types or unsupported units were excluded; see the rejection counts.');
  if (counts.duplicates) warn('duplicate_ids', '同一记录 ID 只保留首次出现的记录。', 'Only the first occurrence of each record ID was retained.');
  const limitations = [
    { code: 'descriptive_only', text: t('结果是记录摘要，不提供诊断、异常阈值或病因判断。', 'This is a descriptive record summary, without diagnosis, abnormality thresholds or causal conclusions.') },
    { code: 'device_estimates', text: t('睡眠阶段来自设备估计，未重新计算或推断 EEG 分期。', 'Sleep stages are device estimates; EEG stages are neither recalculated nor inferred.') },
    { code: 'rr_intervals_unavailable', text: t('没有逐搏 RR 间期；HRV 仅汇总已导入的 SDNN 样本，不从离散心率推算。', 'Beat-to-beat RR intervals are unavailable. HRV summarizes imported SDNN samples only and is not reconstructed from discrete heart-rate samples.') },
    { code: 'no_baseline', text: t('只分析所选时段与来源，未计算多晚趋势或个人基线。', 'Only the selected window and source are analyzed; no multi-night trend or personal baseline is calculated.') },
    { code: 'sample_statistics', text: t('样本统计不表示整晚连续测量；分位数使用 simple-statistics 7.12.0 的 quantile，单样本分位数等于该样本。', 'Sample statistics do not imply continuous overnight measurement. Quantiles use simple-statistics 7.12.0 quantile; a singleton has the same value at every quantile.') },
  ];
  return {
    methodVersion: HEALTH_EVIDENCE_METHOD_VERSION, source: options.source,
    window: { start: iso(from), end: iso(to), durationMinutes: minutes(to - from), intervalConvention: '[start,end)' },
    inputRecordIds: accepted.slice(0, LIMIT).map(({ record }) => record.id), inputRecordIdsTruncated: accepted.length > LIMIT, counts,
    sleep: {
      metrics, stages: base.stages,
      observedSleepMinutes: coverage.asleepMs ? minutes(coverage.asleepMs) : null,
      observedAwakeMinutes: coverage.awakeMs ? minutes(coverage.awakeMs) : null,
      observedMinutes: coverage.observedMs ? minutes(coverage.observedMs) : null,
      coveragePercent: coverage.observedMs ? round(coverage.observedMs / (to - from) * 100) : null,
      unobservedMinutes: minutes(coverage.unobservedMs),
      gaps: coverage.gaps.map(({ start, end }) => ({ start: iso(start), end: iso(end), minutes: minutes(end - start) })),
      gapCount: coverage.gapCount, gapsTruncated: coverage.gapCount > LIMIT,
      sleepAwakeConflictMinutes: minutes(coverage.sleepAwakeConflictMs), stageConflictMinutes: minutes(coverage.stageConflictMs),
      stageChangeCount: coverage.hasStageLabels ? coverage.stageChangeCount : null,
      inBedUnobservedMinutes: coverage.inBedMs ? minutes(coverage.inBedUnobservedMs) : null,
      stageChangeNote: t('仅计连续、无冲突的清醒／Core／Deep／REM 标签变化；缺口、冲突和未细分睡眠会中断计数，不代表临床觉醒。', 'Counts only adjacent, unambiguous Awake/Core/Deep/REM label changes. Gaps, conflicts and unspecified sleep break the sequence; this is not a clinical arousal count.'),
    },
    physiology, warnings, limitations,
  };
}
