// 行内富文本解析（浏览器与服务端共用）。输出 token 数组，渲染时只用 textContent / KaTeX，
// 从不把内容当 HTML 解释——LLM 输出和上传资料都是不可信数据。
// 语法：
//   {{教学语言术语|exam-language term}}   双语术语
//   $...$                                   行内公式（\$ 表示字面美元符）
//   **强调**                                 加粗（内部可含公式和术语）
//   `code`                                  行内代码

export function parseRich(src, depth = 0) {
  const s = String(src ?? '');
  const out = [];
  let buf = '';
  const flush = () => { if (buf) { out.push({ t: 'text', v: buf }); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '$') { buf += '$'; i += 2; continue; }
    if (c === '$') {
      const j = findUnescaped(s, '$', i + 1);
      if (j > i + 1) { flush(); out.push({ t: 'math', v: s.slice(i + 1, j) }); i = j + 1; continue; }
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i) { flush(); out.push({ t: 'code', v: s.slice(i + 1, j) }); i = j + 1; continue; }
    }
    if (c === '{' && s[i + 1] === '{') {
      const j = s.indexOf('}}', i + 2);
      if (j > i) {
        const inner = s.slice(i + 2, j);
        const bar = inner.indexOf('|');
        flush();
        out.push(bar >= 0 ? { t: 'term', teach: inner.slice(0, bar).trim(), exam: inner.slice(bar + 1).trim() } : { t: 'term', teach: inner.trim(), exam: '' });
        i = j + 2;
        continue;
      }
    }
    if (c === '*' && s[i + 1] === '*' && depth < 2) {
      const j = s.indexOf('**', i + 2);
      if (j > i + 2) { flush(); out.push({ t: 'bold', children: parseRich(s.slice(i + 2, j), depth + 1) }); i = j + 2; continue; }
    }
    buf += c;
    i++;
  }
  flush();
  return out;
}

function findUnescaped(s, ch, from) {
  for (let k = from; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === ch) return k;
  }
  return -1;
}

/** 收集一段富文本里的所有行内公式（用于服务端 KaTeX 预检）。 */
export function mathOf(src) {
  const acc = [];
  const walk = (toks) => toks.forEach((t) => (t.t === 'math' ? acc.push(t.v) : t.t === 'bold' ? walk(t.children) : null));
  walk(parseRich(src));
  return acc;
}

/** 纯文本形式（用于搜索、相似度比对）。 */
export function plainOf(src) {
  const walk = (toks) => toks.map((t) => (t.t === 'text' || t.t === 'code' || t.t === 'math' ? t.v : t.t === 'term' ? `${t.teach} ${t.exam}` : walk(t.children))).join('');
  return walk(parseRich(src));
}
