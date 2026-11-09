// S7 自动校验（不依赖模型自觉）。对应 02 文档第 5 节"质量校验清单"的自动部分。
// 输出：修正后的章节（不可信内容被降级 / 移除）+ 校验报告。
import katex from 'katex';
import { runSQL, runJS, deepClose } from './sandbox/index.js';
import { WidgetConfigs } from './schemas.js';
import { parseRich, mathOf, plainOf } from '../shared/richtext.js';
import { compile } from '../shared/expr.js';

// ---------- 文本归一化与原文比对 ----------
export function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 引文是否真实出现在资料中（允许用 … / ... 省略中间部分）。 */
export function quoteFound(quote, haystackNorm) {
  const pieces = String(quote).split(/\.{3}|…/).map(norm).filter((p) => p.length >= 4);
  if (!pieces.length) return false;
  return pieces.every((p) => haystackNorm.includes(p));
}

export function materialText(m) {
  return (m.pages || []).map((p) => p.text).join('\n');
}

// ---------- 遍历 ----------
function children(b) {
  if (b.type === 'example' || b.type === 'box') return [b.body];
  if (b.type === 'exercise') return [b.stem, ...b.parts.flatMap((p) => [p.question, p.solution])];
  return [];
}

function* walk(blocks, pathPrefix = '') {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const here = `${pathPrefix}${i}`;
    yield [b, here];
    for (const arr of children(b)) yield* walk(arr, `${here}.`);
  }
}

function richStrings(b) {
  switch (b.type) {
    case 'paragraph': return [b.rich_text];
    case 'list': return b.items;
    case 'quick_ref': return b.rows.map((r) => r.content);
    case 'table': return b.rows.flat().concat(b.header);
    case 'formula': return b.symbols.flatMap((s) => [s.symbol, s.meaning]);
    default: return [];
  }
}

function katexOK(tex, display) {
  try {
    katex.renderToString(tex, { throwOnError: true, displayMode: display, strict: 'ignore', trust: false, maxExpand: 1000, maxSize: 20 });
    return null;
  } catch (e) {
    return String(e.message).slice(0, 200);
  }
}

function parseExpected(s) {
  if (s === undefined || s === null || s === '') return undefined;
  try { return JSON.parse(s); } catch { return s; }
}

function shingles(text, n = 6) {
  const w = String(text || '').normalize('NFKC').toLowerCase().match(/[a-z0-9]+|[一-鿿]/g) || [];
  const set = new Set();
  for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(' '));
  return set;
}

function containment(a, bSet) {
  const s = shingles(a);
  if (s.size < 3) return 0;
  let hit = 0;
  for (const x of s) if (bSet.has(x)) hit++;
  return hit / s.size;
}

/**
 * @param {object} ctx { course, materials, evidence, datasetSql }
 * @param {object} chapter
 */
export async function verifyChapter(ctx, chapter) {
  const ch = structuredClone(chapter);
  const issues = [];
  const stats = { numeric: [0, 0, 0], sql: [0, 0], evidence: [0, 0], katex: [0, 0], widgets: [0, 0], structure: [0, 0], integrity: [0, 0] };
  const issue = (check, where, problem, severity = 'error') => issues.push({ check, where, problem, severity });
  const matById = new Map(ctx.materials.map((m) => [m.id, m]));
  const evById = new Map(ctx.evidence.map((e) => [e.id, e]));
  const setup = ctx.datasetSql || '';

  // 1) 数值 / 代码 / 查询执行核对
  for (const [b, where] of walk(ch.blocks)) {
    const targets = b.type === 'example' ? [[b, where]] : b.type === 'exercise' ? b.parts.map((p, k) => [p, `${where}.part${k}`]) : [];
    for (const [t, w] of targets) {
      if (!t.verify || t.verify.lang === 'none') { if (t.verify) { t.verified = 'unverified'; stats.numeric[2]++; } continue; }
      const r = t.verify.lang === 'sql' ? await runSQL(setup, t.verify.code) : await runJS(t.verify.code);
      const got = !r.ok ? undefined : t.verify.lang === 'sql' ? r.rows : r.value;
      const exp = parseExpected(t.verify.expected);
      if (r.ok && (exp === undefined || deepClose(got, exp))) {
        t.verified = 'pass';
        t.verify_result = got;
        stats.numeric[0]++;
      } else {
        t.verified = 'fail';
        t.verify_result = r.ok ? got : null;
        stats.numeric[1]++;
        issue('numeric', w, r.ok ? `执行结果 ${JSON.stringify(got).slice(0, 200)} 与文中 ${String(t.verify.expected).slice(0, 200)} 不一致` : `执行失败：${r.error}`);
      }
    }
    if (b.type === 'code' && /^(sql|sqlite)$/i.test(b.lang) && b.runnable) {
      const r = await runSQL(setup, b.source);
      if (r.ok) {
        b.result = { columns: r.columns, rows: r.rows, truncated: r.truncated };
        stats.sql[0]++;
        const exp = parseExpected(b.expected_output);
        if (Array.isArray(exp) && !deepClose(r.rows, exp)) issue('sql', where, '文中给出的结果与真实执行结果不同，已用执行结果替换', 'warn');
        delete b.expected_output; // 结果表只取真实执行输出
      } else {
        b.runnable = false;
        b.verified = 'fail';
        stats.sql[1]++;
        issue('sql', where, `SQL 执行失败：${r.error}`);
      }
    } else if (b.type === 'code' && b.runnable) {
      // 非 SQL 代码不在本机执行
      b.runnable = false;
      b.verified = 'unverified';
    }
  }

  // 2) 证据可追溯：key / exam / skip 必须引用有效证据
  const unwrap = [];
  for (const [b, where] of walk(ch.blocks)) {
    if (b.type !== 'box' || !['key', 'exam', 'skip'].includes(b.kind)) continue;
    const valid = (b.evidence_ids || []).filter((id) => evById.get(id)?.quote_found);
    b.evidence_ids = valid;
    if (valid.length) { stats.evidence[0]++; continue; }
    stats.evidence[1]++;
    if (b.kind === 'skip') {
      unwrap.push(b);
      issue('evidence', where, '"不考"标记没有可追溯的老师原话 / 资料自注，已移除标记（内容保留）');
    } else if (!b.is_inference) {
      b.is_inference = true;
      issue('evidence', where, `"${b.kind === 'key' ? '重点' : '真题'}"标记缺少有效证据，已降级为推断`, 'warn');
    }
  }
  if (unwrap.length) {
    const fix = (arr) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        if (unwrap.includes(arr[i])) arr.splice(i, 1, ...arr[i].body);
        else children(arr[i]).forEach(fix);
      }
    };
    fix(ch.blocks);
  }

  // 3) 渲染：KaTeX、组件配置、图片引用
  for (const [b, where] of walk(ch.blocks)) {
    if (b.type === 'formula') {
      const err = katexOK(b.latex, true);
      if (err) { stats.katex[1]++; issue('render', where, `公式无法渲染：${err}`); } else stats.katex[0]++;
    }
    for (const s of richStrings(b)) {
      for (const m of mathOf(s)) {
        const err = katexOK(m, false);
        if (err) { stats.katex[1]++; issue('render', where, `行内公式无法渲染：${err}`); } else stats.katex[0]++;
      }
    }
    if (b.type === 'widget') {
      let cfg;
      const problem = (() => {
        try { cfg = JSON.parse(b.config_json); } catch { return 'config_json 不是合法 JSON'; }
        const r = WidgetConfigs[b.widget]?.safeParse(cfg);
        if (!r?.success) return `组件配置不合法：${r?.error?.issues?.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
        cfg = r.data;
        try {
          if (b.widget === 'calc') cfg.outputs.forEach((o) => compile(o.expr));
          if (b.widget === 'function_plot') cfg.curves.forEach((c) => compile(c.expr));
        } catch (e) { return `公式表达式不合法：${e.message}`; }
        return null;
      })();
      if (problem) {
        stats.widgets[1]++;
        issue('widget', where, `${problem}；已替换为文字说明`);
        const fallback = b.fallback_text || '';
        Object.keys(b).forEach((k) => delete b[k]);
        Object.assign(b, { type: 'paragraph', rich_text: `（交互组件未通过校验，以下为文字说明）${fallback}` });
        continue;
      }
      if (b.widget === 'sql_steps') {
        for (const [k, st] of cfg.steps.entries()) {
          const r = await runSQL(setup, st.sql);
          if (!r.ok) { issue('widget', where, `第 ${k + 1} 步 SQL 执行失败：${r.error}`); stats.widgets[1]++; }
        }
      }
      if (b.widget === 'sql_sandbox' && cfg.initial_query) {
        const r = await runSQL(setup, cfg.initial_query);
        if (!r.ok) issue('widget', where, `沙箱默认查询执行失败：${r.error}`, 'warn');
      }
      b.config = cfg;
      delete b.config_json;
      stats.widgets[0]++;
    }
    if (b.type === 'figure') {
      const m = matById.get(b.material_id);
      if (!m || !m.pages?.some((p) => p.n === b.page)) issue('render', where, '图片引用的资料 / 页码不存在');
    }
  }

  // 4) 结构完整
  const has = (t) => ch.blocks.some((b) => b.type === t);
  if (!has('quick_ref')) { stats.structure[1]++; issue('structure', 'chapter', '缺少本章速查表 (quick_ref)'); } else stats.structure[0]++;
  for (const [b, where] of walk(ch.blocks)) {
    if (b.type === 'exercise') {
      b.parts.forEach((p, k) => {
        const ok = p.solution.length > 0;
        stats.structure[ok ? 0 : 1]++;
        if (!ok) issue('structure', `${where}.part${k}`, `小题 (${p.label}) 没有解答`);
      });
    }
    if (b.type === 'formula' && b.display && b.symbols.length === 0) issue('structure', where, '公式没有符号说明', 'warn');
    if (b.type === 'heading' && ctx.course.exam_language !== ctx.course.teaching_language && !b.text_exam_lang) issue('structure', where, '小节标题缺少考试语言', 'warn');
  }
  for (const t of ch.terms || []) {
    if (!t.exam_lang) issue('structure', `term:${t.id}`, `术语"${t.teaching_lang}"缺少考试语言原词`, 'warn');
  }

  // 5) 学术诚信：与当期作业比对，疑似泄露的题目移除解答
  const assignments = ctx.materials.filter((m) => m.no_solutions);
  if (assignments.length) {
    const sh = new Set();
    assignments.forEach((m) => shingles(materialText(m)).forEach((x) => sh.add(x)));
    for (const [b, where] of walk(ch.blocks)) {
      if (b.type !== 'exercise') continue;
      const stem = [b.title, ...b.stem.map((x) => JSON.stringify(x)), ...b.parts.map((p) => JSON.stringify(p.question))].join(' ');
      const c = containment(stem, sh);
      if (c > 0.35) {
        stats.integrity[1]++;
        b.parts.forEach((p) => { p.solution = [{ type: 'paragraph', rich_text: '该题与当期作业高度相似，按学术诚信规则不提供解答。' }]; delete p.verify; });
        b.integrity_flag = +c.toFixed(2);
        issue('integrity', where, `题目与当期作业相似度 ${(c * 100).toFixed(0)}%，已移除解答`);
      } else stats.integrity[0]++;
    }
  }

  // 6) 原文一致性抽查：定义 / 结论框里的英文原句是否能在本章资料中找到（只报告，不修改）
  const srcNorm = norm((ch.sources || []).map((s) => matById.get(s.material_id)).filter(Boolean).map(materialText).join('\n'));
  if (srcNorm) {
    for (const [b, where] of walk(ch.blocks)) {
      if (b.type !== 'box' || !['definition', 'result'].includes(b.kind)) continue;
      const quoted = b.body.flatMap(richStrings).join(' ').match(/[“"]([^”"]{25,300})[”"]/g) || [];
      for (const q of quoted) if (!quoteFound(q.slice(1, -1), srcNorm)) issue('source', where, `引号内的原文在本章资料中找不到：${q.slice(0, 80)}`, 'warn');
    }
  }

  const errors = issues.filter((i) => i.severity === 'error').length;
  return {
    chapter: ch,
    report: { at: new Date().toISOString(), errors, warnings: issues.length - errors, stats, issues },
  };
}

/** 搜索用的纯文本。 */
export function chapterPlainText(ch) {
  const out = [];
  for (const [b] of walk(ch.blocks)) {
    if (b.type === 'heading') out.push(`${b.text} ${b.text_exam_lang}`);
    for (const s of richStrings(b)) out.push(plainOf(s));
    if (b.type === 'formula') out.push(b.latex);
    if (b.type === 'code') out.push(b.source);
    if (b.title) out.push(b.title);
  }
  return out.join('\n');
}

export { walk, parseRich };
