# GitHub 界面演示

这些截图展示当前桌面开发版的真实界面，统一使用英文与浅色模式。数据全部为合成示例，模型响应来自本机确定性模拟服务；不含用户记录，也不代表真实模型效果或医学验证。

## 展示范围

- 首页：开始分析、最近会话、Apple Health 导入入口和已连接状态。
- 调查：Pi 调用查询工具后保存一个追问，界面显示问题与待提交的示例回答。
- 数据：真实导入器读取合成 Apple Health XML，展示来源、时段和导入记录。
- 报告：回答后重新查询 02:00–02:30，再通过真实报告工具保存报告。

示例含 13 条记录，其中一条为卧床记录；去重计算得到 420 分钟睡眠、30 分钟已记录清醒。窄窗查询得到 10 分钟睡眠、20 分钟清醒。报告不提供评分，行动仅为示例。

## 复现

在 Windows x64、PowerShell 7、Node.js 24.13+ 环境，从仓库根目录执行：

```powershell
cd pi-app
npm ci
npm run package
npx tsx scripts/demo.ts
```

脚本每次新建 `.smoke/demo-*`，导入合成 XML、保存英文问卷及三条示例调查，再启动隐藏的独立桌面测试实例。真实用户窗口和记录保持不变。终端输出本机模型 URL；模型服务仅监听回环地址，不调用外部服务。脚本会在 30 分钟后退出，也可以按 Ctrl+C 结束。

使用 Playwright CLI 连接测试实例：

```powershell
npx --yes --package @playwright/cli playwright-cli -s=sleepclaw-demo attach --cdp http://127.0.0.1:9337
```

在测试页面通过正常 `window.sleepclaw.request` 配置接口连接下列模拟服务。`baseUrl` 替换为本次脚本输出值；此处的 Key 仅为固定测试字符串。

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

随后可切换「Your data」和「Reports」。模拟服务只接受这一条预定流程；需要重演时启动新实例。测试模式的 `capturePreview` 接口保存真实页面 PNG 到独立演示目录，截图过程不注入伪造界面。首页使用 1200 × 840 的布局，其余三页使用 1200 × 1050 的布局以展示更多内容；图片为高分屏原始导出。右上角「中文」为语言切换入口，当前内容语言仍为英文。

提交的图片位于 `assets/demo/`。`.smoke/` 中的数据库、会话和测试凭据不提交。
