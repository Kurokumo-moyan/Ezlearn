// 软件更新：启动时检查 GitHub 上的最新发布；有新版本时在标题栏下方弹出卡片：
//   立即更新      → 在后台静默下载（右下角小标签显示进度，不打扰使用），下载并校验好后让用户选：
//                     立即重启更新 / 关闭 Ezlearn 后更新（下次关闭时静默安装，下次打开就是新版本）
//   保留当前版本  → 这次不更新，下次启动再问
//   跳过这个版本  → 以后不再提示这个版本
// 下载、签名与 SHA-256 校验、启动安装程序都在服务端完成（server/updater.js）。
import { h, clear, toast } from './dom.js';
import { api } from './api.js';
import { helpIcon } from './help.js';

let card = null;
let pill = null;
let polling = false;
let info = null; // 最近一次检查结果
const LATER_KEY = 'ez-update-later';
const later = { get() { try { return sessionStorage.getItem(LATER_KEY); } catch { return null; } }, set(v) { try { sessionStorage.setItem(LATER_KEY, v); } catch { /* ignore */ } } };
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function closeCard() { card?.remove(); card = null; }
function setPill(text, { onclick, bad = false, progress = null } = {}) {
  pill?.remove();
  let bar = null;
  if (progress !== null) {
    const fill = h('span');
    fill.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
    bar = h('span', { class: 'upd-pill-bar' }, fill);
  }
  pill = h('button', { class: `upd-pill${bad ? ' bad' : ''}`, type: 'button', title: onclick ? '点击查看' : '', onclick: onclick || null }, h('span', null, text), bar);
  if (!onclick) pill.disabled = true;
  document.body.append(pill);
}
function clearPill() { pill?.remove(); pill = null; }

/** 启动时调用：先接上可能还在进行的下载（刷新页面时），再看有没有新版本。 */
export async function checkOnStart() {
  try {
    const st = await api.get('/update/status');
    if (st.state === 'downloading' || st.state === 'ready') {
      info = await api.get('/update/check').catch(() => null);
      if (info?.newer) { follow(); return; }
    }
    const s = await api.get('/settings');
    if (!s.update_check || !s.update_repo) return;
    const u = await api.get('/update/check');
    if (u.newer && !u.skipped && later.get() !== u.latest) offer(u);
  } catch { /* 没网或 GitHub 不可达：静默，不影响使用 */ }
}

/** 设置页“检查更新”按钮：总是联网检查，并告诉用户结果。 */
export async function checkNow(btn) {
  if (btn) btn.disabled = true;
  try {
    const u = await api.get('/update/check?force=1');
    if (!u.configured) toast('这个版本没有配置更新来源（GitHub 仓库）。', true);
    else if (u.newer) offer(u);
    else toast(`已经是最新版本（${u.current}）`);
  } catch (e) {
    toast(`检查更新失败：${e.message}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function cardShell(title, ...kids) {
  closeCard();
  card = h('div', { class: 'upd-card', role: 'dialog', 'aria-label': '软件更新' },
    h('div', { class: 'row' }, h('strong', null, title), helpIcon('update'), h('span', { class: 'spacer' }),
      h('button', { class: 'btn icon', title: '收起', onclick: closeCard }, '✕')),
    ...kids);
  document.body.append(card);
  return card;
}

/** 第一步：发现新版本。 */
function offer(u) {
  info = u;
  const releases = `https://github.com/${u.repo}/releases/latest`;
  const body = h('div', { class: 'upd-body' });
  if (u.notes) body.append(h('div', { class: 'upd-notes' }, u.notes));
  const dismiss = () => { later.set(u.latest); closeCard(); };
  cardShell(`发现新版本 ${u.latest}`,
    h('div', { class: 'small muted' }, `当前版本 ${u.current}${u.size ? ` · 安装包 ${mb(u.size)}` : ''}${u.published ? ` · 发布于 ${new Date(u.published).toLocaleDateString()}` : ''}`),
    body,
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => {
        if (!u.can_install) {
          clear(body).append(h('p', { class: 'small' }, '现在是开发版运行，不能自动安装。请到 GitHub 下载新的安装包：', h('a', { href: releases, target: '_blank', rel: 'noopener' }, releases)));
          return;
        }
        startBackground();
      } }, '立即更新'),
      h('button', { class: 'btn', onclick: dismiss }, '保留当前版本'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', title: '以后不再提示这个版本；有更新的版本时仍会提示', onclick: async () => {
        try { await api.put('/settings', { update_skip: u.latest }); closeCard(); toast(`已跳过 ${u.latest}`); } catch (e) { toast(e.message, true); }
      } }, '跳过这个版本')));
  card.querySelector('.btn.icon').onclick = dismiss;
}

/** 第二步：后台静默下载。卡片收起，右下角小标签显示进度。 */
async function startBackground() {
  closeCard();
  try {
    await api.post('/update/download');
    toast('正在后台下载更新，可以继续使用，下载好后会提醒你。');
    follow();
  } catch (e) {
    setPill('更新下载失败，点击重试', { bad: true, onclick: startBackground });
    toast(e.message, true);
  }
}

async function follow() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const st = await api.get('/update/status');
      if (st.state === 'downloading') {
        setPill(`正在下载更新 ${st.version} · ${st.total ? Math.round((st.received / st.total) * 100) : 0}%`, { progress: st.total ? st.received / st.total : 0 });
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      if (st.state === 'ready') {
        if (st.install_on_exit) showQueued(st.version);
        else { setPill(`更新 ${st.version} 已准备好`, { onclick: () => askHow(st.version) }); askHow(st.version); }
      } else if (st.state === 'error') {
        setPill('更新下载失败，点击重试', { bad: true, onclick: startBackground });
        toast(`更新下载失败：${st.error || '未知错误'}`, true);
      } else clearPill();
      return;
    }
  } catch {
    setPill('更新状态暂时取不到，点击重试', { bad: true, onclick: () => follow() });
  } finally {
    polling = false;
  }
}

/** 第三步：下载并校验好了，让用户选立即重启更新还是关闭后更新。 */
function askHow(version) {
  const msg = h('div', { class: 'small' }, '安装包已下载，数字签名和文件校验都通过。课程数据和设置在更新后都会保留。');
  cardShell(`新版本 ${version} 已准备好`, h('div', { class: 'upd-body' }, msg),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary', onclick: () => restartNow(msg) }, '立即重启更新'),
      h('button', { class: 'btn', title: '现在继续使用；下次关闭 Ezlearn 时自动安装，再打开就是新版本', onclick: async () => {
        try { await api.post('/update/install-on-exit', { on: true }); closeCard(); showQueued(version); toast('好的，关闭 Ezlearn 后会自动安装新版本。'); } catch (e) { toast(e.message, true); }
      } }, '关闭后更新'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', title: '先不决定，点右下角“更新已准备好”可以再选', onclick: closeCard }, '稍后决定')));
}

function showQueued(version) {
  setPill(`关闭后将更新到 ${version}`, { onclick: () => {
    cardShell(`关闭后将更新到 ${version}`,
      h('div', { class: 'upd-body small' }, '下次关闭 Ezlearn 窗口时会在后台自动安装，再打开就是新版本。'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: (e) => restartNow(e.target.closest('.upd-card').querySelector('.upd-body')) }, '改为立即重启更新'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: async () => {
          try { await api.post('/update/install-on-exit', { on: false }); closeCard(); setPill(`更新 ${version} 已准备好`, { onclick: () => askHow(version) }); toast('已取消关闭后自动更新'); } catch (err) { toast(err.message, true); }
        } }, '取消自动更新')));
  } });
}

async function restartNow(msgEl) {
  try {
    await api.post('/update/install');
    if (msgEl) msgEl.textContent = '正在启动安装程序：Ezlearn 会自动关闭，装好后自动重新打开。';
    setPill('正在安装更新……');
  } catch (e) {
    if (msgEl) msgEl.textContent = e.data?.running ? '还有任务在运行，等它完成后再点，或者选“关闭后更新”。' : `更新失败：${e.message}`;
  }
}

/** 设置页里的“软件更新”卡片。 */
export function updateSettingsCard(s) {
  const box = h('input', { type: 'checkbox', checked: Boolean(s.update_check), onchange: async () => {
    try { await api.put('/settings', { update_check: box.checked }); toast(box.checked ? '启动时会检查更新' : '已关闭自动检查更新'); } catch (e) { toast(e.message, true); box.checked = !box.checked; }
  } });
  const btn = h('button', { class: 'btn', onclick: () => checkNow(btn) }, '检查更新');
  return h('div', { class: 'card' }, h('h3', null, '软件更新', helpIcon('update')),
    h('p', { class: 'small' }, `当前版本 ${s.version}`, s.update_repo ? ` · 更新来源 github.com/${s.update_repo}` : ' · 这个版本没有配置更新来源'),
    h('div', { class: 'row' }, h('label', { class: 'small' }, box, ' 启动时自动检查新版本'), h('span', { class: 'spacer' }), btn));
}
