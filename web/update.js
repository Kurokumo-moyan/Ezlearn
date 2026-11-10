// 软件更新提示：启动时检查 GitHub 上的最新发布；有新版本时在标题栏下方弹出卡片，
// 用户可以选择 立即更新 / 保留当前版本（这次不更新，下次启动再问）/ 跳过这个版本（以后不再提示这个版本）。
// 下载、签名与 SHA-256 校验、启动安装程序都在服务端完成（server/updater.js）。
import { h, clear, toast } from './dom.js';
import { api } from './api.js';
import { helpIcon } from './help.js';

let card = null;
const LATER_KEY = 'ez-update-later';
const later = { get() { try { return sessionStorage.getItem(LATER_KEY); } catch { return null; } }, set(v) { try { sessionStorage.setItem(LATER_KEY, v); } catch { /* ignore */ } } };
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function close() { card?.remove(); card = null; }

/** 启动时调用：设置里关闭了检查、没配置仓库、本次已选“保留当前版本”或已跳过的版本都不打扰。 */
export async function checkOnStart() {
  try {
    const s = await api.get('/settings');
    if (!s.update_check || !s.update_repo) return;
    const u = await api.get('/update/check');
    if (u.newer && !u.skipped && later.get() !== u.latest) show(u);
  } catch { /* 没网或 GitHub 不可达：静默，不影响使用 */ }
}

/** 设置页“检查更新”按钮：总是联网检查，并告诉用户结果。 */
export async function checkNow(btn) {
  if (btn) btn.disabled = true;
  try {
    const u = await api.get('/update/check?force=1');
    if (!u.configured) toast('这个版本没有配置更新来源（GitHub 仓库）。', true);
    else if (u.newer) show(u);
    else toast(`已经是最新版本（${u.current}）`);
  } catch (e) {
    toast(`检查更新失败：${e.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function show(u) {
  close();
  const releases = `https://github.com/${u.repo}/releases/latest`;
  const body = h('div', { class: 'upd-body' });
  const actions = h('div', { class: 'row' });
  card = h('div', { class: 'upd-card', role: 'dialog', 'aria-label': '软件更新' },
    h('div', { class: 'row' }, h('strong', null, `发现新版本 ${u.latest}`), helpIcon('update'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn icon', title: '关闭（下次启动再提示）', onclick: () => { later.set(u.latest); close(); } }, '✕')),
    h('div', { class: 'small muted' }, `当前版本 ${u.current}${u.size ? ` · 安装包 ${mb(u.size)}` : ''}${u.published ? ` · 发布于 ${new Date(u.published).toLocaleDateString()}` : ''}`),
    body, actions);
  if (u.notes) body.append(h('div', { class: 'upd-notes' }, u.notes));
  const updateBtn = h('button', { class: 'btn primary', onclick: () => doUpdate(u, body, actions, releases) }, '立即更新');
  actions.append(
    updateBtn,
    h('button', { class: 'btn', onclick: () => { later.set(u.latest); close(); } }, '保留当前版本'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', title: '以后不再提示这个版本；有更新的版本时仍会提示', onclick: async () => {
      try { await api.put('/settings', { update_skip: u.latest }); close(); toast(`已跳过 ${u.latest}`); } catch (e) { toast(e.message, true); }
    } }, '跳过这个版本'));
  document.body.append(card);
}

async function doUpdate(u, body, actions, releases) {
  if (!u.can_install) {
    clear(body).append(h('p', { class: 'small' }, '现在是开发版运行，不能自动安装。请到 GitHub 下载新的安装包：', h('a', { href: releases, target: '_blank', rel: 'noopener' }, releases)));
    return;
  }
  clear(actions);
  const fill = h('div', { class: 'tp-fill' });
  const msg = h('div', { class: 'small' }, '正在下载……');
  clear(body).append(msg, h('div', { class: 'tp-bar' }, fill));
  try {
    let st = await api.post('/update/download');
    while (st.state === 'downloading') {
      fill.style.width = `${st.total ? Math.round((st.received / st.total) * 100) : 0}%`;
      msg.textContent = `正在下载 ${mb(st.received)} / ${mb(st.total)}`;
      await new Promise((r) => setTimeout(r, 600));
      st = await api.get('/update/status');
    }
    if (st.state !== 'ready') throw new Error(st.error || '下载失败');
    fill.style.width = '100%';
    msg.textContent = '下载完成，签名和文件校验通过。正在启动安装程序……';
    await api.post('/update/install');
    msg.textContent = '安装程序已启动：Ezlearn 会自动关闭，装好后自动重新打开。课程数据和设置都会保留。';
  } catch (e) {
    msg.textContent = e.data?.running ? '还有任务在运行，等它完成后再点“立即更新”。' : `更新失败：${e.message}`;
    actions.append(h('button', { class: 'btn', onclick: () => doUpdate(u, body, actions, releases) }, '重试'),
      h('button', { class: 'btn', onclick: () => { later.set(u.latest); close(); } }, '保留当前版本'));
  }
}

/** 设置页里的“更新”卡片。 */
export function updateSettingsCard(s) {
  const box = h('input', { type: 'checkbox', ...(s.update_check ? { checked: '' } : {}), onchange: async () => {
    try { await api.put('/settings', { update_check: box.checked }); toast(box.checked ? '启动时会检查更新' : '已关闭自动检查更新'); } catch (e) { toast(e.message, true); box.checked = !box.checked; }
  } });
  const btn = h('button', { class: 'btn', onclick: () => checkNow(btn) }, '检查更新');
  return h('div', { class: 'card' }, h('h3', null, '软件更新', helpIcon('update')),
    h('p', { class: 'small' }, `当前版本 ${s.version}`, s.update_repo ? ` · 更新来源 github.com/${s.update_repo}` : ' · 这个版本没有配置更新来源'),
    h('div', { class: 'row' }, h('label', { class: 'small' }, box, ' 启动时自动检查新版本'), h('span', { class: 'spacer' }), btn));
}
