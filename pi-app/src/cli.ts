import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SleepApp } from './controller';
import { publicError } from './agent';
import { cliApiKey, latestActiveReport } from './cli-options';
const args = process.argv.slice(2);
const value = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args.includes('--help')) {
  console.log('SleepClaw\n  npm run cli -- [--lang zh|en] [--home PATH] [--import FILE] [--resume ID]\n  --configure --provider NAME --model ID [--base-url URL]\n  --print PROMPT   One model turn, requires configured model and API key env\n  --report         Create a local report from current facts\n  Commands: /new GOAL, /skip, /report, /ask TEXT, /exit\n  Model keys: SLEEPCLAW_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY (never written in plaintext).');
} else {
  const home = resolve(value('--home') || process.env.SLEEPCLAW_HOME || join(homedir(), '.sleepclaw-pi'));
  const application = new SleepApp(home, event => { if (event.type === 'delta') stdout.write(event.text); if (event.type === 'error') console.error(event.message); });
  application.setCredential(cliApiKey(application.snapshot().model?.provider));
  process.on('SIGINT', () => { void application.request('cancel'); });
  const language = value('--lang') === 'en' ? 'en' : 'zh';
  try {
    if (value('--lang')) await application.request('language', { language });
    if (args.includes('--configure')) {
      const provider = value('--provider') || 'openai';
      await application.request('configure', { provider, model: value('--model'), baseUrl: value('--base-url'), apiKey: cliApiKey(provider) });
      console.log(language === 'zh' ? '连接验证通过。CLI 每次从环境变量读取密钥。' : 'Connection verified. CLI reads the key from the environment each time.');
    }
    if (value('--resume')) await application.request('select', { id: value('--resume') });
    if (value('--import')) await application.request('import', { path: value('--import') });
    if (args.includes('--configure')) { /* Configuration is an explicit, standalone operation. */ }
    else if (value('--print')) await application.request('send', { text: value('--print') });
    else if (args.includes('--report')) { const state = await application.request('report'); console.log(latestActiveReport(state)?.markdown ?? (language === 'zh' ? '本次调查尚未生成有效报告。' : 'No current report for this investigation.')); }
    else if (!stdin.isTTY) { let input = ''; for await (const chunk of stdin) input += chunk; if (input.trim()) await application.request('send', { text: input }); else console.log(JSON.stringify(application.snapshot(), null, 2)); }
    else {
      const rl = createInterface({ input: stdin, output: stdout });
      console.log('SleepClaw — /new /skip /report /ask /exit');
      try {
        while (true) {
          const state = application.snapshot();
          const text = await rl.question(`${state.question?.text ?? (language === 'zh' ? '想了解哪次睡眠？' : 'Which sleep would you like to understand?')}\n> `);
          if (text === '/exit') break;
          try {
            if (text.startsWith('/new ')) await application.request('new', { goal: text.slice(5) });
            else if (text === '/skip') await application.request('answer', { skip: true });
            else if (text === '/report') { const reportState = await application.request('report'); console.log(latestActiveReport(reportState)?.markdown ?? (language === 'zh' ? '本次调查尚未生成有效报告。' : 'No current report for this investigation.')); }
            else if (text.startsWith('/ask ')) await application.request('send', { text: text.slice(5) });
            else if (!state.active) await application.request('new', { goal: text });
            else if (state.question) await application.request('answer', { value: /^\d+(\.\d+)?$/.test(text) ? Number(text) : text });
            else await application.request('send', { text });
          } catch (error) { console.error(publicError(error, language).message); }
        }
      } finally { rl.close(); }
    }
  } catch (error) { console.error(publicError(error, language).message); process.exitCode = 1; }
  finally { await application.close(); }
}
