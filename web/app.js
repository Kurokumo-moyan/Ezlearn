import { h, clear, modal, toast } from './dom.js';
import { api, paths } from './api.js';
import { renderBlocks, rich, anchor } from './render.js';
import { mountProgress, onJobFinished, refreshJobs, localTask } from './progress.js';
import { mountTitlebar, setTitleContext, syncHostBackground } from './titlebar.js';

const $app = document.getElementById('app');
let pollTimer = null;
let unsubscribeJob = null;

// ---------------- 偏好（仅本地；读写失败时退回默认） ----------------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
function applyTheme() {
  const t = store.get('ez-theme', 'system');
  if (t === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  document.body.classList.toggle('en-off', store.get('ez-en-off', false));
}
applyTheme();

const ROLE_LABEL = {
  course_outline: '课程大纲', slides: 'Slides', annotated_slides: '批注版 slides', textbook: '教材', lecture_notes: '讲义',
  transcript: '录音转写', tutorial: 'Tutorial', tutorial_solution: 'Tutorial 答案', lab: 'Lab', lab_solution: 'Lab 答案',
  past_exam: '往年真题', past_exam_solution: '真题答案', assignment: '当期作业（不出答案）', dataset: '数据集 (SQL/CSV)', code: '代码', reading: '阅读材料', other: '其他',
};
const EV_LABEL = { not_examinable: '不考', emphasised: '强调 / 重点', exam_format: '考试形式', exam_hint: '考试提示', assessment_rule: '考核规则', correction: '纠错', scope: '范围' };
const dots = (w) => '●'.repeat(Math.max(0, Math.min(3, w | 0)));
const fmtTime = (iso) => { if (!iso) return ''; const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
const readHref = (cid, chid, anc) => `#/c/${encodeURIComponent(cid)}/read${chid ? `/${encodeURIComponent(chid)}` : ''}${chid && anc ? `/${encodeURIComponent(anc)}` : ''}`;

// ---------------- 标题栏 + 顶部进度窗口 ----------------
mountTitlebar(titlebarButtons());
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(syncHostBackground, 50));
mountProgress((code, job) => {
  if (code === 'budget') { sessionStorage.setItem('ez-open-budget', job.course_id); location.hash = `#/c/${encodeURIComponent(job.course_id)}`; if (location.hash === `#/c/${job.course_id}`) route(); }
  else location.hash = '#/settings';
});

// ---------------- 路由 ----------------
async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  document.body.classList.remove('sb-open');
  document.querySelectorAll('.modal-bg').forEach((m) => m.remove());
  clearTimeout(pollTimer);
  if (unsubscribeJob) { unsubscribeJob(); unsubscribeJob = null; }
  try {
    if (parts[0] === 'settings') return await settingsPage();
    if (parts[0] === 'c' && parts[1]) {
      if (parts[2] === 'read') return await reader(parts[1], parts[3] || null, parts[4] || null);
      return await studio(parts[1]);
    }
    return await home();
  } catch (e) {
    clear($app).add(h('div', { id: 'content' }, h('h1', null, '出错了'), h('p', { class: 'err' }, e.message), h('a', { href: '#/' }, '返回首页')));
  }
}
window.addEventListener('hashchange', route);
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', route, { once: true });
else route();

function plainLayout(...kids) {
  const content = h('div', { id: 'content' }, kids);
  clear($app).add(h('div', { id: 'main', class: 'wide' }, content));
  document.getElementById('main').style.marginLeft = '0';
  return content;
}

// 标题栏上的按钮：历史课程、主题、英文术语开关、设置（替代原来散落在各页面顶部的按钮）
function titlebarButtons() {
  const label = () => ({ system: '主题：跟随系统', light: '主题：白天', dark: '主题：黑夜' })[store.get('ez-theme', 'system')];
  const t = h('button', { class: 'btn' }, label());
  t.addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    store.set('ez-theme', order[(order.indexOf(store.get('ez-theme', 'system')) + 1) % 3]);
    applyTheme();
    t.textContent = label();
    syncHostBackground();
    window.dispatchEvent(new Event('themechange'));
  });
  const en = h('button', { class: 'btn' }, store.get('ez-en-off', false) ? '显示英文术语' : '隐藏英文术语');
  en.addEventListener('click', () => { store.set('ez-en-off', !store.get('ez-en-off', false)); applyTheme(); en.textContent = store.get('ez-en-off', false) ? '显示英文术语' : '隐藏英文术语'; });
  return [h('a', { class: 'btn', href: '#/' }, '历史课程'), t, en, h('a', { class: 'btn', href: '#/settings' }, '⚙ 设置')];
}

function llmNotices(status) {
  const go = h('a', { class: 'btn primary', href: '#/settings' }, '去设置');
  const m = status.llm.mode;
  if (m === 'missing' || m === 'unknown') return h('div', { class: 'notice row' }, h('span', null, `还没有填写 ${status.llm.provider_label} 的 API 密钥。只看示例课程不需要；要用自己的课程生成学习书，请先到"设置"里选好 AI 公司并填写密钥。`), h('span', { class: 'spacer' }), go);
  if (m === 'error') return h('div', { class: 'notice row' }, h('span', null, `模型设置有误：${status.llm.error}`), h('span', { class: 'spacer' }), go);
  if (m === 'fake') return h('div', { class: 'notice' }, '当前为假模型测试模式（EZLEARN_FAKE_LLM=1），生成内容仅为占位。');
  return null;
}

// ---------------- 首页：历史课程 ----------------
async function home() {
  const [courses, status] = await Promise.all([api.get('/courses'), api.get('/status')]);
  const form = h('form', { class: 'card' });
  const f = (name, label, value = '', ph = '') => h('label', { class: 'row' }, h('span', { class: 'small' }, label), h('input', { type: 'text', name, value, placeholder: ph }));
  form.add(h('h3', null, '新建课程'),
    h('div', { class: 'row' }, f('code', '课程代码', '', 'COMP9311'), f('title', '课程名称', '', 'Database Systems')),
    h('div', { class: 'row' }, f('teaching_language', '讲解语言', '中文'), f('exam_language', '考试语言', 'English')),
    h('p', { class: 'small muted' }, '讲解语言是学习书和进度提示使用的语言；考试语言用于标注术语原文。'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, '创建')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(form).entries());
    try { const c = await api.post('/courses', d); location.hash = `#/c/${c.id}`; } catch (err) { toast(err.message, true); }
  });
  const demoBtn = h('button', { class: 'btn', onclick: async () => {
    const t = localTask('正在导入示例课程');
    demoBtn.disabled = true;
    try { const r = await api.post('/demo'); t.done(r.existed ? '示例课程已经在列表里' : '导入完成'); home(); } catch (err) { t.fail(err.message); demoBtn.disabled = false; }
  } }, '导入示例课程');
  const hasDemo = courses.some((c) => c.demo);

  setTitleContext('');
  plainLayout(
    h('p', { class: 'muted home-intro' }, '把一门课的教学资料变成按课程结构组织、零基础可读、每个结论可追溯、带交互演示的学习书。所有数据只保存在本机。'),
    llmNotices(status),
    status.llm.mode === 'api' ? h('p', { class: 'small muted' }, `当前模型：${status.llm.provider_label} · ${status.llm.model}。生成内容时，所选资料会发送给该服务商处理。`, h('a', { href: '#/settings' }, '更换')) : null,
    h('div', { class: 'card' }, h('div', { class: 'row' }, h('h3', null, '历史课程'), h('span', { class: 'spacer' }), hasDemo ? null : demoBtn),
      courses.length
        ? h('div', { class: 'history' }, courses.map(historyRow))
        : h('p', { class: 'muted' }, '还没有课程。可以先点右上角"导入示例课程"看看效果，或在下面新建一门课。')),
    form,
  );
}

function historyRow(c) {
  const pr = c.progress || {};
  const bms = [...(pr.bookmarks || [])].reverse();
  const latest = bms[0];
  const cont = latest
    ? h('a', { class: 'btn primary', href: readHref(c.id, latest.chapter_id, latest.anchor) }, `🔖 跳到书签：${latest.label}`)
    : h('a', { class: 'btn primary', href: readHref(c.id) }, '打开课程首页');
  return h('div', { class: 'hist' },
    h('div', { class: 'hist-main' },
      h('div', null, h('b', null, c.code), ' ', c.title, c.demo ? h('span', { class: 'chip mid' }, '示例') : null),
      h('div', { class: 'small muted' },
        `已生成 ${c.chapter_count || 0} 章 · 已掌握 ${pr.mastered || 0} 章`,
        pr.opened_at ? ` · 上次打开 ${fmtTime(pr.opened_at)}` : ' · 还没打开过'),
      pr.last?.chapter_id && !latest ? h('div', { class: 'small' }, '上次读到：', h('a', { href: readHref(c.id, pr.last.chapter_id, pr.last.anchor) }, pr.last.title || pr.last.chapter_id)) : null,
      bms.length > 1 ? h('details', { class: 'small' }, h('summary', null, `全部书签（${bms.length}）`),
        h('ul', null, bms.map((b) => h('li', null, h('a', { href: readHref(c.id, b.chapter_id, b.anchor) }, b.label), h('span', { class: 'muted' }, ` · ${fmtTime(b.at)}`))))) : null),
    h('div', { class: 'hist-act' }, cont, h('a', { class: 'btn', href: `#/c/${encodeURIComponent(c.id)}` }, '管理')));
}

// ---------------- 设置 ----------------
async function settingsPage() {
  const [s, status] = await Promise.all([api.get('/settings'), api.get('/status')]);
  setTitleContext('设置');
  const content = plainLayout(h('h1', null, '设置'));

  // --- AI 模型 ---
  const provSel = h('select', { 'aria-label': 'AI 公司' }, s.providers.map((p) => h('option', { value: p.id, selected: p.id === s.provider }, p.label)));
  const keyIn = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', maxlength: 512 });
  const siteLine = h('div', { class: 'small' });
  const urlRow = h('label', { class: 'row' }, h('span', { class: 'small' }, '接口地址'), h('input', { type: 'text', placeholder: 'https://example.com/v1', value: s.base_url || '' }));
  const urlIn = urlRow.querySelector('input');
  const modelSel = h('select', { 'aria-label': '模型' });
  const modelIn = h('input', { type: 'text', placeholder: '或手动输入模型名', maxlength: 100 });
  const modelMsg = h('div', { class: 'small muted' });
  const visionIn = h('input', { type: 'text', maxlength: 100 });
  const visionNote = h('span', { class: 'small muted' });
  const visionRow = h('div', null, h('div', { class: 'row' }, h('span', { class: 'small' }, '图像识别模型'), visionIn), visionNote);
  const fetchBtn = h('button', { class: 'btn' }, '获取可用模型');
  const cur = () => s.providers.find((p) => p.id === provSel.value);

  const setModels = (models, preferred) => {
    clear(modelSel);
    const p = cur();
    const list = models.length ? models : [preferred || p.default_model].filter(Boolean);
    for (const m of list) modelSel.add(h('option', { value: m, selected: m === preferred }, m === p.default_model ? `${m}（推荐）` : m));
    if (preferred && !list.includes(preferred)) modelSel.prepend(h('option', { value: preferred, selected: true }, `${preferred}（当前）`));
  };

  const drawProvider = () => {
    const p = cur();
    keyIn.value = '';
    keyIn.placeholder = p.has_key ? `已保存（末尾 ${p.key_tail}）。要换新密钥就粘贴在这里` : '把 API 密钥粘贴在这里';
    clear(siteLine).add(p.key_site ? ['还没有密钥？到这里申请：', h('a', { href: p.key_site }, p.key_site)] : '填写你的接口地址、密钥和模型名（本机模型如 Ollama 可以不填密钥）。');
    urlRow.style.display = p.needs_base_url ? '' : 'none';
    modelIn.value = '';
    visionIn.value = p.saved_vision_model || '';
    visionIn.placeholder = p.default_vision_model === null ? '这家不支持看图：如需识别手写，请填它的视觉模型名' : (p.default_vision_model || '留空 = 用上面选的模型');
    visionNote.textContent = p.default_vision_model === null
      ? `${p.label} 的对话模型不能看图片。扫描件和手写批注需要能看图的模型（Claude、GPT、Gemini 都可以）。`
      : '用来读取扫描件、手写批注和照片。一般留空即可。';
    setModels([], p.saved_model || (p.id === s.provider ? s.model : p.default_model));
    modelMsg.textContent = p.has_key || p.needs_base_url ? '' : '填好密钥后会自动获取可用的模型。';
    if (p.has_key) fetchModels(true);
  };

  let fetchSeq = 0;
  async function fetchModels(quiet = false) {
    const p = cur();
    const key = keyIn.value.trim();
    if (!key && !p.has_key && !p.needs_base_url) { if (!quiet) toast('请先粘贴 API 密钥', true); return; }
    const my = ++fetchSeq;
    fetchBtn.disabled = true;
    modelMsg.textContent = '正在向服务商获取可用模型……';
    const t = quiet ? null : localTask(`获取 ${p.label} 的模型列表`);
    try {
      const r = await api.post('/settings/models', { provider: p.id, ...(key ? { api_key: key } : {}), ...(p.needs_base_url && urlIn.value.trim() ? { base_url: urlIn.value.trim() } : {}) });
      if (my !== fetchSeq) return;
      const preferred = modelSel.value && r.models.includes(modelSel.value) ? modelSel.value : r.models.includes(r.default_model) ? r.default_model : r.models[0];
      setModels(r.models, preferred);
      modelMsg.textContent = r.models.length ? `密钥可用，找到 ${r.models.length} 个模型。请选择一个，然后点"保存并启用"。` : '密钥可用，但对方没有返回模型列表。请手动输入模型名。';
      modelMsg.className = 'small ok';
      t?.done(`找到 ${r.models.length} 个模型`);
    } catch (e) {
      if (my !== fetchSeq) return;
      modelMsg.textContent = e.message;
      modelMsg.className = 'small err';
      t?.fail(e.message);
    } finally { fetchBtn.disabled = false; }
  }
  fetchBtn.addEventListener('click', () => fetchModels(false));
  let keyTimer;
  keyIn.addEventListener('input', () => { clearTimeout(keyTimer); if (keyIn.value.trim().length >= 8) keyTimer = setTimeout(() => fetchModels(true), 700); });
  provSel.addEventListener('change', drawProvider);

  const saveBtn = h('button', { class: 'btn primary', onclick: async () => {
    const p = cur();
    const key = keyIn.value.trim();
    if (!key && !p.has_key && !(p.needs_base_url && /^http:\/\/(127\.0\.0\.1|localhost)/.test(urlIn.value.trim()))) return toast('请先粘贴 API 密钥', true);
    const model = modelIn.value.trim() || modelSel.value;
    try {
      await api.put('/settings', { provider: p.id, ...(key ? { api_key: key } : {}), model, vision_model: visionIn.value.trim(), ...(p.needs_base_url ? { base_url: urlIn.value.trim() } : {}) });
      toast(`已保存：${p.label} · ${model}，立即生效`);
      settingsPage();
    } catch (e) { toast(e.message, true); }
  } }, '保存并启用');
  const clearBtn = h('button', { class: 'btn danger', onclick: async () => {
    const p = cur();
    if (!p.has_key) return toast('这家公司没有保存过密钥');
    if (!confirm(`删除已保存的 ${p.label} API 密钥？`)) return;
    await api.put('/settings', { clear_key: p.id });
    toast('已删除');
    settingsPage();
  } }, '删除已保存的密钥');

  content.add(h('div', { class: 'card' }, h('h3', null, 'AI 模型'),
    status.llm.mode === 'api' ? h('p', { class: 'small ok' }, `正在使用：${status.llm.provider_label} · ${status.llm.model}`) : llmNotices(status),
    h('label', { class: 'row' }, h('span', { class: 'small' }, '1. 选择 AI 公司'), provSel),
    siteLine,
    urlRow,
    h('label', { class: 'row' }, h('span', { class: 'small' }, '2. 粘贴 API 密钥'), keyIn),
    h('p', { class: 'small muted' }, '密钥只保存在这台电脑上，不会显示在页面里，也不会发给除这家公司以外的任何地方。'),
    h('div', { class: 'row' }, h('span', { class: 'small' }, '3. 选择模型'), modelSel, fetchBtn),
    h('div', { class: 'row' }, modelIn),
    visionRow,
    modelMsg,
    h('div', { class: 'row' }, saveBtn, h('span', { class: 'spacer' }), clearBtn),
    h('p', { class: 'small muted' }, '不同公司的价格和效果不同：本软件按 Claude 调校，换其他模型时"校验报告"里的警告可能多一些。生成内容时，课程资料会发送给你选的公司处理。')));
  drawProvider();

  // --- 花费上限 ---
  const budgetIn = h('input', { type: 'number', min: 1, max: 10000, step: 1, value: s.budget_usd });
  content.add(h('div', { class: 'card' }, h('h3', null, '花费上限'),
    h('p', { class: 'small muted' }, '每门课最多花多少美元（按用量估算）。达到上限后会自动停止，不会无限扣钱。单门课也可以在它的管理页里单独提高。'),
    h('div', { class: 'row' }, h('span', { class: 'small' }, '新课程默认上限（美元）'), budgetIn,
      h('button', { class: 'btn', onclick: async () => { try { await api.put('/settings', { budget_usd: Number(budgetIn.value) }); toast('已保存'); } catch (e) { toast(e.message, true); } } }, '保存'))));

  // --- 数据与退出 ---
  content.add(h('div', { class: 'card' }, h('h3', null, '数据'),
    h('p', { class: 'small' }, '课程、学习书、书签和设置都保存在：', h('code', null, s.data_dir)),
    h('p', { class: 'small muted' }, '换电脑时把这个文件夹整个复制过去即可。卸载 Ezlearn 时可以选择一并删除。')));
  if (status.can_quit) {
    content.add(h('div', { class: 'card' }, h('h3', null, '退出'),
      h('p', { class: 'small muted' }, '直接关掉窗口也可以：没有任务在运行时，Ezlearn 会在两分钟后自动退出。'),
      h('button', { class: 'btn danger', onclick: () => quitApp() }, '退出 Ezlearn')));
  }
}

async function quitApp() {
  try {
    await api.post('/shutdown');
  } catch (e) {
    if (!e.data?.running) return toast(e.message, true);
    if (!confirm('还有任务在运行，现在退出会中断它（已经花掉的费用不会退）。确定退出？')) return;
    await api.post('/shutdown', { force: true });
  }
  clear($app).add(h('div', { id: 'content' }, h('h1', null, 'Ezlearn 已退出'), h('p', null, '可以关闭这个窗口了。下次使用时，双击桌面上的 Ezlearn 图标。')));
  setTimeout(() => window.close(), 800);
}

// ---------------- 管理页（Studio） ----------------
async function studio(cid) {
  clearTimeout(pollTimer);
  const [d, status] = await Promise.all([api.get(paths.course(cid)), api.get('/status')]);
  const { course } = d;
  const content = plainLayout();
  const busy = d.job?.status === 'running';

  const budgetBtn = h('button', { class: 'btn', onclick: () => raiseBudget(cid, d) }, '提高上限');
  setTitleContext(`${course.code} · 管理`);
  content.add(
    h('div', { class: 'row' }, h('h1', null, `${course.code} ${course.title}`), h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: readHref(cid) }, '打开学习书'),
      h('button', { class: 'btn danger', onclick: async () => {
        if (!confirm(`永久删除课程 ${course.code} 及其全部本地数据？此操作不可撤销。`)) return;
        await api.del(paths.course(cid)); location.hash = '#/';
      } }, '删除课程')),
    h('p', { class: `small ${d.usage >= d.budget ? 'err' : 'muted'}` }, `讲解语言 ${course.teaching_language} · 考试语言 ${course.exam_language} · 学科档案 ${(course.profiles || []).join(', ') || '未判定'} · API 花费约 $${d.usage.toFixed(2)} / 上限 $${d.budget} `, budgetBtn),
    busy ? h('div', { class: 'notice' }, '有任务正在运行，进度显示在窗口顶部。完成后本页会自动刷新。') : null,
  );
  if (sessionStorage.getItem('ez-open-budget') === cid) { sessionStorage.removeItem('ez-open-budget'); raiseBudget(cid, d); }

  // 任务结束后自动刷新本页
  unsubscribeJob = onJobFinished((job) => { if (job.course_id === cid && location.hash === `#/c/${cid}`) studio(cid); });
  const run = async (body) => {
    try { await api.post(`${paths.course(cid)}/run`, body); refreshJobs(); setTimeout(() => { if (location.hash === `#/c/${cid}`) studio(cid); }, 300); } catch (e) { toast(e.message, true); }
  };

  // 1. 资料
  const fileIn = h('input', { type: 'file', multiple: true, accept: '.pdf,.txt,.md,.vtt,.srt,.csv,.sql,.png,.jpg,.jpeg' });
  const roleSel = h('select', null, h('option', { value: '' }, '按文件名自动判断角色'), Object.entries(ROLE_LABEL).map(([k, v]) => h('option', { value: k }, v)));
  const weekIn = h('input', { type: 'text', placeholder: '周次（可选）' });
  const upBtn = h('button', { class: 'btn primary' }, '上传并解析');
  upBtn.addEventListener('click', async () => {
    if (!fileIn.files.length) return toast('请选择文件', true);
    const fd = new FormData();
    const meta = [];
    for (const f of fileIn.files) { fd.append('files', f); meta.push({ ...(roleSel.value ? { role: roleSel.value } : {}), ...(weekIn.value ? { week: weekIn.value } : {}) }); }
    fd.append('meta', JSON.stringify(meta));
    upBtn.disabled = true;
    const t = localTask(`正在上传并解析 ${fileIn.files.length} 个文件`);
    try {
      const r = await api.upload(`${paths.course(cid)}/materials`, fd);
      const enc = r.created.filter((x) => x.needs_confirm);
      t.done(`已解析 ${r.created.length} 个${r.errors.length ? `，${r.errors.length} 个失败` : ''}${enc.length ? `，${enc.length} 个需要确认文字` : ''}`);
      if (r.errors.length) toast(r.errors.map((e) => `${e.filename}：${e.error}`).join('；'), true);
      await studio(cid);
      if (enc.length) confirmEncodings(cid, enc);
    } catch (e) {
      t.fail(e.data?.errors?.map((x) => `${x.filename}：${x.error}`).join('；') || e.message);
      upBtn.disabled = false;
    }
  });
  const pending = d.materials.filter((m) => m.encoding?.confirmed === false);
  const matRows = d.materials.map((m) => {
    const sel = h('select', null, Object.entries(ROLE_LABEL).map(([k, v]) => h('option', { value: k, selected: k === m.role }, v)));
    sel.addEventListener('change', async () => { await api.patch(paths.material(cid, m.id), { role: sel.value }); toast('角色已更新'); });
    const encPending = m.encoding?.confirmed === false;
    return h('tr', null,
      h('td', null, m.filename, m.no_solutions ? h('span', { class: 'chip hot' }, '不出答案') : null,
        encPending ? h('span', { class: 'chip mid', title: '原文件不是 UTF-8，已自动转换了一份副本' }, `已从 ${m.encoding.label} 转换，待确认`) : null,
        m.encoding?.confirmed ? h('span', { class: 'chip good', title: '原文件不是 UTF-8，已转换并经你确认' }, `已转换（${m.encoding.label}）`) : null),
      h('td', null, sel),
      h('td', { class: 'small' }, m.kind === 'image' ? '图片' : `${m.page_count} 页/段`,
        m.vision_pages ? h('span', { class: 'chip mid', title: '这些页没有可提取的文字（扫描件、手写或图片），可以点"图像识别"读取' }, `${m.vision_pages} 页无文字`) : null,
        m.recognised_pages ? h('span', { class: 'chip good', title: '已用图像识别读取' }, `已识别 ${m.recognised_pages} 页${m.handwriting_pages ? ` · 手写 ${m.handwriting_pages} 页` : ''}`) : null,
        m.unclear_pages ? h('span', { class: 'chip hot', title: '模型表示这些页看不太清，请对照原件检查' }, `${m.unclear_pages} 页看不清`) : null,
        m.has_sql ? h('span', { class: 'chip good' }, 'SQL 数据集') : null),
      h('td', { class: 'small muted' }, m.week || ''),
      h('td', null,
        encPending ? h('button', { class: 'btn primary', onclick: () => confirmEncodings(cid, [{ id: m.id, filename: m.filename }]) }, '确认文字') : null, ' ',
        m.kind === 'pdf' || m.kind === 'image' ? h('button', { class: `btn ${m.vision_pages ? 'primary' : ''}`, disabled: busy, title: '读取扫描件、手写批注、照片里的文字', onclick: () => visionDialog(cid, [m], status, run) }, '图像识别') : null, ' ',
        h('button', { class: 'btn', onclick: () => openMaterial(cid, m.id) }, '查看'), ' ',
        h('button', { class: 'btn danger', onclick: async () => { if (confirm(`删除资料 ${m.filename}？`)) { await api.del(paths.material(cid, m.id)); studio(cid); } } }, '删除')));
  });
  content.add(h('div', { class: 'card' }, h('h3', null, '1. 资料'),
    h('p', { class: 'muted small' }, '支持 PDF、TXT/MD、录音文字稿（VTT/SRT/TXT）、SQL、CSV；Word 和 PPT 请先另存为 PDF。不是 UTF-8 编码的文本会自动转换，转换后请确认文字没有乱码。上传后可修改每份资料的角色；当期作业会被标为"不出答案"。'),
    pending.length ? h('div', { class: 'notice row' }, h('span', null, `有 ${pending.length} 个文件的文字编码已自动转换，确认没有乱码之前不会用于生成。`), h('span', { class: 'spacer' }), h('button', { class: 'btn primary', onclick: () => confirmEncodings(cid, pending.map((m) => ({ id: m.id, filename: m.filename }))) }, '逐个确认')) : null,
    (() => {
      const textless = d.materials.filter((m) => m.vision_pages > 0);
      const n = textless.reduce((a, m) => a + m.vision_pages, 0);
      if (!n) return null;
      return h('div', { class: 'notice row' },
        h('span', null, `有 ${n} 页没有文字（扫描件、手写或图片），现在不会用于生成。可以用图像识别把它们读出来。`), h('span', { class: 'spacer' }),
        h('button', { class: 'btn primary', disabled: busy, onclick: () => visionDialog(cid, textless, status, run) }, '图像识别这些页'));
    })(),
    h('p', { class: 'small muted' }, '课件上有老师的手写批注（圈画、"这个必考"之类）时，程序提取文字会漏掉它们：请对这份课件点"图像识别"并选"识别全部页"。'),
    h('div', { class: 'row' }, fileIn, roleSel, weekIn, upBtn),
    d.materials.length ? h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, h('th', null, '文件'), h('th', null, '角色'), h('th', null, '内容'), h('th', null, '周次'), h('th', null, ''))), h('tbody', null, matRows))) : null));

  // 2. 分析
  const confirmedPlan = d.plan?.confirmed;
  const usable = d.materials.filter((m) => m.encoding?.confirmed !== false).length;
  content.add(h('div', { class: 'card' }, h('h3', null, '2. 分析（找证据 → 判断学科 → 分析真题 → 规划章节）'),
    h('div', { class: 'stages' },
      stageCard('证据抽取', `${d.evidence.length} 条（原文核实 ${d.evidence.filter((e) => e.quote_found).length}）`, () => run({ stage: 'S2' }), busy),
      stageCard('学科判定', (course.profiles || []).join(', ') || '未运行', () => run({ stage: 'S3' }), busy),
      stageCard('考核与真题', d.exam ? `${d.exam.papers.length} 份真题已映射` : '未运行', () => run({ stage: 'S4' }), busy),
      stageCard('课程方案', d.plan ? `${d.plan.chapters.length} 章${confirmedPlan ? '（已确认）' : '（待确认）'}` : '未运行', () => run({ stage: 'S5' }), busy)),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', disabled: busy || !usable, onclick: () => run({ stage: 'analyze' }) }, '一键分析'),
      h('span', { class: 'muted small' }, '方案生成后需要你确认，才会开始逐章生成。'))));

  // 3. 方案确认
  if (d.plan) content.add(planEditor(cid, d));

  // 4. 章节
  if (d.plan) {
    const review = h('input', { type: 'checkbox', checked: true });
    const have = new Map(d.chapters.map((c) => [c.id, c]));
    content.add(h('div', { class: 'card' }, h('h3', null, '4. 逐章生成与校验'),
      !confirmedPlan ? h('div', { class: 'notice' }, '请先确认课程方案。') : null,
      h('div', { class: 'row' }, h('label', { class: 'small row' }, review, '生成后让模型审稿（只报告问题，不改内容）'),
        h('button', { class: 'btn primary', disabled: busy || !confirmedPlan, onclick: () => run({ stage: 'all_chapters', review: review.checked, only_missing: true }) }, '生成全部未生成的章节')),
      h('div', { class: 'tbl' }, h('table', null, h('tbody', null, d.plan.chapters.map((pc) => {
        const c = have.get(pc.id);
        return h('tr', null, h('td', null, `${pc.number} ${pc.title}`), h('td', { class: 'small' }, c ? (c.verify ? h('span', { class: c.verify.errors ? 'err' : 'ok' }, `${c.verify.errors} 错误 / ${c.verify.warnings} 警告`) : '已生成') : h('span', { class: 'muted' }, '未生成')),
          h('td', null,
            h('button', { class: 'btn', disabled: busy || !confirmedPlan, onclick: () => run({ stage: 'chapter', chapter_id: pc.id, review: review.checked }) }, c ? '重新生成' : '生成'), ' ',
            c ? h('button', { class: 'btn', onclick: () => showReport(cid, pc.id) }, '校验报告') : null, ' ',
            c ? h('button', { class: 'btn', onclick: async () => { const r = await api.post(`${paths.chapter(cid, pc.id)}/reverify`); toast(`重新校验：${r.errors} 错误 / ${r.warnings} 警告`); studio(cid); } }, '重新校验') : null, ' ',
            c ? h('a', { class: 'btn', href: readHref(cid, pc.id) }, '阅读') : null));
      }))))));
  }

  // 5. 增量更新
  if (d.chapters.length) {
    // 默认勾选方案里没用到的资料（通常就是后来新增的）
    const inPlan = new Set((d.plan?.chapters || []).flatMap((c) => c.sources.map((s) => s.material_id)));
    const boxes = d.materials.filter((m) => m.encoding?.confirmed !== false).map((m) => {
      const cb = h('input', { type: 'checkbox', value: m.id, checked: !inPlan.has(m.id) && !['dataset', 'assignment', 'course_outline'].includes(m.role) });
      return h('label', { class: 'small row' }, cb, `${m.filename}（${ROLE_LABEL[m.role]}）`);
    });
    content.add(h('div', { class: 'card' }, h('h3', null, '5. 增量更新'),
      h('p', { class: 'muted small' }, '上传新资料（新录音稿、批注版课件、新 lab）后，勾选它们生成变更清单：软件只改受影响的部分，由你逐条确认后应用。'),
      h('div', null, boxes),
      h('button', { class: 'btn primary', disabled: busy, onclick: () => {
        const ids = boxes.map((b) => b.querySelector('input')).filter((x) => x.checked).map((x) => x.value);
        if (!ids.length) return toast('请勾选新资料', true);
        run({ stage: 'update', material_ids: ids });
      } }, '生成变更清单'),
      d.updates.length ? h('ul', null, d.updates.map((u) => h('li', null, `${new Date(u.at).toLocaleString()} · ${u.change_count} 项 · ${u.status === 'pending' ? '待确认' : '已应用'} `,
        u.status === 'pending' ? h('button', { class: 'btn', onclick: () => reviewUpdate(cid, u.id) }, '审阅并应用') : null))) : null));
  }

  // 证据库 / 真题分析
  if (d.evidence.length) content.add(evidenceCard(cid, d));
  if (d.exam) content.add(h('div', { class: 'card' }, h('h3', null, '考核与真题分析'), examView(d.exam, d)));
}

function raiseBudget(cid, d) {
  const inp = h('input', { type: 'number', min: 1, max: 10000, step: 1, value: Math.ceil(Math.max(d.budget, d.usage) + 20) });
  const close = modal('提高这门课的花费上限',
    h('p', null, `这门课已经花了约 $${d.usage.toFixed(2)}，当前上限 $${d.budget}。`),
    h('p', { class: 'small muted' }, '上限是为了防止意外扣钱。提高后可以继续生成；费用以服务商的账单为准。'),
    h('div', { class: 'row' }, h('span', null, '新的上限（美元）'), inp,
      h('button', { class: 'btn primary', onclick: async () => {
        const v = Number(inp.value);
        if (!(v >= 1 && v <= 10000)) return toast('请输入 1 到 10000 之间的数字', true);
        try { await api.patch(paths.course(cid), { budget_usd: v }); close(); toast(`上限已改为 $${v}`); studio(cid); } catch (e) { toast(e.message, true); }
      } }, '保存')));
}

/** 逐个确认自动转换过编码的文件：显示前 3000 字，可以换编码重新试，确认没有乱码才使用。 */
async function confirmEncodings(cid, items) {
  const queue = [...items];
  const next = async () => {
    const it = queue.shift();
    if (!it) { studio(cid); return; }
    const base = `${paths.material(cid, it.id)}/encoding`;
    let info = await api.get(base);
    const sel = h('select', null, info.candidates.map((c) => h('option', { value: c.id, selected: c.id === info.encoding }, c.label)));
    const pre = h('div', { class: 'pagetext enc-preview' });
    const warn = h('p', { class: 'small' });
    const draw = () => {
      pre.textContent = info.preview || '（文件是空的）';
      warn.textContent = info.bad_chars ? `用这个编码有 ${info.bad_chars} 处无法识别的字符（显示为 �），可能选错了编码。` : '';
      warn.className = info.bad_chars ? 'small err' : 'small';
    };
    draw();
    sel.addEventListener('change', async () => { info = await api.get(`${base}?enc=${encodeURIComponent(sel.value)}`); draw(); });
    const close = modal(`确认文字：${it.filename}`,
      h('p', null, `这个文件不是 UTF-8 编码。Ezlearn 判断它是 `, h('b', null, info.label), '，已经转换了一份 UTF-8 副本（原文件不会被改动）。请看下面的文字是否正常：'),
      h('div', { class: 'row' }, h('span', { class: 'small' }, '编码'), sel, h('span', { class: 'small muted' }, '文字是乱码就换一个试试')),
      warn, pre,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          try { await api.post(base, { encoding: sel.value }); toast(`${it.filename}：已确认`); close(); next(); } catch (e) { toast(e.message, true); }
        } }, '文字正常，使用这个编码'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => { close(); next(); } }, '稍后再说'),
        h('button', { class: 'btn danger', onclick: async () => { if (!confirm(`删除 ${it.filename}？`)) return; await api.del(paths.material(cid, it.id)); close(); next(); } }, '删除这个文件')));
  };
  next();
}

/** 图像识别：选范围、看估价，再开始。 */
function visionDialog(cid, mats, status, run) {
  const v = status.vision || {};
  if (!v.supported) {
    modal('图像识别', h('p', null, `当前的 AI 公司（${status.llm.provider_label}）不能看图片。`),
      h('p', null, '请到设置里换成 Claude、GPT 或 Gemini，或者填写这家公司的"图像识别模型"。'),
      h('a', { class: 'btn primary', href: '#/settings' }, '去设置'));
    return;
  }
  const textless = mats.reduce((a, m) => a + (m.vision_pages || 0), 0);
  const all = mats.reduce((a, m) => a + (m.page_count || 0), 0);
  const est = (n) => (v.usd_per_page ? `，估计约 $${(n * v.usd_per_page).toFixed(2)}` : '');
  const opt = (value, label, checked, disabled) => h('label', { class: 'row small' }, h('input', { type: 'radio', name: 'vmode', value, checked, disabled }), label);
  const r1 = opt('textless', `只识别没有文字的 ${textless} 页${est(textless)}`, textless > 0, textless === 0);
  const r2 = opt('all', `识别全部 ${all} 页${est(all)}（课件上有手写批注时选这个）`, textless === 0, false);
  const force = h('input', { type: 'checkbox' });
  const close = modal('图像识别',
    h('p', null, mats.length === 1 ? mats[0].filename : `${mats.length} 个文件`),
    h('p', { class: 'small muted' }, `由 ${status.llm.provider_label} 的 ${v.model} 看每一页图片：手写内容会单独标成"【手写批注】"，看不清的字写 [?]，不会编造。原来程序提取的印刷文字保留不变。费用按页计算，以服务商账单为准。`),
    r1, r2,
    h('label', { class: 'row small' }, force, '已经识别过的页也重新识别'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => {
      const mode = [r1, r2].map((x) => x.querySelector('input')).find((x) => x.checked)?.value || 'all';
      close();
      run({ stage: 'vision', material_ids: mats.map((m) => m.id), mode, force: force.checked });
    } }, '开始识别')));
}

function stageCard(title, state, onRun, busy) {
  return h('div', { class: 'stage' }, h('b', null, title), h('div', { class: 'small muted' }, state), h('button', { class: 'btn', disabled: busy, onclick: onRun }, '运行'));
}

function planEditor(cid, d) {
  const plan = structuredClone(d.plan);
  const card = h('div', { class: 'card' });
  const mats = new Map(d.materials.map((m) => [m.id, m]));
  const srcText = (c) => c.sources.map((s) => `${s.material_id}:${s.pages}`).join('; ');
  const parseSrc = (t) => t.split(';').map((x) => x.trim()).filter(Boolean).map((x) => { const [material_id, pages = ''] = x.split(':'); return { material_id: material_id.trim(), pages: pages.trim() }; });
  const tbody = h('tbody');
  const draw = () => {
    clear(tbody);
    plan.chapters.forEach((c, i) => {
      const inp = (k, w) => { const x = h('input', { type: 'text', value: c[k] ?? '' }); if (w) x.style.width = w; x.addEventListener('change', () => { c[k] = x.value; }); return x; };
      const w = h('select', null, [0, 1, 2, 3].map((n) => h('option', { value: n, selected: n === c.weight }, n ? dots(n) : '—')));
      w.addEventListener('change', () => { c.weight = Number(w.value); });
      const src = h('input', { type: 'text', value: srcText(c) });
      src.addEventListener('change', () => { c.sources = parseSrc(src.value); });
      tbody.add(h('tr', null, h('td', null, inp('id', '6em')), h('td', null, inp('number', '3em')), h('td', null, inp('title'), inp('title_exam_lang')), h('td', null, inp('group', '7em')), h('td', null, inp('week', '5em')), h('td', null, w),
        h('td', null, src, h('div', { class: 'muted small' }, c.sources.map((s) => mats.get(s.material_id)?.filename || `?${s.material_id}`).join('；'))),
        h('td', { class: 'small' }, c.widgets.map((wd, k) => h('div', null, h('b', null, wd.widget), `：${wd.stuck_point} `, h('button', { class: 'btn', title: '删除这个组件', onclick: () => { c.widgets.splice(k, 1); draw(); } }, '×')))),
        h('td', null, h('button', { class: 'btn danger', onclick: () => { plan.chapters.splice(i, 1); draw(); } }, '删除'))));
    });
  };
  draw();
  const save = async (confirmed) => {
    const { confirmed: _c, at: _a, ...p } = plan;
    try { await api.put(`${paths.course(cid)}/plan`, { plan: p, confirmed }); toast(confirmed ? '方案已确认' : '草稿已保存'); studio(cid); } catch (e) { toast(e.message, true); }
  };
  card.add(h('h3', null, `3. 课程方案 ${d.plan.confirmed ? '（已确认）' : '（待确认）'}`),
    h('p', { class: 'small' }, h('b', null, '目录依据：'), plan.toc_basis),
    plan.questions_for_user.length ? h('div', { class: 'notice' }, h('b', null, '需要你确认的问题：'), h('ul', null, plan.questions_for_user.map((q) => h('li', null, q)))) : null,
    plan.not_doing.length ? h('p', { class: 'small muted' }, `不做：${plan.not_doing.join('；')}`) : null,
    h('div', { class: 'tbl plan-table' }, h('table', null, h('thead', null, h('tr', null, ['id', '编号', '标题 / 考试语言标题', '分组', '周次', '权重', '来源（资料id:页码; …）', '交互组件', ''].map((x) => h('th', null, x)))), tbody)),
    h('div', { class: 'row' },
      h('button', { class: 'btn', onclick: () => { plan.chapters.push({ id: `ch${String(plan.chapters.length + 1).padStart(2, '0')}x`, number: String(plan.chapters.length + 1), title: '新章节', title_exam_lang: '', group: '', sources: [], week: '', weight: 1, profiles: [], focus: '', widgets: [] }); draw(); } }, '添加章节'),
      h('button', { class: 'btn', onclick: () => save(false) }, '保存草稿'),
      h('button', { class: 'btn primary', onclick: () => save(true) }, '确认方案')));
  return card;
}

function evidenceCard(cid, d) {
  const mats = new Map(d.materials.map((m) => [m.id, m]));
  return h('details', { class: 'card' }, h('summary', null, h('b', null, `证据库：${d.evidence.length} 条`)),
    h('p', { class: 'muted small' }, '只有"原文已核实"的证据能支撑重点 / 不考标记。'),
    h('div', { class: 'tbl' }, h('table', null, h('tbody', null, d.evidence.map((e) => h('tr', null,
      h('td', null, h('span', { class: `badge ${e.type === 'not_examinable' ? 'skip' : 'key'}` }, EV_LABEL[e.type] || e.type)),
      h('td', null, `“${e.quote}”`, e.boundary ? h('div', { class: 'small muted' }, `边界：${e.boundary}`) : null, h('div', { class: 'small muted' }, `→ ${e.target}`)),
      h('td', { class: 'small' }, mats.get(e.material_id)?.filename || e.material_id, ' · ', e.location),
      h('td', { class: 'small' }, e.quote_found ? h('span', { class: 'ok' }, '✓ 原文已核实') : h('span', { class: 'err' }, '✗ 原文未找到'), e.confidence === 'low' ? h('div', { class: 'muted' }, '指代不明') : null),
      h('td', null, h('button', { class: 'btn', onclick: () => showEvidence(cid, e, mats) }, '原文'))))))));
}

function examView(exam, d) {
  const maxMarks = Math.max(1, ...exam.marks_by_chapter.map((x) => x.marks));
  const evById = new Map(d.evidence.map((e) => [e.id, e]));
  return h('div', null,
    exam.assessment.length ? h('div', { class: 'tbl' }, h('table', null, h('thead', null, h('tr', null, ['考核', '占比', '形式', '时间', '门槛'].map((x) => h('th', null, x)))),
      h('tbody', null, exam.assessment.map((a) => h('tr', null, h('td', null, a.name), h('td', null, a.weight), h('td', null, a.format), h('td', null, a.timing), h('td', null, a.hurdle || '')))))) : null,
    exam.marks_by_chapter.length ? h('div', null, h('h4', null, '往年真题分值按章节分布'), exam.marks_by_chapter.map((m) => {
      const bar = h('div', { class: 'bar' });
      bar.style.width = `${(m.marks / maxMarks) * 100}%`;
      return h('div', { class: 'barrow' }, h('span', null, m.chapter_ref), h('div', null, bar), h('span', { class: 'small' }, `${m.marks} 分`));
    })) : null,
    exam.patterns.length ? h('div', null, h('h4', null, '固定题型套路'), h('ul', null, exam.patterns.map((p) => h('li', null, p)))) : null,
    exam.key_topic_judgement.length ? h('div', null, h('h4', null, '是否存在重点'), h('ul', null, exam.key_topic_judgement.map((k) => h('li', null, k.claim,
      k.is_inference ? h('span', { class: 'badge inf' }, '推断') : null,
      k.evidence_ids.map((id) => evById.get(id)).filter(Boolean).map((e) => h('span', { class: 'small muted' }, ` “${e.quote}”`)))))) : null,
    exam.priority.length ? h('div', null, h('h4', null, '复习优先级'), h('div', { class: 'tbl' }, h('table', null, h('tbody', null, exam.priority.map((p) => h('tr', null,
      h('th', null, { highest: '最高', high: '高', medium: '中', low: '低', not_examinable: '不考' }[p.level]), h('td', null, p.chapters.join('、')), h('td', { class: 'small' }, p.reason))))))) : null,
    exam.caveats.length ? h('div', { class: 'notice' }, h('ul', null, exam.caveats.map((c) => h('li', null, c)))) : null);
}

async function showReport(cid, chid) {
  const { report } = await api.get(paths.chapter(cid, chid));
  if (!report) return toast('还没有校验报告', true);
  const st = report.stats;
  modal(`校验报告：${chid}`,
    h('p', null, `${report.errors} 个错误 · ${report.warnings} 个警告 · ${new Date(report.at).toLocaleString()}`),
    h('div', { class: 'tbl' }, h('table', null, h('tbody', null,
      h('tr', null, h('th', null, '数值核算'), h('td', null, `通过 ${st.numeric[0]} · 失败 ${st.numeric[1]} · 未验证 ${st.numeric[2]}`)),
      h('tr', null, h('th', null, 'SQL 执行'), h('td', null, `成功 ${st.sql[0]} · 失败 ${st.sql[1]}`)),
      h('tr', null, h('th', null, '证据'), h('td', null, `有效 ${st.evidence[0]} · 无效 ${st.evidence[1]}`)),
      h('tr', null, h('th', null, '公式渲染'), h('td', null, `正常 ${st.katex[0]} · 错误 ${st.katex[1]}`)),
      h('tr', null, h('th', null, '交互组件'), h('td', null, `正常 ${st.widgets[0]} · 问题 ${st.widgets[1]}`)),
      h('tr', null, h('th', null, '诚信比对'), h('td', null, `通过 ${st.integrity[0]} · 移除解答 ${st.integrity[1]}`))))),
    report.issues.length ? h('div', null, h('h4', null, '自动校验问题'), h('ul', null, report.issues.map((i) => h('li', { class: i.severity === 'error' ? 'err' : '' }, `[${i.check}] ${i.where}：${i.problem}`)))) : h('p', { class: 'ok' }, '自动校验没有发现问题。'),
    report.review?.length ? h('div', null, h('h4', null, '模型审稿意见（未自动修改）'), h('ul', null, report.review.map((r) => h('li', null, `块 ${r.block_index}（${r.severity}）：${r.problem}`, h('div', { class: 'small muted' }, `建议：${r.suggestion}`))))) : null,
    report.review_error ? h('p', { class: 'err' }, `审稿失败：${report.review_error}`) : null);
}

async function reviewUpdate(cid, uid) {
  const u = await api.get(`${paths.course(cid)}/updates/${encodeURIComponent(uid)}`);
  const cbs = [];
  const close = modal('增量更新：变更清单',
    h('p', { class: 'small muted' }, u.coverage_note),
    h('div', null, u.changes.map((c) => {
      const cb = h('input', { type: 'checkbox', checked: !c.problem, disabled: Boolean(c.problem), value: String(c.idx) });
      cbs.push(cb);
      return h('div', { class: 'card' }, h('label', { class: 'row' }, cb, h('b', null, `${c.chapter_id} · ${c.op} @ ${c.block_index} · ${c.change_type}`)),
        h('p', { class: 'small' }, c.reason), c.evidence_quote ? h('p', { class: 'small muted' }, `依据：“${c.evidence_quote}”`) : null,
        c.problem ? h('p', { class: 'err small' }, `无法应用：${c.problem}`) : null,
        c.block ? h('div', { class: 'small' }, renderBlocks([c.block], { courseId: cid })) : null);
    })),
    h('button', { class: 'btn primary', onclick: async () => {
      const accept = cbs.filter((x) => x.checked).map((x) => Number(x.value));
      try { const r = await api.post(`${paths.course(cid)}/updates/${encodeURIComponent(uid)}/apply`, { accept }); toast(`已应用 ${r.applied} 项变更并重新校验`); close(); studio(cid); } catch (e) { toast(e.message, true); }
    } }, '应用所选变更'));
}

// ---------------- 资料原文 / 证据查看 ----------------
function highlighted(text, quote) {
  const t = String(text);
  const q = String(quote || '').split(/\.{3}|…/)[0].trim();
  const i = q.length >= 4 ? t.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return h('div', { class: 'pagetext' }, t);
  return h('div', { class: 'pagetext' }, t.slice(0, i), h('mark', null, t.slice(i, i + q.length)), t.slice(i + q.length));
}

async function openMaterial(cid, mid, page = null, quote = null) {
  const m = await api.get(paths.material(cid, mid));
  let pages = m.pages;
  if (quote) {
    const q = String(quote).split(/\.{3}|…/)[0].trim().toLowerCase();
    const hit = m.pages.find((p) => p.text.toLowerCase().includes(q));
    if (hit) page = hit.n;
  }
  if (page) pages = m.pages.filter((p) => Math.abs(p.n - page) <= 1);
  modal(`${m.filename}（${ROLE_LABEL[m.role]}）`,
    page ? h('p', { class: 'muted small' }, `显示第 ${page} 页/段附近`) : h('p', { class: 'muted small' }, `共 ${m.pages.length} 页/段`),
    pages.slice(0, 60).map((p) => h('div', null, h('h4', null, `${m.role === 'transcript' ? '第' : 'p.'}${p.n}${m.role === 'transcript' ? ' 段' : ''} ${p.timestamp || ''}`), highlighted(p.text, quote), p.needs_vision ? h('p', { class: 'muted small' }, '（本页无可提取文字，可在资料表点"图像识别"）') : null,
      p.vision?.done ? h('p', { class: 'muted small' }, `本页经过图像识别${p.vision.handwriting ? '，含手写内容' : ''}；清晰度：${{ high: '清楚', medium: '一般', low: '看不太清' }[p.vision.confidence] || ''}${p.vision.notes ? `；${p.vision.notes}` : ''}。手写内容可能有误，请对照原件。`) : null)));
}

function showEvidence(cid, e, mats) {
  modal(`证据：${EV_LABEL[e.type] || e.type}`,
    h('blockquote', { class: 'box key' }, `“${e.quote}”`),
    h('p', { class: 'small' }, `来源：${mats.get(e.material_id)?.filename || e.material_id} · ${e.location}`),
    e.boundary ? h('p', { class: 'small' }, `边界：${e.boundary}`) : null,
    h('p', { class: 'small' }, `指向：${e.target}`),
    e.confidence === 'low' ? h('p', { class: 'small err' }, `指代不明：${e.note || ''}`) : null,
    h('p', { class: 'small' }, e.quote_found ? h('span', { class: 'ok' }, '✓ 原文已在资料中找到') : h('span', { class: 'err' }, '✗ 原文未在资料中找到')),
    h('button', { class: 'btn', onclick: () => openMaterial(cid, e.material_id, null, e.quote) }, '跳到资料原文'));
}

// ---------------- 学习书（Reader） ----------------
const chapterCache = new Map();
const openedThisSession = new Set();

async function reader(cid, chid, anc) {
  const [d, progress] = await Promise.all([api.get(paths.course(cid)), api.get(`${paths.course(cid)}/progress`)]);
  const { course } = d;
  // 旧版本把"已掌握"存在浏览器里：第一次打开时搬到服务端
  const legacy = store.get(`ez-done:${cid}`, null);
  if (Array.isArray(legacy) && legacy.length && !progress.mastered.length) {
    progress.mastered = legacy;
    api.put(`${paths.course(cid)}/progress`, { mastered: legacy }).then(() => store.del(`ez-done:${cid}`)).catch(() => {});
  }
  if (!openedThisSession.has(cid)) { openedThisSession.add(cid); api.put(`${paths.course(cid)}/progress`, { opened: true }).catch(() => {}); }
  const done = new Set(progress.mastered);
  const bookmarks = progress.bookmarks;
  const mats = new Map(d.materials.map((m) => [m.id, m]));
  const evMap = new Map(d.evidence.map((e) => [e.id, e]));

  const search = h('input', { id: 'search', type: 'text', placeholder: '搜索（中英文）', 'aria-label': '搜索' });
  const nav = h('nav', { id: 'nav' });
  const content = h('div', { id: 'content' });
  const sidebar = h('aside', { id: 'sidebar' },
    h('div', { id: 'sb-head' }, h('div', { class: 'brand' }, course.code), h('div', { class: 'sub' }, course.title), search),
    nav, h('div', { id: 'sb-foot' }, h('a', { class: 'btn', href: '#/' }, '历史课程'), h('a', { class: 'btn', href: `#/c/${encodeURIComponent(cid)}` }, '管理这门课')));
  clear($app).add(
    h('button', { id: 'menu-btn', class: 'btn', onclick: () => document.body.classList.toggle('sb-open') }, '☰ 目录'),
    h('div', { id: 'scrim', onclick: () => document.body.classList.remove('sb-open') }),
    sidebar, h('div', { id: 'main' }, content));

  // 侧栏：分组目录
  const order = d.plan?.chapters?.map((c) => c.id) || [];
  const chapters = [...d.chapters].sort((a, b) => (order.indexOf(a.id) - order.indexOf(b.id)) || String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
  const chTitle = new Map(chapters.map((c) => [c.id, `${c.number} ${c.title}`]));
  setTitleContext(chid && chTitle.get(chid) ? `${course.code} · ${chTitle.get(chid)}` : `${course.code} ${course.title}`);
  let chapter = null;
  if (chid) {
    if (!chapterCache.has(`${cid}/${chid}`)) chapterCache.set(`${cid}/${chid}`, api.get(paths.chapter(cid, chid)));
    try { chapter = (await chapterCache.get(`${cid}/${chid}`)).chapter; } catch (e) { chapterCache.delete(`${cid}/${chid}`); throw e; }
  }

  const removeBookmark = async (b) => {
    await api.del(`${paths.course(cid)}/bookmarks/${encodeURIComponent(b.id)}`);
    bookmarks.splice(bookmarks.indexOf(b), 1);
    drawNav();
  };
  const drawNav = () => {
    clear(nav).add(h('a', { class: `ch ${!chid ? 'active' : ''}`, href: readHref(cid) }, h('span', { class: 'no' }, '⌂'), h('span', { class: 'tt' }, '课程首页', h('small', null, '考核、真题与重点'))));
    if (bookmarks.length) {
      nav.add(h('details', { class: 'bm-list', open: true }, h('summary', { class: 'grp' }, `🔖 书签（${bookmarks.length}）`),
        [...bookmarks].reverse().map((b) => h('div', { class: 'bm-row' },
          h('a', { href: readHref(cid, b.chapter_id, b.anchor), title: chTitle.get(b.chapter_id) || '' }, b.label),
          h('button', { class: 'tp-btn', title: '删除书签', onclick: () => removeBookmark(b) }, '×')))));
    }
    let grp = null;
    for (const c of chapters) {
      if (c.group && c.group !== grp) { grp = c.group; nav.add(h('div', { class: 'grp' }, grp)); }
      nav.add(h('a', { class: `ch ${c.id === chid ? 'active' : ''}`, href: readHref(cid, c.id) },
        h('span', { class: 'no' }, c.number), h('span', { class: 'tt' }, c.title, c.title_exam_lang ? h('small', { class: 'en-small' }, c.title_exam_lang) : null),
        done.has(c.id) ? h('span', { class: 'done', title: '已掌握' }, '✓') : null, h('span', { class: 'w', title: '期末权重估计' }, dots(c.weight))));
      if (c.id === chid && chapter) {
        nav.add(h('div', { class: 'subs' }, chapter.blocks.filter((b) => b.type === 'heading').map((b) => h('a', { class: b.level === 3 ? 'lv3' : '', href: readHref(cid, chid, anchor(b.id)), 'data-id': anchor(b.id), onclick: (e) => { e.preventDefault(); document.getElementById(anchor(b.id))?.scrollIntoView(); document.body.classList.remove('sb-open'); } }, `${b.number} ${b.text}`)),
          chapter.blocks.some((b) => b.type === 'quick_ref') ? h('a', { href: readHref(cid, chid), 'data-id': 'quick-ref', onclick: (e) => { e.preventDefault(); document.getElementById('quick-ref')?.scrollIntoView(); } }, '本章速查') : null));
      }
    }
  };
  drawNav();

  let tmr;
  search.addEventListener('input', () => {
    clearTimeout(tmr);
    tmr = setTimeout(async () => {
      const q = search.value.trim();
      if (!q) return drawNav();
      const hits = await api.get(`${paths.course(cid)}/search?q=${encodeURIComponent(q)}`);
      clear(nav).add(h('div', { class: 'grp' }, `搜索结果（${hits.length}）`), hits.map((x) => h('a', { class: 'hit', href: readHref(cid, x.chapter_id), onclick: () => { sessionStorage.setItem('ez-find', q); } }, h('small', null, x.chapter), x.snippet)));
    }, 250);
  });

  const ctx = {
    courseId: cid, materials: mats, evidence: evMap,
    showEvidence: (e) => showEvidence(cid, e, mats),
    openMaterial: (mid, page) => openMaterial(cid, mid, page),
  };

  if (!chapter) {
    content.add(readerHome(cid, d, chapters, ctx, progress));
    window.scrollTo(0, 0);
    return;
  }

  // 加书签：记在某个小标题上（没有就记在本章开头）
  const headingName = new Map(chapter.blocks.filter((b) => b.type === 'heading').map((b) => [anchor(b.id), `${b.number || ''} ${b.text}`.trim()]));
  const placeName = (el) => (el && headingName.get(el.id)) || `${chapter.number} ${chapter.title}`;
  const addBookmark = async (headingEl) => {
    const label = placeName(headingEl).slice(0, 200);
    try {
      const bm = await api.post(`${paths.course(cid)}/bookmarks`, { chapter_id: chapter.id, anchor: headingEl?.id || null, label });
      bookmarks.push(bm);
      drawNav();
      toast(`已加书签：${label}`);
    } catch (e) { toast(e.message, true); }
  };
  const currentHeading = () => {
    const hs = [...content.querySelectorAll('h2[id], h3[id]')];
    let best = null;
    for (const x of hs) { if (x.getBoundingClientRect().top <= 120) best = x; else break; }
    return best;
  };

  // 章首卡片
  const marks = (d.exam?.marks_by_chapter || []).filter((m) => [chapter.id, chapter.number, chapter.title].some((k) => String(m.chapter_ref).includes(String(k))));
  const doneCb = h('input', { type: 'checkbox', checked: done.has(chapter.id) });
  doneCb.addEventListener('change', async () => {
    if (doneCb.checked) done.add(chapter.id); else done.delete(chapter.id);
    drawNav();
    try { await api.put(`${paths.course(cid)}/progress`, { mastered: [...done] }); } catch (e) { toast(e.message, true); }
  });
  const toggleAll = (open) => content.querySelectorAll('details.sol, details.num').forEach((x) => { x.open = open; });
  const verifyChip = d.chapters.find((c) => c.id === chapter.id)?.verify;
  content.add(h('div', { class: 'chead' },
    h('div', { class: 'kicker' }, `第 ${chapter.number} 章${chapter.week ? ` · ${chapter.week}` : ''}${chapter.group ? ` · ${chapter.group}` : ''}`),
    h('h1', null, chapter.title, chapter.title_exam_lang ? h('span', { class: 'en' }, chapter.title_exam_lang) : null),
    chapter.summary ? h('p', null, rich(chapter.summary)) : null,
    h('div', { class: 'meta' },
      chapter.weight ? h('span', { class: `chip ${chapter.weight >= 3 ? 'hot' : chapter.weight >= 2 ? 'mid' : ''}` }, `期末权重 ${dots(chapter.weight)}`) : null,
      marks.map((m) => h('span', { class: 'chip hot' }, `真题 ${m.marks} 分`)),
      (chapter.sources || []).map((s) => h('span', { class: 'chip' }, `${mats.get(s.material_id)?.filename || s.material_id}${s.pages ? ` ${s.pages}` : ''}`)),
      (chapter.lecture_dates || []).map((x) => h('span', { class: 'chip' }, `课堂 ${x}`)),
      verifyChip ? h('span', { class: `chip ${verifyChip.errors ? 'hot' : 'good'}`, title: '自动校验结果' }, verifyChip.errors ? `校验：${verifyChip.errors} 个问题` : '✓ 已通过自动校验') : null),
    h('div', { class: 'toolbar' }, h('button', { class: 'btn', onclick: () => toggleAll(true) }, '展开全部例子与解答'), h('button', { class: 'btn', onclick: () => toggleAll(false) }, '收起全部'),
      h('button', { class: 'btn', title: '在当前看到的位置加书签', onclick: () => addBookmark(currentHeading()) }, '🔖 在这里加书签'),
      h('label', { class: 'small row' }, doneCb, '已掌握'))));
  content.add(renderBlocks(chapter.blocks, ctx));
  // 每个小标题旁边的书签按钮
  content.querySelectorAll('h2[id], h3[id]').forEach((x) => x.append(h('button', { class: 'bm-btn', title: '给这一节加书签', onclick: () => addBookmark(x) }, '🔖')));
  if (chapter.todos?.length) content.add(h('div', { class: 'box pitfall' }, h('div', { class: 'bt' }, '待确认（生成时资料不足，未编造）'), h('ul', null, chapter.todos.map((t) => h('li', null, t)))));
  const idx = chapters.findIndex((c) => c.id === chapter.id);
  content.add(h('div', { class: 'row' }, idx > 0 ? h('a', { class: 'btn', href: readHref(cid, chapters[idx - 1].id) }, `← ${chapters[idx - 1].number} ${chapters[idx - 1].title}`) : null, h('span', { class: 'spacer' }),
    idx < chapters.length - 1 ? h('a', { class: 'btn', href: readHref(cid, chapters[idx + 1].id) }, `${chapters[idx + 1].number} ${chapters[idx + 1].title} →`) : null));

  // 定位：书签 / 上次位置 → 搜索关键词 → 章首
  const find = sessionStorage.getItem('ez-find');
  sessionStorage.removeItem('ez-find');
  const target = anc ? document.getElementById(anc) : null;
  if (target) {
    target.scrollIntoView({ block: 'start' });
    target.classList.add('hl');
  } else if (find) {
    const el = [...content.querySelectorAll('p,li,td,h2,h3,pre,summary')].find((x) => x.textContent.toLowerCase().includes(find.toLowerCase()));
    if (el) { el.closest('details')?.setAttribute('open', ''); el.scrollIntoView({ block: 'center' }); el.classList.add('hl'); } else window.scrollTo(0, 0);
  } else window.scrollTo(0, 0);

  // 记住阅读位置（停止滚动 1.5 秒后保存）
  const saveLast = () => {
    if (!content.isConnected) return;
    const hd = currentHeading();
    api.put(`${paths.course(cid)}/progress`, { last: { chapter_id: chapter.id, anchor: hd?.id || null, title: placeName(hd).slice(0, 200) } }).catch(() => {});
  };
  saveLast();
  let st;
  const onScroll = () => { if (!content.isConnected) { window.removeEventListener('scroll', onScroll); return; } clearTimeout(st); st = setTimeout(saveLast, 1500); };
  window.addEventListener('scroll', onScroll, { passive: true });

  // 滚动高亮当前小节
  const links = [...nav.querySelectorAll('.subs a')];
  const io = new IntersectionObserver((ents) => {
    ents.filter((e) => e.isIntersecting).forEach((e) => links.forEach((a) => a.classList.toggle('on', a.getAttribute('data-id') === e.target.id)));
  }, { rootMargin: '0px 0px -70% 0px' });
  content.querySelectorAll('h2[id], h3[id]').forEach((x) => io.observe(x));
}

function readerHome(cid, d, chapters, ctx, progress) {
  const { course } = d;
  const mats = ctx.materials;
  const notEx = d.evidence.filter((e) => e.quote_found && e.type === 'not_examinable');
  const emph = d.evidence.filter((e) => e.quote_found && e.type === 'emphasised');
  const last = progress?.last;
  return h('div', null,
    h('div', { class: 'chead' }, h('div', { class: 'kicker' }, '课程首页'), h('h1', null, `${course.code} ${course.title}`),
      h('p', null, `讲解语言：${course.teaching_language}；考试语言：${course.exam_language}。术语格式为"讲解语言 (考试语言)"，可在左下角隐藏英文。`),
      last?.chapter_id ? h('p', null, h('a', { class: 'btn primary', href: readHref(cid, last.chapter_id, last.anchor) }, `继续阅读：${last.title || last.chapter_id}`)) : null,
      h('div', { class: 'legend' }, h('span', { class: 'badge key' }, '★ 重点'), h('span', { class: 'badge exam' }, '✎ 真题'), h('span', { class: 'badge skip' }, '⊘ 不考'), h('span', { class: 'badge inf' }, '推断'),
        h('span', { class: 'small muted' }, '每个标记都可点开查看老师原话或资料出处；没有证据的不会标"不考"。'))),
    course.coverage_note ? h('div', { class: 'notice' }, course.coverage_note) : null,
    h('h2', null, '章节'),
    chapters.length ? h('div', { class: 'tbl' }, h('table', null, h('tbody', null, chapters.map((c) => h('tr', null, h('td', null, c.number), h('td', null, h('a', { href: readHref(cid, c.id) }, c.title), c.title_exam_lang ? h('span', { class: 'en' }, c.title_exam_lang) : null, progress?.mastered?.includes(c.id) ? h('span', { class: 'chip good' }, '✓ 已掌握') : null), h('td', null, c.week || ''), h('td', { class: 'w' }, dots(c.weight))))))) : h('p', { class: 'muted' }, '还没有生成章节。到"管理"页运行流水线。'),
    d.coverage?.length ? h('div', null, h('h2', null, '证据覆盖范围'), h('p', { class: 'small muted' }, '没有转录或批注的周次 / 章节不会出现"不考"标记。'),
      h('div', { class: 'tbl' }, h('table', null, h('tbody', null, d.coverage.map((c) => h('tr', null, h('td', null, c.week_or_chapter), h('td', null, c.has_transcript ? '有转录' : h('span', { class: 'muted' }, '无转录')), h('td', null, c.has_annotations ? '有批注' : h('span', { class: 'muted' }, '无批注')))))))) : null,
    d.exam ? h('div', null, h('h2', null, '考核结构与真题分析'), examView(d.exam, d)) : null,
    notEx.length ? h('div', null, h('h2', null, '老师明确说不考 / 可略的内容'), notEx.map((e) => h('div', { class: 'box skip' }, h('div', { class: 'bt' }, '⊘ ', e.target, h('button', { class: 'badge skip', onclick: () => ctx.showEvidence(e) }, '原文')),
      h('p', null, `“${e.quote}”`), h('p', { class: 'small muted' }, `${mats.get(e.material_id)?.filename || ''} · ${e.location}${e.boundary ? ` · 边界：${e.boundary}` : ''}`)))) : null,
    emph.length ? h('div', null, h('h2', null, '老师强调过的内容'), h('ul', null, emph.map((e) => h('li', null, `“${e.quote}” `, h('span', { class: 'small muted' }, `${e.location} → ${e.target}`), h('button', { class: 'badge key', onclick: () => ctx.showEvidence(e) }, '原文'))))) : null);
}
