# First-stage product contract

Approved 2026-09-21. Implementation: `pi-app/`. Status and reproducible commands live in its README. Nothing in this specification is evidence of a passing test or released capability.

## Journey

1. Open SleepClaw, choose Chinese or English, describe a goal or import Apple Health. Local history/import remain usable without a model.
2. Configure provider/model/key/base URL before AI interpretation. User-initiated connection test must exercise text and a harmless tool, with no health information. Failed setup preserves previous configuration.
3. Preview dates/sources/coverage. If the intended sleep is ambiguous, ask the user to select one. No silent latest-night selection.
4. Ask one necessary background question at a time. Save progress, avoid repeating known facts, permit skip/direct report. Keep profile facts separate from one sleep's circumstances.
5. Agent can ask a targeted question, query an imported time window and adjust its interpretation. Domain code owns facts, numeric computation, invalidation and persistence.
6. Show summary, five dimensions, appropriate preliminary score or unavailable status, limitations and one actionable suggestion. Expanded detail shows metrics and sources.
7. Record accepted/cannot/unhelpful/later feedback. Resume precisely; corrections create report revisions and mark earlier reports stale.

## Import and calculation

- Native Apple Health XML or ZIP containing export.xml; no third-party export app required.
- Stream relevant records into a staging transaction; cancel/error rolls back. No arbitrary ZIP extraction, external entity resolution or full-archive model upload.
- Preserve record source, offset and canonical time. Stable record identity provides repeated-import idempotence.
- inBed and sleep stages have distinct meanings. Union overlapping sleep intervals; do not sum duplicated sources. Select source when ambiguity changes the result.
- Missing stages, awake, HRV and other fields stay unknown. Efficiency/latency require suitable bounds; device sampling is not continuous waveform evidence.
- Score and five-dimensional interpretation are separate. Only complete, explicitly versioned scoring rules may produce numbers. Current unvalidated/incomplete composite mapping yields null, displayed as unavailable. No improvised medical thresholds.

## Reports and privacy

- Structured report is canonical, fixed UI and Markdown are projections. AI text does not overwrite tool-computed metric values.
- Each report records language, data/fact revision, limitations, source and action. Partial AI output is never presented as a completed report.
- API keys never enter prompts, transcripts, errors or reports. Connection testing uses synthetic content.
- Local health records are unencrypted by product choice. Pi sessions can contain health statements; explain this and delete linked sessions when deleting investigations/data.
- Model analysis sends relevant facts and bounded computed results to the configured provider. Show this before first use. No telemetry.
- Deleting an investigation removes its answers/reports/chat; shared imports and profile remain unless explicitly deleted. Import deletion invalidates dependent analysis and clears related model sessions.

## Acceptance

Synthetic tests cover no-device flow, original ZIP/XML, duplicates, overlapping sources, midnight/time offsets, naps, missing values, unknown/skip/correction, re-read after answers, cancellation/rollback, resume, stale revisions and deletion. Both languages complete the same journey. Skills-disabled core must work. Packaging is Windows x64 only, tested separately from development startup; signing status and untested real providers are disclosed.

## Delivery sequence

Thin desktop/Pi/package smoke → self-report closure → Apple Health → adaptive query/correction → bilingual/reliability/package gates. No prerequisite to finish the old Grok Foundation plan.
