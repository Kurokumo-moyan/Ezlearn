// 安全的算术表达式求值器（浏览器与服务端共用）。
// 交互组件（计算器、函数图）的公式来自 LLM 输出，绝不能用 eval / new Function。
// 这里只支持：数字、变量、+ - * / ^、括号、一元负号、白名单函数和常量。

const FUNCS = {
  sqrt: Math.sqrt, exp: Math.exp, ln: Math.log, log: Math.log, log10: Math.log10, log2: Math.log2,
  abs: Math.abs, min: Math.min, max: Math.max, pow: Math.pow, round: Math.round, floor: Math.floor, ceil: Math.ceil,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan, sign: Math.sign,
};
const CONSTS = { pi: Math.PI, e: Math.E };
const MAX_LEN = 500;
const MAX_DEPTH = 40;

function tokenize(src) {
  if (typeof src !== 'string' || src.length > MAX_LEN) throw new Error('expression too long');
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
    if (m) { out.push({ t: 'num', v: Number(m[1]) }); i += m[1].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    if ('+-*/^(),'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`unexpected character '${c}'`);
  }
  return out;
}

/** 编译成 AST；返回 (vars) => number。 */
export function compile(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => {
    if (!toks[p] || toks[p].t !== t) throw new Error(`expected '${t}'`);
    return toks[p++];
  };
  function expr(d) {
    if (d > MAX_DEPTH) throw new Error('expression too deep');
    let left = term(d + 1);
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p++].t;
      const right = term(d + 1);
      left = { op, a: left, b: right };
    }
    return left;
  }
  function term(d) {
    let left = unary(d + 1);
    while (peek() && (peek().t === '*' || peek().t === '/')) {
      const op = toks[p++].t;
      const right = unary(d + 1);
      left = { op, a: left, b: right };
    }
    return left;
  }
  function unary(d) {
    if (d > MAX_DEPTH) throw new Error('expression too deep');
    if (peek() && peek().t === '-') { p++; return { op: 'neg', a: unary(d + 1) }; }
    if (peek() && peek().t === '+') { p++; return unary(d + 1); }
    return power(d + 1);
  }
  function power(d) {
    const base = atom(d + 1);
    if (peek() && peek().t === '^') { p++; return { op: '^', a: base, b: unary(d + 1) }; }
    return base;
  }
  function atom(d) {
    const tk = peek();
    if (!tk) throw new Error('unexpected end');
    if (tk.t === 'num') { p++; return { num: tk.v }; }
    if (tk.t === '(') { p++; const e = expr(d + 1); eat(')'); return e; }
    if (tk.t === 'id') {
      p++;
      if (peek() && peek().t === '(') {
        if (!Object.hasOwn(FUNCS, tk.v)) throw new Error(`unknown function ${tk.v}`);
        p++;
        const args = [];
        if (peek() && peek().t !== ')') {
          args.push(expr(d + 1));
          while (peek() && peek().t === ',') { p++; args.push(expr(d + 1)); }
        }
        eat(')');
        return { fn: tk.v, args };
      }
      return { id: tk.v };
    }
    throw new Error(`unexpected token ${tk.t}`);
  }
  const ast = expr(0);
  if (p !== toks.length) throw new Error('trailing input');

  const ev = (n, vars) => {
    if ('num' in n) return n.num;
    if ('id' in n) {
      if (Object.hasOwn(vars, n.id)) return Number(vars[n.id]);
      if (Object.hasOwn(CONSTS, n.id)) return CONSTS[n.id];
      throw new Error(`unknown variable ${n.id}`);
    }
    if ('fn' in n) return FUNCS[n.fn](...n.args.map((a) => ev(a, vars)));
    const a = ev(n.a, vars);
    switch (n.op) {
      case 'neg': return -a;
      case '+': return a + ev(n.b, vars);
      case '-': return a - ev(n.b, vars);
      case '*': return a * ev(n.b, vars);
      case '/': return a / ev(n.b, vars);
      case '^': return a ** ev(n.b, vars);
      default: throw new Error('bad op');
    }
  };
  return (vars = {}) => ev(ast, vars);
}

export function evaluate(src, vars) {
  return compile(src)(vars);
}
