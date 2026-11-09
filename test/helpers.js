import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 每个测试进程用独立的临时数据目录与端口，并启用假模型。必须在导入 server 模块之前调用。 */
export function testEnv(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ezlearn-test-'));
  process.env.EZLEARN_DATA_DIR = dir;
  process.env.EZLEARN_PORT = String(port);
  process.env.EZLEARN_FAKE_LLM = '1';
  process.env.EZLEARN_HOST = '127.0.0.1';
  return dir;
}

export async function startServer(port) {
  const { createApp } = await import('../server/index.js');
  const { ensureDataDir } = await import('../server/storage.js');
  const { SESSION_TOKEN } = await import('../server/security.js');
  ensureDataDir();
  const app = createApp();
  const server = await new Promise((r) => { const s = app.listen(port, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, url, body, headers = {}) => {
    const h = { 'X-Ezlearn-Token': SESSION_TOKEN, ...headers };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers: h, body: payload });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text, headers: r.headers };
  };
  return { server, base, call, token: SESSION_TOKEN, close: () => new Promise((r) => server.close(r)) };
}

export async function waitJob(call, cid, ms = 60000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call('GET', `/api/courses/${cid}/job`);
    if (r.json && r.json.status !== 'running') return r.json;
    if (Date.now() - t0 > ms) throw new Error('job timeout');
    await new Promise((res) => setTimeout(res, 100));
  }
}
