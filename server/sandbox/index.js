// 执行校验用的沙箱。设计原则：LLM 生成的代码（可能被资料中的提示注入影响）绝不在宿主进程中直接执行。
//   - SQL：sql.js（WASM）在 worker 线程中执行，有超时与堆内存上限，数据库是一次性的内存副本。
//   - JS ：QuickJS（WASM）上下文，无 I/O、无网络、无 require，有内存与执行时间上限。
//   - Python / R 等：不在本机执行，标记为"未经执行验证"。
import { Worker } from 'node:worker_threads';
import { getQuickJS, shouldInterruptAfterDeadline } from 'quickjs-emscripten';
import { config } from '../config.js';

const WORKER_URL = new URL('./sql-worker.js', import.meta.url);

export function runSQL(setup, query, { timeoutMs = config.limits.sandboxMs * 2, maxRows = config.limits.sqlRows } = {}) {
  return new Promise((resolve) => {
    if (typeof query !== 'string' || query.length > 20000) return resolve({ ok: false, error: 'query too long' });
    const w = new Worker(WORKER_URL, {
      workerData: { setup: String(setup || '').slice(0, 5_000_000), query, maxRows },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
      env: {}, // 不继承环境变量（含 API key）
      execArgv: [], // 不继承宿主的 node 启动参数
    });
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); w.terminate(); resolve(r); } };
    const t = setTimeout(() => finish({ ok: false, error: `timeout after ${timeoutMs}ms` }), timeoutMs);
    w.once('message', finish);
    w.once('error', (e) => finish({ ok: false, error: String(e.message || e).slice(0, 300) }));
    w.once('exit', (code) => finish({ ok: false, error: `worker exited ${code}` }));
  });
}

let quickjs = null;

export async function runJS(code, { timeoutMs = config.limits.sandboxMs, memBytes = config.limits.sandboxMemBytes } = {}) {
  if (typeof code !== 'string' || code.length > 20000) return { ok: false, error: 'code too long' };
  quickjs ||= await getQuickJS();
  const rt = quickjs.newRuntime();
  rt.setMemoryLimit(memBytes);
  rt.setMaxStackSize(1024 * 1024);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + timeoutMs));
  const vm = rt.newContext();
  try {
    // 用 JSON 往返确保结果是纯数据
    const r = vm.evalCode(`JSON.stringify((function(){ return eval(${JSON.stringify(code)}); })())`);
    if (r.error) {
      const err = vm.dump(r.error);
      r.error.dispose();
      return { ok: false, error: String(err?.message || err?.name || JSON.stringify(err)).slice(0, 300) };
    }
    const s = vm.dump(r.value);
    r.value.dispose();
    return { ok: true, value: s === undefined ? null : JSON.parse(s) };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 300) };
  } finally {
    vm.dispose();
    rt.dispose();
  }
}

/** 带数值容差的深比较。 */
export function deepClose(a, b, tol = 1e-6) {
  if (typeof a === 'number' || typeof b === 'number') {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return a === b;
    return Math.abs(x - y) <= tol * Math.max(1, Math.abs(x), Math.abs(y));
  }
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepClose(v, b[i], tol));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return deepClose(ka, kb) && ka.every((k) => deepClose(a[k], b[k], tol));
  }
  return a === b || String(a) === String(b);
}
