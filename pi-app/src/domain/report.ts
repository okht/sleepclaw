import type { Analysis, Fact, Feedback, HealthRecord, Investigation, Metric, Report } from '../shared/types.js';

function numberFact(facts: Fact[], topic: string): number | undefined {
  const fact = facts.find(f => f.scope === 'sleep' && f.topic === topic && f.status === 'known');
  // Free prose is never parsed into a measurement. Only explicit numeric answers count.
  if (typeof fact?.value !== 'number' || !Number.isFinite(fact.value) || fact.value < 0) return undefined;
  return fact.value;
}

export function reportContent(investigation: Investigation, facts: Fact[], analysis: Analysis, feedback: Feedback[], aiInterpretation?: string, aiAction?: string, previousReports: Report[] = []): Omit<Report, 'id' | 'revision' | 'createdAt' | 'markdown'> {
  const zh = investigation.language === 'zh';
  const metrics: Metric[] = analysis.metrics.map(m => ({ ...m }));
  for (const [stage, value] of Object.entries(analysis.stages)) metrics.push({ key: `stage_${stage}_minutes`, value, unit: 'min', source: 'derived' });
  const recalledHours = numberFact(facts, 'sleep_duration_hours');
  if (recalledHours !== undefined) metrics.push({ key: 'selfReportedSleepMinutes', value: Math.round(recalledHours * 60), unit: 'min', source: 'self-report' });
  const awakenings = numberFact(facts, 'remembered_awakenings');
  if (awakenings !== undefined && Number.isInteger(awakenings)) metrics.push({ key: 'rememberedAwakenings', value: awakenings, unit: 'count', source: 'self-report' });
  const deviceDuration = metrics.find(m => m.key === 'totalSleepMinutes' && m.value !== null);
  const duration = deviceDuration ?? metrics.find(m => m.key === 'selfReportedSleepMinutes' && m.value !== null);
  const awake = metrics.find(m => m.key === 'awakeMinutes' && m.value !== null);
  const recovery = facts.find(f => f.scope === 'sleep' && f.topic === 'recovery' && f.status === 'known');
  const unavailable = zh ? '资料不足，暂不评价。' : 'There is not enough information to assess this dimension.';
  const dimensions = [
    { key: 'duration', text: duration ? (zh ? `记录的睡眠时长为 ${duration.value} 分钟，来源：${deviceDuration ? '设备估计' : '本人自述'}。` : `Recorded sleep duration: ${duration.value} minutes (${deviceDuration ? 'device estimate' : 'self-report'}).`) : unavailable, score: null },
    { key: 'continuity', text: awake ? (zh ? `所选范围内设备记录清醒 ${awake.value} 分钟；缺记录的间隔不算清醒。` : `The device recorded ${awake.value} awake minutes in the selected interval. Missing intervals are not counted as wake.`) : unavailable, score: null },
    { key: 'structure', text: Object.keys(analysis.stages).length ? (zh ? '有设备估计分期，可查看阶段时长；这些记录不用于医学诊断。' : 'Device-estimated stages are available. These records do not establish a medical diagnosis.') : unavailable, score: null },
    { key: 'regularity', text: zh ? '本阶段未计算长期规律性，暂不评价。' : 'Long-term regularity has not been calculated in this phase.', score: null },
    { key: 'recovery', text: recovery ? (zh ? `你的恢复感：${String(recovery.value)}` : `Your reported recovery: ${String(recovery.value)}`) : unavailable, score: null },
  ];
  const selectedDeviceRange = Boolean(investigation.start && investigation.end && investigation.source);
  const limitations = [
    ...(selectedDeviceRange ? analysis.warnings.map(w => zh ? w : englishWarning(w)) : []),
    zh ? '评分规则尚未完成验证，本次暂不提供 0～100 总分或维度分数。' : 'Scoring rules have not yet been validated. No 0–100 score or dimension score is provided.',
    zh ? '本报告提供睡眠记录分析，不构成诊断或治疗建议。' : 'This report explains sleep records and is not a diagnosis or treatment recommendation.',
  ];
  if (!selectedDeviceRange) {
    limitations.push(zh ? '尚未选择设备记录范围，设备指标暂不可用。' : 'No device-record interval has been selected; device metrics are unavailable.');
    limitations.push(zh ? '本次分析依靠你的自述，时间和感受可能受到回忆偏差影响。' : 'This analysis relies on your recollection, which may affect reported timing and experiences.');
  }
  if (facts.some(f => f.status === 'unknown')) limitations.push(zh ? '部分问题已跳过或回答未知，相关判断仍有限。' : 'Some answers were skipped or unknown, which limits related interpretations.');
  if (aiInterpretation || aiAction) limitations.push(zh ? 'AI 生成的解释和建议可能存在错误，请结合原始记录和自身感受判断。' : 'AI-generated interpretations and suggestions may be wrong. Consider the original records and your own experience.');
  const defaultAction = zh ? '下一次醒来时，记下大概睡了多久，以及醒后的恢复感。下次分析先对照这两项，再决定是否需要改变习惯。' : 'After your next sleep, note its approximate duration and how refreshed you feel. Compare those two observations before deciding whether to change a habit.';
  const proposedAction = aiAction?.trim() || defaultAction;
  const latestFeedback = new Map(feedback.map(item => [item.reportId, item]));
  // Feedback is meaningful only for its linked action, not every future suggestion.
  const declined = previousReports.some(report => report.action === proposedAction && ['cannot', 'unhelpful', 'later'].includes(latestFeedback.get(report.id)?.choice ?? ''));
  const action = declined
    ? (zh ? '先不重复上次的建议。下一次醒来时，用一句话记录恢复感；你可以随时告诉我哪些做法不方便。' : 'We will not repeat a declined suggestion. After your next sleep, note how refreshed you feel in one sentence, and tell us what is impractical.')
    : proposedAction;
  const scope = investigation.scope === 'nap' ? (zh ? '小睡' : 'nap') : investigation.scope === 'segment' ? (zh ? '睡眠片段' : 'sleep segment') : (zh ? '本次睡眠' : 'sleep');
  const summary = duration
    ? (zh ? `${scope}有 ${duration.value} 分钟的时长记录。先结合你的恢复感和记录覆盖情况理解，暂不根据单一数字判断睡得好坏。` : `This ${scope} has ${duration.value} recorded sleep minutes. Consider your recovery and data coverage before judging overall sleep quality.`)
    : (zh ? '目前已整理你的目标和已提供的信息；资料尚不足以计算睡眠时长或评分。你仍可继续补充或查看这份阶段性记录。' : 'Your goal and available information have been recorded. There is not enough information to calculate sleep duration or a score yet. You may add details or keep this preliminary report.');
  return { investigationId: investigation.id, factRevision: investigation.revision, language: investigation.language, title: zh ? `SleepClaw · ${scope}分析` : `SleepClaw · ${scope} analysis`, summary, basis: { start: investigation.start, end: investigation.end, source: investigation.source, scope: investigation.scope }, metrics, dimensions, score: null, scoreVersion: 'unscored-v1', limitations: [...new Set(limitations)], action, aiInterpretation: aiInterpretation?.trim() || undefined, status: 'complete' };
}

export function buildTimeline(records: HealthRecord[], investigation: Investigation): { timeline: NonNullable<Report['timeline']>; truncated: boolean } {
  if (!investigation.start || !investigation.end || !investigation.source) return { timeline: [], truncated: false };
  const events: Array<{ time: number; stage: string; change: number }> = [];
  const from = Date.parse(investigation.start); const to = Date.parse(investigation.end);
  for (const record of records) {
    if (record.type !== 'sleep' || record.source !== investigation.source || !['core', 'deep', 'rem', 'unspecified', 'awake'].includes(String(record.value))) continue;
    const start = Math.max(from, Date.parse(record.start)); const end = Math.min(to, Date.parse(record.end));
    if (end > start) events.push({ time: start, stage: String(record.value), change: 1 }, { time: end, stage: String(record.value), change: -1 });
  }
  events.sort((a, b) => a.time - b.time);
  const active = new Map<string, number>();
  const timeline: NonNullable<Report['timeline']> = [];
  let previous = events[0]?.time;
  for (const event of events) {
    if (event.time > previous) {
      const detailed = ['core', 'deep', 'rem'].filter(stage => (active.get(stage) ?? 0) > 0);
      const awake = (active.get('awake') ?? 0) > 0;
      const unspecified = (active.get('unspecified') ?? 0) > 0;
      const stage = (awake && (detailed.length > 0 || unspecified)) || detailed.length > 1 ? 'unknown' : awake ? 'awake' : detailed[0] ?? (unspecified ? 'unspecified' : undefined);
      if (stage) {
        const start = new Date(previous).toISOString(); const end = new Date(event.time).toISOString();
        const last = timeline.at(-1);
        if (last?.stage === stage && last.end === start) last.end = end;
        else timeline.push({ start, end, stage });
      }
    }
    active.set(event.stage, (active.get(event.stage) ?? 0) + event.change);
    previous = event.time;
  }
  return { timeline: timeline.slice(0, 200), truncated: timeline.length > 200 };
}

function escapeCell(value: unknown): string { return String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' '); }

function englishWarning(warning: string): string {
  const translations: Record<string, string> = {
    '发现多个睡眠数据来源，请选择一个来源后再计算，避免重复计时。': 'Multiple sleep sources were found. Choose one to avoid counting the same sleep twice.',
    '同一来源的清醒与睡眠记录存在冲突，相关总时长暂不计算。': 'Awake and asleep records conflict within the same source. Related duration totals are unavailable.',
    '部分睡眠阶段互相冲突，已单列为未知阶段。': 'Some sleep stages conflict and have been grouped as unknown.',
    '卧床范围或清醒记录不完整，暂不计算睡眠效率。': 'In-bed coverage or awake records are incomplete. Sleep efficiency is unavailable.',
    '所选范围没有可用的睡眠阶段记录。': 'No usable sleep-stage records were found in the selected interval.',
    '本次未计算个人历史基线，设备阶段属于估计结果。': 'No personal historical baseline was calculated. Device stages are estimates.',
  };
  if (translations[warning]) return translations[warning];
  if (warning.includes('单位不兼容')) return 'Some measurements use incompatible units and have been excluded.';
  if (warning.includes('存在多个来源')) return 'Measurements from multiple sources have not been averaged together.';
  return 'The imported records contain a data-quality limitation. Review the import details before interpreting them.';
}

export function renderReport(report: Omit<Report, 'markdown'>): string {
  const zh = report.language === 'zh';
  const metricLabels: Record<string, string> = zh
    ? { totalSleepMinutes: '设备估计睡眠时长', selfReportedSleepMinutes: '自述睡眠时长', awakeMinutes: '记录清醒时长', inBedMinutes: '记录在床时长', sleepEfficiencyPercent: '睡眠效率', heartRateMean: '记录心率均值', hrvMean: '记录 HRV 均值', respiratoryRateMean: '记录呼吸率均值', oxygenSaturationMean: '记录血氧均值', rememberedAwakenings: '记得的醒来次数', stage_core_minutes: '设备估计核心睡眠', stage_deep_minutes: '设备估计深睡', stage_rem_minutes: '设备估计 REM 睡眠', stage_unspecified_minutes: '未细分的睡眠', stage_unknown_minutes: '存在冲突的阶段' }
    : { totalSleepMinutes: 'Device-estimated sleep duration', selfReportedSleepMinutes: 'Recalled sleep duration', awakeMinutes: 'Recorded awake time', inBedMinutes: 'Recorded time in bed', sleepEfficiencyPercent: 'Sleep efficiency', heartRateMean: 'Mean recorded heart rate', hrvMean: 'Mean recorded HRV', respiratoryRateMean: 'Mean recorded breathing rate', oxygenSaturationMean: 'Mean recorded oxygen saturation', rememberedAwakenings: 'Remembered awakenings', stage_core_minutes: 'Device-estimated Core sleep', stage_deep_minutes: 'Device-estimated Deep sleep', stage_rem_minutes: 'Device-estimated REM sleep', stage_unspecified_minutes: 'Unspecified sleep', stage_unknown_minutes: 'Conflicting stages' };
  const dimensionLabels: Record<string, string> = { duration: '时长', continuity: '连续性', structure: '睡眠结构', regularity: '规律性', recovery: '主观恢复' };
  const sourceLabels = zh ? { device: '设备估计', derived: '记录计算', 'self-report': '本人自述' } : { device: 'Device estimate', derived: 'Calculated from records', 'self-report': 'Self-report' };
  const rows = report.metrics.map(m => `| ${escapeCell(metricLabels[m.key] ?? m.key)} | ${m.value === null ? (zh ? '缺少数据' : 'Unavailable') : m.value} | ${escapeCell(m.unit)} | ${escapeCell(sourceLabels[m.source])} |`);
  const stageLabels: Record<string, string> = zh ? { core: '核心睡眠（设备估计）', deep: '深睡（设备估计）', rem: 'REM（设备估计）', unspecified: '未细分睡眠', awake: '清醒记录', unknown: '阶段冲突，未知' } : { core: 'Core (device estimate)', deep: 'Deep (device estimate)', rem: 'REM (device estimate)', unspecified: 'Unspecified sleep', awake: 'Recorded awake', unknown: 'Conflicting stages; unknown' };
  const basis = report.basis;
  const scopeLabels = zh ? { main: '主睡眠', nap: '小睡', segment: '睡眠片段' } : { main: 'Main sleep', nap: 'Nap', segment: 'Sleep segment' };
  return [
    `# ${report.title}`, '', `${zh ? '报告修订' : 'Report revision'}: ${report.revision} · ${report.createdAt}`, '',
    ...(report.status === 'stale' ? [zh ? '> 这份报告的分析依据已更新；以下内容是历史修订，请生成新报告。' : '> The analysis basis has changed. This is a historical revision; generate a new report.', ''] : []), report.summary, '',
    `## ${zh ? '本次分析依据' : 'Analysis basis'}`, '',
    `${zh ? '记录来源' : 'Record source'}: ${basis?.source ?? (zh ? '本人自述；未选择设备来源' : 'Self-report; no device source selected')}`,
    `${zh ? '范围' : 'Scope'}: ${scopeLabels[basis?.scope ?? 'main']}`,
    `${zh ? '开始' : 'Start'}: ${basis?.start ?? (zh ? '未提供' : 'Not provided')}`,
    `${zh ? '结束' : 'End'}: ${basis?.end ?? (zh ? '未提供' : 'Not provided')}`, '',
    `## ${zh ? '评分' : 'Score'}`, '', zh ? '暂不评分。评分规则尚未完成验证。' : 'Not scored. Scoring rules have not yet been validated.', '',
    `## ${zh ? '五个维度' : 'Five dimensions'}`, '', ...report.dimensions.map(d => `- **${zh ? dimensionLabels[d.key] ?? d.key : d.key}**：${d.text}`), '',
    `## ${zh ? '计算和记录结果' : 'Calculated and recorded results'}`, '',
    zh ? '| 指标 | 数值 | 单位 | 来源 |' : '| Metric | Value | Unit | Source |', '| --- | --- | --- | --- |', ...rows, '',
    ...((report.timeline?.length ?? 0) > 0 ? [`## ${zh ? '记录时间线' : 'Recorded timeline'}`, '', zh ? '时间包含时区；空白间隔代表缺少记录，无法据此判断清醒。' : 'Times include a timezone. Gaps mean missing records and do not establish wakefulness.', '', zh ? '| 开始 | 结束 | 阶段 |' : '| Start | End | Stage |', '| --- | --- | --- |', ...report.timeline!.map(item => `| ${item.start} | ${item.end} | ${stageLabels[item.stage] ?? escapeCell(item.stage)} |`), ''] : []),
    ...(report.aiInterpretation ? [`## ${zh ? 'AI 解读' : 'AI interpretation'}`, '', zh ? '以下解释由模型生成，可能存在错误；请结合记录与自身感受判断。' : 'The following interpretation is AI-generated and may be wrong. Consider the records and your own experience.', '', report.aiInterpretation, ''] : []),
    `## ${zh ? '今晚最值得做的一件事' : 'One next action'}`, '', report.action, '',
    `## ${zh ? '分析局限' : 'Limitations'}`, '', ...report.limitations.map(l => `- ${l}`), '',
  ].join('\n');
}
