// 模型调用封装：多提供商（Anthropic 官方 SDK / OpenAI 兼容接口）+ 结构化输出 + 服务端 zod 校验 + 自动修复 + 预算上限。
// API key 只从环境变量 / .env（Anthropic 另支持 `ant auth login`）读取，永不经过前端、永不写日志。
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { toOutputSchema } from './schemas.js';
import { readJSON, writeJSON } from './storage.js';
import { safeLog } from './security.js';
import { openaiCall, openaiListModels, FormatUnsupported, TokenLimitTooHigh, ProviderError } from './llm-openai.js';
import { getProvider, apiKeyFor, budgetDefault, loadSettings } from './settings.js';
import { resolveProvider, PRESETS } from './providers.js';

const clients = new Map(); // apiKey -> Anthropic client
let impl = null; // 测试时可替换为假实现

export function setLLMImpl(fn) { impl = fn; }

/** 给前端 / 启动日志看的状态：不含密钥，只说"用哪家、是否已配置"。 */
export function llmStatus() {
  if (impl || config.fakeLLM) return { configured: true, mode: 'fake', model: 'fake', provider: 'fake', provider_label: '假模型' };
  const p = getProvider();
  const base = { provider: p.id, provider_label: p.label, model: p.model };
  if (p.error) return { ...base, configured: false, mode: 'error', error: p.error };
  if (p.kind === 'anthropic') {
    const configured = Boolean(apiKeyFor('anthropic') || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
    // 没有环境变量时 SDK 仍可能读取 `ant auth login` 的配置文件；这里只能报告"未知"。
    return { ...base, configured, mode: configured ? 'api' : 'unknown' };
  }
  const configured = Boolean(apiKeyFor(p.id)) || Boolean(p.keyOptional);
  return { ...base, configured, mode: configured ? 'api' : 'missing', key_env: p.keyEnv, host: new URL(p.baseURL).host };
}

function getClient(apiKey, opts = {}) {
  // 没有界面保存的密钥时交给 SDK 自己读环境变量 / `ant auth login` 配置
  const k = `${apiKey || ''}|${JSON.stringify(opts)}`;
  if (!clients.has(k)) clients.set(k, new Anthropic({ ...(apiKey ? { apiKey } : {}), maxRetries: 3, timeout: 30 * 60 * 1000, ...opts }));
  return clients.get(k);
}

export class LLMError extends Error {
  constructor(code, message, detail) { super(message); this.code = code; this.detail = detail; }
}

async function chargeUsage(P, courseId, stage, usage, model) {
  const [pin, pout] = P.price;
  const inTok = usage.input + usage.cacheWrite * 1.25 + usage.cacheRead * 0.1;
  const usd = (inTok * pin + usage.output * pout) / 1e6;
  const u = (await readJSON(courseId, 'usage.json')) || { usd: 0, calls: [] };
  u.usd = +(u.usd + usd).toFixed(4);
  u.calls.push({ at: new Date().toISOString(), stage, provider: P.id, model, input: usage.input, output: usage.output, cache_read: usage.cacheRead, estimated: usage.estimated || undefined, usd: +usd.toFixed(4) });
  if (u.calls.length > 500) u.calls = u.calls.slice(-500);
  await writeJSON(courseId, u, 'usage.json');
  return u;
}

/** 某门课的花费上限：课程里单独设置的优先，其次"设置"里的默认值。 */
export async function courseBudget(courseId) {
  const c = await readJSON(courseId, 'course.json');
  const b = Number(c?.budget_usd);
  return Number.isFinite(b) && b > 0 ? b : budgetDefault();
}

async function assertBudget(courseId) {
  const u = (await readJSON(courseId, 'usage.json')) || { usd: 0 };
  const limit = await courseBudget(courseId);
  if (u.usd >= limit) {
    throw new LLMError('budget', `本课程 API 花费已达上限 $${limit}。如需继续，请在课程管理页点"提高上限"。`);
  }
}

function parseLoose(text) {
  let t = text.trim();
  // 有些模型会包一层 ```json 代码块
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('not json');
}

function zodIssues(err) {
  return (err.issues || []).slice(0, 25).map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
}

// ---------------- Anthropic ----------------

async function anthropicCall(P, { system, messages, jsonSchema, maxTokens, format }) {
  const params = {
    model: P.model,
    max_tokens: maxTokens,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: config.effort, ...(format === 'json_schema' ? { format: { type: 'json_schema', schema: jsonSchema } } : {}) },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
  };
  let msg;
  try {
    msg = await getClient(apiKeyFor('anthropic')).beta.messages.stream(params).finalMessage();
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError && format === 'json_schema' && /schema|output_config|format/i.test(e.message)) throw new FormatUnsupported(e.message);
    if (e instanceof Anthropic.AuthenticationError) throw new LLMError('auth', 'Anthropic API 密钥无效、已被删除或未配置。请到"设置"里重新填写。');
    if (e instanceof Anthropic.RateLimitError) throw new LLMError('rate_limit', 'API 限流，请稍后重试。');
    if (e instanceof Anthropic.APIError) throw new LLMError('api', `API 错误 ${e.status ?? ''}`);
    throw e;
  }
  const u = msg.usage || {};
  return {
    text: msg.content.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    stop: msg.stop_reason === 'refusal' ? 'refusal' : msg.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
    refusal: msg.stop_details?.category ?? null,
    usage: { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 },
    model: msg.model || P.model,
    assistant: { role: 'assistant', content: msg.content },
  };
}

// ---------------- 通用调用 ----------------

const FORMAT_ORDER = ['json_schema', 'json_object', 'prompt'];

async function providerCall(P, req) {
  if (P.kind === 'anthropic') return anthropicCall(P, req);
  try {
    return await openaiCall(P, { ...req, effort: config.effort, apiKey: apiKeyFor(P.id) });
  } catch (e) {
    if (e instanceof ProviderError) throw new LLMError(e.code, e.message);
    throw e;
  }
}

/**
 * 调用模型并返回经 zod 校验的对象。
 * @param {object} o
 * @param {string} o.courseId
 * @param {string} o.stage  S2..S8，仅用于记账与日志
 * @param {string} o.system
 * @param {string} o.user
 * @param {import('zod').ZodType} o.schema
 */
/** 当前提供商用于图像识别的模型；不支持时返回 null。 */
export function visionModelOf(P = getProvider()) {
  const saved = loadSettings().vision_models?.[P.id];
  if (saved) return saved;
  const preset = PRESETS[P.id]?.visionModel;
  if (preset === 'same') return P.model;
  return preset || null;
}

export async function callJSON({ courseId, stage, system, user, schema, maxTokens = 64000, images = null, vision = false }) {
  if (impl || config.fakeLLM) {
    const fake = impl || (await import('./llm-fake.js')).fakeLLM;
    const delay = Number(process.env.EZLEARN_FAKE_DELAY_MS) || 0; // 仅用于演示 / 手动测试进度条
    if (delay) await new Promise((r) => setTimeout(r, Math.min(delay, 10000)));
    return schema.parse(await fake({ stage, system, user, images }));
  }
  let P = getProvider(); // 每次调用取当前设置：界面改了立即生效
  if (P.error) throw new LLMError('config', P.error);
  if (vision) {
    const vm = visionModelOf(P);
    if (!vm) throw new LLMError('config', `${P.label} 不支持图像识别。请到"设置"里换成 Claude、GPT、Gemini，或填写这家公司的图像识别模型。`);
    P = { ...P, model: vm };
  }
  await assertBudget(courseId);
  const jsonSchema = toOutputSchema(schema);
  let format = P.kind === 'anthropic' ? 'json_schema' : P.format;
  let tokens = P.maxOutput ? Math.min(maxTokens, P.maxOutput) : maxTokens;
  // 非 Anthropic 的 json_schema 是 strict:false（不强制），所以除了 Anthropic 都把 schema 写进提示词。
  const schemaHint = `\n\n只输出一个 JSON 对象，不要任何其他文字，不要用代码块包裹。它必须符合以下 JSON Schema：\n${JSON.stringify(jsonSchema)}`;
  const firstUser = () => (P.kind === 'anthropic' && format === 'json_schema' ? user : user + schemaHint);
  // 有图片时：Anthropic 用 image 块，OpenAI 兼容接口用 image_url（data URL）
  const withImages = (text) => {
    if (!images?.length) return text;
    if (P.kind === 'anthropic') return [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: im } })), { type: 'text', text }];
    return [{ type: 'text', text }, ...images.map((im) => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${im}` } }))];
  };
  const messages = [{ role: 'user', content: withImages(firstUser()) }];

  let attempts = 0;
  let downgrades = 0;
  while (attempts < 3) {
    let r;
    try {
      r = await providerCall(P, { system, messages, jsonSchema, maxTokens: tokens, format, stage });
    } catch (e) {
      if (e instanceof FormatUnsupported && downgrades < 4) {
        // 平台不支持这种结构化输出：降一级（json_schema → json_object → 纯提示词）
        const next = FORMAT_ORDER[FORMAT_ORDER.indexOf(format) + 1];
        if (next) {
          safeLog(`[llm] ${stage}: ${format} rejected by ${P.id}, falling back to ${next}`);
          format = next;
          downgrades++;
          messages[0] = { role: 'user', content: withImages(firstUser()) };
          continue;
        }
      }
      if (e instanceof TokenLimitTooHigh && tokens > 4096 && downgrades < 4) {
        tokens = Math.max(4096, Math.floor(tokens / 2));
        downgrades++;
        safeLog(`[llm] ${stage}: output token limit too high for ${P.model}, retrying with ${tokens}`);
        continue;
      }
      if (e instanceof FormatUnsupported) throw new LLMError('api', '模型平台拒绝了 JSON 输出格式。');
      if (e instanceof TokenLimitTooHigh) throw new LLMError('api', `模型 ${P.model} 不接受当前的输出长度上限，请在"设置"里换一个模型。`);
      throw e;
    }
    attempts++;
    await chargeUsage(P, courseId, stage, r.usage, r.model);

    if (r.stop === 'refusal') {
      throw new LLMError('refusal', `模型拒绝了本次请求（${r.refusal ?? 'unknown'}）。`);
    }
    if (r.stop === 'max_tokens') {
      throw new LLMError('max_tokens', `输出超过上限（${tokens} tokens）被截断；请把本章拆小、减少输入资料，或换输出上限更大的模型。`);
    }
    let obj;
    try {
      obj = parseLoose(r.text);
    } catch {
      messages.push(r.assistant, { role: 'user', content: '上一条输出不是合法 JSON。请重新只输出完整、合法的 JSON 对象。' });
      continue;
    }
    const v = schema.safeParse(obj);
    if (v.success) return v.data;
    safeLog(`[llm] ${stage}: schema validation failed (attempt ${attempts})`);
    messages.push(r.assistant, { role: 'user', content: `输出未通过校验，请修正以下问题后重新输出完整 JSON：\n${zodIssues(v.error)}` });
  }
  throw new LLMError('invalid_output', '模型输出连续 3 次未通过结构校验。');
}

/**
 * 获取某个提供商可用的模型列表（设置页"获取可用模型"）。
 * apiKey / baseURL 可以是用户刚输入、尚未保存的值；不传则用已保存的。
 */
export async function listModels(providerId, { apiKey, baseURL } = {}) {
  const preset = PRESETS[providerId];
  if (!preset) throw new LLMError('config', '不认识的提供商');
  const p = resolveProvider({ EZLEARN_PROVIDER: providerId, ...(baseURL ? { EZLEARN_BASE_URL: baseURL } : {}), EZLEARN_MODEL: 'list' });
  if (p.error) throw new LLMError('config', p.error);
  const key = apiKey || apiKeyFor(providerId);
  if (p.kind === 'anthropic') {
    try {
      const out = [];
      for await (const m of getClient(key, { maxRetries: 1, timeout: 20000 }).models.list({ limit: 100 })) {
        out.push(m.id);
        if (out.length >= 200) break;
      }
      return out;
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new LLMError('auth', 'Anthropic API 密钥无效或已被删除。');
      if (e instanceof Anthropic.APIError) throw new LLMError('api', `Anthropic 接口错误 ${e.status ?? ''}`);
      throw new LLMError('network', '连不上 Anthropic，请检查网络。');
    }
  }
  try {
    return await openaiListModels(p, key);
  } catch (e) {
    if (e instanceof ProviderError) throw new LLMError(e.code, e.message);
    throw e;
  }
}
