# 界面与独立报告示例

截图使用英文与浅色模式，覆盖首页、调查、数据和报告页面，并提供应用导出的独立报告文件。

## 展示范围

- 首页：开始分析、最近会话、Apple Health 导入入口和已连接状态。
- 调查：Pi 调用查询工具后保存一个追问，界面显示问题与待提交的示例回答。
- 数据：导入 Apple Health XML 示例记录，展示来源、时段和导入记录。
- 报告：回答后重新查询 02:00–02:30，再通过报告工具保存报告。

示例含 13 条记录，其中一条为卧床记录；去重计算得到 420 分钟睡眠、30 分钟已记录清醒。窄窗查询得到 10 分钟睡眠、20 分钟清醒。报告不提供评分。

## 复现

在 Windows x64、PowerShell 7、Node.js 24.13+ 环境，从仓库根目录执行：

```powershell
cd pi-app
npm ci
npm run package
npx tsx scripts/demo.ts
```

脚本每次新建 `.smoke/demo-*`，导入 XML 示例记录、保存英文问卷及三条示例调查，再启动隐藏的独立桌面实例。终端输出本机协议测试服务的 URL。脚本会在 30 分钟后退出，也可以按 Ctrl+C 结束。

使用 Playwright CLI 连接测试实例：

```powershell
npx --yes --package @playwright/cli playwright-cli -s=sleepclaw-demo attach --cdp http://127.0.0.1:9337
```

在页面通过 `window.sleepclaw.request` 配置接口连接本机服务。将 `baseUrl` 替换为本次脚本输出值，其他参数保持如下：

```javascript
await window.sleepclaw.request('configure', {
  provider: 'local-demo', model: 'Demo model',
  protocol: 'openai-completions',
  baseUrl: 'http://127.0.0.1:<printed-port>/v1',
  apiKey: 'synthetic-demo-key-no-real-credentials'
});
```

使用界面的外观按钮切换浅色模式。「New analysis」可查看首页；选择「Why do I still feel tired?」返回主示例。发送：

```text
I slept for about seven hours, but I still woke up tired. Can we look at last night?
```

在追问框中输入并保存：

```text
Traffic outside woke me around 2 am. I checked the clock and it took a while to settle.
```

随后可切换「Your data」和「Reports」。复现脚本按上述顺序执行，重新运行时需启动新实例。测试模式的 `capturePreview` 接口将页面保存为 PNG。首页使用 1200 × 840 的布局，其余三页使用 1200 × 1050 的布局；图片为高分屏原始导出。右上角「中文」为语言切换入口，当前内容语言仍为英文。

提交的图片位于 `assets/demo/`。`.smoke/` 中的数据库、会话和测试凭据不提交。

## 独立导出报告

[Markdown 报告](../../assets/demo/exported-report.md) 与 [JSON 报告](../../assets/demo/exported-report.json) 为上述桌面流程保存的导出文件。JSON 中的 `markdown` 与独立 Markdown 文件一致。

主页另展示 [三页 PDF 报告](../../assets/demo/sleepclaw-report.pdf)：封面、睡眠摘要与依据、下一步行动。它使用 `sleepclaw-design-system` 的当前 HTML/PDF 模板；三张页面图直接由该 PDF 渲染，保留原排版。当前应用导出格式仍为 Markdown 和 JSON，HTML/PDF 模板的应用接入单独推进。

页面素材为 `assets/demo/report-document-1.png`、`report-document-2.png` 和 `report-document-3.png`。更新时先在设计系统仓库运行 `npm run report:check`，将验证后的 PDF 同步至本仓库，再通过 Poppler 渲染页面图；不要将 Markdown 阅读器截图替代这份独立报告设计。
