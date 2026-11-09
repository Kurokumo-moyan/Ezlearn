import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { testEnv, startServer } from './helpers.js';

const PORT = 5901;
testEnv(PORT);
let S;
before(async () => { S = await startServer(PORT); });
after(async () => { await S.close(); });

function rawGet(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('rejects foreign Host header (DNS rebinding)', async () => {
  const r = await rawGet('/', { Host: 'evil.example:5901' });
  assert.equal(r.status, 421);
});

test('API requires session token', async () => {
  const r = await S.call('GET', '/api/courses', undefined, { 'X-Ezlearn-Token': 'wrong' });
  assert.equal(r.status, 401);
});

test('API rejects cross-origin requests even with token', async () => {
  const r = await S.call('GET', '/api/courses', undefined, { Origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  const r2 = await S.call('GET', '/api/courses', undefined, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(r2.status, 403);
});

test('index page carries strict CSP and token', async () => {
  const r = await S.call('GET', '/');
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.doesNotMatch(csp, /(^|\s)'unsafe-eval'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(r.text.includes(S.token));
});

test('static routes do not escape their directories', async () => {
  for (const p of ['/web/../server/config.js', '/web/%2e%2e/server/config.js', '/shared/..%2fpackage.json', '/vendor/katex/../../package.json']) {
    const r = await rawGet(p, { Host: `127.0.0.1:${PORT}` });
    assert.notEqual(r.status, 200, p);
  }
  const env = await rawGet('/.env', { Host: `127.0.0.1:${PORT}` });
  assert.notEqual(env.status, 200);
});

test('invalid ids are rejected (path traversal)', async () => {
  for (const id of ['..', '..%2f..%2fetc', 'A', 'x'.repeat(80)]) {
    const r = await S.call('GET', `/api/courses/${id}`);
    assert.ok([400, 404].includes(r.status), `${id} -> ${r.status}`);
  }
});

test('upload rejects disallowed types and fake PDFs; never uses client filename as path', async () => {
  const c = await S.call('POST', '/api/courses', { code: 'SEC1', title: 'Security' });
  const cid = c.json.id;
  const fd = new FormData();
  fd.append('files', new Blob(['MZ...']), 'evil.exe');
  const r1 = await S.call('POST', `/api/courses/${cid}/materials`, fd);
  assert.equal(r1.status, 415);

  const fd2 = new FormData();
  fd2.append('files', new Blob(['not a pdf']), 'fake.pdf');
  fd2.append('files', new Blob(['hello\n\nworld']), '../../../../etc/passwd.txt');
  const r2 = await S.call('POST', `/api/courses/${cid}/materials`, fd2);
  assert.equal(r2.status, 201);
  assert.equal(r2.json.errors.length, 1);
  assert.match(r2.json.errors[0].error, /PDF/);
  assert.equal(r2.json.created.length, 1);
  assert.match(r2.json.created[0].id, /^m-[a-f0-9]{12}$/);
  assert.doesNotMatch(r2.json.created[0].filename, /\//);

  const fd3 = new FormData();
  // 真正的二进制（不是 UTF-16 文本）仍然被拒绝
  fd3.append('files', new Blob([Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00])]), 'bin.txt');
  const r3 = await S.call('POST', `/api/courses/${cid}/materials`, fd3);
  assert.equal(r3.status, 400);
});

test('non-UTF-8 text is converted, held back until confirmed, and re-decodable', async () => {
  const cid = (await S.call('POST', '/api/courses', { code: 'ENC', title: 'Encoding' })).json.id;
  // "第一周：数据库的基本概念。老师说这一部分是考试重点，大家要认真复习。" 的 GB18030 字节（Node 没有内置 GBK 编码器）
  const gbBytes = Buffer.from('b5dad2bbd6dca3bacafdbeddbfe2b5c4bbf9b1beb8c5c4eea1a3c0cfcaa6cbb5d5e2d2bbb2bfb7d6cac7bfbccad4d6d8b5e3a3acb4f3bcd2d2aac8cfd5e6b8b4cfb0a1a3', 'hex');
  const fd = new FormData();
  fd.append('files', new Blob([gbBytes]), 'week1_notes.txt');
  const up = await S.call('POST', `/api/courses/${cid}/materials`, fd);
  assert.equal(up.status, 201);
  const item = up.json.created[0];
  assert.equal(item.needs_confirm, true);
  assert.match(item.encoding_label, /GB/);

  const pv = await S.call('GET', `/api/courses/${cid}/materials/${item.id}/encoding`);
  assert.equal(pv.json.encoding, 'gb18030');
  assert.match(pv.json.preview, /第一周/);
  assert.equal(pv.json.bad_chars, 0);
  const big5 = await S.call('GET', `/api/courses/${cid}/materials/${item.id}/encoding?enc=big5`);
  assert.doesNotMatch(big5.json.preview, /第一周/);
  assert.equal((await S.call('GET', `/api/courses/${cid}/materials/${item.id}/encoding?enc=../../x`)).status, 400);

  const { loadCtx } = await import('../server/pipeline.js');
  assert.equal((await loadCtx(cid)).materials.length, 0, 'unconfirmed material is not used');
  const ok = await S.call('POST', `/api/courses/${cid}/materials/${item.id}/encoding`, { encoding: 'gb18030' });
  assert.equal(ok.status, 200);
  const ctx = await loadCtx(cid);
  assert.equal(ctx.materials.length, 1);
  assert.match(ctx.materials[0].pages[0].text, /第一周：数据库/);
});

test('course meta is schema-validated (no extra fields)', async () => {
  const r = await S.call('POST', '/api/courses', { code: 'X', title: 'Y', __proto__: { admin: true }, extra: 1 });
  assert.equal(r.status, 400);
});

test('PATCH course only changes provided fields', async () => {
  const c = await S.call('POST', '/api/courses', { code: 'P1', title: 'Patch', teaching_language: 'English', exam_language: '中文' });
  const r = await S.call('PATCH', `/api/courses/${c.json.id}`, { title: 'Patched' });
  assert.equal(r.status, 200);
  assert.equal(r.json.title, 'Patched');
  assert.equal(r.json.teaching_language, 'English');
  assert.equal(r.json.exam_language, '中文');
});

test('error responses do not leak stack traces', async () => {
  const r = await S.call('POST', '/api/courses', '{bad json', { 'Content-Type': 'application/json' });
  assert.ok(r.status >= 400);
  assert.doesNotMatch(r.text, /at .*\.js:\d+/);
});

test('settings API masks keys, validates input; progress & bookmarks validate ids', async () => {
  const put = await S.call('PUT', '/api/settings', { provider: 'openai', api_key: 'sk-test-abcdefghijkl9876', model: 'gpt-x' });
  assert.equal(put.status, 200);
  assert.ok(!put.text.includes('sk-test-abcdefghijkl9876'), 'key must never be returned');
  assert.equal(put.json.providers.find((p) => p.id === 'openai').key_tail, '9876');
  assert.equal((await S.call('PUT', '/api/settings', { api_key: 'has space in it' })).status, 400);
  assert.equal((await S.call('PUT', '/api/settings', { provider: 'custom', base_url: 'http://evil.example/v1' })).status, 400);
  assert.equal((await S.call('PUT', '/api/settings', { provider: 'nope' })).status, 400);
  assert.equal((await S.call('PUT', '/api/settings', { clear_key: 'openai' })).json.providers.find((p) => p.id === 'openai').has_key, false);

  const cid = (await S.call('POST', '/api/courses', { code: 'BM', title: 'Bookmarks' })).json.id;
  assert.equal((await S.call('POST', '/api/courses', { code: 'X', title: 'Y', learner_level: '零基础' })).status, 400, 'learner level option removed');
  const bm = await S.call('POST', `/api/courses/${cid}/bookmarks`, { chapter_id: 'ch01', anchor: 'sec-s1-2', label: '1.2 主键' });
  assert.equal(bm.status, 201);
  assert.equal((await S.call('POST', `/api/courses/${cid}/bookmarks`, { chapter_id: '../x', label: 'bad' })).status, 400);
  assert.equal((await S.call('POST', `/api/courses/${cid}/bookmarks`, { chapter_id: 'ch01', anchor: '"><script>', label: 'bad' })).status, 400);
  await S.call('PUT', `/api/courses/${cid}/progress`, { mastered: ['ch01'], opened: true, last: { chapter_id: 'ch01', anchor: 'sec-s1-2', title: '1.2' } });
  const list = (await S.call('GET', '/api/courses')).json;
  const c = list.find((x) => x.id === cid);
  assert.equal(list[0].id, cid, 'most recently opened course first');
  assert.equal(c.progress.mastered, 1);
  assert.equal(c.progress.bookmarks[0].label, '1.2 主键');
  assert.equal((await S.call('DELETE', `/api/courses/${cid}/bookmarks/${bm.json.id}`)).status, 204);
  assert.equal((await S.call('GET', `/api/courses/${cid}/progress`)).json.bookmarks.length, 0);

  assert.equal((await S.call('PATCH', `/api/courses/${cid}`, { budget_usd: 45 })).status, 200);
  assert.equal((await S.call('GET', `/api/courses/${cid}`)).json.budget, 45);
  assert.equal((await S.call('PATCH', `/api/courses/${cid}`, { budget_usd: -1 })).status, 400);
  assert.ok(Array.isArray((await S.call('GET', '/api/jobs')).json));
  assert.equal((await S.call('POST', '/api/shutdown')).status, 409, 'not launched by the desktop launcher');
});
