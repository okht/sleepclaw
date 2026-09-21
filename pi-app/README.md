# SleepClaw Pi desktop

第一阶段开发入口。桌面和 CLI 共用领域数据与 Pi 会话执行核心，Skills 全部禁用时仍可完成核心调查。旧工程不参与此目录的构建。

## 开发、测试与打包

使用 Windows x64、PowerShell 7 和 Node.js 24.13+。

```powershell
npm ci
npm start
npm run typecheck
npm test
npm run make
npm run smoke
```

Forge 使用 TypeScript＋Webpack。`make` 先生成独立 Node 运行时与生产依赖，再打包 Electron，最后制作 Squirrel 安装器。Windows x64 产物位于：

- `out/SleepClaw-win32-x64/sleepclaw.exe`：可直接运行的应用。
- `out/make/squirrel.windows/x64/SleepClaw-Setup.exe`：安装器，生成成功后才可分发。

`smoke` 对打包后的可执行文件进行本机协议测试，使用 `.smoke/packaged-*` 的独立数据目录，检查 SQLite、Pi 加载、模型连接、工具调用及报告保存。干净 Windows 安装测试需单独执行。当前包未签名，不能承诺没有 SmartScreen 或杀毒软件提示。

## 使用流程

首次打开可连接模型，也可先在本地使用。新建调查后逐题回答；支持跳过、随时生成简报、改答案及继续未答问题。连接模型后才启用 AI 对话、动态追问和定向查询。

导入 Apple Health 原始 XML 或含有唯一 `export.xml` 的 ZIP。导入成功后显示日期、来源和睡眠候选。请选择目标，或手动设置时间范围、来源及整段睡眠／午睡／片段；不自动把最近记录当作用户目标。编辑时间使用电脑当前时区，内部保存 ISO 时间。

报告数字来自计算工具，AI 解读单独显示。已有报告保持其生成时语言，切换语言后新生成报告使用当前语言。修正事实会令旧报告失效，新报告保存新版本。缺失记录保持未知；所有综合分和维度分目前为空，并明确解释评分规则尚未验证。

## 模型与 CLI

桌面支持 OpenAI-compatible 与 Anthropic Messages 配置。连接测试要求服务既能输出文本，也能调用一个无健康数据的测试工具。远程地址要求 HTTPS，本机服务可用 HTTP。成功后才保存配置，失败不覆盖原配置。

```powershell
npm run cli -- --help
npm run cli -- --lang zh
npm run cli -- --import 'C:\data\export.zip'
npm run cli -- --resume <investigation-id>
npm run cli -- --print '整理这次睡眠'
```

CLI 使用环境变量 `SLEEPCLAW_API_KEY`，或对应协议的 `OPENAI_API_KEY`／`ANTHROPIC_API_KEY`；不在命令行参数中传密钥。通过 `--configure --provider openai --model <id> --base-url <url>` 测试并保存模型元数据。桌面安全存储的密钥不会由 CLI 解密。开发 CLI 需要 Node；Windows 桌面运行时自带 Node。

交互命令：`/new`、`/skip`、`/report`、`/ask <问题>`、`/exit`。CLI 与桌面不要同时写同一 Home；分别使用 `--home`／`SLEEPCLAW_HOME` 可创建独立实例。

## 保存与删除

默认目录：`%USERPROFILE%\.sleepclaw-pi`；可用 `SLEEPCLAW_HOME` 指定独立目录。

- SQLite 保存个人档案、本次事实、导入记录、报告与反馈。
- Pi 原生会话保存聊天和工具调用；这些内容也可能包含健康信息。
- `reports/` 保存 JSON 和 Markdown；桌面固定模板渲染结构化报告。
- 桌面 `credentials.bin` 使用 Electron safeStorage 保护密钥。健康数据按产品决定不强制加密。

删除调查会删除其答案、报告、反馈和会话，保留共享导入及个人档案。导入、事实或档案可单独删除；关联报告同步清理，旧会话被清除以免再次引用已删除内容。更正与删除语义不同：更正保留失效版本，删除移除关联输出。逻辑删除不等同于磁盘取证级擦除，也不会删除用户原文件、外部备份或模型服务已收到的数据。

## Skills

默认不加载全局扩展、项目上下文或 Skills。可在 Home 的 `skills.json` 明确选择受信的 Pi Skill 路径：

```json
{ "paths": ["C:/path/to/my-skill"] }
```

沿用 Pi Skill 语义与 `/skill:NAME`。Skills 为可选的分析方法；领域工具始终可用。当前不提供扩展商店，也不自动启用任意 JavaScript 扩展。受信配置不等同于操作系统沙箱。

## 资源和限制

`node_modules/` 为开发依赖，`runtime/` 为生成的生产运行时，`runtime-bundle/` 保存其 ASAR 归档，`.webpack/` 和 `out/` 为构建输出；只有 Windows x64 产物。运行时裁剪只作用于生成目录中其他平台的 esbuild 副本。开发与生产运行时分别用 `package-lock.json`／`runtime-lock.json` 锁定依赖，通过 `npm ci` 安装；不运行 Rust、旧 Python 或旧前端构建。

将生产依赖合并成 ASAR 可减少 Squirrel 对大量小文件的重复写入。原生可执行文件保持 unpacked，Pi 的 JavaScript、资源及许可证内容仍完整保存。`smoke` 检查资源文件数量，防止退回数万个散文件的打包方式。

导入流式处理、可取消，失败事务回滚。当前保护上限为 XML 2 GiB、相关记录 100 万条、ZIP 2 万条目及压缩比 1000。候选睡眠按 90 分钟间隔分组，只提供候选，用户可手动修正；这不构成生理分期判断。

本期未实现 EEG／SleepGPT、临床、自动同步、其他设备适配、长期基线、复杂报告管理器或自动更新。实际测试结果、包大小和尚未完成的发布验证详见 [验证记录](../docs/product/phase-1-validation.md)。
