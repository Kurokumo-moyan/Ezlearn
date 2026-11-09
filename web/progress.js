// 顶部进度窗口：所有后台任务（分析、生成章节、增量更新）和本地操作（上传解析、获取模型）都在这里显示，
// 带进度条；每行提示使用课程的讲解语言（由服务端按语言生成）。同时兼做心跳：窗口开着，服务就不会自动退出。
import { h, clear } from './dom.js';
import { api } from './api.js';

const panel = h('div', { id: 'taskpanel', class: 'hidden', role: 'status', 'aria-live': 'polite' });
const list = h('div', { class: 'tp-list' });
const head = h('div', { class: 'tp-head' });
const toggle = h('button', { class: 'tp-btn', title: '收起 / 展开' }, '—');
panel.add(head, list);
let collapsed = false;
toggle.addEventListener('click', () => { collapsed = !collapsed; panel.classList.toggle('collapsed', collapsed); toggle.textContent = collapsed ? '▢' : '—'; });

const locals = new Map(); // id -> {label, state, msg, at}
const dismissed = new Set();
let jobs = [];
let timer = null;
let seq = 0;
const listeners = new Set();
const lastStatus = new Map();
const seenDoneAt = new Map(); // 本窗口第一次看到任务结束的时间
let actionHandler = () => {};

export function mountProgress(onAction) {
  actionHandler = onAction || actionHandler;
  if (!panel.isConnected) document.body.prepend(panel);
  poll();
  setInterval(() => { api.post('/heartbeat').catch(() => {}); }, 30 * 1000);
}

/** 任务结束（成功或失败）时回调 (job) => void。 */
export function onJobFinished(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** 立即刷新（刚启动一个任务后调用）。 */
export function refreshJobs() { clearTimeout(timer); poll(); }

/** 本地操作：返回 { done(msg), fail(msg) }，显示不确定进度条。 */
export function localTask(label) {
  const id = `l${++seq}`;
  locals.set(id, { label, state: 'running', msg: '', at: Date.now() });
  draw();
  const end = (state, msg) => {
    locals.set(id, { label, state, msg: msg || '', at: Date.now() });
    draw();
    setTimeout(() => { locals.delete(id); draw(); }, state === 'error' ? 8000 : 2500);
  };
  return { done: (m) => end('done', m), fail: (m) => end('error', m) };
}

async function poll() {
  try {
    const next = await api.get('/jobs');
    for (const j of next) {
      if (j.status !== 'running' && !seenDoneAt.has(j.id)) seenDoneAt.set(j.id, Date.parse(j.finished_at || 0) > Date.now() - 60000 ? Date.now() : 0);
      const prev = lastStatus.get(j.id);
      if (prev === 'running' && j.status !== 'running') listeners.forEach((fn) => { try { fn(j); } catch { /* ignore */ } });
      lastStatus.set(j.id, j.status);
    }
    jobs = next;
  } catch { /* 服务暂时不可达：保留上次状态 */ }
  draw();
  const busy = jobs.some((j) => j.status === 'running');
  const fading = jobs.some((j) => j.status === 'done' && Date.now() - (seenDoneAt.get(j.id) || 0) < 11000);
  timer = setTimeout(poll, busy ? 1200 : fading ? 3000 : 15000);
}

const pct = (x) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;

function bar(fraction, indeterminate = false) {
  const fill = h('div', { class: `tp-fill${indeterminate ? ' ind' : ''}` });
  if (!indeterminate) fill.style.width = pct(fraction);
  return h('div', { class: 'tp-bar' }, fill);
}

const ACTIONS = {
  budget: '提高花费上限',
  auth: '打开设置填写密钥',
  model: '打开设置选择模型',
  config: '打开设置',
  quota: '打开设置',
};

function draw() {
  const now = Date.now();
  // 成功的任务显示 10 秒后自动隐藏；失败的留着，直到用户点 ×
  const visible = jobs.filter((j) => !dismissed.has(j.id) && (j.status === 'running' || (j.status === 'error' && seenDoneAt.get(j.id)) || now - (seenDoneAt.get(j.id) || 0) < 10000));
  const loc = [...locals.entries()];
  const total = visible.length + loc.length;
  panel.classList.toggle('hidden', total === 0);
  if (!total) return;
  const running = visible.filter((j) => j.status === 'running').length + loc.filter(([, l]) => l.state === 'running').length;
  clear(head).add(h('b', null, running ? `正在进行 ${running} 项任务` : '任务已结束'), h('span', { class: 'spacer' }), toggle);
  clear(list);
  for (const j of visible) {
    const close = j.status !== 'running' ? h('button', { class: 'tp-btn', title: '关闭', onclick: () => { dismissed.add(j.id); draw(); } }, '×') : null;
    const act = j.status === 'error' && ACTIONS[j.error_code] ? h('button', { class: 'btn primary', onclick: () => actionHandler(j.error_code, j) }, ACTIONS[j.error_code]) : null;
    const lines = (j.lines || []).slice(collapsed ? -1 : -3);
    list.add(h('div', { class: `tp-item ${j.status}` },
      h('div', { class: 'tp-title' }, h('span', null, `${j.course_code} · ${j.kind_label}`), h('span', { class: 'spacer' }),
        h('span', { class: 'tp-pct' }, j.status === 'running' ? pct(j.progress) : j.status === 'done' ? '✓' : '✗'), close),
      bar(j.status === 'done' ? 1 : j.progress),
      h('div', { class: 'tp-lines' }, lines.map((l) => h('div', null, l.text))),
      act));
  }
  for (const [, l] of loc) {
    list.add(h('div', { class: `tp-item ${l.state}` },
      h('div', { class: 'tp-title' }, h('span', null, l.label), h('span', { class: 'spacer' }), h('span', { class: 'tp-pct' }, l.state === 'running' ? '…' : l.state === 'done' ? '✓' : '✗')),
      bar(l.state === 'running' ? 0 : 1, l.state === 'running'),
      l.msg ? h('div', { class: 'tp-lines' }, h('div', null, l.msg)) : null));
  }
}
