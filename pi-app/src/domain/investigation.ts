import type { Fact, FactUncertainty, FactValue, Investigation, InvestigationPlan, InvestigationPlanInput } from '../shared/types.js';

const MAX_ORIGINAL_LENGTH = 20_000;
const uncertainWording = /\b(?:maybe|perhaps|possibly|uncertain|not sure|don['’]?t know|do not know|can['’]?t remember|cannot remember|can['’]?t recall|cannot recall)\b|记不清|记不太清|不确定|不知道|可能|也许|说不准/i;
// Recognize uncertainty without extracting a measurement, date, or range.
const approximateWording = /\b(?:about|around|approximately|roughly|approx\.?)\s+(?:\d|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|eleven\b|twelve\b|a (?:few|couple|half)\b|midnight\b|noon\b|bedtime\b)|大约|大概|约莫|差不多|(?:\d+(?:\.\d+)?|[一二三四五六七八九十半]+)(?:\s*(?:个小时|小时|分钟|点|时))?\s*左右/i;

export function inferFactUncertainty(value: FactValue): FactUncertainty | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (uncertainWording.test(value)) return { kind: 'uncertain', original: value };
  if (approximateWording.test(value)) return { kind: 'approximate', original: value };
  return undefined;
}

export function validateFactUncertainty(input: FactUncertainty | undefined, value: FactValue): FactUncertainty | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== 'object' || !['approximate', 'range', 'uncertain'].includes(input.kind)
    || typeof input.original !== 'string' || !input.original.trim() || input.original.length > MAX_ORIGINAL_LENGTH
    || typeof value === 'number' || typeof value === 'boolean') throw new Error('INVALID_FACT_UNCERTAINTY');
  for (const bound of [input.lower, input.upper]) {
    if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound))) throw new Error('INVALID_FACT_UNCERTAINTY');
  }
  if (input.lower !== undefined && input.upper !== undefined && input.lower > input.upper) throw new Error('INVALID_FACT_UNCERTAINTY');
  if (input.unit !== undefined && (typeof input.unit !== 'string' || !input.unit.trim() || input.unit.length > 64)) throw new Error('INVALID_FACT_UNCERTAINTY');
  if (input.kind === 'range' && (input.lower === undefined || input.upper === undefined || input.unit === undefined)) throw new Error('INVALID_FACT_UNCERTAINTY');
  return { kind: input.kind, original: input.original,
    ...(input.lower !== undefined ? { lower: input.lower } : {}),
    ...(input.upper !== undefined ? { upper: input.upper } : {}),
    ...(input.unit !== undefined ? { unit: input.unit.trim() } : {}),
  };
}

export function validateInvestigationPlan(input: InvestigationPlanInput, revision: number): InvestigationPlan {
  if (!input || typeof input !== 'object' || typeof input.objective !== 'string' || !input.objective.trim() || input.objective.length > 4_000
    || !Number.isSafeInteger(input.revision) || input.revision < 1 || !Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > 6) throw new Error('INVALID_PLAN');
  if (input.revision !== revision) throw new Error('PLAN_STALE');
  const ids = new Set<string>();
  const steps = input.steps.map(step => {
    if (!step || typeof step !== 'object' || typeof step.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(step.id) || ids.has(step.id)
      || !['clarify', 'query', 'report'].includes(step.kind) || !['pending', 'done', 'blocked'].includes(step.status)
      || typeof step.description !== 'string' || !step.description.trim() || step.description.length > 2_000
      || (step.reason !== undefined && (typeof step.reason !== 'string' || step.reason.length > 2_000))) throw new Error('INVALID_PLAN');
    ids.add(step.id);
    return { id: step.id, kind: step.kind, description: step.description.trim(), status: step.status,
      ...(step.reason?.trim() ? { reason: step.reason.trim() } : {}),
    };
  });
  return { objective: input.objective.trim(), steps, revision, updatedAt: new Date().toISOString() };
}

export interface InvestigationAmbiguity { id: string; kind: 'target' | 'time' | 'fact'; topic?: string; scope?: Fact['scope']; description: string }
export interface InvestigationNextAction { kind: 'clarify' | 'query' | 'report'; description: string; reason?: string }
export interface InvestigationGuidance {
  revision: number;
  planStatus: 'missing' | 'current' | 'stale';
  ambiguities: InvestigationAmbiguity[];
  nextActions: InvestigationNextAction[];
  canReport: true;
}

/** Advisory only: unknown answers never block a report or require completing the questionnaire. */
export function buildInvestigationGuidance(investigation: Investigation, facts: Fact[]): InvestigationGuidance {
  const zh = investigation.language === 'zh';
  const planStatus = !investigation.plan ? 'missing' : investigation.plan.revision === investigation.revision ? 'current' : 'stale';
  const relevantFacts = facts.filter(fact => fact.scope === 'profile' || fact.investigationId === investigation.id);
  const ambiguities: InvestigationAmbiguity[] = [];
  const suggestions: InvestigationNextAction[] = [];
  const selected = Boolean(investigation.start && investigation.end && investigation.source?.trim()
    && Number.isFinite(Date.parse(investigation.start)) && Number.isFinite(Date.parse(investigation.end))
    && Date.parse(investigation.start) < Date.parse(investigation.end));
  if (!selected) {
    const description = zh ? '如需查询设备记录，请先确认目标睡眠的时段与来源；也可只用自述继续。' : 'For device queries, confirm the sleep interval and source first. You may continue with self-report only.';
    ambiguities.push({ id: 'target', kind: 'target', description });
    suggestions.push({ kind: 'clarify', description });
  }
  for (const fact of relevantFacts) {
    const uncertainty = fact.uncertainty ?? inferFactUncertainty(fact.value);
    if (!uncertainty) continue;
    const isTime = /time|schedule|bedtime|sleep_onset/.test(fact.topic)
      || /\d{1,2}:\d{2}|\b\d{1,2}\s*(?:am|pm)\b|[零一二三四五六七八九十\d]+点/i.test(uncertainty.original);
    const description = fact.status === 'unknown'
      ? (zh ? `「${fact.topic}」仍未知，可保留原话并继续，不重复要求回答。` : `${fact.topic} remains unknown. Keep the original wording and continue without requiring another answer.`)
      : (zh ? `「${fact.topic}」包含${isTime ? '模糊时间' : '不确定信息'}，仅在影响本次分析时确认；保留原话，不转换为精确值。` : `${fact.topic} contains ${isTime ? 'an ambiguous time' : 'uncertain information'}. Clarify only if it affects this investigation; retain the original wording without turning it into an exact value.`);
    ambiguities.push({ id: fact.id, kind: isTime ? 'time' : 'fact', topic: fact.topic, scope: fact.scope, description });
    if (fact.status !== 'unknown') suggestions.push({ kind: 'clarify', description });
  }
  if (selected) suggestions.push({ kind: 'query', description: zh ? '如需设备依据，仅查询已选来源和睡眠时段内的相关记录。' : 'If device evidence is needed, query relevant records only within the selected source and sleep interval.' });
  // Stale plans remain inspectable by revision, but never supply executable next steps.
  const currentSteps = planStatus === 'current' ? investigation.plan!.steps.filter(step => step.status === 'pending').map(({ kind, description, reason }) => ({ kind, description, ...(reason ? { reason } : {}) })) : [];
  const nextActions: InvestigationNextAction[] = investigation.status === 'reported' ? [] : [...currentSteps, ...suggestions].filter(action => action.kind !== 'report' && (action.kind !== 'query' || selected)).slice(0, 5);
  nextActions.push({ kind: 'report', description: zh ? '可随时使用现有信息生成报告，明确未知项；无需完成全部问卷。' : 'You may report with the available information at any time, retaining unknowns without completing every question.' });
  return { revision: investigation.revision, planStatus, ambiguities, nextActions, canReport: true };
}
