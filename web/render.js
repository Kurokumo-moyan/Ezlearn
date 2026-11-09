// 内容块渲染器。所有文本经 textContent 输出；公式交给 KaTeX（trust:false，禁止 \href 等）。
import { h, frag } from './dom.js';
import { parseRich } from '/shared/richtext.js';
import { mountWidget } from './widgets.js';

const KATEX_OPTS = { throwOnError: false, strict: 'ignore', trust: false, maxExpand: 1000, maxSize: 20, output: 'htmlAndMathml' };

export function math(tex, display = false) {
  const el = h(display ? 'div' : 'span', { class: display ? 'katex-wrap' : null });
  if (window.katex) {
    try { window.katex.render(String(tex), el, { ...KATEX_OPTS, displayMode: display }); return el; } catch { /* fallthrough */ }
  }
  el.className = 'math-err';
  el.textContent = display ? `$$${tex}$$` : `$${tex}$`;
  return el;
}

export function rich(src) {
  const out = document.createDocumentFragment();
  const emit = (toks, parent) => {
    for (const t of toks) {
      if (t.t === 'text') parent.add(document.createTextNode(t.v));
      else if (t.t === 'math') parent.add(math(t.v));
      else if (t.t === 'code') parent.add(h('code', null, t.v));
      else if (t.t === 'bold') { const b = h('strong'); emit(t.children, b); parent.add(b); }
      else if (t.t === 'term') parent.add(h('span', { class: 'term' }, t.teach), t.exam ? h('span', { class: 'en' }, t.exam) : null);
    }
  };
  emit(parseRich(src), out);
  return out;
}

/** 符号说明里的 symbol：带 $ 的按富文本，含反斜杠的按 LaTeX，否则按纯文本。 */
function symbol(s) {
  if (/\$/.test(s)) return rich(s);
  if (/\\|[_^]/.test(s)) return math(s);
  return document.createTextNode(s);
}

const BOX_TITLE = {
  key: '★ 重点', exam: '✎ 真题关联', skip: '⊘ 不考 / 可略', definition: '定义 (Definition)', result: '结论', pitfall: '易错点',
  intuition: '直觉', template: '答题模板', extension: '拓展（课程外内容）', correction: '资料勘误',
};

function vstatus(t) {
  if (!t.verify && !t.verified) return null;
  const s = t.verified || 'unverified';
  const lang = t.verify?.lang && t.verify.lang !== 'none' ? `（${t.verify.lang} 沙箱）` : '';
  const label = s === 'pass' ? `✓ 已执行核对${lang}` : s === 'fail' ? `✗ 核对未通过${lang}` : '未经执行验证';
  return h('div', { class: 'vstat' }, h('span', { class: `badge ${s === 'pass' ? 'pass' : s === 'fail' ? 'fail' : 'unv'}` }, label));
}

function resultTable(columns, rows, truncated) {
  return h('div', { class: 'tbl' }, h('table', null,
    h('thead', null, h('tr', null, columns.map((c) => h('th', null, c)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((v) => (v === null ? h('td', { class: 'null' }, 'NULL') : h('td', null, String(v))))))),
  ), truncated ? h('div', { class: 'muted small' }, '（仅显示前若干行）') : null);
}

export function renderBlocks(blocks, ctx) {
  return frag((blocks || []).map((b) => renderBlock(b, ctx)));
}

export function renderBlock(b, ctx) {
  try {
    switch (b.type) {
      case 'heading': {
        const tag = b.level === 3 ? 'h3' : 'h2';
        return h(tag, { id: anchor(b.id) }, b.number ? `${b.number} ` : '', b.text, b.text_exam_lang ? h('span', { class: 'en' }, b.text_exam_lang) : null);
      }
      case 'paragraph': return h('p', null, rich(b.rich_text));
      case 'list': return h(b.ordered ? 'ol' : 'ul', null, (b.items || []).map((it) => h('li', null, rich(it))));
      case 'formula':
        return h('div', { class: 'formula' }, math(b.latex, b.display !== false),
          b.symbols?.length ? h('dl', { class: 'vars' }, b.symbols.map((s) => [h('dt', null, symbol(s.symbol)), h('dd', null, rich(s.meaning))])) : null);
      case 'table':
        return h('div', { class: 'tbl' }, h('table', null,
          b.caption ? h('caption', { class: 'muted small' }, b.caption) : null,
          h('thead', null, h('tr', null, (b.header || []).map((c) => h('th', null, rich(c))))),
          h('tbody', null, (b.rows || []).map((r) => h('tr', null, r.map((c) => h('td', null, rich(c)))))),
        ));
      case 'code':
        return frag(
          h('pre', null, h('code', null, b.source)),
          b.annotations?.length ? h('ul', { class: 'annot' }, b.annotations.map((a) => h('li', null, h('b', null, `L${a.line} `), rich(a.note)))) : null,
          b.result ? h('div', { class: 'result-cap' }, '执行结果（课程样例库，sql.js 真实执行）') : null,
          b.result ? resultTable(b.result.columns, b.result.rows, b.result.truncated) : null,
          b.verified === 'fail' ? h('div', { class: 'vstat' }, h('span', { class: 'badge fail' }, '✗ 执行失败')) : null,
        );
      case 'figure': {
        const m = ctx.materials?.get(b.material_id);
        return h('figure', { class: 'fig' }, h('figcaption', null, '图：', rich(b.caption), h('div', { class: 'muted small' },
          `来源：${m ? m.filename : b.material_id} 第 ${b.page} 页${b.license ? ` · ${b.license}` : ''} `,
          m ? h('button', { class: 'btn', onclick: () => ctx.openMaterial?.(b.material_id, b.page) }, '查看原页') : null)));
      }
      case 'widget': return mountWidget(b, ctx);
      case 'quick_ref':
        return frag(h('h2', { id: 'quick-ref' }, '本章速查', h('span', { class: 'en' }, 'Quick reference')),
          h('div', { class: 'tbl' }, h('table', null, h('tbody', null, (b.rows || []).map((r) => h('tr', null, h('th', null, rich(r.concept)), h('td', null, rich(r.content))))))));
      case 'example':
        return h('details', { class: 'num' }, h('summary', null, `🔢 具体例子：${b.title || ''}`), renderBlocks(b.body, ctx), vstatus(b));
      case 'box': {
        const ev = (b.evidence_ids || []).map((id) => ctx.evidence?.get(id)).filter(Boolean);
        return h('div', { class: `box ${b.kind}` },
          h('div', { class: 'bt' }, b.title ? `${BOX_TITLE[b.kind]?.split(' ')[0] || ''} ${b.title}` : BOX_TITLE[b.kind] || b.kind,
            b.is_inference ? h('span', { class: 'badge inf', title: '没有直接证据，这是推断' }, '推断') : null,
            ev.map((e, i) => h('button', { class: `badge ${b.kind === 'skip' ? 'skip' : b.kind === 'exam' ? 'exam' : 'key'}`, title: '查看证据原文', onclick: () => ctx.showEvidence?.(e) }, `证据 ${i + 1}`))),
          renderBlocks(b.body, ctx));
      }
      case 'exercise':
        return h('div', { class: 'exq', id: anchor(b.id) },
          h('div', { class: 'exh' }, b.title, b.source ? h('small', null, b.source) : null, b.integrity_flag ? h('span', { class: 'badge fail' }, '与当期作业相似，未提供解答') : null),
          renderBlocks(b.stem, ctx),
          (b.parts || []).map((p) => h('div', { class: 'part' },
            h('div', { class: 'pl' }, `(${p.label})`), renderBlocks(p.question, ctx),
            h('details', { class: 'sol' }, h('summary', null, `查看 (${p.label}) 解答`), h('div', { class: 'solb' }, renderBlocks(p.solution, ctx), vstatus(p))))));
      default:
        return h('p', { class: 'muted' }, `（未知内容块：${String(b.type)}）`);
    }
  } catch (e) {
    console.error(e);
    return h('p', { class: 'err' }, '（此内容块渲染失败）');
  }
}

export function anchor(id) {
  return `sec-${String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60)}`;
}
