// 软件内设置（模型提供商、密钥、模型名、默认预算）。保存在数据目录的 settings.json，界面修改后立即生效，无需重启。
// 优先级：界面设置 > .env / 环境变量 > 内置默认。
// 密钥只在服务端保存与使用；接口只返回"是否已保存 + 末尾 4 位"。文件权限 0600（Windows 上位于当前用户私有的 %APPDATA%）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { PRESETS, resolveProvider } from './providers.js';

const FILE = () => path.join(config.dataDir, 'settings.json');
let cache = null;
let version = 0;

export function loadSettings() {
  if (cache) return cache;
  try {
    const v = JSON.parse(fs.readFileSync(FILE(), 'utf8'));
    cache = v && typeof v === 'object' ? v : {};
  } catch {
    cache = {};
  }
  cache.keys ||= {};
  cache.models ||= {};
  return cache;
}

export function saveSettings(next) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${FILE()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
  cache = next;
  version++;
  providerCache = null;
}

/** 测试用：丢弃缓存，下次重新读文件。 */
export function reloadSettings() { cache = null; providerCache = null; version++; }

/** 把界面设置叠加到环境变量上，得到 resolveProvider 的输入。 */
export function effectiveEnv(env = process.env) {
  const s = loadSettings();
  const e = { ...env };
  if (s.provider && PRESETS[s.provider]) {
    e.EZLEARN_PROVIDER = s.provider;
    // 换了提供商时，.env 里给别家写的模型名 / 地址不能带过来
    if (s.models[s.provider]) e.EZLEARN_MODEL = s.models[s.provider];
    else if (env.EZLEARN_PROVIDER && env.EZLEARN_PROVIDER !== s.provider) delete e.EZLEARN_MODEL;
    if (s.provider === 'custom' && s.base_url) e.EZLEARN_BASE_URL = s.base_url;
    else if (s.provider !== 'custom') delete e.EZLEARN_BASE_URL;
  }
  return e;
}

let providerCache = null;
/** 当前生效的提供商（不含密钥）。 */
export function getProvider() {
  if (!providerCache) providerCache = Object.freeze(resolveProvider(effectiveEnv()));
  return providerCache;
}

/** 某个提供商的密钥：界面保存的优先，其次环境变量。 */
export function apiKeyFor(id) {
  const s = loadSettings();
  const preset = PRESETS[id];
  return s.keys[id] || (preset ? process.env[preset.keyEnv] : '') || '';
}

export function keyTail(id) {
  const k = apiKeyFor(id);
  return k ? k.slice(-4) : '';
}

export function budgetDefault() {
  const b = Number(loadSettings().budget_usd);
  return Number.isFinite(b) && b > 0 ? b : config.budgetUsdPerCourse;
}

export function settingsVersion() { return version; }
