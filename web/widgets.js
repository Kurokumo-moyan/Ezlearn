// 交互组件注册表。配置已在服务端校验（schemas.js WidgetConfigs），这里再做防御式检查。
// 公式只经 shared/expr.js 安全解析；颜色全部来自 CSS 变量。
import { h, clear } from './dom.js';
import { compile } from '/shared/expr.js';
import { SqlEngine, sharedEngine } from './sqlengine.js';

const REG = {};
const reg = (name, fn) => { REG[name] = fn; };

export function mountWidget(b, ctx) {
  const el = h('div', { class: 'wg' });
  const fn = REG[b.widget];
  const cfg = b.config;
  if (!fn || !cfg || typeof cfg !== 'object') {
    el.add(h('p', { class: 'muted' }, b.fallback_text || '（交互组件不可用）'));
    return el;
  }
  if (cfg.title) el.add(h('div', { class: 'wt' }, `▶ ${cfg.title}`));
  try { fn(el, cfg, ctx); } catch (e) {
    console.error(e);
    el.add(h('p', { class: 'err' }, '组件初始化失败：'), h('p', null, b.fallback_text || ''));
  }
  return el;
}

const arr = (x) => (Array.isArray(x) ? x : []);
const fmt = (v, d = 2) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(d)).toString() : String(v));

function table(columns, rows, cellClass) {
  return h('div', { class: 'tbl' }, h('table', null,
    h('thead', null, h('tr', null, arr(columns).map((c) => h('th', null, String(c))))),
    h('tbody', null, arr(rows).map((r, i) => h('tr', null, arr(r).map((v, j) => h('td', { class: (cellClass?.(i, j, v) || '') + (v === null ? ' null' : '') }, v === null ? 'NULL' : String(v))))))));
}

// ---------------- SQL 沙箱 ----------------
reg('sql_sandbox', (el, cfg, ctx) => {
  const eng = new SqlEngine(ctx.courseId);
  const ta = h('textarea', { rows: 6, spellcheck: 'false', 'aria-label': 'SQL' });
  ta.value = String(cfg.initial_query || 'SELECT 1;');
  const out = h('div');
  const status = h('span', { class: 'muted small' });
  const run = async () => {
    status.textContent = '执行中…';
    clear(out);
    try {
      const t0 = performance.now();
      const r = await eng.exec(ta.value);
      out.add(r.columns.length ? table(r.columns, r.values.slice(0, 200)) : h('p', { class: 'muted' }, '语句已执行（无结果集）'));
      status.textContent = `${r.values.length} 行 · ${(performance.now() - t0).toFixed(0)} ms`;
    } catch (e) {
      out.add(h('p', { class: 'err' }, String(e.message)));
      status.textContent = '';
    }
  };
  ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });
  el.add(ta, h('div', { class: 'controls' },
    h('button', { class: 'btn primary', onclick: run }, '运行 (Ctrl+Enter)'),
    h('button', { class: 'btn', onclick: async () => { await eng.reset(); status.textContent = '数据库已重置'; } }, '重置数据库'),
    h('button', { class: 'btn', onclick: () => { ta.value = cfg.initial_query; } }, '恢复示例查询'), status), out,
  h('div', { class: 'muted small' }, '浏览器内 SQLite（sql.js），预载课程样例数据库；修改只影响本页面。'));
});

// ---------------- SQL 执行顺序（每步真实执行） ----------------
reg('sql_steps', (el, cfg, ctx) => {
  const steps = arr(cfg.steps);
  const eng = sharedEngine(ctx.courseId);
  const bar = h('div', { class: 'steps' });
  const body = h('div');
  let cur = 0;
  const show = async (i) => {
    cur = i;
    [...bar.children].forEach((b, k) => b.classList.toggle('on', k === i));
    clear(body);
    const st = steps[i];
    body.add(h('div', { class: 'note' }, h('b', null, `第 ${i + 1} 步：${st.clause}`)), h('p', { class: 'note' }, st.note), h('pre', null, h('code', null, st.sql)));
    const box = h('div', null, h('span', { class: 'muted small' }, '执行中…'));
    body.add(box);
    try {
      const r = await eng.exec(st.sql);
      clear(box).add(h('div', { class: 'result-cap' }, `中间表：${r.values.length} 行`), table(r.columns, r.values.slice(0, 100)));
    } catch (e) { clear(box).add(h('p', { class: 'err' }, e.message)); }
  };
  steps.forEach((s, i) => bar.add(h('button', { class: 'btn', onclick: () => show(i) }, `${i + 1}. ${s.clause}`)));
  el.add(bar, h('div', { class: 'controls' },
    h('button', { class: 'btn', onclick: () => cur > 0 && show(cur - 1) }, '← 上一步'),
    h('button', { class: 'btn', onclick: () => cur < steps.length - 1 && show(cur + 1) }, '下一步 →')), body);
  if (steps.length) show(0);
});

// ---------------- JOIN 行匹配 ----------------
reg('join_match', (el, cfg) => {
  const L = cfg.left; const R = cfg.right;
  const li = arr(L.columns).indexOf(cfg.left_key);
  const ri = arr(R.columns).indexOf(cfg.right_key);
  if (li < 0 || ri < 0) throw new Error('join key not found');
  const outCols = [...L.columns.map((c) => `${L.name}.${c}`), ...R.columns.map((c) => `${R.name}.${c}`)];
  // 预先计算每一步：第 i 步处理左表第 i 行
  const steps = [];
  const acc = [];
  L.rows.forEach((lr, i) => {
    const matches = [];
    R.rows.forEach((rr, j) => { if (lr[li] !== null && rr[ri] !== null && String(lr[li]) === String(rr[ri])) matches.push(j); });
    const added = matches.map((j) => [...lr, ...R.rows[j]]);
    let nullFill = false;
    if (!matches.length && cfg.join === 'left') { added.push([...lr, ...R.columns.map(() => null)]); nullFill = true; }
    const start = acc.length;
    acc.push(...added);
    steps.push({ i, matches, rows: acc.slice(), newFrom: start, nullFill });
  });
  let k = -1;
  const view = h('div');
  const note = h('p', { class: 'note' });
  const render = () => {
    clear(view);
    const st = steps[k];
    view.add(h('div', { class: 'pair' },
      h('div', null, h('div', { class: 'small' }, h('b', null, L.name), '（左表）'), table(L.columns, L.rows, (i, j) => (st && i === st.i ? 'hl' : j === li ? '' : ''))),
      h('div', null, h('div', { class: 'small' }, h('b', null, R.name), '（右表）'), table(R.columns, R.rows, (i) => (st && st.matches.includes(i) ? 'hl' : '')))),
    h('div', { class: 'small' }, h('b', null, `结果（${cfg.join === 'left' ? 'LEFT JOIN' : 'INNER JOIN'} ON ${L.name}.${cfg.left_key} = ${R.name}.${cfg.right_key}）`)),
    table(outCols, st ? st.rows : [], (i, j) => (st && i >= st.newFrom ? (st.nullFill && j >= L.columns.length ? 'nullfill' : 'newrow') : '')));
    if (!st) note.textContent = '点"下一步"逐行处理左表。';
    else if (st.matches.length) note.textContent = `左表第 ${st.i + 1} 行（${cfg.left_key}=${L.rows[st.i][li]}）在右表找到 ${st.matches.length} 行匹配 → 输出 ${st.matches.length} 行。`;
    else note.textContent = cfg.join === 'left' ? `左表第 ${st.i + 1} 行没有匹配 → LEFT JOIN 仍保留它，右表各列补 NULL。` : `左表第 ${st.i + 1} 行没有匹配 → INNER JOIN 丢弃它。`;
  };
  el.add(h('div', { class: 'controls' },
    h('button', { class: 'btn', onclick: () => { if (k > -1) { k--; render(); } } }, '← 上一步'),
    h('button', { class: 'btn primary', onclick: () => { if (k < steps.length - 1) { k++; render(); } } }, '下一步 →'),
    h('button', { class: 'btn', onclick: () => { k = -1; render(); } }, '重置')), note, view);
  render();
});

// ---------------- 通用逐步演示 ----------------
reg('stepper', (el, cfg) => {
  const steps = arr(cfg.steps);
  let i = 0;
  const body = h('div');
  const range = h('input', { type: 'range', min: 0, max: steps.length - 1, step: 1, value: 0, 'aria-label': '步骤' });
  const lab = h('span', { class: 'small' });
  const render = () => {
    const st = steps[i];
    range.value = String(i);
    lab.textContent = `${i + 1} / ${steps.length}`;
    clear(body).add(h('div', { class: 'note' }, h('b', null, st.label)), h('p', { class: 'note' }, st.note));
    if (st.table) {
      const hl = new Set(arr(st.highlight).map(String));
      body.add(table(st.table.header, st.table.rows, (_r, _c, v) => (hl.has(String(v)) ? 'hl' : '')));
    }
  };
  range.addEventListener('input', () => { i = Number(range.value); render(); });
  el.add(h('div', { class: 'controls' },
    h('button', { class: 'btn', onclick: () => { if (i > 0) { i--; render(); } } }, '←'), range,
    h('button', { class: 'btn', onclick: () => { if (i < steps.length - 1) { i++; render(); } } }, '→'), lab), body);
  if (steps.length) render();
});

// ---------------- 计算器 ----------------
reg('calc', (el, cfg) => {
  const vals = {};
  const outs = arr(cfg.outputs).map((o) => ({ ...o, fn: compile(o.expr), node: h('span', { class: 'out' }) }));
  const recalc = () => outs.forEach((o) => {
    try { const v = o.fn(vals); o.node.textContent = `${fmt(v, o.digits ?? 2)}${o.unit ? ` ${o.unit}` : ''}`; } catch (e) { o.node.textContent = `错误：${e.message}`; }
  });
  const inputs = arr(cfg.inputs).map((inp) => {
    vals[inp.name] = inp.value;
    const field = h('input', { type: 'number', value: inp.value, step: inp.step ?? 'any', 'aria-label': inp.label });
    field.addEventListener('input', () => { vals[inp.name] = Number(field.value); recalc(); });
    return h('label', null, inp.label, field, inp.unit ? h('span', { class: 'muted' }, inp.unit) : null);
  });
  el.add(cfg.note ? h('p', { class: 'note' }, cfg.note) : null, h('div', { class: 'controls' }, inputs),
    h('div', { class: 'tbl' }, h('table', null, h('tbody', null, outs.map((o) => h('tr', null, h('th', null, o.label), h('td', null, o.node), h('td', { class: 'muted small' }, h('code', null, o.expr))))))));
  recalc();
});

// ---------------- SVG 绘图工具 ----------------
function plotFrame(W, H, cfg) {
  const pad = { l: 46, r: 14, t: 12, b: 34 };
  const sx = (x) => pad.l + ((x - cfg.x_min) / (cfg.x_max - cfg.x_min)) * (W - pad.l - pad.r);
  const sy = (y) => H - pad.b - ((y - cfg.y_min) / (cfg.y_max - cfg.y_min)) * (H - pad.t - pad.b);
  const svg = h('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': cfg.title || 'plot' });
  const ticks = (a, b) => { const n = 5; return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n); };
  ticks(cfg.x_min, cfg.x_max).forEach((x) => { svg.add(h('line', { class: 'plot-grid', x1: sx(x), x2: sx(x), y1: pad.t, y2: H - pad.b }), h('text', { class: 'plot-text', x: sx(x), y: H - pad.b + 14, 'text-anchor': 'middle' }, fmt(x, 2))); });
  ticks(cfg.y_min, cfg.y_max).forEach((y) => { svg.add(h('line', { class: 'plot-grid', x1: pad.l, x2: W - pad.r, y1: sy(y), y2: sy(y) }), h('text', { class: 'plot-text', x: pad.l - 6, y: sy(y), 'text-anchor': 'end', 'dominant-baseline': 'middle' }, fmt(y, 2))); });
  svg.add(h('line', { class: 'plot-axis', x1: pad.l, x2: W - pad.r, y1: H - pad.b, y2: H - pad.b }), h('line', { class: 'plot-axis', x1: pad.l, x2: pad.l, y1: pad.t, y2: H - pad.b }));
  svg.add(h('text', { class: 'plot-text', x: W - pad.r, y: H - 4, 'text-anchor': 'end' }, cfg.x_label || ''), h('text', { class: 'plot-text', x: 4, y: pad.t + 4 }, cfg.y_label || ''));
  const layer = h('g');
  svg.add(layer);
  return { svg, layer, sx, sy, clampY: (y) => Math.max(cfg.y_min - (cfg.y_max - cfg.y_min), Math.min(cfg.y_max + (cfg.y_max - cfg.y_min), y)) };
}

// ---------------- 函数图 + 参数滑块 ----------------
reg('function_plot', (el, cfg) => {
  if (!(cfg.x_max > cfg.x_min && cfg.y_max > cfg.y_min)) throw new Error('bad range');
  const vals = {};
  const curves = arr(cfg.curves).slice(0, 5).map((c) => ({ ...c, fn: compile(c.expr) }));
  const f = plotFrame(640, 360, cfg);
  const draw = () => {
    clear(f.layer);
    curves.forEach((c, k) => {
      const pts = [];
      for (let i = 0; i <= 240; i++) {
        const x = cfg.x_min + ((cfg.x_max - cfg.x_min) * i) / 240;
        let y;
        try { y = c.fn({ ...vals, x }); } catch { y = NaN; }
        if (Number.isFinite(y)) pts.push(`${f.sx(x).toFixed(1)},${f.sy(f.clampY(y)).toFixed(1)}`);
      }
      f.layer.add(h('polyline', { class: `plot-line plot-c${k}`, points: pts.join(' ') }));
    });
  };
  const controls = arr(cfg.params).map((p) => {
    vals[p.name] = p.value;
    const out = h('span', { class: 'out' }, fmt(p.value, 3));
    const r = h('input', { type: 'range', min: p.min, max: p.max, step: p.step, value: p.value, 'aria-label': p.label });
    r.addEventListener('input', () => { vals[p.name] = Number(r.value); out.textContent = fmt(vals[p.name], 3); draw(); });
    return h('label', null, p.label, r, out);
  });
  el.add(h('div', { class: 'controls' }, controls), f.svg, h('div', { class: 'legend' }, curves.map((c, k) => h('span', null, h('span', { class: `sw c${k}` }), c.label, ' ', h('code', null, c.expr)))));
  draw();
});

// ---------------- 供需 + 剩余 / 税 / 无谓损失 ----------------
reg('supply_demand', (el, cfg) => {
  const s = { da: 0, dc: 0, t: cfg.tax_per_unit || 0 };
  const box = { x_min: 0, x_max: cfg.q_max, y_min: 0, y_max: cfg.p_max, x_label: 'Q', y_label: 'P', title: cfg.title };
  const f = plotFrame(640, 380, box);
  const info = h('div', { class: 'tbl' });
  const draw = () => {
    const a = cfg.demand.intercept + s.da; const b = cfg.demand.slope;
    const c = cfg.supply.intercept + s.dc; const d = cfg.supply.slope;
    const t = s.t;
    const Q0 = Math.max(0, (a - c) / (b + d)); const P0 = a - b * Q0;
    const Qt = Math.max(0, (a - c - t) / (b + d)); const Pd = a - b * Qt; const Ps = Pd - t;
    const CS = 0.5 * (a - Pd) * Qt; const PS = 0.5 * (Ps - c) * Qt; const TR = t * Qt; const DWL = 0.5 * t * (Q0 - Qt);
    const P = (q, p) => `${f.sx(q).toFixed(1)},${f.sy(p).toFixed(1)}`;
    clear(f.layer);
    f.layer.add(
      h('polygon', { class: 'sd-cs', points: [P(0, a), P(0, Pd), P(Qt, Pd)].join(' ') }),
      h('polygon', { class: 'sd-ps', points: [P(0, Ps), P(0, c), P(Qt, Ps)].join(' ') }),
      t > 0 ? h('polygon', { class: 'sd-tax', points: [P(0, Pd), P(Qt, Pd), P(Qt, Ps), P(0, Ps)].join(' ') }) : null,
      t > 0 ? h('polygon', { class: 'sd-dwl', points: [P(Qt, Pd), P(Q0, P0), P(Qt, Ps)].join(' ') }) : null,
      h('line', { class: 'plot-line plot-c0', x1: f.sx(0), y1: f.sy(a), x2: f.sx(cfg.q_max), y2: f.sy(f.clampY(a - b * cfg.q_max)) }),
      h('line', { class: 'plot-line plot-c1', x1: f.sx(0), y1: f.sy(c), x2: f.sx(cfg.q_max), y2: f.sy(f.clampY(c + d * cfg.q_max)) }),
      t > 0 ? h('line', { class: 'plot-line plot-c3', x1: f.sx(0), y1: f.sy(c + t), x2: f.sx(cfg.q_max), y2: f.sy(f.clampY(c + t + d * cfg.q_max)) }) : null,
      h('circle', { class: 'sd-dot', cx: f.sx(Qt), cy: f.sy(Pd), r: 4 }),
    );
    clear(info).add(h('table', null, h('tbody', null,
      h('tr', null, h('th', null, '均衡（无税）'), h('td', null, `Q* = ${fmt(Q0)}, P* = ${fmt(P0)}`)),
      h('tr', null, h('th', null, '均衡（含税）'), h('td', null, `Q = ${fmt(Qt)}, 买方价 ${fmt(Pd)}, 卖方得 ${fmt(Ps)}`)),
      h('tr', null, h('th', null, '消费者剩余 CS'), h('td', null, fmt(CS))),
      h('tr', null, h('th', null, '生产者剩余 PS'), h('td', null, fmt(PS))),
      h('tr', null, h('th', null, '税收'), h('td', null, fmt(TR))),
      h('tr', null, h('th', null, '无谓损失 DWL'), h('td', null, fmt(DWL))))));
  };
  const slider = (label, key, min, max, step) => {
    const out = h('span', { class: 'out' }, fmt(s[key]));
    const r = h('input', { type: 'range', min, max, step, value: s[key], 'aria-label': label });
    r.addEventListener('input', () => { s[key] = Number(r.value); out.textContent = fmt(s[key]); draw(); });
    return h('label', null, label, r, out);
  };
  const span = cfg.p_max / 2;
  el.add(h('div', { class: 'controls' }, slider('需求移动 Δa', 'da', -span, span, span / 50), slider('供给移动 Δc', 'dc', -span, span, span / 50), slider('从量税 t', 't', 0, span, span / 50)),
    f.svg, h('div', { class: 'legend' }, h('span', null, h('span', { class: 'sw c0' }), '需求 P = a − bQ'), h('span', null, h('span', { class: 'sw c1' }), '供给 P = c + dQ'), h('span', null, h('span', { class: 'sw c3' }), '含税供给'),
      h('span', null, h('span', { class: 'sw cs' }), 'CS'), h('span', null, h('span', { class: 'sw ps' }), 'PS'), h('span', null, h('span', { class: 'sw tax' }), '税收'), h('span', null, h('span', { class: 'sw dwl' }), 'DWL')), info);
  draw();
});

// ---------------- 博弈支付矩阵 ----------------
reg('payoff_matrix', (el, cfg) => {
  const R = arr(cfg.row_actions); const C = arr(cfg.col_actions);
  const pay = R.map((_, i) => C.map((_, j) => [...(cfg.payoffs?.[i]?.[j] || [0, 0])]));
  const holder = h('div');
  const render = () => {
    const rowBest = C.map((_, j) => Math.max(...R.map((_, i) => pay[i][j][0])));
    const colBest = R.map((_, i) => Math.max(...C.map((_, j) => pay[i][j][1])));
    const nash = [];
    const cell = (i, j) => {
      const br1 = pay[i][j][0] === rowBest[j]; const br2 = pay[i][j][1] === colBest[i];
      if (br1 && br2) nash.push(`(${R[i]}, ${C[j]})`);
      const inp = (k, best) => {
        const x = h('input', { type: 'number', value: pay[i][j][k], step: 'any', class: best ? 'br' : null, 'aria-label': `payoff ${i} ${j} ${k}` });
        x.style.width = '4.5em';
        x.addEventListener('change', () => { pay[i][j][k] = Number(x.value) || 0; render(); });
        return x;
      };
      return h('td', { class: br1 && br2 ? 'nash' : null }, inp(0, br1), ' , ', inp(1, br2));
    };
    const tbl = h('div', { class: 'tbl' }, h('table', null,
      h('thead', null, h('tr', null, h('th', null, `${cfg.row_player} \\ ${cfg.col_player}`), C.map((c) => h('th', null, c)))),
      h('tbody', null, R.map((r, i) => h('tr', null, h('th', null, r), C.map((_, j) => cell(i, j)))))));
    clear(holder).add(tbl, h('p', { class: 'note' }, '下划线 = 该玩家对对方策略的最优反应；绿色格 = 纯策略纳什均衡：', h('b', null, nash.length ? nash.join('、') : '无（可能存在混合策略均衡）')));
  };
  el.add(h('p', { class: 'muted small' }, '每格为（行玩家收益, 列玩家收益），可直接修改数字。'), holder);
  render();
});
