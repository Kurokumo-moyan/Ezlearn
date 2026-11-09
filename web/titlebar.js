// 软件顶部标题栏：替代系统标题栏。显示软件名、当前位置、常用按钮；在桌面版里还有"最小化 / 最大化 / 关闭"，
// 空白处可以拖动窗口、双击最大化（由 WebView2 的 app-region 实现）。在普通浏览器里打开时没有窗口按钮。
import { h } from './dom.js';

const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
export const isDesktop = Boolean(host);

let ctxEl = null;
let maxBtn = null;
let nativeDrag = true;

export function mountTitlebar(navButtons) {
  if (document.getElementById('titlebar')) return;
  ctxEl = h('span', { class: 'tb-ctx' });
  const drag = h('div', { class: 'tb-drag' },
    h('a', { class: 'tb-brand', href: '#/', title: '回到首页' }, h('span', { class: 'tb-logo', 'aria-hidden': 'true' }, 'E'), h('span', { class: 'tb-name' }, 'Ezlearn 通用学习软件')),
    ctxEl);
  const bar = h('header', { id: 'titlebar', role: 'banner' }, drag, h('div', { class: 'tb-nav' }, navButtons));
  if (host) {
    const wc = (cls, title, label, cmd) => h('button', { class: `wc ${cls}`, title, 'aria-label': title, tabindex: '-1', onclick: () => host.postMessage(cmd) }, label);
    maxBtn = wc('max', '最大化', '▢', 'max');
    bar.add(h('div', { class: 'tb-wc' }, wc('min', '最小化', '—', 'min'), maxBtn, wc('close', '关闭', '✕', 'close')));
    host.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.type !== 'window') return;
      document.body.classList.toggle('maximized', Boolean(d.maximized));
      maxBtn.title = d.maximized ? '还原' : '最大化';
      maxBtn.setAttribute('aria-label', maxBtn.title);
      maxBtn.textContent = d.maximized ? '❐' : '▢';
      nativeDrag = d.nativeDrag !== false;
    });
    // 旧版 WebView2 运行时不支持 CSS 拖动区域时，改由宿主程序拖动
    drag.addEventListener('mousedown', (e) => {
      if (nativeDrag || e.button !== 0 || e.target.closest('a,button,input,select')) return;
      host.postMessage(e.detail === 2 ? 'max' : 'drag');
    });
    document.documentElement.classList.add('desktop');
  }
  document.body.prepend(bar);
  if (host) { host.postMessage('ready'); syncHostBackground(); }
}

/** 标题栏上的"当前位置"，同时作为任务栏里显示的窗口标题。 */
export function setTitleContext(text) {
  if (ctxEl) ctxEl.textContent = text ? text : '';
  document.title = text ? `${text} — Ezlearn` : 'Ezlearn 通用学习软件';
}

/** 让窗口边框颜色跟随白天 / 黑夜主题。 */
export function syncHostBackground() {
  if (!host) return;
  const m = getComputedStyle(document.body).backgroundColor.match(/\d+/g);
  if (!m || m.length < 3) return;
  const hex = m.slice(0, 3).map((x) => Number(x).toString(16).padStart(2, '0')).join('');
  host.postMessage(`bg:#${hex}`);
}
