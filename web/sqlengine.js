// 浏览器内 SQL 引擎：sql.js 跑在 Web Worker 里（WASM 内存数据库），可超时终止，不会卡死页面。
import { api, paths } from './api.js';

const datasetCache = new Map();

async function datasetSql(courseId) {
  if (!datasetCache.has(courseId)) datasetCache.set(courseId, api.get(`${paths.course(courseId)}/dataset`).then((r) => r.sql || ''));
  return datasetCache.get(courseId);
}

export class SqlEngine {
  constructor(courseId) {
    this.courseId = courseId;
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.ready = null;
  }

  _spawn() {
    this.worker = new Worker('/vendor/sqljs/worker.sql-wasm.js');
    this.worker.onmessage = (e) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      clearTimeout(p.timer);
      if (e.data.error) p.reject(new Error(e.data.error)); else p.resolve(e.data);
    };
    this.worker.onerror = (e) => { e.preventDefault(); };
  }

  _send(msg, timeoutMs) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill();
        reject(new Error(`执行超时（>${timeoutMs / 1000}s），已重置数据库`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, ...msg });
    });
  }

  kill() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('reset')); }
    this.pending.clear();
  }

  ensure() {
    if (!this.ready) {
      this.ready = (async () => {
        this._spawn();
        await this._send({ action: 'open' }, 15000);
        const setup = await datasetSql(this.courseId);
        if (setup) await this._send({ action: 'exec', sql: setup }, 15000);
      })().catch((e) => { this.ready = null; throw e; });
    }
    return this.ready;
  }

  /** 返回最后一条语句的结果 {columns, values}。 */
  async exec(sql, timeoutMs = 4000) {
    await this.ensure();
    const r = await this._send({ action: 'exec', sql }, timeoutMs);
    const res = r.results || [];
    return res[res.length - 1] || { columns: [], values: [] };
  }

  reset() { this.kill(); return this.ensure(); }
}

const shared = new Map();
/** 只读演示共用一个引擎；可写沙箱各自独立。 */
export function sharedEngine(courseId) {
  if (!shared.has(courseId)) shared.set(courseId, new SqlEngine(courseId));
  return shared.get(courseId);
}
