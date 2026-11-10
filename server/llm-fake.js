// 假模型：仅用于自动化测试和无 API key 时演示流水线（EZLEARN_FAKE_LLM=1）。
// 输出由输入资料机械推导，结构与真实阶段输出一致；内容不代表真实讲解质量。

function dataBlock(user, name) {
  const m = new RegExp(`<data name="${name}">\\n([\\s\\S]*?)\\n</data>`).exec(user);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return m[1]; }
}

function manifestOf(user) {
  const m = /<manifest>\n([\s\S]*?)\n<\/manifest>/.exec(user);
  return m ? JSON.parse(m[1]) : [];
}

const KW = /(not examinable|won't (be )?(assess|test|examin)|skip|important|focus|exam|不考|重点|考试)/i;

export async function fakeLLM({ stage, user, images }) {
  switch (stage) {
    case 'S1V':
      return { text: images?.length ? '（假模型转写）Week 3 · Linear regression · 老师手写：this is examinable' : '', handwriting: ['this is examinable'], has_handwriting: true, confidence: 'medium', notes: '' };
    case 'S2': {
      const evidence = [];
      for (const mm of user.matchAll(/<material id="([^"]+)"[^>]*>\n([\s\S]*?)\n<\/material>/g)) {
        for (const w of mm[2].matchAll(/\[([^\]]+)\]\s*…?([\s\S]*?)(?=\n\n\[|$)/g)) {
          const sentence = w[2].split(/(?<=[.!?。！？])\s*/).find((s) => KW.test(s));
          if (!sentence) continue;
          const q = sentence.replace(/…/g, '').trim().slice(0, 200);
          const type = /not examinable|won't|skip|不考/i.test(q) ? 'not_examinable' : /important|focus|重点/i.test(q) ? 'emphasised' : 'exam_format';
          evidence.push({ type, material_id: mm[1], location: w[1], quote: q, target: q.slice(0, 60), confidence: 'high', ...(type === 'not_examinable' ? { boundary: '按原话范围' } : {}) });
        }
      }
      return { evidence: evidence.slice(0, 50), coverage: [{ week_or_chapter: 'all', has_transcript: /role="transcript"/.test(user), has_annotations: false, material_ids: [] }] };
    }
    case 'S3': {
      const sql = /select|sql|join/i.test(user);
      return {
        primary_profile: sql ? 'database_sql' : 'math_stats', secondary_profiles: [], ratios: [{ profile: sql ? 'database_sql' : 'math_stats', ratio: 1 }],
        chapter_profiles: [], rationale: { exam_types: '写查询', material_forms: '代码与表', likely_stuck_points: 'JOIN 与 GROUP BY' },
        recommended_blocks: ['code', 'table', 'example'], recommended_widgets: sql ? ['sql_sandbox', 'sql_steps', 'join_match'] : ['calc'],
      };
    }
    case 'S4':
      return { assessment: [{ name: 'Final exam', weight: '60%', format: 'written', timing: 'end of term' }], papers: [], marks_by_chapter: [], patterns: [], key_topic_judgement: [{ claim: '没有往年真题，以下为推断', evidence_ids: [], is_inference: true }], priority: [], caveats: ['假模型输出'] };
    case 'S5': {
      const mats = manifestOf(user).filter((m) => ['slides', 'lecture_notes', 'textbook', 'annotated_slides'].includes(m.role));
      const extra = manifestOf(user).filter((m) => ['tutorial', 'tutorial_solution', 'lab', 'lab_solution'].includes(m.role));
      return {
        toc_basis: '按 slides 文件顺序', questions_for_user: [], not_doing: ['不提供当期作业答案'],
        chapters: mats.map((m, i) => ({
          id: `ch${String(i + 1).padStart(2, '0')}`, number: String(i + 1), title: m.filename.replace(/\.[a-z]+$/i, ''), title_exam_lang: m.filename, group: '正文',
          sources: [{ material_id: m.id, pages: `1-${m.pages}` }, ...extra.map((x) => ({ material_id: x.id, pages: '' }))], week: m.week || '', weight: 2, profiles: [], focus: '',
          widgets: [{ widget: 'sql_sandbox', stuck_point: '查询结果想不清', interaction: '改查询看结果', default_data: '课程样例库' }],
        })),
      };
    }
    case 'S6': {
      const id = /输出对象的 id 必须是 "([^"]+)"/.exec(user)?.[1] || 'ch01';
      const num = /number="([^"]+)"/.exec(user)?.[1] || '1';
      const ev = (dataBlock(user, 'evidence') || [])[0];
      const table = /CREATE TABLE\s+(\w+)/i.exec(user)?.[1];
      const blocks = [
        { type: 'heading', level: 2, id: `s${num}-1`, number: `${num}.1`, text: '概览', text_exam_lang: 'Overview' },
        { type: 'paragraph', rich_text: '本节介绍{{关系|relation}}的基本概念，公式 $n = 3$ 只是占位。' },
        { type: 'example', title: '平均数', body: [{ type: 'paragraph', rich_text: '(1+2+3)/3 = 2' }], verify: { lang: 'js', code: '(1+2+3)/3', expected: '2' } },
      ];
      if (table) blocks.push({ type: 'code', lang: 'sql', source: `SELECT COUNT(*) AS n FROM ${table};`, runnable: true, annotations: [{ line: 1, note: '统计行数' }] });
      if (ev) blocks.push({ type: 'box', kind: ev.type === 'not_examinable' ? 'skip' : 'key', title: '老师原话', body: [{ type: 'paragraph', rich_text: ev.quote }], evidence_ids: [ev.id] });
      blocks.push({ type: 'exercise', id: `${id}-ex1`, title: '例题 1', source: '假模型', stem: [{ type: 'paragraph', rich_text: '计算 2+2。' }], parts: [{ label: 'a', question: [{ type: 'paragraph', rich_text: '结果？' }], solution: [{ type: 'paragraph', rich_text: '4' }], verify: { lang: 'js', code: '2+2', expected: '4' } }] });
      blocks.push({ type: 'quick_ref', rows: [{ concept: '关系', content: '一张表' }] });
      return { id, number: num, title: '假章节', title_exam_lang: 'Fake chapter', group: '正文', weight: 2, week: '', lecture_dates: [], sources: [], summary: '假模型生成的占位章节。', blocks, terms: [{ id: 'relation', teaching_lang: '关系', exam_lang: 'relation' }], todos: [] };
    }
    case 'S7':
      return { issues: [] };
    case 'S8': {
      const chs = dataBlock(user, 'chapters') || [];
      return { changes: chs.slice(0, 1).map((c) => ({ chapter_id: c.id, op: 'append', block_index: 0, new_block_json: JSON.stringify({ type: 'paragraph', rich_text: '（根据新资料补充的说明）' }), change_type: 'other', evidence_quote: '', reason: '新资料' })), coverage_note: '已纳入新资料' };
    }
    default:
      throw new Error(`fake: unknown stage ${stage}`);
  }
}
