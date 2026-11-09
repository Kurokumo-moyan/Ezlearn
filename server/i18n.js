// 任务进度提示的多语言文本：按课程的"讲解语言"显示。目前支持中文与英文，其他语言用英文。

const MSG = {
  zh: {
    'job.analyze': '一键分析', 'job.S2': '证据抽取', 'job.S3': '学科判定', 'job.S4': '考核与真题分析', 'job.S5': '课程方案',
    'job.chapter': '生成章节', 'job.all_chapters': '生成全部章节', 'job.update': '增量更新',
    start: '开始：{kind}',
    s2_batch: '正在从资料里找老师的原话（第 {k}/{n} 批）',
    s2_done: '证据抽取完成：{count} 条，其中 {found} 条已在原文中核实',
    s3: '正在判断这门课属于哪类学科',
    s3_done: '学科判定完成：{profiles}',
    s4: '正在分析考核方式与往年真题',
    s4_done: '考核与真题分析完成',
    s5: '正在规划章节目录',
    s5_done: '课程方案完成：共 {n} 章，等你确认',
    s6: '正在编写第 {number} 章「{title}」',
    s7: '正在自动检查第 {number} 章（算数字、找原话、看公式）',
    s7_review: '正在让模型审读第 {number} 章',
    ch_done: '第 {number} 章完成：{errors} 个错误，{warnings} 个警告',
    ch_skip: '跳过已生成的第 {number} 章',
    s8: '正在对比新资料，整理变更清单',
    s8_done: '变更清单完成：{n} 项待你确认',
    done: '全部完成',
    error: '出错了：{error}',
  },
  en: {
    'job.analyze': 'Analyse course', 'job.S2': 'Evidence extraction', 'job.S3': 'Subject detection', 'job.S4': 'Assessment & past exams', 'job.S5': 'Course plan',
    'job.chapter': 'Write chapter', 'job.all_chapters': 'Write all chapters', 'job.update': 'Incremental update',
    start: 'Started: {kind}',
    s2_batch: 'Finding what the lecturer actually said (batch {k}/{n})',
    s2_done: 'Evidence done: {count} items, {found} verified against the source',
    s3: 'Working out what kind of subject this is',
    s3_done: 'Subject detected: {profiles}',
    s4: 'Analysing assessment and past exams',
    s4_done: 'Assessment analysis done',
    s5: 'Planning the chapters',
    s5_done: 'Plan ready: {n} chapters, waiting for your confirmation',
    s6: 'Writing chapter {number} "{title}"',
    s7: 'Checking chapter {number} (numbers, quotes, formulas)',
    s7_review: 'Model review of chapter {number}',
    ch_done: 'Chapter {number} done: {errors} errors, {warnings} warnings',
    ch_skip: 'Skipping chapter {number} (already written)',
    s8: 'Comparing new materials and listing changes',
    s8_done: 'Change list ready: {n} items for you to review',
    done: 'All done',
    error: 'Something went wrong: {error}',
  },
};

/** 把课程的讲解语言（自由文本，如"中文"、"English"、"简体中文"）映射到消息语言。 */
export function langOf(teachingLanguage) {
  const t = String(teachingLanguage || '').toLowerCase();
  if (/中|汉|華|华|chinese|mandarin|zh/.test(t)) return 'zh';
  return 'en';
}

export function t(lang, key, params = {}) {
  const table = MSG[lang] || MSG.zh;
  const tpl = table[key] ?? MSG.zh[key] ?? key;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (params[k] === undefined ? '' : String(params[k])));
}
