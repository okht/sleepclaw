import type { Question, Language } from '../shared/types.js';

type QuestionDefinition = { topic: string; scope: 'profile' | 'sleep'; zh: string; en: string; reasonZh: string; reasonEn: string };

// Stable topic keys are persisted, while wording follows the investigation language.
// A report never requires this list to be completed.
const questions: QuestionDefinition[] = [
  { topic: 'age_range', scope: 'profile', zh: '你的年龄大概在哪个范围？', en: 'What is your approximate age range?', reasonZh: '帮助说明分析的适用范围；可以跳过。', reasonEn: 'This helps describe the scope of the analysis. You may skip.' },
  { topic: 'usual_schedule', scope: 'profile', zh: '你平时大概几点睡、几点起？', en: 'When do you usually go to bed and get up?', reasonZh: '之后可以区分平时作息和这次的变化。', reasonEn: 'This distinguishes your usual schedule from changes during this sleep.' },
  { topic: 'sleep_duration_hours', scope: 'sleep', zh: '这次你觉得自己实际睡了几个小时？不知道也没关系。', en: 'How many hours do you think you actually slept? It is fine not to know.', reasonZh: '保留你的感受，与设备估计分开比较。', reasonEn: 'Your recollection remains separate from device estimates.' },
  { topic: 'remembered_awakenings', scope: 'sleep', zh: '这次睡眠中，你记得醒过几次？', en: 'How many awakenings do you remember during this sleep?', reasonZh: '了解你感受到的睡眠中断。', reasonEn: 'This records the interruptions you actually noticed.' },
  { topic: 'recovery', scope: 'sleep', zh: '醒来后感觉恢复得怎么样？', en: 'How refreshed did you feel after waking?', reasonZh: '时长相近时，恢复感仍然可能不同。', reasonEn: 'Similar sleep durations can still feel different.' },
  { topic: 'recent_context', scope: 'sleep', zh: '这次睡前或睡眠中，有什么和平时不同的事情吗？', en: 'Was anything different before or during this sleep?', reasonZh: '例如压力、环境、咖啡或饮酒；只说你记得的就好。', reasonEn: 'For example stress, environment, caffeine or alcohol. Share only what you remember.' },
  { topic: 'work_pattern', scope: 'profile', zh: '你的工作或上学时间固定吗？有没有轮班？', en: 'Is your work or study schedule regular, or do you work shifts?', reasonZh: '建议需要适合你的实际生活安排。', reasonEn: 'Suggestions should fit your real schedule.' },
  { topic: 'medications', scope: 'profile', zh: '有没有长期使用、你愿意记录的药物或补充剂？', en: 'Are there regular medicines or supplements you would like to record?', reasonZh: '仅作为背景记录，不会建议自行调整用药；可以跳过。', reasonEn: 'This is context only. We will not suggest changing treatment. You may skip.' },
  { topic: 'usual_caffeine', scope: 'profile', zh: '你平时喝咖啡或茶的习惯是怎样的？', en: 'What are your usual coffee, tea or other caffeine habits?', reasonZh: '便于区分日常习惯和偶尔的变化。', reasonEn: 'This helps distinguish usual habits from occasional changes.' },
  { topic: 'usual_alcohol', scope: 'profile', zh: '你平时有饮酒习惯吗？大概是什么时候？', en: 'Do you usually drink alcohol, and roughly when?', reasonZh: '用于理解背景，不会据此直接判断原因。', reasonEn: 'This provides context and does not establish a cause.' },
  { topic: 'usual_exercise', scope: 'profile', zh: '你平时一般什么时候运动？', en: 'When do you usually exercise?', reasonZh: '让行动建议更符合你的安排。', reasonEn: 'This helps keep suggestions practical for you.' },
  { topic: 'sleep_environment', scope: 'profile', zh: '你通常睡觉的环境怎么样？有容易打扰你的地方吗？', en: 'What is your usual sleeping environment like? Is anything disruptive?', reasonZh: '了解你能够实际改变的环境因素。', reasonEn: 'This helps identify environmental changes within your control.' },
  { topic: 'daytime_energy', scope: 'profile', zh: '你平时白天的精神和困倦情况怎么样？', en: 'How is your usual daytime energy or sleepiness?', reasonZh: '睡眠分析也需要考虑白天的实际感受。', reasonEn: 'Your daytime experience matters alongside sleep records.' },
  { topic: 'sleep_goal', scope: 'profile', zh: '关于睡眠，你长期最想改善的是什么？', en: 'What would you most like to improve about your sleep over time?', reasonZh: '以后优先围绕你关心的事情分析。', reasonEn: 'Future analyses can focus on what matters most to you.' },
];

export function questionDefinitions(language: Language): Array<Omit<Question, 'id'>> {
  return questions.map(q => ({ topic: q.topic, scope: q.scope, text: language === 'zh' ? q.zh : q.en, reason: language === 'zh' ? q.reasonZh : q.reasonEn }));
}
