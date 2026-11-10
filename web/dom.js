// 安全的 DOM 构造：只用 textContent / 属性白名单，永不 innerHTML。
const ATTRS = new Set(['class', 'id', 'type', 'value', 'title', 'for', 'name', 'placeholder', 'min', 'max', 'step', 'rows', 'cols', 'checked', 'disabled', 'selected', 'open', 'colspan', 'role', 'aria-label', 'aria-expanded', 'accept', 'multiple', 'href', 'viewBox', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'points', 'r', 'cx', 'cy', 'width', 'height', 'text-anchor', 'dominant-baseline', 'tabindex', 'data-id', 'spellcheck', 'autocomplete', 'target', 'rel', 'maxlength', 'inputmode', 'aria-live', 'aria-hidden', 'src', 'alt']);
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'path', 'line', 'polyline', 'polygon', 'circle', 'text', 'g', 'rect']);

function setAttr(el, k, v) {
  if (v === false || v === null || v === undefined) return;
  if (!ATTRS.has(k)) throw new Error(`attr not allowed: ${k}`);
  if (k === 'href') {
    // 只允许站内 hash 路由，或 https 外链（外链一律新窗口打开、不带 Referer、不给 opener）
    const s = String(v);
    if (s.startsWith('https://')) {
      if (!/^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~%/?=&#-]*)?$/.test(s)) throw new Error('bad external link');
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    } else if (!s.startsWith('#')) throw new Error('only hash or https links allowed');
  }
  if (k === 'target' || k === 'rel') return; // 由上面统一设置
  if (k === 'src' && !String(v).startsWith('blob:')) throw new Error('only blob: image sources allowed');
  if (k === 'checked' || k === 'selected' || k === 'open' || k === 'disabled' || k === 'multiple') {
    if (v) el.setAttribute(k, '');
    el[k] = Boolean(v);
    return;
  }
  if (k === 'value' && 'value' in el && !SVG_TAGS.has(el.localName)) { el.value = String(v); return; }
  el.setAttribute(k, String(v));
}

export function h(tag, attrs, ...kids) {
  const el = SVG_TAGS.has(tag) ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else setAttr(el, k, v);
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function frag(...kids) {
  return append(document.createDocumentFragment(), kids);
}

export function modal(title, ...body) {
  const bg = h('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) close(); } });
  const close = () => { bg.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc);
  bg.append(h('div', { class: 'modal', role: 'dialog' }, h('div', { class: 'row' }, h('h3', null, title), h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: close }, '关闭')), body));
  document.body.append(bg);
  return close;
}

export function toast(msg, bad = false) {
  const t = h('div', { class: `notice ${bad ? 'err' : ''}` }, msg);
  Object.assign(t.style, { position: 'fixed', right: '16px', bottom: '16px', zIndex: 60, maxWidth: '420px' });
  document.body.append(t);
  setTimeout(() => t.remove(), bad ? 7000 : 3500);
}

// 安全的追加：忽略 null/false、展开数组、字符串按文本节点处理。
for (const P of [Element.prototype, DocumentFragment.prototype]) {
  Object.defineProperty(P, 'add', { value(...kids) { append(this, kids); return this; }, configurable: true });
}
