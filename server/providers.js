// 模型提供商：Anthropic（官方 SDK）+ 一组 OpenAI 兼容接口（GPT / DeepSeek / Gemini / 通义 / Kimi / 智谱 / OpenRouter / 自定义）。
// 纯函数模块：只根据环境变量算出"用哪家、哪个模型、发到哪个地址"，不读密钥值本身（密钥在调用时按变量名读取）。

/**
 * format：结构化输出能力，失败时自动降级 json_schema → json_object → prompt（只靠提示词 + 服务端 zod 校验）。
 * tokenParam：输出上限参数名（OpenAI 新模型只认 max_completion_tokens）。
 * price：[$ / 1M 输入, $ / 1M 输出]，仅用于预算估算；价格会变，可用 EZLEARN_PRICE_IN / EZLEARN_PRICE_OUT 覆盖。
 */
export const PRESETS = Object.freeze({
  anthropic: { label: 'Anthropic Claude', kind: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', model: 'claude-opus-5-5', keyPattern: /^sk-ant-/ },
  openai: { label: 'OpenAI GPT', kind: 'openai', keyEnv: 'OPENAI_API_KEY', baseURL: 'https://api.openai.com/v1', model: 'gpt-5', format: 'json_schema', tokenParam: 'max_completion_tokens', reasoning: true, streamUsage: true, maxOutput: 64000, price: [1.25, 10], keyPattern: /^sk-/ },
  deepseek: { label: 'DeepSeek 深度求索', kind: 'openai', keyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com', model: 'deepseek-reasoner', format: 'json_object', tokenParam: 'max_tokens', streamUsage: true, maxOutput: 64000, price: [0.28, 0.42], keyPattern: /^sk-/ },
  gemini: { label: 'Google Gemini', kind: 'openai', keyEnv: 'GEMINI_API_KEY', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-pro', format: 'json_schema', tokenParam: 'max_tokens', maxOutput: 64000, price: [1.25, 10] },
  qwen: { label: '阿里通义千问（百炼）', kind: 'openai', keyEnv: 'DASHSCOPE_API_KEY', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', format: 'json_object', tokenParam: 'max_tokens', streamUsage: true, maxOutput: 32000, price: [0.4, 1.2], keyPattern: /^sk-/ },
  moonshot: { label: 'Moonshot Kimi', kind: 'openai', keyEnv: 'MOONSHOT_API_KEY', baseURL: 'https://api.moonshot.cn/v1', model: 'kimi-k2-0905-preview', format: 'json_object', tokenParam: 'max_tokens', maxOutput: 32000, price: [0.6, 2.5], keyPattern: /^sk-/ },
  zhipu: { label: '智谱 GLM', kind: 'openai', keyEnv: 'ZHIPUAI_API_KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6', format: 'json_object', tokenParam: 'max_tokens', maxOutput: 32000, price: [0.6, 2.2] },
  openrouter: { label: 'OpenRouter（多家模型聚合）', kind: 'openai', keyEnv: 'OPENROUTER_API_KEY', baseURL: 'https://openrouter.ai/api/v1', model: 'openai/gpt-5', format: 'json_schema', tokenParam: 'max_tokens', maxOutput: 32000, price: [2, 10], keyPattern: /^sk-or-/ },
  custom: { label: '自定义 OpenAI 兼容接口', kind: 'openai', keyEnv: 'EZLEARN_API_KEY', baseURL: '', model: '', format: 'json_object', tokenParam: 'max_tokens', maxOutput: 32000, price: [2, 10], keyOptionalOnLoopback: true },
});

/** 所有可能存放密钥的环境变量名：日志脱敏用。 */
export const SECRET_ENVS = Object.freeze([...new Set(Object.values(PRESETS).map((p) => p.keyEnv).concat('ANTHROPIC_AUTH_TOKEN'))]);

export const ANTHROPIC_PRICING = Object.freeze({ 'claude-opus-5-5': [4, 20], 'claude-sonnet-5-5': [2, 10], 'claude-haiku-5-5': [0.1, 0.5], 'claude-fable-5-1': [10, 50] });

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const FORMATS = ['json_schema', 'json_object', 'prompt'];

/**
 * 校验接口地址：必须 https；只有本机回环地址（Ollama / LM Studio 等本地模型）允许 http。
 * 禁止 URL 内嵌账号密码、查询串与片段，防止密钥随地址泄露或请求被改写。
 */
export function checkBaseURL(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new Error('接口地址不是合法的 URL'); }
  if (u.username || u.password) throw new Error('接口地址里不能包含用户名或密码');
  if (u.search || u.hash) throw new Error('接口地址不能带 ? 或 # 部分');
  const loopback = LOOPBACK.has(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && loopback))) {
    throw new Error('接口地址必须以 https:// 开头（只有本机 http://127.0.0.1 例外），否则密钥和课程资料会明文传输');
  }
  return { url: u.href.replace(/\/+$/, ''), loopback };
}

function priceOverride(env) {
  const a = Number.parseFloat(env.EZLEARN_PRICE_IN ?? '');
  const b = Number.parseFloat(env.EZLEARN_PRICE_OUT ?? '');
  return Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= 0 ? [a, b] : null;
}

/** 根据环境变量决定提供商。返回值不含密钥；配置有误时带 error 字段（服务照常启动，调用时报错）。 */
export function resolveProvider(env = process.env) {
  let id = String(env.EZLEARN_PROVIDER || '').trim().toLowerCase();
  if (!id) {
    // 未显式指定：有 Anthropic 凭据用 Anthropic（兼容旧配置），否则用第一个找到密钥的提供商。
    const hasAnthropic = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE;
    id = hasAnthropic ? 'anthropic' : Object.keys(PRESETS).find((k) => k !== 'custom' && env[PRESETS[k].keyEnv]) || 'anthropic';
  }
  const preset = PRESETS[id];
  if (!preset) {
    return { id, label: id, kind: 'none', model: '', error: `不认识的 EZLEARN_PROVIDER=${id}。可选：${Object.keys(PRESETS).join(' / ')}` };
  }
  const { keyPattern: _unused, ...rest } = preset;
  const p = { id, ...rest };
  p.model = String(env.EZLEARN_MODEL || preset.model).trim();

  if (preset.kind === 'anthropic') {
    p.price = priceOverride(env) || ANTHROPIC_PRICING[p.model] || ANTHROPIC_PRICING['claude-opus-5-5'];
    return p;
  }

  p.price = priceOverride(env) || preset.price;
  const fmt = String(env.EZLEARN_JSON_MODE || '').trim();
  if (FORMATS.includes(fmt)) p.format = fmt;
  const cap = Number.parseInt(env.EZLEARN_MAX_OUTPUT_TOKENS ?? '', 10);
  if (Number.isFinite(cap) && cap >= 1024) p.maxOutput = Math.min(cap, 256000);

  const rawURL = env.EZLEARN_BASE_URL || preset.baseURL;
  if (!rawURL) return { ...p, error: '自定义接口需要设置 EZLEARN_BASE_URL（例如 https://example.com/v1）' };
  try {
    const { url, loopback } = checkBaseURL(rawURL);
    p.baseURL = url;
    p.keyOptional = Boolean(preset.keyOptionalOnLoopback && loopback);
  } catch (e) {
    return { ...p, baseURL: '', error: `EZLEARN_BASE_URL 无效：${e.message}` };
  }
  if (!p.model) return { ...p, error: '自定义接口需要设置 EZLEARN_MODEL（模型名）' };
  return p;
}
