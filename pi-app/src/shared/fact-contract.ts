import type { FactInput, FactUncertainty, FactValue, Language } from './types.js';

export const FACT_CONTRACT_GUIDANCE = `Core sleep facts use scope="sleep": sleep_duration_hours is recalled sleep duration in hours; remembered_awakenings is a count; recovery is the user's feeling after waking. Use those exact topic keys. A bare number for sleep_duration_hours or its legacy alias sleep_duration means hours, never minutes. Include explicit units in a string when the user gives minutes. Preserve ranges, approximate wording and uncertainty as strings with uncertainty metadata; never invent an exact midpoint. Legacy sleep aliases sleep_duration, wake_feeling and waking_feeling are normalized to sleep_duration_hours or recovery. Profile habits retain scope="profile". Other topics, including sleep_complaint, remain custom facts and do not establish recovery. Custom facts remain visible in the report's fact recap. Only save user-supplied information.`;

const aliases: Record<string, string> = { sleep_duration: 'sleep_duration_hours', wake_feeling: 'recovery', waking_feeling: 'recovery' };
export function canonicalFactTopic(topic: string, scope: FactInput['scope']): string {
  return scope === 'sleep' && Object.hasOwn(aliases, topic) ? aliases[topic] : topic;
}

const uncertainWording = /\b(?:maybe|perhaps|possibly|uncertain|not sure|don['’]?t know|do not know|can['’]?t remember|cannot remember|can['’]?t recall|cannot recall)\b|记不清|记不太清|不确定|不知道|可能|也许|说不准/i;
const approximateWording = /\b(?:about|around|approximately|roughly|approx\.?)\s+(?:\d|one\b|two\b|three\b|four\b|five\b|six\b|seven\b|eight\b|nine\b|ten\b|eleven\b|twelve\b|a (?:few|couple|half)\b|midnight\b|noon\b|bedtime\b)|大约|大概|约莫|差不多|(?:^|\s)约\s*(?:\d|[零一二两三四五六七八九十半])|(?:\d+(?:\.\d+)?|[一二三四五六七八九十半]+)(?:\s*(?:个小时|小时|分钟|点|时))?\s*左右/i;
export function inferFactUncertainty(value: FactValue): FactUncertainty | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  if (uncertainWording.test(value)) return { kind: 'uncertain', original: value };
  if (approximateWording.test(value)) return { kind: 'approximate', original: value };
  return undefined;
}

const englishNumbers: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const chineseNumbers: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function numberToken(text: string): number | undefined {
  const token = text.trim().toLowerCase();
  if (/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) return Number(token);
  if (Object.hasOwn(englishNumbers, token)) return englishNumbers[token];
  if (Object.hasOwn(chineseNumbers, token)) return chineseNumbers[token];
  if (token === '半') return 0.5;
  const chinese = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(token);
  if (chinese) return (chinese[1] ? chineseNumbers[chinese[1]] : 1) * 10 + (chinese[2] ? chineseNumbers[chinese[2]] : 0);
  const decimal = /^([零〇一二两三四五六七八九十]+)点([零〇一二三四五六七八九]+)$/.exec(token);
  if (decimal) {
    const whole = numberToken(decimal[1]);
    if (whole !== undefined) return whole + Number(`0.${[...decimal[2]].map(digit => chineseNumbers[digit]).join('')}`);
  }
  return undefined;
}

/** Whole-answer grammar only. Narrative, dates, clock times and mixed units stay verbatim. */
function quantity(text: string, topic: string): { lower: number; upper?: number } | undefined {
  let body = text.trim().toLowerCase();
  let divisor = 1;
  const duration = topic === 'sleep_duration_hours';
  const unit = duration ? /\s*(?:个小时|小时|hours?|hrs?|h|分钟|minutes?|mins?)\s*$/ : /\s*(?:次|times?|awakenings?)\s*$/;
  const matchedUnit = unit.exec(body);
  if (matchedUnit) {
    if (/分钟|minutes?|mins?/.test(matchedUnit[0])) divisor = 60;
    body = body.slice(0, matchedUnit.index).trim();
  }
  body = body.replace(/^(?:大约|大概|约莫|差不多|约)\s*|^(?:about|around|approximately|roughly|approx\.?)\s+/i, '').replace(/\s*左右$/, '');
  body = body.replace(/^between\s+/i, '');
  const range = /^(.+?)\s*(?:到|至|～|~|–|—|-|\bto\b|\band\b)\s*(.+)$/.exec(body);
  if (range) {
    const lower = numberToken(range[1]), upper = numberToken(range[2]);
    if (lower !== undefined && upper !== undefined && Number.isFinite(lower) && Number.isFinite(upper) && lower <= upper) return { lower: lower / divisor, upper: upper / divisor };
    return undefined;
  }
  const exact = numberToken(body);
  return exact === undefined || !Number.isFinite(exact) ? undefined : { lower: exact / divisor };
}

/** Shared by initial answers, corrections, model tools and the desktop preview. */
export function normalizeFactInput(input: FactInput): FactInput {
  const topic = canonicalFactTopic(input.topic, input.scope);
  const normalized = { ...input, topic };
  // Explicit metadata has priority and is validated at the store boundary. Do
  // not turn a caller's invalid number+uncertainty combination into valid prose.
  if (input.uncertainty !== undefined) {
    const range = input.uncertainty;
    if (input.scope === 'sleep' && topic === 'sleep_duration_hours' && range?.kind === 'range'
      && typeof range.lower === 'number' && Number.isFinite(range.lower) && typeof range.upper === 'number' && Number.isFinite(range.upper)
      && typeof range.unit === 'string' && /^(?:minutes?|mins?|分钟)$/i.test(range.unit.trim())) {
      return { ...normalized, uncertainty: { ...range, lower: range.lower / 60, upper: range.upper / 60, unit: 'hours' } };
    }
    if (input.scope === 'sleep' && topic === 'sleep_duration_hours' && range?.kind === 'range'
      && typeof range.unit === 'string' && /^(?:hours?|hrs?|h|小时|个小时)$/i.test(range.unit.trim())) {
      return { ...normalized, uncertainty: { ...range, unit: 'hours' } };
    }
    return normalized;
  }
  if (typeof input.value !== 'string') return normalized;
  const original = input.value;
  if (input.status === 'unknown') return { ...normalized, value: null, uncertainty: original.trim() ? { kind: 'uncertain', original } : undefined };
  if (/^(?:不知道|不清楚|记不清|不确定|未知|unknown|not sure|i\s+(?:don['’]?t|do not)\s+know|i\s+(?:can['’]?t|cannot)\s+(?:remember|recall))\s*[。.!！?？]?$/i.test(original.trim())) {
    return { ...normalized, value: null, status: 'unknown', uncertainty: { kind: 'uncertain', original } };
  }
  let uncertainty = inferFactUncertainty(original);
  if (input.scope === 'sleep' && ['sleep_duration_hours', 'remembered_awakenings'].includes(topic)) {
    const parsed = quantity(original, topic);
    // Every approximation prefix accepted by the quantity grammar must retain
    // uncertainty, including spelled numbers and leading-decimal quantities.
    if (parsed && !uncertainty && /^(?:大约|大概|约莫|差不多|约)\s*|^(?:about|around|approximately|roughly|approx\.?)\s+|左右\s*$/i.test(original.trim())) uncertainty = { kind: 'approximate', original };
    if (parsed?.upper !== undefined && uncertainty?.kind !== 'uncertain') return { ...normalized,
      uncertainty: { kind: 'range', original, lower: parsed.lower, upper: parsed.upper, unit: topic === 'sleep_duration_hours' ? 'hours' : 'count' } };
    if (parsed && !uncertainty) return { ...normalized, value: parsed.lower };
  }
  return uncertainty ? { ...normalized, uncertainty } : normalized;
}

export function factTopicLabel(topic: string, language: Language): string {
  const labels: Record<string, [string, string]> = {
    age_range: ['年龄范围', 'Age range'], usual_schedule: ['平时作息', 'Usual schedule'],
    sleep_duration_hours: ['自述睡眠时长（小时）', 'Recalled sleep duration (hours)'], remembered_awakenings: ['记得的醒来次数', 'Remembered awakenings'],
    recovery: ['醒后恢复感', 'Recovery after waking'], recent_context: ['本次相关背景', 'Context for this sleep'],
    work_pattern: ['工作安排', 'Work pattern'], medications: ['药物或补充剂', 'Medicines or supplements'],
    usual_caffeine: ['日常咖啡因习惯', 'Usual caffeine'], usual_alcohol: ['日常饮酒习惯', 'Usual alcohol'],
    usual_exercise: ['运动习惯', 'Usual exercise'], sleep_environment: ['睡眠环境', 'Sleep environment'],
    daytime_energy: ['平时白天精神', 'Usual daytime energy'], sleep_goal: ['长期睡眠目标', 'Sleep goal'],
    sleep_complaint: ['自述睡眠困扰', 'Reported sleep concern'],
  };
  const canonical = canonicalFactTopic(topic, 'sleep');
  return Object.hasOwn(labels, canonical) ? labels[canonical][language === 'zh' ? 0 : 1] : topic;
}
