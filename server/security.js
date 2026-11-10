// 本地 Web 服务的安全层。
// 威胁模型：本机浏览器里打开的任意恶意网页（CSRF、DNS rebinding、跨站读取），
// 以及上传资料 / LLM 输出中的恶意内容（提示注入、XSS、路径穿越）。
import crypto from 'node:crypto';
import { config } from './config.js';
import { SECRET_ENVS } from './providers.js';

// 每次启动生成新的会话令牌，只通过同源页面下发；跨站页面读不到（同源策略 + Host 校验）。
export const SESSION_TOKEN = crypto.randomBytes(32).toString('base64url');

const allowedHosts = new Set([
  `127.0.0.1:${config.port}`,
  `localhost:${config.port}`,
  `[::1]:${config.port}`,
]);
const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));

/** 拒绝 Host 头不是本机的请求：防 DNS rebinding。 */
export function hostGuard(req, res, next) {
  if (!allowedHosts.has(String(req.headers.host || '').toLowerCase())) {
    return res.status(421).type('text/plain').send('Misdirected request');
  }
  next();
}

/** 安全响应头。CSP 不允许任何内联脚本和外部来源。 */
export function securityHeaders(_req, res, next) {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'", // sql.js 需要编译 WASM；不允许 eval / 内联脚本
      "style-src 'self' 'unsafe-inline'", // KaTeX 输出使用内联 style 属性
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cache-Control': 'no-store',
  });
  next();
}

function tokenEquals(a) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(SESSION_TOKEN);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 常量时间比较两个字符串。 */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/** 所有 /api 请求：自定义头里的令牌（会触发 CORS 预检，跨站无法伪造）+ Origin 校验。 */
export function apiGuard(req, res, next) {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'origin_forbidden' });
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return res.status(403).json({ error: 'cross_site_forbidden' });
  if (!tokenEquals(req.headers['x-ezlearn-token'])) return res.status(401).json({ error: 'bad_token' });
  next();
}

// ---- 输入校验工具 ----
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function assertId(id, what = 'id') {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    const e = new Error(`invalid ${what}`);
    e.status = 400;
    throw e;
  }
  return id;
}

/** 把用户给的文件名清理成仅用于显示的字符串（永远不用它拼磁盘路径）。 */
export function displayName(name) {
  return String(name || 'file')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .slice(0, 200);
}

/** 日志里只记录元数据，不记录资料内容、提示词或密钥。 */
/** 抹掉日志里的密钥：已配置的密钥原文 + 常见密钥格式（sk-… / AIza… / Bearer …）。 */
export function scrubSecrets(text) {
  let s = String(text);
  for (const name of SECRET_ENVS) {
    const v = process.env[name];
    if (v && v.length >= 8) s = s.split(v).join('***');
  }
  return s
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
    .replace(/sk-(?!ant-)[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, 'AIza***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***');
}

export function safeLog(...args) {
  console.log(new Date().toISOString(), ...args.map(scrubSecrets));
}
