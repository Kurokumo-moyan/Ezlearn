// 导入示例课程 DEMO-SQL（虚构资料），不需要 API key。
// 章节内容是手写的"标准答案"形态，但同样经过 S7 自动校验：SQL 真实执行、证据原文核对、公式渲染检查。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../server/config.js';
import { ensureDataDir, writeJSON, writeRaw, newId } from '../server/storage.js';
import { parseFile, guessRole, pagesForRole } from '../server/ingest.js';
import { loadCtx, saveCourse } from '../server/pipeline.js';
import { verifyChapter, quoteFound, norm, materialText } from '../server/verify.js';

const DIR = path.join(ROOT, 'samples', 'sql-demo');

export async function seedDemo({ quiet = false } = {}) {
  ensureDataDir();
  const course = {
    id: newId('demo-'), code: 'DEMO-SQL', title: '数据库入门（示例课程，资料为虚构）', teaching_language: '中文', exam_language: 'English',
    assessment_summary: '期末 60%（闭卷手写 SQL，40% 门槛）、Lab 20%、作业 20%', profiles: ['database_sql'], demo: true,
    created_at: new Date().toISOString(),
  };
  await saveCourse(course);
  const cid = course.id;

  const byName = {};
  for (const f of fs.readdirSync(DIR).sort()) {
    const buf = fs.readFileSync(path.join(DIR, f));
    const parsed = await parseFile(f, buf);
    const role = guessRole(f);
    const m = { id: newId('m-'), filename: f, role, kind: parsed.kind, week: /week03/.test(f) ? 'Week 3' : '', date: /transcript/.test(f) ? '2026-09-23' : '', no_solutions: role === 'assignment', pages: pagesForRole(role, parsed, f, buf), ...(parsed.sql ? { sql: parsed.sql } : {}), size: buf.length, added_at: new Date().toISOString() };
    await writeRaw(cid, buf, 'raw', `${m.id}.bin`);
    await writeJSON(cid, m, 'materials', `${m.id}.json`);
    byName[f] = m;
  }
  const M = (f) => byName[f].id;
  const tr = byName['week03_lecture_transcript.txt'];
  const para = (needle) => tr.pages.find((p) => p.text.includes(needle))?.n;

  // S2 证据（示例中手写；真实流程由模型抽取后同样做原文核对）
  const ev = [
    { id: 'ev-demo-key', type: 'emphasised', material_id: M('week03_lecture_transcript.txt'), location: `2026-09-23 第 ${para('really important')} 段`, quote: 'GROUP BY and HAVING are really important, they come up in the final every year.', target: '3.4 GROUP BY 与 HAVING', confidence: 'high' },
    { id: 'ev-demo-skip', type: 'not_examinable', material_id: M('week03_lecture_transcript.txt'), location: `2026-09-23 第 ${para('not examinable')} 段`, quote: 'The proof on slide 12 that join is associative is not examinable, but you need to know how to use the result', target: 'slide 12 连接结合律的证明', boundary: '只排除证明；"可以按任意顺序连接多表"这一结论仍要会用', confidence: 'high' },
    { id: 'ev-demo-fix', type: 'correction', material_id: M('week03_lecture_transcript.txt'), location: `2026-09-23 第 ${para('correction')} 段`, quote: 'WHERE filters rows before grouping, HAVING filters groups after aggregation.', target: 'slide 8 WHERE / HAVING 写反', confidence: 'high' },
    { id: 'ev-demo-rows', type: 'exam_hint', material_id: M('week03_lecture_transcript.txt'), location: `2026-09-23 第 ${para('how many rows')} 段`, quote: 'A very common exam question is: how many rows does this join return?', target: '3.2 LEFT JOIN 行数', confidence: 'high' },
    { id: 'ev-demo-fmt', type: 'exam_format', material_id: M('DEMO-SQL_course_outline.txt'), location: 'p.1', quote: 'Final exam: 60%. 2 hours, closed book. You will write SQL queries by hand', target: '期末形式', confidence: 'high' },
  ];
  const ctxMats = Object.values(byName);
  for (const e of ev) e.quote_found = quoteFound(e.quote, norm(materialText(ctxMats.find((m) => m.id === e.material_id))));
  await writeJSON(cid, { items: ev, coverage: [{ week_or_chapter: 'Week 3', has_transcript: true, has_annotations: false, material_ids: [M('week03_lecture_transcript.txt')] }, { week_or_chapter: 'Week 1–2, 4', has_transcript: false, has_annotations: false, material_ids: [] }] }, 'evidence.json');

  await writeJSON(cid, { primary_profile: 'database_sql', secondary_profiles: [], ratios: [{ profile: 'database_sql', ratio: 1 }], chapter_profiles: [], rationale: { exam_types: '手写 SQL、判断结果行数', material_forms: 'slides + 转录 + 样例数据库', likely_stuck_points: 'JOIN 行数、WHERE vs HAVING、NULL 与 COUNT' }, recommended_blocks: ['code', 'table', 'example'], recommended_widgets: ['sql_sandbox', 'sql_steps', 'join_match'] }, 'profile.json');

  await writeJSON(cid, {
    assessment: [
      { name: 'Final exam', weight: '60%', format: '闭卷，手写 SQL，2 小时', timing: '期末', hurdle: '期末需达到 40%' },
      { name: 'Labs', weight: '20%', format: '每周 lab', timing: 'Week 2–9' },
      { name: 'Assignment 1', weight: '20%', format: '提交 .sql', timing: 'Week 7' },
    ],
    papers: [{ year: '2025', material_id: M('final_exam_2025.txt'), duration: '2 小时', total_marks: '40', questions: [
      { no: 'Q1(a)', marks: 6, type: '写查询', chapter_refs: ['ch03'], topics: ['LEFT JOIN', 'COUNT', 'GROUP BY'] },
      { no: 'Q1(b)', marks: 4, type: '写查询', chapter_refs: ['ch03'], topics: ['GROUP BY', 'HAVING'] },
      { no: 'Q2', marks: 4, type: '判断结果行数', chapter_refs: ['ch03'], topics: ['LEFT JOIN'] },
    ] }],
    marks_by_chapter: [{ chapter_ref: 'ch03 连接与分组', marks: 14 }],
    patterns: ['"列出每个 X 及其 Y 的数量，没有 Y 的也要显示 0" → LEFT JOIN + COUNT(右表主键) + GROUP BY', '"有多少行" → 逐行数匹配，LEFT JOIN 不丢左表行'],
    key_topic_judgement: [
      { claim: 'GROUP BY / HAVING 是重点：老师原话"每年期末都考"，且 2025 真题 Q1 两问都用到。', evidence_ids: ['ev-demo-key'], is_inference: false },
      { claim: '只有一份往年试卷，分值分布的代表性有限。', evidence_ids: [], is_inference: true },
    ],
    priority: [{ level: 'highest', chapters: ['ch03 连接与分组'], reason: '老师强调 + 真题 14/40 分' }, { level: 'not_examinable', chapters: ['slide 12 连接结合律的证明（只排除证明）'], reason: '老师原话 2026-09-23' }],
    caveats: ['示例课程的资料均为虚构，仅用于演示软件功能。'],
  }, 'exam.json');

  await writeJSON(cid, {
    toc_basis: '按 Week 3 slides 的编号组织（示例只包含一章）', questions_for_user: [], not_doing: ['不提供 Assignment 1 的答案（当期作业）'], confirmed: true, at: new Date().toISOString(),
    chapters: [{ id: 'ch03', number: '3', title: '连接与分组', title_exam_lang: 'Joins and Grouping', group: '查询基础', sources: [{ material_id: M('week03_slides_joins_grouping.txt'), pages: '1-9' }, { material_id: M('week03_lecture_transcript.txt'), pages: '' }], week: 'Week 3', weight: 3, profiles: ['database_sql'], focus: 'JOIN 行数、执行顺序、WHERE vs HAVING、COUNT 与 NULL',
      widgets: [
        { widget: 'join_match', stuck_point: 'JOIN 结果行数想不清', interaction: '逐行匹配', default_data: '样例库 employees / departments' },
        { widget: 'sql_steps', stuck_point: '书写顺序 ≠ 执行顺序', interaction: '逐步看中间表', default_data: '真题 Q1(b)' },
        { widget: 'sql_sandbox', stuck_point: '想自己试', interaction: '改查询立即看结果', default_data: '样例库' },
      ] }],
  }, 'plan.json');

  const chapter = demoChapter(M);
  const ctx = await loadCtx(cid);
  const { chapter: verified, report } = await verifyChapter(ctx, chapter);
  await writeJSON(cid, verified, 'chapters', 'ch03.json');
  await writeJSON(cid, report, 'verify', 'ch03.json');
  await saveCourse({ ...course, coverage_note: '转录覆盖 Week 3；其余周没有转录，因此不标"不考"。' });
  if (!quiet) console.log(`示例课程已导入：${cid}（校验：${report.errors} 个错误，${report.warnings} 个警告）`);
  return { courseId: cid, report };
}

const P = (rich_text) => ({ type: 'paragraph', rich_text });
const SQL = (source, annotations = []) => ({ type: 'code', lang: 'sql', source, runnable: true, annotations });

function demoChapter(M) {
  const slides = M('week03_slides_joins_grouping.txt');
  return {
    id: 'ch03', number: '3', title: '连接与分组', title_exam_lang: 'Joins and Grouping', group: '查询基础', weight: 3, week: 'Week 3', lecture_dates: ['2026-09-23'],
    sources: [{ material_id: slides, pages: 'slides 1–12' }, { material_id: M('week03_lecture_transcript.txt'), pages: '全文' }],
    summary: '一张表只记录一类事物，问题却常常横跨几张表。本章解决两件事：怎样把多张表的行**拼起来**（JOIN），以及怎样把行**分组后汇总**（GROUP BY / HAVING）。',
    terms: [
      { id: 'join', teaching_lang: '连接', exam_lang: 'join' }, { id: 'left-join', teaching_lang: '左外连接', exam_lang: 'left outer join' },
      { id: 'aggregate', teaching_lang: '聚合函数', exam_lang: 'aggregate function' },
    ],
    todos: [],
    blocks: [
      { type: 'heading', level: 2, id: 's3-1', number: '3.1', text: '为什么需要连接', text_exam_lang: 'Why joins' },
      { type: 'box', kind: 'intuition', body: [P('员工表里只存了部门编号 `dept_id`，部门名字在另一张表里。想回答"Alice 在哪个部门"，就得拿 Alice 的 `dept_id` 去部门表里找同号的那一行——这个"按条件配对"的动作就是{{连接|join}}。')] },
      P('样例数据库有两张表：`employees(emp_id, name, dept_id, salary, manager_id)` 和 `departments(dept_id, name)`。注意 Eve 的 `dept_id` 是 NULL（还没分配部门），Legal 部门目前没有员工——这两个"落单"的行正是考试最爱考的地方。'),
      { type: 'heading', level: 3, id: 's3-1-1', number: '3.1.1', text: '内连接', text_exam_lang: 'INNER JOIN' },
      SQL('SELECT e.name AS employee, d.name AS department\nFROM employees e\nJOIN departments d ON e.dept_id = d.dept_id\nORDER BY e.emp_id;', [
        { line: 2, note: '`e` 是表别名，后面用 `e.name` 区分两张表里同名的 `name` 列' },
        { line: 3, note: '`JOIN` 默认就是 `INNER JOIN`；`ON` 写配对条件。改成 `ON e.emp_id = d.dept_id` 会得到错误的配对' },
        { line: 4, note: '不写 `ORDER BY` 时结果顺序没有保证' },
      ]),
      P('结果只有 4 行：Eve 没有部门（NULL 与任何值比较都不为真），Legal 没有员工，两者都**不出现在内连接结果中**。'),
      { type: 'widget', widget: 'join_match', fallback_text: '把员工表的每一行依次和部门表比较 dept_id，相等就输出一行。', config_json: JSON.stringify({
        title: '逐行看 INNER JOIN 如何配对', join: 'inner',
        left: { name: 'employees', columns: ['name', 'dept_id'], rows: [['Alice', 1], ['Bob', 1], ['Chen', 2], ['Dana', 2], ['Eve', null]] },
        right: { name: 'departments', columns: ['dept_id', 'name'], rows: [[1, 'Research'], [2, 'Sales'], [3, 'Legal']] },
        left_key: 'dept_id', right_key: 'dept_id' }) },
      { type: 'formula', latex: 'R \\bowtie_{\\theta} S = \\sigma_{\\theta}(R \\times S)', display: true, symbols: [
        { symbol: 'R, S', meaning: '两个关系（表）' }, { symbol: 'R \\times S', meaning: '笛卡尔积：R 的每一行和 S 的每一行都配一次，共 $|R|\\cdot|S|$ 行' },
        { symbol: '\\sigma_{\\theta}', meaning: '选择：只保留满足条件 $\\theta$ 的行' }, { symbol: '\\theta', meaning: '连接条件，例如 `e.dept_id = d.dept_id`' },
        { symbol: '\\bowtie_{\\theta}', meaning: '{{θ 连接|theta-join}}' } ] },
      { type: 'example', title: '用笛卡尔积验证"4 行"', body: [
        P('employees 有 5 行，departments 有 3 行，笛卡尔积有 $5 \\times 3 = 15$ 行。在这 15 行里只保留 `e.dept_id = d.dept_id` 的行：Alice、Bob 各配 Research，Chen、Dana 各配 Sales，Eve 的 NULL 一个都配不上，所以剩 4 行。'),
        SQL('SELECT COUNT(*) AS cross_rows FROM employees, departments;') ],
        verify: { lang: 'sql', code: 'SELECT (SELECT COUNT(*) FROM employees, departments), (SELECT COUNT(*) FROM employees e, departments d WHERE e.dept_id = d.dept_id);', expected: '[[15, 4]]' } },
      { type: 'box', kind: 'skip', title: 'slide 12：连接结合律的证明', evidence_ids: ['ev-demo-skip'], body: [P('证明不考。**结论仍要会用**：$(R \\bowtie S) \\bowtie T = R \\bowtie (S \\bowtie T)$，所以三张表可以按任意顺序连接，结果相同。')] },

      { type: 'heading', level: 2, id: 's3-2', number: '3.2', text: '左外连接', text_exam_lang: 'LEFT (OUTER) JOIN' },
      P('{{左外连接|left outer join}}保留左表的**每一行**；右边找不到配对时，右表的列全部填 NULL。'),
      SQL('SELECT e.name AS employee, d.name AS department\nFROM employees e\nLEFT JOIN departments d ON e.dept_id = d.dept_id\nORDER BY e.emp_id;', [{ line: 3, note: '只把 `JOIN` 改成 `LEFT JOIN`：Eve 回来了，department 为 NULL' }]),
      { type: 'box', kind: 'exam', title: '"这个连接返回几行？"', evidence_ids: ['ev-demo-rows'], body: [
        P('数行的方法：**逐行扫左表**，每一行的贡献 = 右表中配上的行数；LEFT JOIN 时配不上的行仍贡献 1 行。'),
        { type: 'table', header: ['左表行', '配上的右表行', '贡献'], rows: [['Alice', 'Research', '1'], ['Bob', 'Research', '1'], ['Chen', 'Sales', '1'], ['Dana', 'Sales', '1'], ['Eve (NULL)', '无', '1（补 NULL）']] },
        P('合计 5 行。这正是 2025 期末 Q2（4 分）。') ] },
      { type: 'widget', widget: 'join_match', fallback_text: 'LEFT JOIN 时，Eve 没有配对，但仍输出一行，部门列为 NULL。', config_json: JSON.stringify({
        title: '同样的数据，换成 LEFT JOIN', join: 'left',
        left: { name: 'employees', columns: ['name', 'dept_id'], rows: [['Alice', 1], ['Bob', 1], ['Chen', 2], ['Dana', 2], ['Eve', null]] },
        right: { name: 'departments', columns: ['dept_id', 'name'], rows: [[1, 'Research'], [2, 'Sales'], [3, 'Legal']] },
        left_key: 'dept_id', right_key: 'dept_id' }) },
      { type: 'table', header: ['', 'INNER JOIN', 'LEFT JOIN'], rows: [['左表配不上的行', '丢弃', '保留，右列补 NULL'], ['右表配不上的行', '丢弃', '丢弃'], ['本例行数', '4', '5']] },

      { type: 'heading', level: 2, id: 's3-3', number: '3.3', text: '查询的执行顺序', text_exam_lang: 'Logical query processing order' },
      P('SQL 的**书写顺序**是 SELECT → FROM → WHERE → GROUP BY → HAVING → ORDER BY，但数据库的**逻辑执行顺序**是 FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT（slide 6）。很多"为什么这里不能用别名""为什么 WHERE 里不能写 AVG"的问题，看执行顺序就懂了。'),
      { type: 'widget', widget: 'sql_steps', fallback_text: '先 FROM/JOIN 得到 4 行，再按部门分组，再用 HAVING 保留平均工资大于 7000 的组，最后 SELECT 输出部门名。', config_json: JSON.stringify({
        title: '逐步执行 2025 Q1(b) 的查询',
        steps: [
          { clause: 'FROM employees e JOIN departments d', sql: 'SELECT e.name AS emp, e.salary, d.dept_id, d.name AS dept FROM employees e JOIN departments d ON e.dept_id = d.dept_id ORDER BY d.dept_id, e.emp_id;', note: '先把两张表配成一张中间表（4 行，Eve 和 Legal 不在）。' },
          { clause: 'GROUP BY d.dept_id, d.name', sql: 'SELECT d.dept_id, d.name AS dept, COUNT(*) AS rows_in_group, AVG(e.salary) AS avg_salary FROM employees e JOIN departments d ON e.dept_id = d.dept_id GROUP BY d.dept_id, d.name ORDER BY d.dept_id;', note: '同一部门的行合成一组；从这一步起每组只剩一行，只能输出分组列和聚合值。' },
          { clause: 'HAVING AVG(e.salary) > 7000', sql: 'SELECT d.dept_id, d.name AS dept, AVG(e.salary) AS avg_salary FROM employees e JOIN departments d ON e.dept_id = d.dept_id GROUP BY d.dept_id, d.name HAVING AVG(e.salary) > 7000;', note: 'HAVING 作用在"组"上，所以可以用 AVG。Sales 的平均 6250 被过滤掉。' },
          { clause: 'SELECT d.name', sql: 'SELECT d.name FROM employees e JOIN departments d ON e.dept_id = d.dept_id GROUP BY d.dept_id, d.name HAVING AVG(e.salary) > 7000;', note: '最后才挑选输出列。' },
        ] }) },

      { type: 'heading', level: 2, id: 's3-4', number: '3.4', text: '分组与聚合', text_exam_lang: 'GROUP BY and aggregation' },
      { type: 'box', kind: 'key', title: 'GROUP BY / HAVING', evidence_ids: ['ev-demo-key'], body: [P('老师原话：每年期末都考。2025 期末 Q1 的两问（共 10 分）都要用到。')] },
      P('{{聚合函数|aggregate function}}把一组行算成一个值：`COUNT`、`SUM`、`AVG`、`MIN`、`MAX`。`GROUP BY` 决定"一组"是什么。'),
      SQL('SELECT d.name AS department, COUNT(*) AS n, AVG(e.salary) AS avg_salary\nFROM employees e\nJOIN departments d ON e.dept_id = d.dept_id\nGROUP BY d.dept_id, d.name\nORDER BY d.name;', [
        { line: 1, note: 'SELECT 里只能出现分组列（d.name）和聚合值；直接写 e.name 在标准 SQL 中是错误' },
        { line: 4, note: '按 dept_id 分组更稳妥（名字可能重复）；同时把 d.name 放进 GROUP BY 才能在 SELECT 里输出它' } ]),
      { type: 'example', title: 'Research 的平均工资', body: [P('Research 有 Alice 9000、Bob 7000，平均 $\\frac{9000 + 7000}{2} = 8000$；Sales 有 Chen 6000、Dana 6500，平均 $\\frac{6000+6500}{2} = 6250$。所以只有 Research 满足"平均工资 > 7000"。')],
        verify: { lang: 'sql', code: "SELECT AVG(salary) FROM employees WHERE dept_id = 1 UNION ALL SELECT AVG(salary) FROM employees WHERE dept_id = 2;", expected: '[[8000], [6250]]' } },
      { type: 'heading', level: 3, id: 's3-4-1', number: '3.4.1', text: 'WHERE 与 HAVING', text_exam_lang: 'WHERE vs HAVING' },
      { type: 'box', kind: 'correction', title: 'slide 8 写反了', evidence_ids: ['ev-demo-fix'], body: [
        P('slide 8 写作：“HAVING filters rows before grouping. WHERE filters groups after aggregation.”'),
        P('**正确应为**：WHERE 在分组**之前**过滤行，HAVING 在聚合**之后**过滤组。理由：执行顺序是 WHERE → GROUP BY → HAVING；老师在 2026-09-23 课上也当场更正了。') ] },
      { type: 'table', header: ['', 'WHERE', 'HAVING'], rows: [['作用对象', '单行', '分组'], ['执行时机', 'GROUP BY 之前', 'GROUP BY 之后'], ['能否用聚合函数', '不能', '能'], ['例子', '`WHERE salary > 6000`', '`HAVING AVG(salary) > 7000`']] },
      { type: 'heading', level: 3, id: 's3-4-2', number: '3.4.2', text: 'COUNT(*) 与 COUNT(列)', text_exam_lang: 'COUNT(*) vs COUNT(column)' },
      { type: 'box', kind: 'pitfall', title: 'LEFT JOIN 之后数人数', body: [
        P('`COUNT(*)` 数**行**；`COUNT(e.emp_id)` 只数 emp_id **非 NULL** 的行。Legal 没有员工，LEFT JOIN 后仍有 1 行（员工列全是 NULL），所以 `COUNT(*)` 得 1、`COUNT(e.emp_id)` 得 0——题目要的是 0。'),
        SQL('SELECT d.name, COUNT(*) AS count_star, COUNT(e.emp_id) AS count_emp\nFROM departments d\nLEFT JOIN employees e ON e.dept_id = d.dept_id\nGROUP BY d.dept_id, d.name\nORDER BY d.name;') ] },
      { type: 'widget', widget: 'sql_sandbox', fallback_text: '可在浏览器中运行 SQL 查询样例数据库。', config_json: JSON.stringify({ title: '自己试一试', initial_query: 'SELECT d.name, COUNT(e.emp_id) AS n\nFROM departments d\nLEFT JOIN employees e ON e.dept_id = d.dept_id\nGROUP BY d.dept_id, d.name;' }) },
      { type: 'box', kind: 'template', title: '"每个 X 的 Y 数量（没有的显示 0）"', body: [{ type: 'list', ordered: true, items: [
        '`FROM X LEFT JOIN Y ON …`——X 放左边，保证每个 X 都在',
        '`GROUP BY X 的主键, X 的显示列`',
        '`COUNT(Y 的主键)`——不要用 `COUNT(*)`',
        '英文作答句式：*"A LEFT JOIN is used so that departments without employees are retained; COUNT(e.emp_id) ignores the NULLs introduced by the outer join, giving 0."*' ] }] },

      { type: 'heading', level: 2, id: 's3-ex', number: '3.5', text: '真题', text_exam_lang: 'Past exam questions' },
      { type: 'exercise', id: 'ex-2025-q1', title: '2025 期末 Question 1', source: 'final_exam_2025 · 10 分', stem: [P('Schema：`employees(emp_id, name, dept_id, salary, manager_id)`，`departments(dept_id, name)`。')],
        parts: [
          { label: 'a', question: [P('[6 分] 列出每个部门名及其员工人数，没有员工的部门显示 0，按部门名排序。')],
            solution: [SQL('SELECT d.name, COUNT(e.emp_id) AS num_employees\nFROM departments d\nLEFT JOIN employees e ON e.dept_id = d.dept_id\nGROUP BY d.dept_id, d.name\nORDER BY d.name;'), P('得分点：LEFT JOIN 方向正确（部门在左）；`COUNT(e.emp_id)` 而不是 `COUNT(*)`；GROUP BY 包含输出的 d.name；ORDER BY。')],
            verify: { lang: 'sql', code: 'SELECT d.name, COUNT(e.emp_id) FROM departments d LEFT JOIN employees e ON e.dept_id = d.dept_id GROUP BY d.dept_id, d.name ORDER BY d.name;', expected: '[["Legal",0],["Research",2],["Sales",2]]' } },
          { label: 'b', question: [P('[4 分] 找出平均工资大于 7000 的部门名。')],
            solution: [SQL('SELECT d.name\nFROM departments d\nJOIN employees e ON e.dept_id = d.dept_id\nGROUP BY d.dept_id, d.name\nHAVING AVG(e.salary) > 7000;'), P('得分点：条件写在 HAVING（写在 WHERE 会报错）；结果只有 Research（平均 8000）。')],
            verify: { lang: 'sql', code: 'SELECT d.name FROM departments d JOIN employees e ON e.dept_id = d.dept_id GROUP BY d.dept_id, d.name HAVING AVG(e.salary) > 7000;', expected: '[["Research"]]' } },
        ] },
      { type: 'exercise', id: 'ex-2025-q2', title: '2025 期末 Question 2', source: 'final_exam_2025 · 4 分', stem: [P('`SELECT * FROM employees e LEFT JOIN departments d ON e.dept_id = d.dept_id` 在样例数据上返回几行？说明理由。')],
        parts: [{ label: 'a', question: [P('行数与理由。')], solution: [P('**5 行**。LEFT JOIN 保留左表 employees 的全部 5 行：Alice、Bob、Chen、Dana 各配上 1 个部门，Eve 的 dept_id 为 NULL 配不上，仍输出 1 行且部门列为 NULL。Legal 在右表、没有员工，LEFT JOIN 不保留右表落单行，所以不出现。')],
          verify: { lang: 'sql', code: 'SELECT COUNT(*) FROM employees e LEFT JOIN departments d ON e.dept_id = d.dept_id;', expected: '[[5]]' } }] },

      { type: 'quick_ref', rows: [
        { concept: 'INNER JOIN', content: '只保留两边都配上的行' },
        { concept: 'LEFT JOIN', content: '保留左表全部行，配不上补 NULL' },
        { concept: 'θ 连接', content: '$R \\bowtie_{\\theta} S = \\sigma_{\\theta}(R \\times S)$' },
        { concept: '执行顺序', content: 'FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT' },
        { concept: 'WHERE vs HAVING', content: 'WHERE 过滤行（分组前，不能用聚合）；HAVING 过滤组（分组后）' },
        { concept: 'COUNT', content: '`COUNT(*)` 数行；`COUNT(col)` 数非 NULL 值' },
      ] },
    ],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(path.join(ROOT, 'scripts', 'seed-demo.js'))) {
  seedDemo().catch((e) => { console.error(e); process.exit(1); });
}
