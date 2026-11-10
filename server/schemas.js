// 数据结构（对应 02_流水线与数据结构.md 第 3 节）。
// 两个用途：1) 作为 LLM 结构化输出的 JSON Schema；2) 所有 LLM 输出落盘前的服务端强校验。
// 结构化输出不支持递归 schema，所以内容块按"叶子块 → 一层容器 → 顶层容器"展开成三层。
import { z } from 'zod';

const S = (max) => z.string().max(max);
const rich = S(8000); // 行内语法：{{教学术语|exam term}}、$math$、**强调**、`code`

export const BOX_KINDS = ['key', 'exam', 'skip', 'definition', 'result', 'pitfall', 'intuition', 'template', 'extension', 'correction'];
export const WIDGET_TYPES = ['sql_sandbox', 'sql_steps', 'join_match', 'stepper', 'calc', 'function_plot', 'supply_demand', 'payoff_matrix'];
export const VERIFY_LANGS = ['sql', 'js', 'none'];
export const MATERIAL_ROLES = [
  'course_outline', 'slides', 'annotated_slides', 'textbook', 'lecture_notes', 'transcript',
  'tutorial', 'tutorial_solution', 'lab', 'lab_solution', 'past_exam', 'past_exam_solution',
  'assignment', 'dataset', 'code', 'reading', 'other',
];
export const EVIDENCE_TYPES = ['not_examinable', 'emphasised', 'exam_format', 'exam_hint', 'assessment_rule', 'correction', 'scope'];

const Verify = z.object({
  lang: z.enum(VERIFY_LANGS),
  code: S(20000),
  expected: S(20000).describe('期望结果的 JSON 字符串（数字、数组或对象）；SQL 为结果行数组的 JSON'),
});

// ---- 叶子块 ----
const Heading = z.object({ type: z.literal('heading'), level: z.union([z.literal(2), z.literal(3)]), id: S(64), number: S(32), text: S(300), text_exam_lang: S(300) });
const Paragraph = z.object({ type: z.literal('paragraph'), rich_text: rich });
const List = z.object({ type: z.literal('list'), ordered: z.boolean(), items: z.array(rich).max(60) });
const Formula = z.object({
  type: z.literal('formula'), latex: S(4000), display: z.boolean(),
  symbols: z.array(z.object({ symbol: S(200), meaning: S(1000) })).max(40),
});
const Table = z.object({ type: z.literal('table'), header: z.array(S(300)).max(30), rows: z.array(z.array(S(2000)).max(30)).max(200), caption: S(300).optional() });
const Code = z.object({
  type: z.literal('code'), lang: S(20), source: S(20000), runnable: z.boolean(),
  annotations: z.array(z.object({ line: z.number().int(), note: S(1000) })).max(80),
  expected_output: S(20000).optional().describe('SQL 的期望结果（JSON 行数组）；校验阶段会用真实执行结果覆盖'),
});
const Figure = z.object({ type: z.literal('figure'), material_id: S(64), page: z.number().int(), caption: S(500), license: S(200).optional() });
const Widget = z.object({ type: z.literal('widget'), widget: z.enum(WIDGET_TYPES), config_json: S(30000), fallback_text: S(2000) });
const QuickRef = z.object({ type: z.literal('quick_ref'), rows: z.array(z.object({ concept: S(300), content: rich })).max(80) });

const LEAVES = [Heading, Paragraph, List, Formula, Table, Code, Figure, Widget, QuickRef];
export const LeafBlock = z.discriminatedUnion('type', LEAVES);

// ---- 一层容器：具体例子（只含叶子） ----
const ExampleL1 = z.object({ type: z.literal('example'), title: S(300), body: z.array(LeafBlock).max(60), verify: Verify.optional() });
const Inner = z.discriminatedUnion('type', [...LEAVES, ExampleL1]);

// ---- 顶层容器 ----
const Box = z.object({
  type: z.literal('box'), kind: z.enum(BOX_KINDS), title: S(300).optional(), body: z.array(Inner).max(60),
  evidence_ids: z.array(S(64)).max(10).optional(), is_inference: z.boolean().optional(),
});
const Exercise = z.object({
  type: z.literal('exercise'), id: S(64), title: S(300), source: S(300), stem: z.array(Inner).max(40),
  parts: z.array(z.object({ label: S(20), question: z.array(Inner).max(30), solution: z.array(Inner).max(60), verify: Verify.optional() })).max(30),
});

export const Block = z.discriminatedUnion('type', [...LEAVES, ExampleL1, Box, Exercise]);

export const Term = z.object({ id: S(64), teaching_lang: S(200), exam_lang: S(200), definition: S(1000).optional() });

export const ChapterOut = z.object({
  id: S(64), number: S(16), title: S(300), title_exam_lang: S(300), group: S(120), weight: z.number().int(),
  week: S(40), lecture_dates: z.array(S(40)).max(20),
  sources: z.array(z.object({ material_id: S(64), pages: S(60) })).max(30),
  summary: S(1000).describe('这一章在解决什么问题（1–3 句，直觉层面）'),
  blocks: z.array(Block).max(400),
  terms: z.array(Term).max(200),
  todos: z.array(S(500)).max(50),
});

export const EvidenceOut = z.object({
  evidence: z.array(z.object({
    type: z.enum(EVIDENCE_TYPES), material_id: S(64), location: S(120), quote: S(600), target: S(300),
    boundary: S(300).optional(), confidence: z.enum(['high', 'low']), note: S(500).optional(),
  })).max(300),
  coverage: z.array(z.object({ week_or_chapter: S(80), has_transcript: z.boolean(), has_annotations: z.boolean(), material_ids: z.array(S(64)).max(30) })).max(60),
});

export const ProfileOut = z.object({
  primary_profile: S(40), secondary_profiles: z.array(S(40)).max(5),
  ratios: z.array(z.object({ profile: S(40), ratio: z.number() })).max(6),
  chapter_profiles: z.array(z.object({ chapter_hint: S(200), profiles: z.array(S(40)).max(4) })).max(60),
  rationale: z.object({ exam_types: S(1500), material_forms: S(1500), likely_stuck_points: S(1500) }),
  recommended_blocks: z.array(S(40)).max(20), recommended_widgets: z.array(z.enum(WIDGET_TYPES)).max(8),
});

export const ExamOut = z.object({
  assessment: z.array(z.object({ name: S(120), weight: S(30), format: S(300), timing: S(120), hurdle: S(200).optional() })).max(20),
  papers: z.array(z.object({
    year: S(30), material_id: S(64), duration: S(40), total_marks: S(20), teacher_or_format_note: S(500).optional(),
    questions: z.array(z.object({ no: S(20), marks: z.number(), type: S(120), chapter_refs: z.array(S(64)).max(6), topics: z.array(S(200)).max(10) })).max(80),
  })).max(20),
  marks_by_chapter: z.array(z.object({ chapter_ref: S(120), marks: z.number() })).max(60),
  patterns: z.array(S(500)).max(30),
  key_topic_judgement: z.array(z.object({ claim: S(600), evidence_ids: z.array(S(64)).max(10), is_inference: z.boolean() })).max(40),
  priority: z.array(z.object({ level: z.enum(['highest', 'high', 'medium', 'low', 'not_examinable']), chapters: z.array(S(120)).max(30), reason: S(800) })).max(10),
  caveats: z.array(S(600)).max(20),
});

export const PlanOut = z.object({
  toc_basis: S(1000),
  chapters: z.array(z.object({
    id: S(64), number: S(16), title: S(300), title_exam_lang: S(300), group: S(120),
    sources: z.array(z.object({ material_id: S(64), pages: S(60) })).max(30),
    week: S(40), weight: z.number().int(), profiles: z.array(S(40)).max(4), focus: S(800),
    widgets: z.array(z.object({ widget: z.enum(WIDGET_TYPES), stuck_point: S(500), interaction: S(500), default_data: S(500) })).max(6),
  })).max(60),
  questions_for_user: z.array(S(500)).max(20),
  not_doing: z.array(S(500)).max(20),
});

/** 图像识别（转写）一页的结果。 */
export const VisionOut = z.object({
  text: z.string().max(30000),
  handwriting: z.array(z.string().max(2000)).max(80),
  has_handwriting: z.boolean(),
  confidence: z.enum(['high', 'medium', 'low']),
  notes: z.string().max(1000),
  // 看不清的地方：text / handwriting 里写 [[?编号]]，这里给出根据上下文推断的 1–2 个写法
  uncertain: z.array(z.object({
    id: z.number().int().min(1).max(99),
    guesses: z.array(z.string().min(1).max(200)).min(1).max(2),
    reason: z.string().max(300),
    region: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }).nullable(),
  })).max(30).default([]),
});

export const ReviewOut = z.object({
  issues: z.array(z.object({ block_index: z.number().int(), severity: z.enum(['error', 'warn']), problem: S(1000), suggestion: S(1500) })).max(100),
});

export const UpdateOut = z.object({
  changes: z.array(z.object({
    chapter_id: S(64), op: z.enum(['replace', 'insert_after', 'delete', 'append']), block_index: z.number().int(),
    new_block_json: S(30000).describe('新内容块的 JSON 字符串；delete 时为空字符串'),
    change_type: z.enum(['new_evidence', 'new_example', 'new_exercise', 'scope_change', 'correction', 'other']),
    evidence_quote: S(600), reason: S(800),
  })).max(100),
  coverage_note: S(800),
});

// ---- 把 zod schema 转成结构化输出可接受的 JSON Schema ----
const DROP = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minItems', 'maxItems', 'pattern', '$schema', 'format']);
function clean(node) {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (DROP.has(k)) continue;
    out[k === 'oneOf' ? 'anyOf' : k] = clean(v);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

export function toOutputSchema(schema) {
  return clean(z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' }));
}

// ---- 交互组件配置（服务端校验 config_json；前端也会做防御式检查） ----
const cell = z.union([z.string().max(500), z.number(), z.boolean(), z.null()]);
const num = z.number().finite();
const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,30}$/);
const expr = z.string().max(500); // 由 shared/expr.js 安全解析，不会被 eval

export const WidgetConfigs = {
  sql_sandbox: z.object({ title: z.string().max(200), dataset_material_id: z.string().max(64).optional(), initial_query: z.string().max(4000) }).strict(),
  sql_steps: z.object({
    title: z.string().max(200), dataset_material_id: z.string().max(64).optional(),
    steps: z.array(z.object({ clause: z.string().max(300), sql: z.string().max(4000), note: z.string().max(1000) }).strict()).min(1).max(12),
  }).strict(),
  join_match: z.object({
    title: z.string().max(200), join: z.enum(['inner', 'left']),
    left: z.object({ name: z.string().max(40), columns: z.array(z.string().max(40)).max(8), rows: z.array(z.array(cell).max(8)).max(12) }).strict(),
    right: z.object({ name: z.string().max(40), columns: z.array(z.string().max(40)).max(8), rows: z.array(z.array(cell).max(8)).max(12) }).strict(),
    left_key: z.string().max(40), right_key: z.string().max(40),
  }).strict(),
  stepper: z.object({
    title: z.string().max(200),
    steps: z.array(z.object({ label: z.string().max(200), note: z.string().max(2000), table: z.object({ header: z.array(z.string().max(200)).max(20), rows: z.array(z.array(cell).max(20)).max(40) }).strict().optional(), highlight: z.array(z.string().max(100)).max(20).optional() }).strict()).min(1).max(40),
  }).strict(),
  calc: z.object({
    title: z.string().max(200), note: z.string().max(1000).optional(),
    inputs: z.array(z.object({ name: ident, label: z.string().max(100), value: num, step: num.optional(), unit: z.string().max(30).optional() }).strict()).min(1).max(12),
    outputs: z.array(z.object({ label: z.string().max(100), expr, digits: z.number().int().min(0).max(8).optional(), unit: z.string().max(30).optional() }).strict()).min(1).max(12),
  }).strict(),
  function_plot: z.object({
    title: z.string().max(200), x_label: z.string().max(60), y_label: z.string().max(60),
    x_min: num, x_max: num, y_min: num, y_max: num,
    params: z.array(z.object({ name: ident, label: z.string().max(100), min: num, max: num, step: num, value: num }).strict()).max(5),
    curves: z.array(z.object({ label: z.string().max(100), expr }).strict()).min(1).max(5),
  }).strict(),
  supply_demand: z.object({
    title: z.string().max(200),
    demand: z.object({ intercept: num, slope: num }).strict(), // P = a - bQ
    supply: z.object({ intercept: num, slope: num }).strict(), // P = c + dQ
    tax_per_unit: num.optional(), q_max: num, p_max: num,
  }).strict(),
  payoff_matrix: z.object({
    title: z.string().max(200), row_player: z.string().max(40), col_player: z.string().max(40),
    row_actions: z.array(z.string().max(40)).min(2).max(4), col_actions: z.array(z.string().max(40)).min(2).max(4),
    payoffs: z.array(z.array(z.tuple([num, num]))).max(4),
  }).strict(),
};
