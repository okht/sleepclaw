# Shared sleep tools and host plugins

## Scope — 2026-09-21

The desktop keeps Pi as its sole conversation runtime. Codex and Claude Code use their own conversation runtime and call the same deterministic SleepClaw tool module over local stdio MCP. They do not launch a nested Pi agent. The existing interactive Pi CLI remains; a JSON tools CLI is added for host integrations and testing.

`SleepStore` owns facts, questions, plans, reports and imported records. `createSleepTools` owns schemas, scoped IDs, bounded queries and tool responses. The Pi adapter, CLI and MCP adapter call this same interface. MCP uses the official TypeScript SDK's low-level `Server` because the JSON/TypeBox schemas also serve Pi; protocol framing, cancellation and lifecycle use the SDK, with no hand-written JSON-RPC transport.

### New capabilities

- Optional fact uncertainty retains original wording and explicit numeric bounds/unit. Approximate/ranged facts cannot carry a numeric or boolean exact value. Unknown stays null. Correcting a fact replaces old uncertainty.
- Saved plans contain an objective and at most six checks/questions/report steps. They bind to the investigation revision. Corrections and target changes stale the plan; explicit deletion clears affected plans that may retain deleted information.
- Context includes uncertainty and next-step guidance, scoped action feedback, and a direct-report option. This guidance is advisory; the model selects the meaningful next check.
- `sleep_health_analysis` reuses interval-union sleep calculations and adds source-specific coverage, unobserved intervals, overlap conflicts, observed stage-label transitions and descriptive physiology sample statistics. Input IDs and gap lists are capped at 200; calculations use the full bounded input.
- All host mutation calls specify the investigation. Errors suppress private paths/upstream payloads. Data queries cannot leave the selected episode or execute arbitrary SQL.

## Open-source selection and actual trials

| Project | Decision and input fit |
|---|---|
| [simple-statistics](https://github.com/simple-statistics/simple-statistics), **7.12.0**, ISC | Direct dependency. Pure JS, no runtime dependencies. Median and quartiles for existing numeric observations; SleepClaw handles source/unit/window/quality semantics. Independent Node trial: 15 assertions, including missing values, duplicate IDs, one sample and extremes. |
| [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), **1.30.0**, MIT | Direct dependency for a local server and real SDK-client tests. Shared domain functions remain independent of transport. |
| [YASA](https://github.com/raphaelvallat/yasa), BSD-3-Clause | Reviewed official inputs/statistics; not installed or executed. EEG prediction needs raw signals; Apple Core cannot be invented as N1/N2. Hypnogram statistics require explicit assumptions about recording and in-bed bounds. Defer the Python scientific stack to the EEG phase. |
| [NeuroKit2](https://github.com/neuropsychology/NeuroKit), MIT | Reviewed official HRV API; not installed or executed. Requires true ECG/PPG peaks or RR intervals. The current discrete heart-rate/SDNN records cannot feed those computations. |
| [pyActigraphy](https://github.com/ghammad/pyActigraphy), GPL-3.0 | Reviewed formats and dependencies; not installed or executed. Primarily uses activity counts/accelerometry, absent from current imports. Distribution licensing also requires a separate review. |
| [Momentum Apple Health MCP](https://github.com/the-momentum/apple-health-mcp-server), MIT | Reviewed import/query approach; not copied or run. Its Python/multiple-database stack duplicates existing streaming XML/ZIP and SQLite work. Its README points toward Open Wearables. |

The selection distinguishes source inspection from execution. No claim is made that every candidate was runtime-tested. `simple-statistics` is a general statistical library; SleepClaw's sleep-record interpretation remains project code. Existing sax 1.6.1 (BlueOak-1.0.0) and yauzl 3.4.0 (MIT) remain the import implementation. The generated bundle contains license files for every included package, plus `runtime/dependencies.json`.

Trial observations: the simple-statistics npm archive was 338,634 bytes, unpacked 1,345,701 bytes; one Node 24.13 run calculated median/p10/p90/MAD over 100,000 values in 6.485 ms, with whole-process RSS 66,469,888 bytes. These are a single local trial, not a product-wide performance promise. The integration tests check numerical results separately.

**Version-specific numeric rule:** 7.12.0 uses linear R type-7 quantiles. The currently published website documentation also contains older 7.8.7 behavior. Results declare `quantileMethod: linear-r7`; lockfile and two-sample regression cases prevent silent semantic drift. [Versioned source](https://github.com/simple-statistics/simple-statistics/blob/v7.12.0/src/quantile_sorted.js).

## Health interpretation limits

Outputs describe recorded samples, unweighted by duration. Unobserved intervals remain unknown; null is not zero. Conflicts are counted and suppress incompatible totals. Sources stay separate. Stage transitions are device-label changes, not clinical arousals. Discrete HR is not a beat-to-beat series, and imported HRV is SDNN. There are no clinical thresholds, EEG inference, baseline/trend calculations or causal conclusions in this change.

Input references: [Apple sleep analysis](https://developer.apple.com/documentation/healthkit/hkcategoryvaluesleepanalysis), [Apple SDNN](https://developer.apple.com/documentation/healthkit/hkquantitytypeidentifier/heartratevariabilitysdnn), [YASA statistics](https://yasa-sleep.org/generated/yasa.Hypnogram.sleep_statistics.html), [NeuroKit HRV](https://neuropsychology.github.io/NeuroKit/functions/hrv.html), [pyActigraphy inputs](https://ghammad.github.io/pyActigraphy/api.html).

## What remains model-dependent

The tool contract enforces value precision, source/window selection, schemas and plan revision. It cannot prove that a submitted user quote is genuine, that a clarification is useful, or that a prose explanation is supported. The shared prompt and sleep-investigation Skill give the model these policies. Existing localhost response fixtures test protocol plumbing, not autonomous judgment.

Use behavior cases to evaluate models: an uncertain time with two devices; skipped answers; a correction that invalidates an explanation; sparse physiology; a direct-report request; rejected action feedback; hostile instructions in source names. Grade final facts, selected windows, unsupported claims, unnecessary questions and successful completion. Do not require one exact tool-call order. Broader real-provider evaluation and per-claim machine-validated evidence links remain follow-up work.

## Packaging and retention

Node >=24.13 and the whole built plugin folder are required. Codex uses plugin-root-relative cwd; Claude uses its documented plugin-root variable. No global installation or marketplace registration is performed by the build. Defaults use a separate `.sleepclaw-tools` home, outside plugin caches. Generated runtime is ignored by Git and rebuilt from the lockfile.

Tool summaries may be sent to the host model provider; raw archives stay local. Host chat retention is independent of local SleepClaw deletion. The plugin currently exposes no delete operation. This change does not install/update the desktop binary, register a marketplace, or claim public-directory publication.

Setup and commands: [plugin README](../../plugins/sleepclaw/README.md). Packaging references: [OpenAI plugins](https://developers.openai.com/plugins/build/plugins), [Codex relative cwd implementation](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/plugin_config.rs), [Claude reference](https://code.claude.com/docs/en/plugins-reference).

## Verification recorded on 2026-09-21

- `npm run typecheck`: passed. `npm test`: **175/175 passed**, including all existing desktop/controller/health tests.
- New direct tool tests cover uncertainty, explicit IDs, feedback isolation, timezone/calendar validation, half-open query endpoints and safe errors. No Skills or model connection are required for these tests.
- Real MCP SDK-client/stdio tests cover create, import, deduplication, target, health analysis, plan, question, facts, report, feedback and CLI JSON output. Closing during an in-progress import aborts it, waits for rollback and preserves existing facts; retry imports without partial duplicates.
- Plugin build and Codex plugin/Skill validators passed. The installed Claude CLI's manifest validator passed; its local configuration was absent, so a signed-in interactive Claude session was not launched and no configuration was restored.
- A built plugin copied to a temporary path containing spaces completed MCP startup, discovery and a tool call under both Codex-style relative cwd and Claude-style root substitution. This verifies the launch contracts; it does not claim an interactive install in either host's UI.
- An independent Skill forward-test used a new local store and an uncertain self-report with an immediate-report request. Eight actual CLI calls saved ranges/uncertainty and an English report; no follow-up question, target or device measurements were fabricated. It exposed missing setup documentation and untranslated English JSON notes; both were corrected, and range display received regression tests.
- Built server: **1,202,443 bytes**. Whole built plugin including Skill, manifests, licenses and docs at measurement: **1,235,765 bytes**. Node runtime is not included. Rebuilding or changing docs can change these values.
- Desktop runtime dependency list and runtime lock include simple-statistics and are regression-tested against the application manifest. This turn did not rebuild/reinstall the Electron installer or restart the user's application.

No global plugin install, marketplace publication, Git commit/push or private-health-data run was performed. Broader real-provider behavioral evaluation remains outstanding.
