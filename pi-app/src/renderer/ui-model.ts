import type { AppEvent, AppSnapshot, ChatMessage, Fact, Language, Report } from '../shared/types';

export function isSnapshot(value: unknown): value is AppSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AppSnapshot>;
  return typeof candidate.configured === 'boolean' && Array.isArray(candidate.messages) && Array.isArray(candidate.investigations);
}

export function visibleMessages(messages: ChatMessage[], delta: string, investigationId?: string): ChatMessage[] {
  if (!delta) return messages;
  return [...messages, { id: `stream-${investigationId ?? 'new'}`, role: 'assistant', text: delta }];
}

export function applyStreamEvent(delta: string, event: AppEvent): string {
  if (event.type === 'state') return '';
  return event.type === 'delta' ? delta + event.text : delta;
}

export function conversationFacts(facts: Fact[], investigationId?: string): Fact[] {
  return facts.filter((fact) => fact.scope === 'profile' || fact.investigationId === investigationId);
}

export function orderedReports(reports: Report[], investigationId?: string): Report[] {
  return [...reports].sort((a, b) => Number(b.investigationId === investigationId) - Number(a.investigationId === investigationId)
    || b.createdAt.localeCompare(a.createdAt));
}

export function formatDate(value: string | undefined, language: Language): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-GB', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

export function displayNumber(value: number | null): string {
  return value === null || !Number.isFinite(value) ? '—' : new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
}

const publicErrors = ['AUTH_FAILED', 'QUOTA', 'MODEL_NOT_FOUND', 'CANCELLED', 'TIMEOUT', 'CONFIG_REQUIRED', 'CONFIG_INVALID', 'BASE_URL_INVALID', 'TOOL_TEST_FAILED', 'MODEL_REQUIRED', 'BUSY', 'TARGET_REQUIRED', 'SOURCE_REQUIRED', 'CREDENTIAL_STORAGE_UNAVAILABLE', 'WORKER_EXITED', 'NOT_READY'] as const;
export function errorKey(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return `error_${publicErrors.find((code) => new RegExp(`\\b${code}\\b`).test(text)) || 'REQUEST_FAILED'}`;
}

export function localizedRecordText(text: string, language: Language): string {
  if (language === 'zh') return text;
  const labels: Record<string, string> = {
    '部分记录缺少设备来源，分析时需要确认来源。': 'Some records have no device source. Confirm their source before interpreting them.',
    '文件中没有找到可用的睡眠或相关生理记录。': 'No usable sleep or related measurements were found in this file.',
    '设备标记为睡眠的区间并集；卧床和重复阶段不会重复相加。': 'Unique intervals marked as sleep; in-bed and overlapping stage records are not added twice.',
    '仅统计设备记录到的清醒，缺少记录不等于零清醒。': 'Only recorded awake intervals are counted. Missing records do not mean no awakenings.',
    '需要可靠卧床范围和完整睡眠／清醒覆盖；资料不足时不计算。': 'Requires reliable in-bed boundaries and complete sleep/awake coverage; unavailable when records are incomplete.',
    '已记录样本的算术平均；无法代表缺失时段，不用于诊断。': 'Arithmetic mean of recorded samples; it does not describe missing periods or establish a diagnosis.',
  };
  return labels[text] ?? (/[\u3400-\u9fff]/.test(text) ? 'A data-quality limitation affects this result. Review the imported records before drawing conclusions.' : text);
}

export function toDatetimeLocal(value: string | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function manualTargetPayload(start: string, end: string, source: string): { start: string; end: string; source: string } | null {
  const localPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
  if (!localPattern.test(start) || !localPattern.test(end) || !source.trim()) return null;
  const startDate = new Date(start);
  const endDate = new Date(end);
  const normalizedStart = start.length === 16 ? `${start}:00` : start;
  const normalizedEnd = end.length === 16 ? `${end}:00` : end;
  // Reject invalid calendar dates and local times skipped during a daylight-saving transition.
  if (toDatetimeLocal(start) !== normalizedStart || toDatetimeLocal(end) !== normalizedEnd || endDate.getTime() <= startDate.getTime()) return null;
  return { start: startDate.toISOString(), end: endDate.toISOString(), source };
}
