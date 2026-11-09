import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { assertId, displayName } from './security.js';
import fs from 'node:fs/promises';
import { readJSON, writeJSON, writeRaw, listJSON, listCourses, deleteCourse, removeFile, newId, countJSON, courseDir } from './storage.js';
import { parseFile, guessRole, validRole, pagesForRole, ALLOWED_EXT } from './ingest.js';
import { PROFILES } from './prompts.js';
import { PlanOut, MATERIAL_ROLES } from './schemas.js';
import { llmStatus, listModels, courseBudget } from './llm.js';
import { PRESETS, checkBaseURL } from './providers.js';
import { loadSettings, saveSettings, getProvider, keyTail, budgetDefault } from './settings.js';
import { ENCODINGS, decodeAs } from './encoding.js';
import { touch, requestShutdown, canShutdown } from './lifecycle.js';
import { seedDemo } from '../scripts/seed-demo.js';
import {
  loadCtx, saveCourse, startJob, jobOf, runEvidence, runProfile, runExam, runPlan, runChapter,
  runUpdate, applyUpdate, reverifyChapter, searchIndex, allJobs, runningJobCount,
} from './pipeline.js';

export const api = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const parse = (schema, v) => {
  const r = schema.safeParse(v);
  if (!r.success) throw Object.assign(new Error(r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')), { status: 400 });
  return r.data;
};
const cid = (req) => assertId(req.params.cid, 'course id');

api.get('/status', (_req, res) => res.json({ llm: llmStatus(), budget_usd: budgetDefault(), can_quit: canShutdown() }));

// ---------- 心跳 / 退出 ----------
api.post('/heartbeat', (_req, res) => { touch(); res.json({ ok: true }); });

api.post('/shutdown', (req, res) => {
  const force = req.body?.force === true;
  if (!canShutdown()) return res.status(409).json({ error: '当前不是由桌面启动器运行，请直接关闭命令行窗口。' });
  if (runningJobCount() > 0 && !force) return res.status(409).json({ error: '还有任务在运行，退出会中断它。', running: true });
  res.json({ ok: true });
  setTimeout(requestShutdown, 200);
});

// ---------- 任务进度（顶部进度面板） ----------
api.get('/jobs', (_req, res) => { touch(); res.json(allJobs()); });

// ---------- 设置：模型提供商 / 密钥 / 模型 / 默认预算 ----------
const KEY_SITES = {
  anthropic: 'https://console.anthropic.com/settings/keys', openai: 'https://platform.openai.com/api-keys', deepseek: 'https://platform.deepseek.com/api_keys',
  gemini: 'https://aistudio.google.com/apikey', qwen: 'https://bailian.console.aliyun.com', moonshot: 'https://platform.moonshot.cn/console/api-keys',
  zhipu: 'https://open.bigmodel.cn/usercenter/apikeys', openrouter: 'https://openrouter.ai/keys', custom: '',
};

function settingsView() {
  const s = loadSettings();
  const p = getProvider();
  return {
    provider: p.id,
    model: p.model,
    base_url: s.base_url || (p.id === 'custom' ? p.baseURL || '' : ''),
    budget_usd: budgetDefault(),
    data_dir: config.dataDir,
    error: p.error || null,
    providers: Object.entries(PRESETS).map(([id, x]) => ({
      id, label: x.label, default_model: x.model, key_site: KEY_SITES[id] || '', needs_base_url: id === 'custom',
      has_key: Boolean(keyTail(id)), key_tail: keyTail(id), saved_model: s.models[id] || '',
    })),
  };
}

const KeyStr = z.string().trim().regex(/^[\x21-\x7E]{8,512}$/, '密钥里不能有空格或中文，请重新复制');
const ModelStr = z.string().trim().regex(/^[A-Za-z0-9._:/-]{1,100}$/, '模型名格式不对');
const ProviderId = z.enum(Object.keys(PRESETS));

api.get('/settings', (_req, res) => res.json(settingsView()));

api.put('/settings', wrap(async (req, res) => {
  const b = parse(z.object({
    provider: ProviderId.optional(),
    api_key: KeyStr.optional(),
    clear_key: ProviderId.optional(),
    model: ModelStr.or(z.literal('')).optional(),
    base_url: z.string().trim().max(500).optional(),
    budget_usd: z.number().min(1).max(10000).optional(),
  }).strict(), req.body);
  const s = structuredClone(loadSettings());
  const pid = b.provider || s.provider || getProvider().id;
  if (b.provider) s.provider = b.provider;
  if (b.api_key) s.keys[pid] = b.api_key;
  if (b.clear_key) delete s.keys[b.clear_key];
  if (b.model !== undefined) { if (b.model) s.models[pid] = b.model; else delete s.models[pid]; }
  if (b.base_url !== undefined) {
    if (b.base_url) {
      try { s.base_url = checkBaseURL(b.base_url).url; } catch (e) { throw Object.assign(new Error(e.message), { status: 400 }); }
    } else delete s.base_url;
  }
  if (b.budget_usd !== undefined) s.budget_usd = b.budget_usd;
  saveSettings(s);
  res.json(settingsView());
}));

api.post('/settings/models', wrap(async (req, res) => {
  const b = parse(z.object({ provider: ProviderId, api_key: KeyStr.optional(), base_url: z.string().trim().max(500).optional() }).strict(), req.body);
  try {
    const models = await listModels(b.provider, { apiKey: b.api_key, baseURL: b.base_url });
    res.json({ models, default_model: PRESETS[b.provider].model });
  } catch (e) {
    res.status(e.code === 'auth' ? 401 : 502).json({ error: e.message, code: e.code || null });
  }
}));

// ---------- 示例课程 ----------
api.post('/demo', wrap(async (_req, res) => {
  const existing = (await listCourses()).find((c) => c.demo);
  if (existing) return res.json({ id: existing.id, existed: true });
  const { courseId: id } = await seedDemo({ quiet: true });
  res.status(201).json({ id });
}));

api.get('/profiles', (_req, res) => res.json(Object.values(PROFILES).map(({ id, name }) => ({ id, name }))));

// ---------- 课程 ----------
const CourseMeta = z.object({
  code: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(200),
  teaching_language: z.string().trim().min(1).max(40).default('中文'),
  exam_language: z.string().trim().min(1).max(40).default('English'),
  assessment_summary: z.string().trim().max(2000).default(''),
}).strict();

api.get('/courses', wrap(async (_req, res) => {
  // 历史课程：附上阅读进度与书签，按最近打开排序
  const out = [];
  for (const c of await listCourses()) {
    const pr = (await readJSON(c.id, 'progress.json')) || {};
    out.push({
      ...c,
      chapter_count: await countJSON(c.id, 'chapters'),
      progress: { mastered: (pr.mastered || []).length, opened_at: pr.opened_at || null, last: pr.last || null, bookmarks: (pr.bookmarks || []).slice(-20) },
    });
  }
  out.sort((a, b) => String(b.progress.opened_at || b.created_at || '').localeCompare(String(a.progress.opened_at || a.created_at || '')));
  res.json(out);
}));

api.post('/courses', wrap(async (req, res) => {
  const meta = parse(CourseMeta, req.body);
  const course = { id: newId('c-'), ...meta, profiles: [], created_at: new Date().toISOString() };
  await saveCourse(course);
  res.status(201).json(course);
}));

api.patch('/courses/:cid', wrap(async (req, res) => {
  const ctx = await loadCtx(cid(req));
  // 注意：不能用 CourseMeta.partial()——zod 会对缺省字段套用 default，导致 PATCH 意外覆盖
  const opt = (n) => z.string().trim().max(n).optional();
  const patch = parse(z.object({
    code: opt(40), title: opt(200), teaching_language: opt(40), exam_language: opt(40), assessment_summary: opt(2000),
    profiles: z.array(z.enum(Object.keys(PROFILES))).max(5).optional(),
    budget_usd: z.number().min(1).max(10000).optional(),
  }).strict(), req.body);
  Object.assign(ctx.course, patch);
  await saveCourse(ctx.course);
  res.json(ctx.course);
}));

api.delete('/courses/:cid', wrap(async (req, res) => {
  const id = cid(req);
  if (jobOf(id)?.status === 'running') return res.status(409).json({ error: '任务运行中，无法删除' });
  await deleteCourse(id);
  res.status(204).end();
}));

api.get('/courses/:cid', wrap(async (req, res) => {
  const id = cid(req);
  const ctx = await loadCtx(id, { all: true });
  const chapters = await listJSON(id, 'chapters');
  const repById = new Map();
  for (const c of chapters) repById.set(c.id, await readJSON(id, 'verify', `${c.id}.json`));
  res.json({
    course: ctx.course,
    materials: ctx.materials.map(({ pages, sql, ...m }) => ({ ...m, page_count: pages.length, vision_pages: pages.filter((p) => p.needs_vision).length, has_sql: Boolean(sql) })),
    evidence: ctx.evidence,
    coverage: ctx.coverage,
    profile: await readJSON(id, 'profile.json'),
    exam: await readJSON(id, 'exam.json'),
    plan: await readJSON(id, 'plan.json'),
    chapters: chapters.map((c) => {
      const r = repById.get(c.id);
      return { id: c.id, number: c.number, title: c.title, title_exam_lang: c.title_exam_lang, group: c.group, weight: c.weight, week: c.week, verify: r ? { errors: r.errors, warnings: r.warnings } : null };
    }),
    updates: (await listJSON(id, 'updates')).map(({ changes, ...u }) => ({ ...u, change_count: changes.length })),
    usage: (await readJSON(id, 'usage.json'))?.usd ?? 0,
    budget: await courseBudget(id),
    job: jobOf(id),
  });
}));

// ---------- 资料上传（S1） ----------
const upload = multer({
  storage: multer.memoryStorage(),
  defParamCharset: 'utf8',
  limits: { fileSize: config.limits.uploadBytes, files: config.limits.filesPerUpload, fields: 10, fieldSize: 64 * 1024, parts: 40 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) return cb(Object.assign(new Error(`不支持的文件类型：${ext || '(无扩展名)'}`), { status: 415 }));
    cb(null, true);
  },
});

const UploadMeta = z.array(z.object({
  role: z.enum(MATERIAL_ROLES).optional(),
  week: z.string().max(40).optional(),
  date: z.string().max(40).optional(),
}).strict()).max(config.limits.filesPerUpload);

api.post('/courses/:cid/materials', upload.array('files'), wrap(async (req, res) => {
  const id = cid(req);
  await loadCtx(id);
  let meta = [];
  if (req.body?.meta) {
    try { meta = parse(UploadMeta, JSON.parse(req.body.meta)); } catch (e) { throw Object.assign(new Error(`meta 不合法：${e.message}`), { status: 400 }); }
  }
  const created = [];
  const errors = [];
  for (const [i, f] of (req.files || []).entries()) {
    const filename = displayName(f.originalname);
    try {
      const parsed = await parseFile(filename, f.buffer);
      const role = meta[i]?.role || guessRole(filename, parsed.pages.slice(0, 2).map((pg) => pg.text).join('\n'));
      const mid = newId('m-');
      const m = {
        id: mid, filename, role, kind: parsed.kind, week: meta[i]?.week || '', date: meta[i]?.date || '',
        no_solutions: role === 'assignment', pages: pagesForRole(role, parsed, filename, f.buffer),
        ...(parsed.sql ? { sql: parsed.sql } : {}), size: f.size, added_at: new Date().toISOString(),
        // 不是 UTF-8 的文本：已自动转成 UTF-8 副本，等用户确认没有乱码（原文件字节保存在 raw/ 不动）
        ...(parsed.enc?.needs_confirm ? { encoding: { detected: parsed.enc.encoding, label: parsed.enc.label, confirmed: false } } : {}),
      };
      await writeRaw(id, f.buffer, 'raw', `${mid}.bin`);
      await writeJSON(id, m, 'materials', `${mid}.json`);
      created.push({ id: mid, filename, role, pages: m.pages.length, needs_confirm: Boolean(m.encoding), encoding_label: m.encoding?.label || null });
    } catch (e) {
      errors.push({ filename, error: e.status ? e.message : '解析失败' });
    }
  }
  res.status(created.length ? 201 : 400).json({ created, errors });
}));

const MaterialPatch = z.object({
  role: z.enum(MATERIAL_ROLES).optional(), week: z.string().max(40).optional(), date: z.string().max(40).optional(), no_solutions: z.boolean().optional(),
}).strict();

api.patch('/courses/:cid/materials/:mid', wrap(async (req, res) => {
  const id = cid(req);
  const mid = assertId(req.params.mid);
  const m = await readJSON(id, 'materials', `${mid}.json`);
  if (!m) return res.status(404).json({ error: 'not found' });
  const p = parse(MaterialPatch, req.body);
  Object.assign(m, p);
  if (p.role) m.no_solutions = p.no_solutions ?? (p.role === 'assignment');
  if (!validRole(m.role)) m.role = 'other';
  await writeJSON(id, m, 'materials', `${mid}.json`);
  res.json({ ok: true });
}));

// 编码预览：用指定编码（默认自动识别的那个）把原始字节解码，给用户看前 3000 字有没有乱码
api.get('/courses/:cid/materials/:mid/encoding', wrap(async (req, res) => {
  const id = cid(req);
  const mid = assertId(req.params.mid);
  const m = await readJSON(id, 'materials', `${mid}.json`);
  if (!m) return res.status(404).json({ error: 'not found' });
  const enc = String(req.query.enc || m.encoding?.detected || 'utf-8');
  if (!ENCODINGS[enc]) return res.status(400).json({ error: '不支持的编码' });
  const raw = await fs.readFile(path.join(courseDir(id), 'raw', `${mid}.bin`));
  const strip = enc === 'utf-8' && raw[0] === 0xef ? 3 : enc.startsWith('utf-16') && (raw[0] === 0xff || raw[0] === 0xfe) ? 2 : 0;
  const text = decodeAs(raw.subarray(strip), enc);
  res.json({
    encoding: enc, label: ENCODINGS[enc], detected: m.encoding?.detected || 'utf-8',
    candidates: Object.entries(ENCODINGS).map(([k, v]) => ({ id: k, label: v })),
    preview: text.slice(0, 3000), bad_chars: (text.match(/\uFFFD/g) || []).length,
  });
}));

api.post('/courses/:cid/materials/:mid/encoding', wrap(async (req, res) => {
  const id = cid(req);
  const mid = assertId(req.params.mid);
  const { encoding } = parse(z.object({ encoding: z.enum(Object.keys(ENCODINGS)) }).strict(), req.body);
  const m = await readJSON(id, 'materials', `${mid}.json`);
  if (!m) return res.status(404).json({ error: 'not found' });
  const raw = await fs.readFile(path.join(courseDir(id), 'raw', `${mid}.bin`));
  const parsed = await parseFile(m.filename, raw, { encoding });
  m.pages = pagesForRole(m.role, parsed, m.filename);
  if (parsed.sql) m.sql = parsed.sql; else delete m.sql;
  m.encoding = { detected: m.encoding?.detected || encoding, used: encoding, label: ENCODINGS[encoding], confirmed: true, at: new Date().toISOString() };
  await writeJSON(id, m, 'materials', `${mid}.json`);
  res.json({ ok: true, pages: m.pages.length });
}));

api.get('/courses/:cid/materials/:mid', wrap(async (req, res) => {
  const m = await readJSON(cid(req), 'materials', `${assertId(req.params.mid)}.json`);
  if (!m) return res.status(404).json({ error: 'not found' });
  const { sql, ...rest } = m;
  res.json(rest);
}));

api.delete('/courses/:cid/materials/:mid', wrap(async (req, res) => {
  const id = cid(req);
  const mid = assertId(req.params.mid);
  await removeFile(id, 'materials', `${mid}.json`);
  await removeFile(id, 'raw', `${mid}.bin`);
  res.status(204).end();
}));

api.get('/courses/:cid/dataset', wrap(async (req, res) => {
  const ctx = await loadCtx(cid(req));
  res.json({ sql: ctx.datasetSql });
}));

// ---------- 流水线 ----------
const RunReq = z.discriminatedUnion('stage', [
  z.object({ stage: z.enum(['S2', 'S3', 'S4', 'S5', 'analyze']) }).strict(),
  z.object({ stage: z.literal('chapter'), chapter_id: z.string().max(64), review: z.boolean().default(true) }).strict(),
  z.object({ stage: z.literal('all_chapters'), review: z.boolean().default(true), only_missing: z.boolean().default(true) }).strict(),
  z.object({ stage: z.literal('update'), material_ids: z.array(z.string().max(64)).min(1).max(50) }).strict(),
]);

api.post('/courses/:cid/run', wrap(async (req, res) => {
  const id = cid(req);
  const r = parse(RunReq, req.body);
  const { course } = await loadCtx(id);
  let fn;
  switch (r.stage) {
    case 'S2': fn = (log) => runEvidence(id, null, log); break;
    case 'S3': fn = (log) => runProfile(id, log); break;
    case 'S4': fn = (log) => runExam(id, log); break;
    case 'S5': fn = (log) => runPlan(id, log); break;
    case 'analyze': fn = async (log) => { await runEvidence(id, null, log.scope(0, 0.55)); await runProfile(id, log.scope(0.55, 0.65)); await runExam(id, log.scope(0.65, 0.8)); return runPlan(id, log.scope(0.8, 1)); }; break;
    case 'chapter': assertId(r.chapter_id, 'chapter id'); fn = (log) => runChapter(id, r.chapter_id, { review: r.review }, log); break;
    case 'all_chapters': fn = async (log) => {
      const plan = await readJSON(id, 'plan.json');
      if (!plan?.confirmed) throw Object.assign(new Error('课程方案尚未确认'), { status: 409 });
      const have = new Set((await listJSON(id, 'chapters')).map((c) => c.id));
      const out = {};
      const todo = plan.chapters.filter((c) => !(r.only_missing && have.has(c.id)));
      for (const [i, c] of todo.entries()) {
        const rep = await runChapter(id, c.id, { review: r.review }, log.scope(i / todo.length, (i + 1) / todo.length));
        out[c.id] = { errors: rep.errors, warnings: rep.warnings };
      }
      return out;
    }; break;
    case 'update': r.material_ids.forEach((m) => assertId(m)); fn = (log) => runUpdate(id, r.material_ids, log); break;
    default: throw Object.assign(new Error('bad stage'), { status: 400 });
  }
  res.status(202).json(startJob(id, r.stage, fn, course));
}));

api.get('/courses/:cid/job', wrap(async (req, res) => res.json(jobOf(cid(req)))));

api.put('/courses/:cid/plan', wrap(async (req, res) => {
  const id = cid(req);
  const body = parse(z.object({ plan: PlanOut, confirmed: z.boolean() }).strict(), req.body);
  const ids = new Set();
  for (const c of body.plan.chapters) {
    assertId(c.id, 'chapter id');
    if (ids.has(c.id)) throw Object.assign(new Error(`重复的章节 id ${c.id}`), { status: 400 });
    ids.add(c.id);
    c.weight = Math.max(0, Math.min(3, c.weight | 0));
  }
  const saved = { ...body.plan, confirmed: body.confirmed, at: new Date().toISOString() };
  await writeJSON(id, saved, 'plan.json');
  res.json(saved);
}));

// ---------- 章节 ----------
api.get('/courses/:cid/chapters/:chid', wrap(async (req, res) => {
  const id = cid(req);
  const ch = assertId(req.params.chid, 'chapter id');
  const chapter = await readJSON(id, 'chapters', `${ch}.json`);
  if (!chapter) return res.status(404).json({ error: 'not found' });
  res.json({ chapter, report: await readJSON(id, 'verify', `${ch}.json`) });
}));

api.post('/courses/:cid/chapters/:chid/reverify', wrap(async (req, res) => {
  res.json(await reverifyChapter(cid(req), assertId(req.params.chid, 'chapter id')));
}));

api.get('/courses/:cid/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 100);
  if (!q) return res.json([]);
  const idx = await searchIndex(cid(req));
  const hits = [];
  for (const c of idx) {
    const t = c.text.toLowerCase();
    let at = t.indexOf(q);
    let n = 0;
    while (at >= 0 && n < 5) {
      hits.push({ chapter_id: c.id, chapter: `${c.number} ${c.title}`, snippet: c.text.slice(Math.max(0, at - 40), at + q.length + 60) });
      at = t.indexOf(q, at + q.length);
      n++;
    }
  }
  res.json(hits.slice(0, 50));
}));

// ---------- 阅读进度 / 已掌握 / 书签（保存在服务端，换浏览器也在） ----------
const Anchor = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const ChId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/i).max(64);

async function readProgress(id) {
  const p = (await readJSON(id, 'progress.json')) || {};
  return { mastered: p.mastered || [], bookmarks: p.bookmarks || [], last: p.last || null, opened_at: p.opened_at || null };
}

api.get('/courses/:cid/progress', wrap(async (req, res) => {
  const id = cid(req);
  await loadCtx(id);
  res.json(await readProgress(id));
}));

api.put('/courses/:cid/progress', wrap(async (req, res) => {
  const id = cid(req);
  await loadCtx(id);
  const b = parse(z.object({
    mastered: z.array(ChId).max(500).optional(),
    last: z.object({ chapter_id: ChId.nullable(), anchor: Anchor.nullable().optional(), title: z.string().max(200).optional() }).strict().optional(),
    opened: z.boolean().optional(),
  }).strict(), req.body);
  const p = await readProgress(id);
  if (b.mastered) p.mastered = [...new Set(b.mastered)];
  if (b.last) p.last = { ...b.last, at: new Date().toISOString() };
  if (b.opened) p.opened_at = new Date().toISOString();
  await writeJSON(id, p, 'progress.json');
  res.json(p);
}));

api.post('/courses/:cid/bookmarks', wrap(async (req, res) => {
  const id = cid(req);
  await loadCtx(id);
  const b = parse(z.object({ chapter_id: ChId, anchor: Anchor.nullable().optional(), label: z.string().trim().min(1).max(200) }).strict(), req.body);
  const p = await readProgress(id);
  if (p.bookmarks.length >= 200) throw Object.assign(new Error('书签太多了（上限 200 个），请先删掉一些'), { status: 400 });
  const bm = { id: newId('bm-'), chapter_id: b.chapter_id, anchor: b.anchor || null, label: b.label, at: new Date().toISOString() };
  p.bookmarks.push(bm);
  await writeJSON(id, p, 'progress.json');
  res.status(201).json(bm);
}));

api.delete('/courses/:cid/bookmarks/:bid', wrap(async (req, res) => {
  const id = cid(req);
  const bid = assertId(req.params.bid);
  const p = await readProgress(id);
  p.bookmarks = p.bookmarks.filter((x) => x.id !== bid);
  await writeJSON(id, p, 'progress.json');
  res.status(204).end();
}));

// ---------- 增量更新 ----------
api.get('/courses/:cid/updates/:uid', wrap(async (req, res) => {
  const u = await readJSON(cid(req), 'updates', `${assertId(req.params.uid)}.json`);
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json(u);
}));

api.post('/courses/:cid/updates/:uid/apply', wrap(async (req, res) => {
  const { accept } = parse(z.object({ accept: z.array(z.number().int().min(0)).max(200) }).strict(), req.body);
  res.json(await applyUpdate(cid(req), assertId(req.params.uid), accept));
}));
