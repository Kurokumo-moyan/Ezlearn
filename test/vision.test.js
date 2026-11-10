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

test('PDF pages render to JPEG; images are re-encoded', async () => {
  const { openPdf, normalizeImage } = await import('../server/pagerender.js');
  const doc = await openPdf(PDF);
  assert.equal(doc.pages, 2);
  const img = await doc.render(1);
  assert.deepEqual([...img.subarray(0, 3)], [0xff, 0xd8, 0xff]);
  await doc.close();
  const again = await normalizeImage(img);
  assert.deepEqual([...again.subarray(0, 3)], [0xff, 0xd8, 0xff]);
});

test('image uploads: magic bytes checked, stored as a textless page', async () => {
  const cid = (await S.call('POST', '/api/courses', { code: 'IMG', title: 'Images' })).json.id;
  const { openPdf } = await import('../server/pagerender.js');
  const doc = await openPdf(PDF);
  const png = await doc.render(2);
  await doc.close();
  const fd = new FormData();
  fd.append('files', new Blob([png]), 'whiteboard.jpg');
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

test('unreadable text: guesses stored, confirmed value corrects material and generated chapter in context only', async () => {
  const cid = (await S.call('POST', '/api/courses', { code: 'UNC', title: 'Uncertain' })).json.id;
  const fd = new FormData();
  fd.append('files', new Blob([PDF]), 'L1.pdf');
  const mid = (await S.call('POST', `/api/courses/${cid}/materials`, fd)).json.created[0].id;
  await S.call('POST', `/api/courses/${cid}/run`, { stage: 'vision', material_ids: [mid], mode: 'textless' });
  assert.equal((await waitJob(S.call, cid)).status, 'done');

  // 正文先用最可能的写法；待确认列表给出前后文与位置
  let m = (await S.call('GET', `/api/courses/${cid}/materials/${mid}`)).json;
  assert.match(m.pages[1].text, /第一单元 走进化学世界/);
  const list = (await S.call('GET', `/api/courses/${cid}/uncertain`)).json;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].guesses, ['一', '七']);
  assert.match(list[0].before, /第$/);
  assert.match(list[0].after, /^单元 走进化学世界/);
  assert.equal(list[0].region.w, 0.3);
  assert.equal((await S.call('GET', `/api/courses/${cid}`)).json.materials[0].uncertain_pending, 1);

  // 原图接口
  const img = await fetch(`${S.base}/api/courses/${cid}/materials/${mid}/pages/2/image`, { headers: { 'X-Ezlearn-Token': S.token } });
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${S.base}/api/courses/${cid}/materials/${mid}/pages/99/image`, { headers: { 'X-Ezlearn-Token': S.token } })).status, 404);

  // 已生成的章节里用到了这处猜测；别处同样的"一"不能被改
  const { writeJSON, readJSON } = await import('../server/storage.js');
  await writeJSON(cid, {
    id: 'ch01', number: '1', title: '走进化学世界', title_exam_lang: '', summary: '', weight: 1, group: '', week: '',
    sources: [{ material_id: mid, pages: '1-2' }], terms: [], todos: [],
    blocks: [
      { type: 'heading', level: 2, id: 's1', number: '1.1', text: '第一单元 走进化学世界', text_exam_lang: '' },
      { type: 'paragraph', rich_text: '一个原子由原子核和核外电子构成。' },
      { type: 'quick_ref', rows: [{ concept: '单元', content: '第一单元 走进化学世界' }] },
    ],
  }, 'chapters', 'ch01.json');

  const r = (await S.call('POST', `/api/courses/${cid}/uncertain/resolve`, { items: [{ material_id: mid, page: 2, id: 1, value: '七' }] })).json;
  assert.equal(r.confirmed, 1);
  assert.deepEqual(r.corrected_chapters, ['ch01']);
  const ch = await readJSON(cid, 'chapters', 'ch01.json');
  assert.equal(ch.blocks[0].text, '第七单元 走进化学世界');
  assert.equal(ch.blocks[1].rich_text, '一个原子由原子核和核外电子构成。');
  m = (await S.call('GET', `/api/courses/${cid}/materials/${mid}`)).json;
  assert.match(m.pages[1].text, /第七单元 走进化学世界/);
  assert.equal((await S.call('GET', `/api/courses/${cid}/uncertain`)).json.length, 0);
  assert.equal((await S.call('GET', `/api/courses/${cid}/uncertain?all=1`)).json[0].chosen, '七');
  assert.ok(await readJSON(cid, 'verify', 'ch01.json'), 'corrected chapter re-verified');
  assert.equal((await S.call('POST', `/api/courses/${cid}/uncertain/resolve`, { items: [{ material_id: '../x', page: 2, id: 1, value: 'x' }] })).status, 400);
});

test('marker text: unknown markers become [?], skipped items keep the guess', async () => {
  const { resolveMarked } = await import('../server/pipeline.js');
  assert.equal(resolveMarked('A[[?1]]B[[?2]]C', [{ id: 1, guesses: ['x', 'y'], chosen: null }]), 'AxB[?]C');
  assert.equal(resolveMarked('A[[?1]]B', [{ id: 1, guesses: ['x'], chosen: 'z' }]), 'AzB');
});
