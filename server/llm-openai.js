// OpenAI 兼容接口（/chat/completions）适配器：GPT、DeepSeek、Gemini、通义、Kimi、智谱、OpenRouter、自建接口。
// 只用 Node 内置 fetch，不引入额外 npm 依赖（减少供应链风险）。
// 安全要点：
//  - 禁止跟随重定向（redirect: 'error'），密钥不会被转发到别的主机；
//  - 地址已在 providers.js 校验为 https（或本机回环 http）；
//  - 响应体与单行长度设上限，防止异常服务端撑爆内存；
//  - 错误信息只截取少量文本并抹掉密钥后再给前端。

export class FormatUnsupported extends Error {}
export class TokenLimitTooHigh extends Error {}

export class ProviderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const MAX_TEXT = 4 * 1024 * 1024; // 单次回复最多 4MB 文本
const MAX_LINE = 1024 * 1024;
const TOTAL_TIMEOUT_MS = 30 * 60 * 1000;
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

function scrub(text, key) {
  let s = String(text ?? '').slice(0, 300);
  if (key && key.length >= 8) s = s.split(key).join('***');
  return s.replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1***').replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***');
}

function reasoningEffort(effort) {
  return ['minimal', 'low', 'medium', 'high'].includes(effort) ? effort : 'high';
}

function buildBody(p, { system, messages, jsonSchema, maxTokens, format, stage, effort }) {
  const body = {
    model: p.model,
    messages: [{ role: 'system', content: system }, ...messages],
    stream: true,
    [p.tokenParam || 'max_tokens']: maxTokens,
  };
  if (p.streamUsage) body.stream_options = { include_usage: true };
  if (p.reasoning) body.reasoning_effort = reasoningEffort(effort);
  if (format === 'json_schema') {
    const name = `ezlearn_${String(stage).replace(/[^A-Za-z0-9_-]/g, '')}`.slice(0, 64);
    // strict:false：本项目 schema 含可选字段，strict 模式要求全部必填；最终由服务端 zod 把关。
    body.response_format = { type: 'json_schema', json_schema: { name, schema: jsonSchema, strict: false } };
  } else if (format === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  return body;
}

async function readLimited(res, limit) {
  try {
    const t = await res.text();
    return t.slice(0, limit);
  } catch { return ''; }
}

function classify(status, bodyText, p, key) {
  const t = String(bodyText).toLowerCase();
  if (status === 401 || status === 403) return new ProviderError('auth', `${p.label} 的 API 密钥无效、已被删除或没有权限。请到"设置"里重新填写。`);
  if (status === 402 || t.includes('insufficient_quota') || t.includes('insufficient balance')) return new ProviderError('quota', `${p.label} 账户余额不足或额度用完，请到对方网站充值。`);
  if (status === 429) return new ProviderError('rate_limit', `${p.label} 限流，请稍后重试。`);
  if (status === 400 || status === 422) {
    if (/response_format|json_schema|json_object|structured/.test(t)) return new FormatUnsupported(t);
    if (/max_tokens|max_completion_tokens|max_output_tokens|maximum.{0,40}tokens|token.{0,20}limit/.test(t)) return new TokenLimitTooHigh(t);
  }
  if (status === 404 || /model.{0,60}(not exist|not found|does not exist|invalid|不存在)/.test(t)) {
    return new ProviderError('model', `${p.label} 不认识模型 "${p.model}"。请到"设置"里点"获取可用模型"，重新选一个。`);
  }
  return new ProviderError('api', `${p.label} 接口错误 ${status}：${scrub(bodyText, key)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postWithRetry(url, init, p, key) {
  let last;
  for (let i = 0; i < 4; i++) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new ProviderError('timeout', `${p.label} 超过 30 分钟没有完成，已放弃。`);
      // 重定向被拒（可能是地址写错或被劫持）：不重试，直接报错
      if (/redirect/i.test(String(e?.cause?.message || e?.message))) throw new ProviderError('api', `${p.label} 接口返回了重定向，已拒绝跟随（检查接口地址）。`);
      last = new ProviderError('network', `连不上 ${p.label}（${scrub(e?.cause?.code || e?.message, key)}）。检查网络或代理。`);
      await sleep(1000 * 2 ** i);
      continue;
    }
    if (res.ok) return res;
    const text = await readLimited(res, 4000);
    const err = classify(res.status, text, p, key);
    if (RETRY_STATUS.has(res.status) && !(err instanceof ProviderError && err.code === 'quota') && i < 3) {
      const ra = Number.parseFloat(res.headers.get('retry-after') || '');
      await sleep(Number.isFinite(ra) ? Math.min(ra, 60) * 1000 : 2000 * 2 ** i);
      last = err;
      continue;
    }
    throw err;
  }
  throw last;
}

/** 解析 SSE 流，累计正文；忽略 reasoning_content（DeepSeek 思考过程）以免混入 JSON。 */
async function readStream(res, p, key) {
  let text = '';
  let refusal = '';
  let finish = null;
  let usage = null;
  let model = null;
  let buf = '';
  const decoder = new TextDecoder();
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    if (ev.error) throw new ProviderError('api', `${p.label} 返回错误：${scrub(ev.error.message || JSON.stringify(ev.error), key)}`);
    if (ev.model) model = ev.model;
    if (ev.usage) usage = ev.usage;
    const ch = ev.choices?.[0];
    if (!ch) return;
    if (ch.usage) usage = ch.usage; // Kimi 把 usage 放在 choice 里
    const d = ch.delta || ch.message || {};
    if (typeof d.content === 'string') text += d.content;
    if (typeof d.refusal === 'string') refusal += d.refusal;
    if (ch.finish_reason) finish = ch.finish_reason;
    if (text.length > MAX_TEXT) throw new ProviderError('api', `${p.label} 返回内容超过 ${MAX_TEXT / 1024 / 1024}MB，已中止。`);
  };
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, i).replace(/\r$/, ''));
      buf = buf.slice(i + 1);
    }
    if (buf.length > MAX_LINE) throw new ProviderError('api', `${p.label} 返回了异常数据（单行过长），已中止。`);
  }
  buf += decoder.decode();
  if (buf) handle(buf.replace(/\r$/, ''));
  return { text, refusal, finish, usage, model };
}

/**
 * 一次调用。返回统一结构：
 * { text, stop: 'end'|'max_tokens'|'refusal', refusal, usage: {input, output, cacheRead, cacheWrite, estimated}, model, assistant }
 */
export async function openaiCall(p, req) {
  const key = req.apiKey || '';
  if (!key && !p.keyOptional) throw new ProviderError('auth', `还没有配置 ${p.label} 的 API 密钥。请到"设置"里填写。`);
  const headers = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (p.id === 'openrouter') headers['X-Title'] = 'Ezlearn';
  const body = buildBody(p, req);
  const res = await postWithRetry(`${p.baseURL}/chat/completions`, {
    method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
  }, p, key);

  let r;
  try {
    r = await readStream(res, p, key);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new ProviderError('timeout', `${p.label} 超过 30 分钟没有完成，已放弃。`);
    throw new ProviderError('network', `${p.label} 连接中断（${scrub(e?.message, key)}）。`);
  }

  const u = r.usage || {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0;
  let usage;
  if (Number.isFinite(u.prompt_tokens) || Number.isFinite(u.completion_tokens)) {
    usage = { input: Math.max(0, (u.prompt_tokens || 0) - cached), cacheRead: cached, cacheWrite: 0, output: u.completion_tokens || 0, estimated: false };
  } else {
    // 平台没返回用量：按字符数保守估算（约 2 字符 / token），保证预算上限仍然生效
    // 图片按约 6000 字符（≈1600 token）估算
    const inChars = body.messages.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.reduce((k, c) => k + (c.type === 'text' ? c.text.length : 6000), 0) : String(m.content).length), 0);
    usage = { input: Math.ceil(inChars / 2), cacheRead: 0, cacheWrite: 0, output: Math.ceil(r.text.length / 2), estimated: true };
  }

  let stop = 'end';
  if (r.finish === 'length') stop = 'max_tokens';
  else if (r.finish === 'content_filter' || (r.refusal && !r.text)) stop = 'refusal';
  return {
    text: r.text,
    stop,
    refusal: r.refusal || (stop === 'refusal' ? 'content_filter' : null),
    usage,
    model: r.model || p.model,
    assistant: { role: 'assistant', content: r.text },
  };
}

const NON_CHAT = /embed|tts|whisper|dall-?e|image|audio|moderation|realtime|transcri|search|speech|rerank|vision-preview|davinci|babbage|computer-use|sora|ocr/i;

/** 读取平台的模型列表（GET /models），只保留像对话模型的条目。 */
export async function openaiListModels(p, key) {
  if (!key && !p.keyOptional) throw new ProviderError('auth', '请先填写 API 密钥。');
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  let res;
  try {
    res = await fetch(`${p.baseURL}/models`, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new ProviderError('timeout', `${p.label} 20 秒内没有响应。`);
    if (/redirect/i.test(String(e?.cause?.message || e?.message))) throw new ProviderError('api', `${p.label} 接口返回了重定向，已拒绝跟随。`);
    throw new ProviderError('network', `连不上 ${p.label}（${scrub(e?.cause?.code || e?.message, key)}）。检查网络或代理。`);
  }
  const text = (await readLimited(res, 2 * 1024 * 1024));
  if (!res.ok) {
    const err = classify(res.status, text, p, key);
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('api', `${p.label} 接口错误 ${res.status}：${scrub(text, key)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new ProviderError('api', `${p.label} 返回的模型列表不是 JSON。`); }
  const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [];
  const ids = list
    .map((m) => String(m?.id ?? m?.name ?? '').replace(/^models\//, ''))
    .filter((id) => /^[A-Za-z0-9._:/\-]{1,100}$/.test(id) && !NON_CHAT.test(id));
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
