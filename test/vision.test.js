// 图像识别：PDF 页面渲染、图片上传校验、识别任务把转写结果并入页面文字（假模型，不调用真实 API）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testEnv, startServer, waitJob } from './helpers.js';

testEnv(5867);
let S;
before(async () => { S = await startServer(5867); });
after(() => S.close());

const PDF = fs.readFileSync(new URL('./fixtures/two-pages.pdf', import.meta.url));

test('PDF pages render to PNG; images are re-encoded', async () => {
  const { openPdf, normalizeImage } = await import('../server/pagerender.js');
  const doc = await openPdf(PDF);
  assert.equal(doc.pages, 2);
  const png = await doc.render(1);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  await doc.close();
  const again = await normalizeImage(png);
  assert.equal(again.subarray(1, 4).toString(), 'PNG');
});

test('image uploads: magic bytes checked, stored as a textless page', async () => {
  const cid = (await S.call('POST', '/api/courses', { code: 'IMG', title: 'Images' })).json.id;
  const { openPdf } = await import('../server/pagerender.js');
  const doc = await openPdf(PDF);
  const png = await doc.render(2);
  await doc.close();
  const fd = new FormData();
  fd.append('files', new Blob([png]), 'whiteboard.png');
  fd.append('files', new Blob([Buffer.from('not really a jpeg')]), 'fake.jpg');
  const r = await S.call('POST', `/api/courses/${cid}/materials`, fd);
  assert.equal(r.json.created.length, 1);
  assert.equal(r.json.errors[0].filename, 'fake.jpg');
  const d = (await S.call('GET', `/api/courses/${cid}`)).json;
  assert.equal(d.materials[0].kind, 'image');
  assert.equal(d.materials[0].vision_pages, 1);

  await S.call('POST', `/api/courses/${cid}/run`, { stage: 'vision', material_ids: [d.materials[0].id], mode: 'textless' });
  const job = await waitJob(S.call, cid);
  assert.equal(job.status, 'done', job.error);
  const m = (await S.call('GET', `/api/courses/${cid}/materials/${d.materials[0].id}`)).json;
  assert.match(m.pages[0].text, /【手写批注】/);
  assert.equal(m.pages[0].needs_vision, false);
});

test('vision job: textless pages only by default, keeps printed text layer, re-run skips done pages', async () => {
  const cid = (await S.call('POST', '/api/courses', { code: 'VIS', title: 'Vision' })).json.id;
  const fd = new FormData();
  fd.append('files', new Blob([PDF]), 'L1.pdf');
  const mid = (await S.call('POST', `/api/courses/${cid}/materials`, fd)).json.created[0].id;

  await S.call('POST', `/api/courses/${cid}/run`, { stage: 'vision', material_ids: [mid], mode: 'textless' });
  let job = await waitJob(S.call, cid);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.result.pages, 1, 'only page 2 has no text');
  let m = (await S.call('GET', `/api/courses/${cid}/materials/${mid}`)).json;
  assert.equal(m.pages[0].text, 'GROUP BY is not examinable here');
  assert.equal(m.pages[0].vision, undefined);
  assert.equal(m.pages[1].vision.done, true);
  assert.equal(m.pages[1].needs_vision, false);

  // "识别全部页"：已识别的跳过，只做第 1 页；印刷文字保留在 text_layer
  await S.call('POST', `/api/courses/${cid}/run`, { stage: 'vision', material_ids: [mid], mode: 'all' });
  job = await waitJob(S.call, cid);
  assert.equal(job.result.pages, 1);
  m = (await S.call('GET', `/api/courses/${cid}/materials/${mid}`)).json;
  assert.equal(m.pages[0].text_layer, 'GROUP BY is not examinable here');
  assert.match(m.pages[0].text, /【手写批注】\n- this is examinable/);

  const d = (await S.call('GET', `/api/courses/${cid}`)).json;
  assert.equal(d.materials[0].recognised_pages, 2);
  assert.equal(d.materials[0].handwriting_pages, 2);
  assert.equal(d.materials[0].vision_pages, 0);
  assert.equal((await S.call('POST', `/api/courses/${cid}/run`, { stage: 'vision', material_ids: [mid], mode: 'sideways' })).status, 400);
});

test('providers without vision are reported, a vision model can be configured', async () => {
  const { resolveProvider } = await import('../server/providers.js');
  const { visionModelOf } = await import('../server/llm.js');
  assert.equal(visionModelOf(resolveProvider({ EZLEARN_PROVIDER: 'deepseek' })), null);
  assert.equal(visionModelOf(resolveProvider({ EZLEARN_PROVIDER: 'openai', EZLEARN_MODEL: 'gpt-x' })), 'gpt-x');
  assert.equal(visionModelOf(resolveProvider({ EZLEARN_PROVIDER: 'qwen' })), 'qwen-vl-max');
  const put = await S.call('PUT', '/api/settings', { provider: 'deepseek', vision_model: 'some-vl-model' });
  assert.equal(put.json.providers.find((p) => p.id === 'deepseek').saved_vision_model, 'some-vl-model');
  assert.equal(visionModelOf(resolveProvider({ EZLEARN_PROVIDER: 'deepseek' })), 'some-vl-model');
  await S.call('PUT', '/api/settings', { provider: 'anthropic', vision_model: '' });
  const st = (await S.call('GET', '/api/status')).json;
  assert.equal(typeof st.vision.supported, 'boolean');
});
