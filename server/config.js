// 运行配置：全部来自环境变量 / .env，带安全默认值。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 读取项目根目录的 .env（若存在）。Node >= 21 内置，不引入 dotenv 依赖。
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile(envFile);
}

function defaultDataDir() {
  // 数据放在仓库之外，避免课程资料（可能受版权保护）被误提交。
  const base = process.env.APPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'Ezlearn');
}

function int(name, def, min, max) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

function num(name, def, min, max) {
  const v = Number.parseFloat(process.env[name] ?? '');
  if (!Number.isFinite(v)) return def;
  return Math.min(max, Math.max(min, v));
}

const host = process.env.EZLEARN_HOST || '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(host) && process.env.EZLEARN_ALLOW_REMOTE !== '1') {
  // 默认只允许监听回环地址：本软件没有多用户鉴权，不应暴露到局域网。
  throw new Error(`EZLEARN_HOST=${host} 不是回环地址。若确实需要，请同时设置 EZLEARN_ALLOW_REMOTE=1 并自行加反向代理鉴权。`);
}

export const config = Object.freeze({
  host,
  port: int('EZLEARN_PORT', 5855, 1024, 65535),
  dataDir: path.resolve(process.env.EZLEARN_DATA_DIR || defaultDataDir()),
  effort: process.env.EZLEARN_EFFORT || 'high',
  // 每门课的 API 花费上限（美元，按 token 估算），防止失控循环烧钱。
  budgetUsdPerCourse: num('EZLEARN_BUDGET_USD', 20, 0, 10000),
  fakeLLM: process.env.EZLEARN_FAKE_LLM === '1',
  limits: Object.freeze({
    uploadBytes: int('EZLEARN_MAX_UPLOAD_MB', 50, 1, 500) * 1024 * 1024,
    filesPerUpload: 20,
    jsonBody: '2mb',
    pdfPages: 1500,
    materialChars: 3_000_000,
    sandboxMs: 2000,
    sandboxMemBytes: 64 * 1024 * 1024,
    sqlRows: 500,
  }),
});

