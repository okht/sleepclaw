# Pi desktop architecture

## Modules

- Electron main: native file selection, sandboxed window, credential encryption, narrow IPC and worker lifecycle.
- React + assistant-ui: view projection, composition, question cards, data/report panes. ExternalStoreRuntime displays Pi events; it does not run a second agent.
- Independent Node worker: Pi SDK session execution and SleepClaw tool registration. No default shell/code-editing tools. Optional Skills use Pi conventions; core works without them.
- SleepStore: SQLite facts, imports, investigations, pending questions, reports and feedback; transactions and revisions behind one interface.
- Health module: streaming XML/ZIP parsing, source-aware candidates and deterministic interval/metric calculations.
- CLI: same application controller and store. No separate provider loop or question engine.

## Persistence

New home defaults to the OS user's `.sleepclaw-pi` directory, overridable by SLEEPCLAW_HOME. Never migrate or rename old Home automatically. SQLite owns domain truth, Pi JSONL owns model conversation. Current facts are supplied on each run; old facts are explicitly superseded. Investigation IDs link domain state and session directories.

Health records are persisted locally without mandatory encryption; original Apple Health archives are not uploaded. When AI analysis is used, conversation text, selected facts and bounded tool results are sent to the user's configured model provider. Electron safeStorage protects saved keys; the worker receives keys in memory. CLI supports environment credentials without writing plaintext keys. Settings contain no key. Reports export structured JSON and Markdown. Original imported source files are never modified.

## Reuse and exact versions

The lockfile is authoritative. Initial reviewed versions: Pi 0.86.1; Electron 44.4.3; Forge 7.11.2; assistant-ui 0.15.21; sax 1.6.1; yauzl 3.4.0. React/i18next provide UI/localization. Node's built-in SQLite removes an extra native addon; packaged utility-process loading is a release gate.

Use Forge's TypeScript/Webpack integration. The ESM worker and its production dependencies use a separate runtime.asar archive; native executables remain unpacked. This preserves Pi's assets and imports while preventing Squirrel/NuGet from processing 26,000 small files individually. The packaged smoke checks Pi model-protocol and tool execution through a local test endpoint. Development and runtime dependencies have separate checked-in lockfiles. Do not bundle a second LLM loop or rebuild upstream monorepos. Preserve dependency licenses in the archive and aggregate UI license texts.

Sources: [Pi SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md), [assistant-ui external store](https://www.assistant-ui.com/docs/runtimes/custom/external-store), [Electron process model](https://www.electronjs.org/docs/latest/tutorial/process-model), [Forge](https://www.electronforge.io/templates/typescript-+-webpack-template), [sax](https://github.com/isaacs/sax-js), [yauzl](https://github.com/thejoshwolfe/yauzl).

## Failure and resource policy

Only one active mutation/agent run per controller. Cancel interrupts model/import work. Requests have IDs; UI cannot invoke arbitrary channels or filesystem operations. Domain mutations commit before completion events. Retry must not duplicate imports/reports. Import progress is bounded and UI stays responsive. Build only Windows x64, one output directory; measure actual cache/runtime/package sizes. Do not delete user data to recover disk space.

Default automated checks cover local model-protocol execution. Dependency vulnerability audit, package smoke, TypeScript checks and domain tests are separate evidence; warnings and failures are reported rather than concealed.
