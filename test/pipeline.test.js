import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testEnv, startServer, waitJob } from './helpers.js';

const PORT = 5902;
testEnv(PORT);
let S;
before(async () => { S = await startServer(PORT); });
after(async () => { await S.close(); });

const SAMPLES = path.resolve('samples', 'sql-demo');

test('full pipeline S1 → S8 with fake model', async () => {
  const c = await S.call('POST', '/api/courses', { code: 'T-SQL', title: 'Test course' });
  assert.equal(c.status, 201);
  const cid = c.json.id;

  // S1
  const fd = new FormData();
  for (const f of ['DEMO-SQL_course_outline.txt', 'week03_slides_joins_grouping.txt', 'week03_lecture_transcript.txt', 'company.sql', 'assignment1_spec.txt']) {
    fd.append('files', new Blob([fs.readFileSync(path.join(SAMPLES, f))]), f);
  }
  const up = await S.call('POST', `/api/courses/${cid}/materials`, fd);
  assert.equal(up.status, 201, JSON.stringify(up.json));
  assert.equal(up.json.created.length, 5);
  const roles = Object.fromEntries(up.json.created.map((m) => [m.filename, m.role]));
  assert.equal(roles['week03_lecture_transcript.txt'], 'transcript');
  assert.equal(roles['company.sql'], 'dataset');
  assert.equal(roles['assignment1_spec.txt'], 'assignment');

  // S2–S5
  let r = await S.call('POST', `/api/courses/${cid}/run`, { stage: 'analyze' });
  assert.equal(r.status, 202);
  let job = await waitJob(S.call, cid);
  assert.equal(job.status, 'done', job.error);
  let d = (await S.call('GET', `/api/courses/${cid}`)).json;
  assert.ok(d.evidence.length > 0);
  assert.ok(d.evidence.every((e) => typeof e.quote_found === 'boolean'));
  assert.ok(d.evidence.some((e) => e.quote_found), 'fake evidence quotes come from the material, so some must verify');
  assert.deepEqual(d.course.profiles, ['database_sql']);
  assert.ok(d.plan && !d.plan.confirmed);

  // 未确认方案时拒绝生成章节
  r = await S.call('POST', `/api/courses/${cid}/run`, { stage: 'all_chapters' });
  job = await waitJob(S.call, cid);
  assert.equal(job.status, 'error');

  // 确认方案
  const { confirmed, at, ...plan } = d.plan;
  r = await S.call('PUT', `/api/courses/${cid}/plan`, { plan, confirmed: true });
  assert.equal(r.status, 200);

  // S6 + S7
  r = await S.call('POST', `/api/courses/${cid}/run`, { stage: 'all_chapters', review: true });
  job = await waitJob(S.call, cid);
  assert.equal(job.status, 'done', job.error);
  d = (await S.call('GET', `/api/courses/${cid}`)).json;
  assert.equal(d.chapters.length, 1);
  const chId = d.chapters[0].id;
  const ch = (await S.call('GET', `/api/courses/${cid}/chapters/${chId}`)).json;
  const code = ch.chapter.blocks.find((b) => b.type === 'code');
  assert.ok(code.result, 'SQL code block must carry the real execution result');
  assert.equal(code.result.rows[0][0], 3, 'fake model counts the first table (departments) of the sample db');
  const ex = ch.chapter.blocks.find((b) => b.type === 'example');
  assert.equal(ex.verified, 'pass');

  // 搜索
  const s = await S.call('GET', `/api/courses/${cid}/search?q=${encodeURIComponent('关系')}`);
  assert.ok(s.json.length > 0);

  // S8
  const fd2 = new FormData();
  fd2.append('files', new Blob([fs.readFileSync(path.join(SAMPLES, 'final_exam_2025.txt'))]), 'final_exam_2025.txt');
  const up2 = await S.call('POST', `/api/courses/${cid}/materials`, fd2);
  r = await S.call('POST', `/api/courses/${cid}/run`, { stage: 'update', material_ids: [up2.json.created[0].id] });
  job = await waitJob(S.call, cid);
  assert.equal(job.status, 'done', job.error);
  const upd = job.result;
  assert.equal(upd.status, 'pending');
  const before = ch.chapter.blocks.length;
  r = await S.call('POST', `/api/courses/${cid}/updates/${upd.id}/apply`, { accept: upd.changes.map((c) => c.idx) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const after2 = (await S.call('GET', `/api/courses/${cid}/chapters/${chId}`)).json.chapter;
  assert.equal(after2.blocks.length, before + 1);
  assert.equal(after2.blocks[after2.blocks.length - 1].type, 'quick_ref', 'appended block goes before quick_ref');

  // 不能重复应用
  r = await S.call('POST', `/api/courses/${cid}/updates/${upd.id}/apply`, { accept: [0] });
  assert.equal(r.status, 409);

  // 删除课程
  r = await S.call('DELETE', `/api/courses/${cid}`);
  assert.equal(r.status, 204);
  r = await S.call('GET', `/api/courses/${cid}`);
  assert.equal(r.status, 404);
});
