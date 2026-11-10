// 多提供商：配置解析、地址校验，以及 OpenAI 兼容适配器对着本机模拟服务器的端到端行为。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { resolveProvider, checkBaseURL } from '../server/providers.js';

const KEY = 'sk-testkey-0123456789abcdef';
const MOCK_PORT = 5871;
const requests = [];
let script = []; // 每个请求依次取一个处理函数
let redirectTargetHit = false;

function sse(res, chunks, usage) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify({ model: 'mock-model', choices: [{ index: 0, delta: { content: c } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\r\n\r\n`);
  if (usage) res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  res.end('data: [DONE]\n\n');
}

const mock = http.createServer((req, res) => {
  if (req.url === '/elsewhere') { redirectTargetHit = true; res.end('{}'); return; }
  if (req.method === 'GET' && req.url === '/v1/models') {
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); res.end('{"error":{"message":"bad key"}}'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'mock-model' }, { id: 'text-embedding-3-small' }, { id: 'models/gemini-x' }, { id: 'whisper-1' }, { id: 'bad id with spaces' }, { id: 'a-chat-model' }] }));
    return;
  }
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const json = JSON.parse(body);
    requests.push({ url: req.url, auth: req.headers.authorization, body: json });
    const fn = script.shift();
    if (!fn) { res.writeHead(500); res.end('no script'); return; }
    fn(req, res, json);
  });
});

let llm;
let storage;
let security;
const COURSE = 'mock-course';

before(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  process.env.EZLEARN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ezlearn-prov-'));
  process.env.EZLEARN_FAKE_LLM = '0';
  process.env.EZLEARN_PROVIDER = 'custom';
  process.env.EZLEARN_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;
  process.env.EZLEARN_MODEL = 'mock-model';
  process.env.EZLEARN_API_KEY = KEY;
  process.env.EZLEARN_JSON_MODE = 'json_schema';
  process.env.EZLEARN_PRICE_IN = '1';
  process.env.EZLEARN_PRICE_OUT = '2';
  llm = await import('../server/llm.js');
  storage = await import('../server/storage.js');
  security = await import('../server/security.js');
  storage.ensureDataDir();
});

after(() => new Promise((r) => mock.close(r)));

const Out = z.object({ answer: z.number(), note: z.string().optional() });
const call = () => llm.callJSON({ courseId: COURSE, stage: 'S2', system: 'sys', user: 'question', schema: Out, maxTokens: 64000 });

// ---------------- 配置解析 ----------------

test('preset resolution: explicit provider, default model, auto-detect', () => {
  const d = resolveProvider({ EZLEARN_PROVIDER: 'deepseek' });
  assert.equal(d.baseURL, 'https://api.deepseek.com');
  assert.equal(d.model, 'deepseek-reasoner');
  assert.equal(d.keyEnv, 'DEEPSEEK_API_KEY');
  assert.equal(resolveProvider({ OPENAI_API_KEY: 'sk-x' }).id, 'openai');
  assert.equal(resolveProvider({ OPENAI_API_KEY: 'sk-x', ANTHROPIC_API_KEY: 'sk-ant-x' }).id, 'anthropic');
  assert.equal(resolveProvider({}).id, 'anthropic');
  assert.equal(resolveProvider({ EZLEARN_PROVIDER: 'openai', EZLEARN_MODEL: 'gpt-x' }).model, 'gpt-x');
  assert.match(resolveProvider({ EZLEARN_PROVIDER: 'nope' }).error, /不认识/);
  assert.match(resolveProvider({ EZLEARN_PROVIDER: 'custom', EZLEARN_MODEL: 'm' }).error, /EZLEARN_BASE_URL/);
  assert.deepEqual(resolveProvider({ EZLEARN_PROVIDER: 'openai', EZLEARN_PRICE_IN: '3', EZLEARN_PRICE_OUT: '9' }).price, [3, 9]);
});

test('base URL must be https, except loopback http; no credentials/query', () => {
  assert.equal(checkBaseURL('https://api.example.com/v1/').url, 'https://api.example.com/v1');
  assert.equal(checkBaseURL('http://127.0.0.1:11434/v1').loopback, true);
  assert.throws(() => checkBaseURL('http://api.example.com/v1'), /https/);
  assert.throws(() => checkBaseURL('http://192.168.1.5/v1'), /https/);
  assert.throws(() => checkBaseURL('https://user:pw@api.example.com/v1'), /用户名或密码/);
  assert.throws(() => checkBaseURL('https://api.example.com/v1?x=1'), /\?/);
  assert.throws(() => checkBaseURL('file:///etc/passwd'), /https/);
  assert.throws(() => checkBaseURL('not a url'), /URL/);
  assert.match(resolveProvider({ EZLEARN_PROVIDER: 'openai', EZLEARN_BASE_URL: 'http://evil.example/v1' }).error, /https/);
  // 远程自定义接口必须有密钥，本机接口可以没有
  assert.equal(resolveProvider({ EZLEARN_PROVIDER: 'custom', EZLEARN_BASE_URL: 'https://x.example/v1', EZLEARN_MODEL: 'm' }).keyOptional, false);
  assert.equal(resolveProvider({ EZLEARN_PROVIDER: 'custom', EZLEARN_BASE_URL: 'http://localhost:1234/v1', EZLEARN_MODEL: 'm' }).keyOptional, true);
});

test('status never exposes the key', () => {
  const s = llm.llmStatus();
  assert.equal(s.provider, 'custom');
  assert.equal(s.mode, 'api');
  assert.ok(!JSON.stringify(s).includes(KEY));
});

test('log scrubbing removes configured key and common key formats', () => {
  const out = security.scrubSecrets(`key=${KEY} other=sk-abcdefghijklmnop g=AIzaSyA1234567890abcdef Authorization: Bearer abc.def.ghi123`);
  assert.ok(!out.includes(KEY));
  assert.ok(!out.includes('sk-abcdefghijklmnop'));
  assert.ok(!out.includes('AIzaSyA1234567890'));
  assert.ok(!out.includes('abc.def.ghi123'));
});

// ---------------- 适配器端到端 ----------------

test('streams SSE, sends bearer key + schema, validates, charges budget', async () => {
  requests.length = 0;
  script = [(_q, res) => sse(res, ['{"ans', 'wer": 4', '2}'], { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 200 } })];
  const out = await call();
  assert.deepEqual(out, { answer: 42 });
  const r = requests[0];
  assert.equal(r.url, '/v1/chat/completions');
  assert.equal(r.auth, `Bearer ${KEY}`);
  assert.equal(r.body.model, 'mock-model');
  assert.equal(r.body.stream, true);
  assert.equal(r.body.messages[0].role, 'system');
  assert.equal(r.body.response_format.type, 'json_schema');
  assert.equal(r.body.max_tokens, 32000, 'capped by provider maxOutput');
  assert.match(r.body.messages[1].content, /JSON Schema/);
  const u = await storage.readJSON(COURSE, 'usage.json');
  // (800 + 200*0.1) * $1 + 500 * $2 = 820 + 1000 → $0.00182
  assert.equal(u.calls.at(-1).usd, 0.0018);
  assert.equal(u.calls.at(-1).provider, 'custom');
});

test('falls back json_schema → json_object → prompt when the platform rejects the format', async () => {
  requests.length = 0;
  script = [
    (_q, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"response_format json_schema is not supported"}}'); },
    (_q, res) => { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"json_object not supported for this model"}}'); },
    (_q, res) => sse(res, ['```json\n{"answer": 1}\n```']),
  ];
  assert.deepEqual(await call(), { answer: 1 });
  assert.equal(requests[0].body.response_format.type, 'json_schema');
  assert.equal(requests[1].body.response_format.type, 'json_object');
  assert.equal(requests[2].body.response_format, undefined);
  const u = await storage.readJSON(COURSE, 'usage.json');
  assert.equal(u.calls.at(-1).estimated, true, 'no usage returned → estimated, still charged');
  assert.ok(u.calls.at(-1).usd > 0);
});

test('halves output limit when the platform says max_tokens is too large', async () => {
  requests.length = 0;
  script = [
    (_q, res) => { res.writeHead(400); res.end('{"error":{"message":"max_tokens is too large: 32000 > 8192"}}'); },
    (_q, res) => sse(res, ['{"answer": 2}']),
  ];
  assert.deepEqual(await call(), { answer: 2 });
  assert.equal(requests[1].body.max_tokens, 16000);
});

test('invalid output gets a repair turn with zod issues', async () => {
  requests.length = 0;
  script = [(_q, res) => sse(res, ['{"answer": "x"}']), (_q, res) => sse(res, ['{"answer": 3}'])];
  assert.deepEqual(await call(), { answer: 3 });
  const msgs = requests[1].body.messages;
  assert.equal(msgs.at(-2).role, 'assistant');
  assert.equal(msgs.at(-2).content, '{"answer": "x"}');
  assert.match(msgs.at(-1).content, /answer/);
});

test('truncated output (finish_reason length) is reported, not parsed', async () => {
  script = [(_q, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"answer":' }, finish_reason: 'length' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  }];
  await assert.rejects(call(), (e) => e.code === 'max_tokens');
});

test('401 maps to auth error without leaking the key', async () => {
  script = [(_q, res) => { res.writeHead(401); res.end(`{"error":{"message":"Incorrect API key provided: ${KEY}"}}`); }];
  await assert.rejects(call(), (e) => e.code === 'auth' && !e.message.includes(KEY));
});

test('other API errors are truncated and scrubbed', async () => {
  script = [(_q, res) => { res.writeHead(418); res.end(`teapot ${KEY} ${'x'.repeat(5000)}`); }];
  await assert.rejects(call(), (e) => e.code === 'api' && !e.message.includes(KEY) && e.message.length < 500);
});

test('402 / insufficient balance maps to quota error (no retry)', async () => {
  requests.length = 0;
  script = [(_q, res) => { res.writeHead(402); res.end('{"error":{"message":"Insufficient Balance"}}'); }];
  await assert.rejects(call(), (e) => e.code === 'quota');
  assert.equal(requests.length, 1);
});

test('redirects are refused so the key is never forwarded', async () => {
  redirectTargetHit = false;
  script = [(_q, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${MOCK_PORT}/elsewhere` }); res.end(); }];
  await assert.rejects(call(), (e) => e.code === 'api' && /重定向/.test(e.message));
  assert.equal(redirectTargetHit, false);
});

test('budget cap blocks further calls', async () => {
  await storage.writeJSON(COURSE, { usd: 999, calls: [] }, 'usage.json');
  requests.length = 0;
  await assert.rejects(call(), (e) => e.code === 'budget');
  assert.equal(requests.length, 0);
});

test('model list: only chat-like ids, Gemini prefix stripped, key checked', async () => {
  const models = await llm.listModels('custom', { baseURL: `http://127.0.0.1:${MOCK_PORT}/v1` });
  assert.deepEqual(models, ['a-chat-model', 'gemini-x', 'mock-model']);
  await assert.rejects(llm.listModels('custom', { apiKey: 'sk-wrong-key-123456', baseURL: `http://127.0.0.1:${MOCK_PORT}/v1` }), (e) => e.code === 'auth');
  await assert.rejects(llm.listModels('custom', { baseURL: 'http://evil.example/v1' }), (e) => e.code === 'config');
});

test('settings saved in the app override env immediately; key never leaves via status', async () => {
  const settings = await import('../server/settings.js');
  const before = llm.llmStatus();
  assert.equal(before.provider, 'custom');
  settings.saveSettings({ provider: 'deepseek', keys: { deepseek: 'sk-from-ui-0123456789' }, models: { deepseek: 'deepseek-chat' } });
  const s = llm.llmStatus();
  assert.equal(s.provider, 'deepseek');
  assert.equal(s.model, 'deepseek-chat');
  assert.equal(s.mode, 'api');
  assert.ok(!JSON.stringify(s).includes('sk-from-ui'));
  assert.equal(settings.keyTail('deepseek'), '6789');
  // 换回自定义接口：EZLEARN_BASE_URL 来自环境变量，仍然生效
  settings.saveSettings({ provider: 'custom', keys: {}, models: {} });
  assert.equal(llm.llmStatus().provider, 'custom');
  assert.equal(llm.llmStatus().model, 'mock-model');
  settings.saveSettings({ keys: {}, models: {} });
});

test('vision calls send the page image as an OpenAI-style data URL with the vision model', async () => {
  const { z } = await import('zod');
  requests.length = 0;
  script = [(_q, res) => sse(res, ['{"text":"","handwriting":["x"],"has_handwriting":true,"confidence":"high","notes":""}'])];
  const out = await llm.callJSON({ courseId: COURSE + '-v', stage: 'S1V', system: 's', user: 'page', vision: true, images: ['aGVsbG8='],
    schema: z.object({ text: z.string(), handwriting: z.array(z.string()), has_handwriting: z.boolean(), confidence: z.string(), notes: z.string() }) });
  assert.equal(out.handwriting[0], 'x');
  const content = requests[0].body.messages[1].content;
  assert.ok(Array.isArray(content));
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].image_url.url, 'data:image/jpeg;base64,aGVsbG8=');
});
