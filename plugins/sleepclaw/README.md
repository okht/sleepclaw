# SleepClaw plugin

Local sleep investigation tools and a sleep-specific Skill for Codex and Claude Code. The host assistant chooses the next question or query. The same calculations also run in the SleepClaw Pi desktop app.

## Build once

Requires **Node.js 24.13 or newer** (built-in SQLite). From the repository:

```powershell
cd pi-app
npm ci
npm run plugin:build
```

The build writes `plugins/sleepclaw/runtime/sleepclaw-tools.cjs` and dependency notices. Distribute the **whole plugin folder including runtime**, not only the manifests. A source checkout needs this build before loading. No Electron, Pi runtime, Python, API key or network service is required to run the built tools. The Node SQLite experimental warning goes to stderr, never protocol stdout.

## Claude Code

From the repository root after building:

```powershell
claude --plugin-dir ./plugins/sleepclaw
```

Use `/sleepclaw:sleep-investigation` or ask to investigate your sleep. Review the tool permissions presented by the host. `.mcp.json` uses Claude's plugin-root variable; the Skill is under `skills/`.

## Codex

The supported compatibility manifest is `.codex-plugin/plugin.json`. It points to `.mcp.json`, which uses `cwd: "."` relative to the installed plugin root. A small Node launcher handles both hosts: Claude expands its plugin-root argument, while Codex leaves it literal and the launcher uses the configured plugin-root cwd. No shell interpolation or model-generated code is involved.

Add the **built** plugin to a local marketplace through Codex's plugin-creator / plugin directory flow, then enable it in a new session. This repository does not install it, create a marketplace or change global settings automatically. Invoke `$sleep-investigation` after enabling it.

For a tools-only connection without a marketplace, the user can explicitly register the built server:

```powershell
codex mcp add sleepclaw -- node C:/absolute/path/to/plugins/sleepclaw/runtime/sleepclaw-tools.cjs mcp
```

Replace the path with the actual built location. This command modifies Codex configuration and is a user-run setup option, not part of the build. MCP alone provides the tools; enabling the plugin additionally supplies the Skill. [Codex MCP configuration](https://developers.openai.com/codex/mcp/), [plugin packaging](https://developers.openai.com/plugins/build/plugins), [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference).

## Storage and privacy

Default tool storage is `~/.sleepclaw-tools`, separate from the desktop. Choose another store with `--home <absolute-directory>` or the `SLEEPCLAW_HOME` environment variable **before launching the host**. Keep it outside the plugin installation/cache folder. The tools do not read desktop credentials or configure a second model. Avoid sharing an active desktop database with another host while either is changing facts.

User-selected Apple Health ZIP/XML files are parsed locally and never returned as attachments. Facts, relevant observations and summaries returned by a tool enter the host conversation and may go to its model provider. Stored imports/reports are local and unencrypted; apply the same device access controls as other personal health files. SleepClaw deletion cannot erase Codex/Claude conversation history. This first plugin exposes no destructive delete tool.

## Tools and standalone CLI

List exact schemas from a source checkout:

```powershell
cd pi-app
npm run tools -- --home C:/path/to/isolated-sleep-store list
```

Or from the built plugin (no npm packages needed):

```powershell
node runtime/sleepclaw-tools.cjs --home C:/path/to/isolated-sleep-store list
node runtime/sleepclaw-tools.cjs --home C:/path/to/isolated-sleep-store call sleep_context '{}'
```

`call <tool-name> --stdin` reads a JSON object from stdin, which is useful for shell quoting. Calls return JSON; errors return a safe code and nonzero CLI exit status. MCP uses the same tools via `mcp` instead of `call`.

| Tool | Purpose |
|---|---|
| `sleep_context` | List investigations or read explicitly selected facts, pending question, guidance and plan status |
| `sleep_create` | Start a requested investigation and return its ID |
| `sleep_import` | Locally import the selected ZIP/XML, with cancellation and deduplication |
| `sleep_fact` | Save/correct known, unknown, approximate or ranged user facts |
| `sleep_question` | Save one question and optional reason |
| `sleep_target` | Select the user's episode/source; require zoned timestamps |
| `sleep_plan` | Save up to six checks tied to the current investigation revision |
| `sleep_data_query` | Re-read a bounded interval/type in the selected episode |
| `sleep_health_analysis` | Sleep coverage/gaps/conflicts and source-specific physiology sample statistics |
| `sleep_report` | Save a versioned report, even with incomplete information |
| `sleep_feedback` | Save the user's response to a report action |

Scoped calls require `investigationId`. No tool silently chooses the newest investigation. No arbitrary SQL, remote URLs, shell execution, auto-discovery of health files, diagnosis or disease-risk scoring is exposed.

## Useful first requests

- 「昨晚大概睡了六到七小时，具体不记得。没有手表，先用这些信息给我报告。」
- “Import this Apple Health export. Ask me which episode to use if there is more than one, then check what the records can tell us about my interruption.”
- 「刚才说错了，那是平时的习惯，不是昨晚。更正后更新报告。」

See [implementation and verification](../../docs/architecture/sleep-tools-plugin.md) for reuse choices and known limits.
