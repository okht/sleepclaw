export type Language = 'zh' | 'en';
export type SleepScope = 'main' | 'nap' | 'segment';
export type FactValue = string | number | boolean | null;
export interface Fact { id: string; topic: string; value: FactValue; status: 'known' | 'unknown'; scope: 'profile' | 'sleep'; investigationId?: string; revision: number; updatedAt: string }
export interface Question { id: string; topic: string; text: string; reason?: string; scope: 'profile' | 'sleep' }
export interface Investigation { id: string; goal: string; language: Language; scope: SleepScope; createdAt: string; revision: number; start?: string; end?: string; source?: string; pendingQuestion?: Question; status: 'collecting' | 'ready' | 'reported' }
export interface HealthRecord { id: string; type: 'sleep' | 'heartRate' | 'hrv' | 'respiratoryRate' | 'oxygenSaturation'; value: string | number; unit?: string; source: string; start: string; end: string; startOffset: string; endOffset: string }
export interface ImportSummary { id: string; name: string; importedAt: string; recordCount: number; duplicateCount: number; sources: string[]; start?: string; end?: string; warnings: string[] }
export interface SleepCandidate { id: string; start: string; end: string; source: string; asleepMinutes: number }
export interface Metric { key: string; value: number | null; unit: string; source: 'device' | 'self-report' | 'derived'; note?: string }
export interface Analysis { start?: string; end?: string; source?: string; metrics: Metric[]; stages: Record<string, number>; warnings: string[]; recordCount: number }
export interface Report { id: string; investigationId: string; revision: number; factRevision: number; language: Language; createdAt: string; title: string; summary: string; metrics: Metric[]; dimensions: Array<{ key: string; text: string; score: number | null }>; score: number | null; scoreVersion: string; limitations: string[]; action: string; aiInterpretation?: string; status: 'complete' | 'stale'; markdown: string; basis?: { start?: string; end?: string; source?: string; scope: SleepScope }; timeline?: Array<{ start: string; end: string; stage: string }> }
export interface Feedback { reportId: string; choice: 'accepted' | 'cannot' | 'unhelpful' | 'later'; note?: string; createdAt: string }
export interface DomainSnapshot { investigations: Investigation[]; active?: Investigation; facts: Fact[]; imports: ImportSummary[]; candidates: SleepCandidate[]; reports: Report[]; feedback: Feedback[]; question?: Question }
export interface ModelConfig { provider: string; model: string; baseUrl?: string; apiKey?: string; protocol?: 'openai-completions' | 'anthropic-messages' }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string }
export interface AppSnapshot extends DomainSnapshot { language: Language; model?: Omit<ModelConfig, 'apiKey'>; configured: boolean; messages: ChatMessage[]; busy: boolean }
export type AppEvent = { type: 'state'; state: AppSnapshot } | { type: 'delta'; text: string } | { type: 'progress'; message: string } | { type: 'error'; code: string; message: string };
export interface DesktopBridge { request(method: string, params?: Record<string, unknown>): Promise<unknown>; onEvent(callback: (event: AppEvent) => void): () => void; chooseFile(): Promise<string | null> }
declare global { interface Window { sleepclaw: DesktopBridge } }
