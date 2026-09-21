import { randomUUID } from 'node:crypto';
import { Type, type Static, type TObject, type TProperties } from 'typebox';
import { Value } from 'typebox/value';
import { SleepStore } from './domain/index.js';
import { buildInvestigationGuidance } from './domain/investigation.js';
import { analyzeRecords } from './health/index.js';
import { analyzeHealthEvidence, parseZonedTimestamp } from './health/evidence.js';

const text = (maxLength = 4000) => Type.String({ minLength: 1, maxLength });
const scope = Type.Union([Type.Literal('profile'), Type.Literal('sleep')]);
const sleepScope = Type.Union([Type.Literal('main'), Type.Literal('nap'), Type.Literal('segment')]);
const measurement = Type.Union(['sleep', 'heartRate', 'hrv', 'respiratoryRate', 'oxygenSaturation'].map(value => Type.Literal(value)));
const windowFields = { start: Type.Optional(text(80)), end: Type.Optional(text(80)) };

export interface SleepTool {
  name: string;
  label: string;
  description: string;
  parameters: TObject;
  readOnly: boolean;
  execute(params: unknown, signal?: AbortSignal): Promise<unknown>;
}

/** One deterministic interface, used by Pi, CLI and MCP. No model or credentials. */
export function createSleepTools(store: SleepStore, options: { investigationId?: () => string; onChange?: () => void } = {}): SleepTool[] {
  function tool<P extends TProperties>(name: string, label: string, description: string, fields: P, readOnly: boolean,
    execute: (params: Static<TObject<P>>, id: string, signal?: AbortSignal) => unknown | Promise<unknown>, scoped = true): SleepTool {
    const parameters = Type.Object({ ...fields, ...(scoped && !options.investigationId ? { investigationId: text(100) } : {}) }, { additionalProperties: false });
    return { name, label, description, parameters, readOnly, execute: async (raw, signal) => {
      if (!Value.Check(parameters, raw)) throw new Error('INVALID_TOOL_ARGUMENTS');
      if (signal?.aborted) throw new Error('CANCELLED');
      const params = raw as Static<TObject<P>> & { investigationId?: string };
      const id = scoped ? options.investigationId?.() ?? params.investigationId! : '';
      if (scoped) store.getInvestigation(id);
      const result = await execute(params, id, signal);
      if (!readOnly) options.onChange?.();
      return result;
    } };
  }
  function window(id: string, params: { start?: string; end?: string }) {
    const active = store.getInvestigation(id);
    if (!active.start || !active.end || !active.source) throw new Error('TARGET_REQUIRED');
    const start = params.start ?? active.start, end = params.end ?? active.end;
    if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) < Date.parse(active.start) || Date.parse(end) > Date.parse(active.end) || Date.parse(end) <= Date.parse(start)) throw new Error('INVALID_QUERY_RANGE');
    return { start, end, source: active.source };
  }
  const tools = [
    tool('sleep_context', 'Sleep context', 'Read current facts, pending question, uncertainty and plan status. Corrected facts supersede chat history. Without investigationId, list investigations for explicit selection.',
      options.investigationId ? {} : { investigationId: Type.Optional(text(100)) }, true, params => sleepContext(store, options.investigationId?.() ?? (params as { investigationId?: string }).investigationId), false),
    tool('sleep_fact', 'Save a fact', 'Save only user-supplied facts. Preserve approximate/range/uncertain wording with uncertainty metadata; never convert a range to its midpoint. A correction replaces the previous fact. Separate profile habits from this sleep.', {
      topic: text(101), value: Type.Union([Type.String({ maxLength: 20000 }), Type.Number(), Type.Boolean(), Type.Null()]), scope,
      status: Type.Optional(Type.Union([Type.Literal('known'), Type.Literal('unknown')])),
      uncertainty: Type.Optional(Type.Object({ kind: Type.Union([Type.Literal('approximate'), Type.Literal('range'), Type.Literal('uncertain')]), original: text(), lower: Type.Optional(Type.Number()), upper: Type.Optional(Type.Number()), unit: Type.Optional(text(40)) }, { additionalProperties: false })),
    }, false, (params, id) => store.setFact(id, params)),
    tool('sleep_question', 'One follow-up', 'Persist one useful next question before asking it, with a short reason. Do not ask for already known information or block a direct report.', {
      topic: text(101), text: text(), reason: Type.Optional(text()), scope,
    }, false, (params, id) => store.saveQuestion(id, { id: randomUUID(), ...params })),
    tool('sleep_target', 'Select sleep', 'Set episode and source only after the user explicitly selects or unambiguously identifies them. Time strings must include a timezone. Never silently select the newest episode.', {
      start: text(80), end: text(80), source: text(500), scope: Type.Optional(sleepScope),
    }, false, (params, id) => {
      requireZonedTimes(params.start, params.end);
      return store.setTarget(id, params);
    }),
    tool('sleep_data_query', 'Look closer at data', 'Query a bounded window inside the selected sleep, optionally by type. Returns deterministic metrics and up to 200 observations. Missing records are unknown. Do not repeat the same query without new evidence.', {
      ...windowFields, type: Type.Optional(measurement),
    }, true, (params, id) => {
      if (params.start || params.end) requireZonedTimes(params.start, params.end);
      const selected = window(id, params);
      const from = Date.parse(selected.start), to = Date.parse(selected.end);
      const records = store.getRecords({ ...selected, type: params.type }).filter(record => {
        const start = Date.parse(record.start), end = Date.parse(record.end);
        return start === end ? start >= from && start < to : end > from && start < to;
      });
      return { revision: store.getInvestigation(id).revision, window: selected, analysis: analyzeRecords(records, selected), observations: records.slice(0, 200), truncated: records.length > 200 };
    }),
    tool('sleep_report', 'Create report', 'Generate a versioned report now; incomplete facts are allowed. Computed metrics are authoritative. Separate observations, user statements and tentative explanations, state uncertainty and provide one feasible action. Leave interpretation/action empty for a local facts-only report.', {
      interpretation: Type.String({ maxLength: 16000 }), action: Type.String({ maxLength: 2000 }),
    }, false, (params, id) => store.buildReport(id, params.interpretation || undefined, params.action || undefined)),
    tool('sleep_feedback', 'Remember action feedback', 'Save the user expressed response to an action in this investigation.', {
      reportId: text(100), choice: Type.Union(['accepted', 'cannot', 'unhelpful', 'later'].map(value => Type.Literal(value))), note: Type.Optional(text()),
    }, false, (params, id) => {
      if (!store.snapshot(id).reports.some(report => report.id === params.reportId && report.investigationId === id)) throw new Error('REPORT_NOT_FOUND');
      return store.recordFeedback(params.reportId, params.choice, params.note);
    }),
    tool('sleep_plan', 'Plan the investigation', 'Persist a short user-visible investigation plan (maximum six steps), with the current context revision. Describe checks and questions, not hidden reasoning. Refresh after facts or target change; PLAN_STALE means read context first. A report request may end investigation immediately.', {
      objective: text(), revision: Type.Integer({ minimum: 1 }), steps: Type.Array(Type.Object({
        id: text(100), kind: Type.Union(['clarify', 'query', 'report'].map(value => Type.Literal(value))), description: text(2000),
        status: Type.Union(['pending', 'done', 'blocked'].map(value => Type.Literal(value))), reason: Type.Optional(text(2000)),
      }, { additionalProperties: false }), { minItems: 1, maxItems: 6 }),
    }, false, (params, id) => store.savePlan(id, params)),
    tool('sleep_health_analysis', 'Analyze health evidence', 'Analyze selected Apple Health sleep/physiology records: coverage, unknown gaps, conflicts, stage transitions and sample median/quartiles. Uses simple-statistics. Same-source only; discrete samples cannot establish continuous physiology, calculate beat-to-beat HRV or diagnose a condition.', windowFields, true, (params, id) => {
      if (params.start || params.end) requireZonedTimes(params.start, params.end);
      const selected = window(id, params);
      return { revision: store.getInvestigation(id).revision, ...analyzeHealthEvidence(store.getRecords(selected), { ...selected, language: store.getInvestigation(id).language }) };
    }),
  ];
  if (!options.investigationId) tools.push(
    tool('sleep_create', 'Start sleep investigation', 'Start a new investigation only when requested. Save its ID and use it explicitly on subsequent calls. Resume an existing investigation with sleep_context.', {
      goal: text(10000), language: Type.Union([Type.Literal('zh'), Type.Literal('en')]), scope: Type.Optional(sleepScope),
    }, false, params => store.createInvestigation(params.goal, params.language, params.scope), false),
    tool('sleep_import', 'Import Apple Health', 'Import a user-selected local Apple Health ZIP/XML file. Never discover health files automatically. Local parsing, atomic/cancellable; existing records are deduplicated. Raw archives are not returned. Tool results entering the host chat may be sent to its model provider.', {
      path: text(4000),
    }, false, async (params, _id, signal) => {
      const imported = await store.importFile(params.path, { signal });
      const { name: _name, ...summary } = imported;
      return summary;
    }, false),
  );
  return tools;
}

function requireZonedTimes(...values: Array<string | undefined>): void {
  if (values.some(value => value !== undefined && !Number.isFinite(parseZonedTimestamp(value)))) throw new Error('TIMEZONE_REQUIRED');
}

export function sleepContext(store: SleepStore, investigationId?: string): unknown {
  if (investigationId) store.getInvestigation(investigationId);
  const snapshot = store.snapshot(investigationId);
  const imports = snapshot.imports.slice(-25).map(({ id, recordCount, sources, start, end, warnings }) => ({ id, recordCount, sources, start, end, warnings }));
  const base = { investigations: snapshot.investigations.slice(0, 25).map(({ id, goal, language, scope, revision, status }) => ({ id, goal, language, scope, revision, status })), candidates: snapshot.candidates.slice(0, 25), imports };
  if (!investigationId) return { ...base, nextAction: 'Choose an investigation explicitly or use sleep_create. No latest investigation is selected implicitly.' };
  const active = snapshot.active!;
  const reports = snapshot.reports.filter(report => report.investigationId === investigationId);
  const ids = new Set(reports.map(report => report.id));
  return { ...base, language: active.language, investigation: active, facts: snapshot.facts, pendingQuestion: snapshot.question,
    guidance: buildInvestigationGuidance(active, snapshot.facts),
    feedback: snapshot.feedback.filter(item => ids.has(item.reportId)).slice(-15),
    reports: reports.slice(0, 1).map(report => report.status === 'stale' ? { id: report.id, status: report.status } : { id: report.id, status: report.status, metrics: report.metrics, action: report.action }),
  };
}

const SAFE_CODES = new Set(['INVALID_TOOL_ARGUMENTS', 'UNKNOWN_TOOL', 'CANCELLED', 'BUSY', 'TARGET_REQUIRED', 'TIMEZONE_REQUIRED', 'INVALID_QUERY_RANGE', 'PLAN_STALE', 'INVALID_PLAN', 'INVALID_FACT_UNCERTAINTY', 'INVALID_FACT', 'INVALID_FACT_STATUS', 'INVALID_FACT_VALUE', 'FACT_TOO_LONG', 'INVESTIGATION_NOT_FOUND', 'INVALID_GOAL', 'INVALID_INVESTIGATION', 'INVALID_QUESTION', 'INVALID_TARGET', 'INVALID_SCOPE', 'INVALID_TIME_RANGE', 'INVALID_DATE', 'QUERY_TOO_LARGE_NARROW_TIME_RANGE', 'REPORT_NOT_FOUND', 'INVALID_FEEDBACK', 'REPORT_TEXT_TOO_LONG', 'IMPORT_CANCELLED', 'IMPORT_IN_PROGRESS']);
export function safeToolError(error: unknown) {
  const message = error instanceof Error && error.name === 'AbortError' ? 'CANCELLED' : error instanceof Error ? error.message : '';
  const code = SAFE_CODES.has(message) ? message : 'TOOL_FAILED';
  const hints: Record<string, string> = {
    PLAN_STALE: 'Read sleep_context and refresh the plan using its current revision.',
    TARGET_REQUIRED: 'Ask one question to select the episode and source; a self-report report is still available.',
    TIMEZONE_REQUIRED: 'Confirm the calendar date and timezone; do not guess from a vague local time.',
    INVALID_FACT_UNCERTAINTY: 'Keep the original wording as a string or unknown null; do not store an approximate/range answer as an exact number.',
    QUERY_TOO_LARGE_NARROW_TIME_RANGE: 'Narrow the time window. Do not retry the same unbounded query.',
    TOOL_FAILED: 'Check the selected file and inputs locally. Raw error details are withheld to avoid exposing private paths or health data.',
  };
  return { code, message: hints[code] ?? 'Check tool arguments and current investigation context before retrying.' };
}
