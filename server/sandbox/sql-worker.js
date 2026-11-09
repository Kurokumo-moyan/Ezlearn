// 在独立 worker 线程里运行 sql.js（SQLite 编译为 WASM，内存数据库，无宿主文件系统访问）。
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

async function main() {
  const initSqlJs = require('sql.js/dist/sql-wasm.js');
  const wasmBinary = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const SQL = await initSqlJs({ wasmBinary });
  const db = new SQL.Database();
  try {
    if (workerData.setup) db.exec(workerData.setup);
    const res = db.exec(workerData.query);
    const last = res[res.length - 1] || { columns: [], values: [] };
    const truncated = last.values.length > workerData.maxRows;
    parentPort.postMessage({ ok: true, columns: last.columns, rows: last.values.slice(0, workerData.maxRows), truncated });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: String(e.message || e).slice(0, 500) });
  } finally {
    db.close();
  }
}

main().catch((e) => parentPort.postMessage({ ok: false, error: String(e.message || e).slice(0, 500) }));
