import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { analyzeRecords, identifyCandidates, importAppleHealth } from '../health/index.js';
import type { Analysis, DomainSnapshot, Fact, FactValue, Feedback, HealthRecord, ImportSummary, Investigation, Language, Question, Report, SleepScope } from '../shared/types.js';
import { questionDefinitions } from './questions.js';
import { buildTimeline, renderReport, reportContent } from './report.js';

type Row = Record<string, unknown>;
type FactInput = { topic: string; value: FactValue; status?: Fact['status']; scope: Fact['scope'] };
type RecordQuery = { start?: string; end?: string; source?: string; type?: HealthRecord['type'] };
const MAX_QUERY_RECORDS = 50_000;
const iso = () => new Date().toISOString();
const parse = <T>(row: Row | undefined): T | undefined => row ? JSON.parse(String(row.data)) as T : undefined;

export class SleepStore {
  readonly home: string;
  private readonly db: DatabaseSync;
  private importing = false;
  private pendingExports = new Map<string, Report>();
  private pendingDeletedReports = new Set<string>();

  constructor(home: string) {
    this.home = resolve(home);
    mkdirSync(this.home, { recursive: true });
    mkdirSync(join(this.home, 'reports'), { recursive: true });
    this.db = new DatabaseSync(join(this.home, 'sleepclaw.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS investigations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, topic TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(owner, topic));
      CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS health_records (id TEXT PRIMARY KEY, type TEXT NOT NULL, source TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS health_time_idx ON health_records(start, end);
      CREATE TABLE IF NOT EXISTS import_records (import_id TEXT NOT NULL, record_id TEXT NOT NULL, PRIMARY KEY(import_id, record_id), FOREIGN KEY(import_id) REFERENCES imports(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED, FOREIGN KEY(record_id) REFERENCES health_records(id));
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, investigation_id TEXT NOT NULL, data TEXT NOT NULL, FOREIGN KEY(investigation_id) REFERENCES investigations(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS feedback (id INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT NOT NULL, data TEXT NOT NULL, FOREIGN KEY(report_id) REFERENCES reports(id) ON DELETE CASCADE);
      PRAGMA user_version=1;`);
  }

  private writable(): void { if (this.importing) throw new Error('IMPORT_IN_PROGRESS'); }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    const previousExports = new Map(this.pendingExports);
    const previousDeleted = new Set(this.pendingDeletedReports);
    let value: T;
    try { value = operation(); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); this.pendingExports = previousExports; this.pendingDeletedReports = previousDeleted; throw error; }
    this.flushExports();
    return value;
  }
  private rows<T>(table: 'investigations' | 'imports' | 'reports' | 'feedback'): T[] {
    return this.db.prepare(`SELECT data FROM ${table}`).all().map(row => parse<T>(row) as T);
  }
  private saveInvestigation(value: Investigation): void {
    this.db.prepare('INSERT INTO investigations (id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(value.id, JSON.stringify(value));
  }
  private factsFor(id: string): Fact[] {
    return this.db.prepare("SELECT data FROM facts WHERE owner = 'profile' OR owner = ? ORDER BY rowid").all(id).map(row => parse<Fact>(row) as Fact);
  }
  getInvestigation(id: string): Investigation {
    const value = parse<Investigation>(this.db.prepare('SELECT data FROM investigations WHERE id=?').get(id));
    if (!value) throw new Error('INVESTIGATION_NOT_FOUND');
    return value;
  }
  selectInvestigation(id: string): Investigation { return this.getInvestigation(id); }

  setLanguage(id: string, language: Language): Investigation {
    this.writable();
    if (!['zh', 'en'].includes(language)) throw new Error('INVALID_LANGUAGE');
    const investigation = this.getInvestigation(id);
    investigation.language = language;
    if (investigation.pendingQuestion) {
      const translated = questionDefinitions(language).find(q => q.topic === investigation.pendingQuestion!.topic && q.scope === investigation.pendingQuestion!.scope);
      if (translated) investigation.pendingQuestion = { id: investigation.pendingQuestion.id, ...translated };
    }
    this.saveInvestigation(investigation);
    return investigation;
  }

  snapshot(activeId?: string): DomainSnapshot {
    const investigations = this.rows<Investigation>('investigations').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const active = activeId ? investigations.find(i => i.id === activeId) : investigations[0];
    const facts = active ? this.factsFor(active.id) : this.db.prepare("SELECT data FROM facts WHERE owner='profile'").all().map(row => parse<Fact>(row) as Fact);
    const reports = this.rows<Report>('reports').sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.revision - a.revision);
    // A many-year export must not make the welcome screen load every observation.
    const candidateRecords = this.db.prepare("SELECT r.data FROM health_records r WHERE r.type='sleep' AND EXISTS (SELECT 1 FROM import_records ir JOIN imports i ON i.id=ir.import_id WHERE ir.record_id=r.id) ORDER BY r.start DESC LIMIT 5000").all().map(row => parse<HealthRecord>(row) as HealthRecord);
    const candidates = identifyCandidates(candidateRecords).sort((a, b) => b.start.localeCompare(a.start)).slice(0, 100);
    return { investigations, active, facts, imports: this.rows<ImportSummary>('imports'), candidates, reports, feedback: this.rows<Feedback>('feedback'), question: active?.pendingQuestion };
  }

  createInvestigation(goal: string, language: Language, scope: SleepScope = 'main'): Investigation {
    this.writable();
    if (!goal.trim() || goal.length > 10_000) throw new Error('INVALID_GOAL');
    if (!['zh', 'en'].includes(language) || !['main', 'nap', 'segment'].includes(scope)) throw new Error('INVALID_INVESTIGATION');
    const investigation: Investigation = { id: randomUUID(), goal: goal.trim(), language, scope, createdAt: iso(), revision: 1, status: 'collecting' };
    this.saveInvestigation(investigation);
    this.nextQuestion(investigation.id);
    return this.getInvestigation(investigation.id);
  }

  private invalidate(id: string): void {
    const investigation = this.getInvestigation(id);
    investigation.revision += 1;
    investigation.status = 'collecting';
    this.saveInvestigation(investigation);
    for (const row of this.db.prepare('SELECT data FROM reports WHERE investigation_id=?').all(id)) {
      const report = parse<Report>(row)!;
      if (report.status !== 'stale') {
        report.status = 'stale';
        report.markdown = renderReport(report);
        this.db.prepare('UPDATE reports SET data=? WHERE id=?').run(JSON.stringify(report), report.id);
        this.pendingExports.set(report.id, report);
      }
    }
  }

  setTarget(id: string, target: { start: string; end: string; source: string; scope?: SleepScope }): Investigation {
    this.writable();
    if (!Number.isFinite(Date.parse(target.start)) || !Number.isFinite(Date.parse(target.end)) || Date.parse(target.end) <= Date.parse(target.start) || !target.source.trim()) throw new Error('INVALID_TARGET');
    if (target.scope && !['main', 'nap', 'segment'].includes(target.scope)) throw new Error('INVALID_SCOPE');
    this.transaction(() => {
      const investigation = this.getInvestigation(id);
      Object.assign(investigation, { start: new Date(target.start).toISOString(), end: new Date(target.end).toISOString(), source: target.source, scope: target.scope ?? investigation.scope });
      this.saveInvestigation(investigation);
      this.invalidate(id);
    });
    return this.getInvestigation(id);
  }

  getRecords(query: RecordQuery = {}): HealthRecord[] {
    if (query.start && query.end && Date.parse(query.start) >= Date.parse(query.end)) throw new Error('INVALID_TIME_RANGE');
    const conditions = ['EXISTS (SELECT 1 FROM import_records ir JOIN imports i ON i.id=ir.import_id WHERE ir.record_id=r.id)'];
    const values: string[] = [];
    if (query.start) { if (!Number.isFinite(Date.parse(query.start))) throw new Error('INVALID_DATE'); conditions.push('r.end >= ?'); values.push(new Date(query.start).toISOString()); }
    if (query.end) { if (!Number.isFinite(Date.parse(query.end))) throw new Error('INVALID_DATE'); conditions.push('r.start <= ?'); values.push(new Date(query.end).toISOString()); }
    if (query.source) { conditions.push('r.source = ?'); values.push(query.source); }
    if (query.type) { conditions.push('r.type = ?'); values.push(query.type); }
    const rows = this.db.prepare(`SELECT r.data FROM health_records r WHERE ${conditions.join(' AND ')} ORDER BY r.start,r.id LIMIT ?`).all(...values, MAX_QUERY_RECORDS + 1);
    if (rows.length > MAX_QUERY_RECORDS) throw new Error('QUERY_TOO_LARGE_NARROW_TIME_RANGE');
    return rows.map(row => parse<HealthRecord>(row) as HealthRecord);
  }

  async importFile(path: string, options: { signal?: AbortSignal; onProgress?: (count: number) => void } = {}): Promise<ImportSummary> {
    this.writable();
    if (options.signal?.aborted) throw new Error('IMPORT_CANCELLED');
    this.db.exec('BEGIN IMMEDIATE');
    this.importing = true;
    const importId = randomUUID();
    let existing = 0;
    const insert = this.db.prepare('INSERT OR IGNORE INTO health_records (id,type,source,start,end,data) VALUES (?,?,?,?,?,?)');
    const link = this.db.prepare('INSERT OR IGNORE INTO import_records (import_id,record_id) VALUES (?,?)');
    try {
      const { summary } = await importAppleHealth(path, { ...options, onRecord: record => {
        if (options.signal?.aborted) throw new Error('IMPORT_CANCELLED');
        const result = insert.run(record.id, record.type, record.source, new Date(record.start).toISOString(), new Date(record.end).toISOString(), JSON.stringify(record));
        if (Number(result.changes) === 0) existing += 1;
        link.run(importId, record.id);
      } });
      if (options.signal?.aborted) throw new Error('IMPORT_CANCELLED');
      const result: ImportSummary = { ...summary, id: importId, duplicateCount: summary.duplicateCount + existing };
      this.db.prepare('INSERT INTO imports (id,data) VALUES (?,?)').run(importId, JSON.stringify(result));
      for (const investigation of this.rows<Investigation>('investigations')) {
        if (investigation.start && investigation.end && (!result.start || Date.parse(result.start) <= Date.parse(investigation.end)) && (!result.end || Date.parse(result.end) >= Date.parse(investigation.start))) this.invalidate(investigation.id);
      }
      this.db.exec('COMMIT');
      this.flushExports();
      return result;
    } catch (error) { if (this.db.isTransaction) { this.db.exec('ROLLBACK'); this.pendingExports.clear(); } throw error; }
    finally { this.importing = false; }
  }

  setFact(id: string, input: FactInput): Fact {
    this.writable();
    this.getInvestigation(id);
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,100}$/.test(input.topic) || !['profile', 'sleep'].includes(input.scope)) throw new Error('INVALID_FACT');
    if (input.status && !['known', 'unknown'].includes(input.status)) throw new Error('INVALID_FACT_STATUS');
    if (typeof input.value === 'number' && !Number.isFinite(input.value)) throw new Error('INVALID_FACT_VALUE');
    if (!['string', 'number', 'boolean'].includes(typeof input.value) && input.value !== null) throw new Error('INVALID_FACT_VALUE');
    if (typeof input.value === 'string' && input.value.length > 20_000) throw new Error('FACT_TOO_LONG');
    const owner = input.scope === 'profile' ? 'profile' : id;
    const previous = parse<Fact>(this.db.prepare('SELECT data FROM facts WHERE owner=? AND topic=?').get(owner, input.topic));
    const status = input.status ?? (input.value === null ? 'unknown' : 'known');
    const fact: Fact = { id: previous?.id ?? randomUUID(), topic: input.topic, value: status === 'unknown' ? null : input.value, status, scope: input.scope, investigationId: input.scope === 'sleep' ? id : undefined, revision: (previous?.revision ?? 0) + 1, updatedAt: iso() };
    this.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO facts (id,owner,topic,data) VALUES (?,?,?,?)').run(fact.id, owner, input.topic, JSON.stringify(fact));
      const affected = input.scope === 'profile' ? this.rows<Investigation>('investigations') : [this.getInvestigation(id)];
      for (const investigation of affected) {
        if (investigation.pendingQuestion?.topic === fact.topic && investigation.pendingQuestion.scope === fact.scope) { delete investigation.pendingQuestion; this.saveInvestigation(investigation); }
        this.invalidate(investigation.id);
      }
    });
    return fact;
  }

  nextQuestion(id: string): Question | undefined {
    const investigation = this.getInvestigation(id);
    if (investigation.status === 'reported') return undefined;
    if (investigation.pendingQuestion) return investigation.pendingQuestion;
    this.writable();
    const facts = this.factsFor(id);
    const definition = questionDefinitions(investigation.language).find(q => !facts.some(f => f.scope === q.scope && f.topic === q.topic));
    if (!definition) { investigation.status = 'ready'; this.saveInvestigation(investigation); return undefined; }
    const question = { id: randomUUID(), ...definition };
    investigation.pendingQuestion = question;
    this.saveInvestigation(investigation);
    return question;
  }

  saveQuestion(id: string, question: Question): Question {
    this.writable();
    if (!question.text.trim() || question.text.length > 4_000 || !/^[a-zA-Z][a-zA-Z0-9_.-]{0,100}$/.test(question.topic) || !['sleep', 'profile'].includes(question.scope)) throw new Error('INVALID_QUESTION');
    const investigation = this.getInvestigation(id);
    investigation.pendingQuestion = { ...question, id: question.id || randomUUID() };
    investigation.status = 'collecting';
    this.saveInvestigation(investigation);
    return investigation.pendingQuestion;
  }

  answer(id: string, value: FactValue, skip = false): Fact {
    const question = this.getInvestigation(id).pendingQuestion ?? this.nextQuestion(id);
    if (!question) throw new Error('NO_PENDING_QUESTION');
    // Plain numeric text entered into a known numeric question is explicit user input.
    // Narrative answers and unknown values are kept verbatim, without guessing a number.
    if (!skip && typeof value === 'string' && ['sleep_duration_hours', 'remembered_awakenings'].includes(question.topic) && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) value = Number(value.trim());
    const fact = this.setFact(id, { topic: question.topic, scope: question.scope, value, status: skip || value === null ? 'unknown' : 'known' });
    this.nextQuestion(id);
    return fact;
  }

  buildReport(id: string, aiInterpretation?: string, aiAction?: string): Report {
    this.writable();
    if ((aiInterpretation?.length ?? 0) > 30_000 || (aiAction?.length ?? 0) > 2_000) throw new Error('REPORT_TEXT_TOO_LONG');
    const investigation = this.getInvestigation(id);
    const records = investigation.start && investigation.end ? this.getRecords({ start: investigation.start, end: investigation.end, source: investigation.source }) : [];
    const analysis: Analysis = analyzeRecords(records, { start: investigation.start, end: investigation.end, source: investigation.source });
    const previousReports = this.rows<Report>('reports');
    const existing = previousReports.filter(r => r.investigationId === id);
    const timeline = buildTimeline(records, investigation);
    const content = { ...reportContent(investigation, this.factsFor(id), analysis, this.rows<Feedback>('feedback'), aiInterpretation, aiAction, previousReports), timeline: timeline.timeline };
    if (timeline.truncated) content.limitations.push(investigation.language === 'zh' ? '时间线较长，仅展示前 200 段；指标仍基于全部选定记录计算。' : 'The timeline is long; only its first 200 segments are shown. Metrics still use all selected records.');
    const unchanged = existing.find(report => report.status === 'complete' && Object.entries(content).every(([key, value]) => JSON.stringify(report[key as keyof Report]) === JSON.stringify(value)));
    if (unchanged) { investigation.status = 'reported'; delete investigation.pendingQuestion; this.saveInvestigation(investigation); this.exportReport(unchanged); return unchanged; }
    const report: Report = { id: randomUUID(), revision: existing.reduce((max, r) => Math.max(max, r.revision), 0) + 1, createdAt: iso(), ...content, markdown: '' };
    report.markdown = renderReport(report);
    this.transaction(() => {
      this.db.prepare('INSERT INTO reports (id,investigation_id,data) VALUES (?,?,?)').run(report.id, id, JSON.stringify(report));
      investigation.status = 'reported';
      delete investigation.pendingQuestion;
      this.saveInvestigation(investigation);
    });
    this.exportReport(report);
    return report;
  }

  private exportReport(report: Report): void {
    for (const [extension, content] of [['json', JSON.stringify(report, null, 2)], ['md', report.markdown]]) {
      const path = join(this.home, 'reports', `${report.id}.${extension}`);
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, path);
    }
  }

  private flushExports(): void {
    for (const id of this.pendingDeletedReports) {
      for (const extension of ['json', 'md', 'json.tmp', 'md.tmp']) rmSync(join(this.home, 'reports', `${id}.${extension}`), { force: true });
      this.pendingDeletedReports.delete(id);
    }
    for (const [id, report] of this.pendingExports) { this.exportReport(report); this.pendingExports.delete(id); }
  }

  private deleteLinkedReports(investigationIds: string[]): void {
    const ids = new Set(investigationIds);
    for (const report of this.rows<Report>('reports')) if (ids.has(report.investigationId)) {
      this.db.prepare('DELETE FROM reports WHERE id=?').run(report.id);
      this.pendingExports.delete(report.id);
      this.pendingDeletedReports.add(report.id);
    }
  }

  deleteFact(factId: string): void {
    this.writable();
    const fact = parse<Fact>(this.db.prepare('SELECT data FROM facts WHERE id=?').get(factId));
    if (!fact) throw new Error('FACT_NOT_FOUND');
    this.transaction(() => {
      this.db.prepare('DELETE FROM facts WHERE id=?').run(factId);
      const affected = fact.scope === 'profile' ? this.rows<Investigation>('investigations') : [this.getInvestigation(fact.investigationId!)];
      this.deleteLinkedReports(affected.map(item => item.id));
      for (const investigation of affected) {
        delete investigation.pendingQuestion;
        this.saveInvestigation(investigation);
        this.invalidate(investigation.id);
      }
    });
  }

  clearProfile(): void {
    this.writable();
    this.transaction(() => {
      this.db.prepare("DELETE FROM facts WHERE owner='profile'").run();
      const investigations = this.rows<Investigation>('investigations');
      this.deleteLinkedReports(investigations.map(item => item.id));
      for (const investigation of investigations) {
        delete investigation.pendingQuestion;
        this.saveInvestigation(investigation);
        this.invalidate(investigation.id);
      }
    });
  }

  recordFeedback(reportId: string, choice: Feedback['choice'], note?: string): Feedback {
    this.writable();
    if (!this.db.prepare('SELECT id FROM reports WHERE id=?').get(reportId)) throw new Error('REPORT_NOT_FOUND');
    if (!['accepted', 'cannot', 'unhelpful', 'later'].includes(choice) || (note?.length ?? 0) > 4_000) throw new Error('INVALID_FEEDBACK');
    const feedback: Feedback = { reportId, choice, note: note?.trim() || undefined, createdAt: iso() };
    this.db.prepare('INSERT INTO feedback (report_id,data) VALUES (?,?)').run(reportId, JSON.stringify(feedback));
    return feedback;
  }

  deleteInvestigation(id: string): void {
    this.writable();
    this.getInvestigation(id);
    this.transaction(() => {
      this.deleteLinkedReports([id]);
      this.db.prepare('DELETE FROM facts WHERE owner=?').run(id);
      this.db.prepare('DELETE FROM investigations WHERE id=?').run(id);
    });
  }

  deleteImport(id: string): void {
    this.writable();
    const summary = parse<ImportSummary>(this.db.prepare('SELECT data FROM imports WHERE id=?').get(id));
    if (!summary) throw new Error('IMPORT_NOT_FOUND');
    this.transaction(() => {
      this.db.prepare('DELETE FROM imports WHERE id=?').run(id);
      this.db.exec('DELETE FROM health_records WHERE NOT EXISTS (SELECT 1 FROM import_records WHERE import_records.record_id=health_records.id)');
      const investigations = this.rows<Investigation>('investigations');
      const affected = investigations.filter(investigation => investigation.start && investigation.end && (!investigation.source || summary.sources.includes(investigation.source)) && (!summary.start || Date.parse(summary.start) <= Date.parse(investigation.end)) && (!summary.end || Date.parse(summary.end) >= Date.parse(investigation.start)));
      this.deleteLinkedReports(affected.map(item => item.id));
      // Candidate summaries are visible before a target is selected, so even an
      // unselected investigation can have a follow-up quoting the removed import.
      for (const investigation of investigations) {
        delete investigation.pendingQuestion;
        this.saveInvestigation(investigation);
      }
      for (const investigation of affected) this.invalidate(investigation.id);
    });
  }

  close(): void { this.writable(); this.db.close(); }
}
