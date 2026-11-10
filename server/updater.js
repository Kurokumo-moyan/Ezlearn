// 自动更新：从 GitHub Releases 检查新版本、下载安装包、校验签名后交给安装程序升级。
//
// 发布方式（见 scripts/release.mjs）：每个 Release 附带三个文件
//   Ezlearn-Setup-<版本>.exe        安装包
//   ezlearn-update.json             清单：{ app, version, file, size, sha256, notes, published }
//   ezlearn-update.json.sig         用发布者私钥对清单原始字节做的 Ed25519 签名（base64）
// 软件内置发布者公钥（server/update-key.js）。只有签名正确、清单里的 sha256 与下载的安装包一致，
// 才会运行安装包——GitHub 账号被盗或下载被篡改都装不进来。
//
// 网络安全：只访问 https；只跟随到 GitHub 自己的域名的重定向；每个文件都有大小上限；
// User-Agent 用通用名称，不带任何用户信息；不发送 Cookie / 令牌。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { config, ROOT } from './config.js';
import { loadSettings } from './settings.js';
import { UPDATE_PUBLIC_KEY } from './update-key.js';
import { safeLog } from './security.js';

export const MANIFEST_NAME = 'ezlearn-update.json';
const ALLOWED_HOSTS = new Set(['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const FILE_RE = /^Ezlearn-Setup-(\d+\.\d+\.\d+)\.exe$/;
const MAX_JSON = 1024 * 1024;
const MAX_SIG = 4096;
const MAX_EXE = 400 * 1024 * 1024;
const CHECK_TTL = 60 * 60 * 1000;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
export const CURRENT_VERSION = pkg.version;

/** 更新来源仓库：环境变量 > package.json 的 ezlearn.updateRepo。格式 owner/repo，不合法时视为未配置。 */
export function updateRepo() {
  const r = String(process.env.EZLEARN_UPDATE_REPO || pkg.ezlearn?.updateRepo || '').trim();
  return REPO_RE.test(r) ? r : '';
}

/** 安装版才知道装在哪：app\ 的上一级有 ezlearn-install.json。开发时运行返回 null（只能检查，不能自动安装）。 */
export function installDir() {
  const dir = path.resolve(ROOT, '..');
  return path.basename(ROOT).toLowerCase() === 'app' && fs.existsSync(path.join(dir, 'ezlearn-install.json')) ? dir : null;
}

/** "1.10.0" > "1.9.3"；只比较 x.y.z 数字。 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  return 0;
}

/** 校验清单签名并检查字段。返回清单对象；不合格时抛错。 */
let publicKey = UPDATE_PUBLIC_KEY;
/** 测试用：换成测试密钥。 */
export function setPublicKey(pem) { publicKey = pem || UPDATE_PUBLIC_KEY; }

export function verifyManifest(raw, sigB64, publicKeyPem = publicKey) {
  if (!publicKeyPem) throw new Error('这个版本没有内置更新签名公钥，不能自动安装更新。');
  let ok = false;
  try {
    const sig = Buffer.from(String(sigB64).trim(), 'base64');
    ok = sig.length === 64 && crypto.verify(null, raw, crypto.createPublicKey(publicKeyPem), sig);
  } catch { ok = false; }
  if (!ok) throw new Error('更新清单的签名不正确，已拒绝。可能被篡改或不是官方发布。');
  let m;
  try { m = JSON.parse(raw.toString('utf8')); } catch { throw new Error('更新清单格式不对。'); }
  const fm = FILE_RE.exec(m?.file || '');
  if (m?.app !== 'ezlearn' || !fm || fm[1] !== m.version || !/^[0-9a-f]{64}$/.test(m.sha256 || '')
    || !Number.isInteger(m.size) || m.size <= 0 || m.size > MAX_EXE) throw new Error('更新清单内容不合规，已拒绝。');
  return { version: m.version, file: m.file, size: m.size, sha256: m.sha256, notes: String(m.notes || '').slice(0, 4000), published: String(m.published || '').slice(0, 40) };
}

// ---------------- 受限的 HTTPS 下载 ----------------
let fetchImpl = (...a) => fetch(...a);
/** 测试用：替换网络请求。 */
export function setFetch(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

async function safeGet(url, { accept = '*/*', timeoutMs = 20000 } = {}) {
  let u = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname)) throw new Error(`拒绝访问非 GitHub 地址：${u.hostname}`);
    const r = await fetchImpl(u.href, {
      redirect: 'manual',
      headers: { 'User-Agent': 'Ezlearn-Updater', Accept: accept, ...(u.hostname === 'api.github.com' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ([301, 302, 303, 307, 308].includes(r.status)) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error('下载地址跳转异常');
      u = new URL(loc, u);
      continue;
    }
    if (r.status === 404) throw Object.assign(new Error('没有找到发布的版本'), { code: 'not_found' });
    if (r.status === 403 || r.status === 429) throw Object.assign(new Error('GitHub 暂时限制了访问次数，请稍后再试'), { code: 'rate_limited' });
    if (!r.ok) throw new Error(`GitHub 返回 ${r.status}`);
    return r;
  }
  throw new Error('下载地址跳转次数过多');
}

async function readLimited(r, max) {
  const len = Number(r.headers.get('content-length'));
  if (Number.isFinite(len) && len > max) throw new Error('文件过大，已拒绝');
  const chunks = [];
  let n = 0;
  for await (const c of r.body) {
    n += c.length;
    if (n > max) throw new Error('文件过大，已拒绝');
    chunks.push(c);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

// ---------------- 检查更新 ----------------
let cached = null; // { at, result }

export async function checkForUpdate({ force = false } = {}) {
  const repo = updateRepo();
  const base = { current: CURRENT_VERSION, repo, can_install: Boolean(installDir()) };
  if (!repo) return { ...base, configured: false, newer: false };
  if (!force && cached && Date.now() - cached.at < CHECK_TTL) return cached.result;
  const rel = JSON.parse((await readLimited(await safeGet(`https://api.github.com/repos/${repo}/releases/latest`, { accept: 'application/vnd.github+json' }), MAX_JSON)).toString('utf8'));
  const assets = Array.isArray(rel.assets) ? rel.assets : [];
  const find = (name) => assets.find((a) => a?.name === name)?.browser_download_url;
  const mUrl = find(MANIFEST_NAME);
  const sUrl = find(`${MANIFEST_NAME}.sig`);
  if (!mUrl || !sUrl) throw new Error('最新发布里缺少更新清单或签名文件');
  const raw = await readLimited(await safeGet(mUrl), MAX_JSON);
  const sig = (await readLimited(await safeGet(sUrl), MAX_SIG)).toString('utf8');
  const m = verifyManifest(raw, sig);
  const exeUrl = find(m.file);
  if (!exeUrl) throw new Error('最新发布里缺少安装包');
  const newer = compareVersions(m.version, CURRENT_VERSION) > 0;
  const result = { ...base, configured: true, newer, latest: m.version, notes: m.notes, published: m.published, size: m.size, skipped: loadSettings().update_skip === m.version };
  cached = { at: Date.now(), result, manifest: m, exeUrl };
  return result;
}

// ---------------- 下载 ----------------
const dl = { state: 'idle', received: 0, total: 0, version: null, file: null, error: null };
let installOnExit = false; // 用户选了“关闭后更新”

export function downloadStatus() { return { ...dl, file: dl.file ? path.basename(dl.file) : null, install_on_exit: installOnExit }; }

/** “关闭后更新”：只能在安装包已下载并校验好时打开。 */
export function setInstallOnExit(on) {
  if (on && (dl.state !== 'ready' || !installDir())) throw Object.assign(new Error(installDir() ? '安装包还没有下载好' : '当前是开发版运行，不能自动安装'), { status: 409 });
  installOnExit = Boolean(on);
  return downloadStatus();
}

/**
 * 服务退出时调用（窗口关闭 / 空闲退出 / 点“退出”）。用户选了“关闭后更新”就同步校验后静默启动安装程序：
 * /S 不弹窗、不重新打开，/Update 保持原来的桌面快捷方式状态。任何问题都只记日志，不阻止退出。
 */
export function runPendingInstall() {
  if (!installOnExit) return false;
  installOnExit = false;
  try {
    const dir = installDir();
    const m = cached?.manifest;
    if (!dir || dl.state !== 'ready' || !dl.file || !m || path.basename(dl.file) !== m.file) return false;
    const h = crypto.createHash('sha256').update(fs.readFileSync(dl.file)).digest('hex');
    if (h !== m.sha256) { safeLog('[update] install-on-exit skipped: hash mismatch'); return false; }
    spawn(dl.file, ['/S', '/Update', `/D=${dir}`], { detached: true, stdio: 'ignore', windowsHide: true, cwd: updatesDir() }).unref();
    safeLog(`[update] installing ${m.version} after exit`);
    return true;
  } catch (e) {
    safeLog(`[update] install-on-exit failed: ${e.message}`);
    return false;
  }
}
const updatesDir = () => path.join(config.dataDir, 'local', 'updates');

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** 后台下载最新安装包；立即返回。 */
export function startDownload() {
  if (dl.state === 'downloading') return downloadStatus();
  if (!cached?.manifest || !cached.result.newer) throw Object.assign(new Error('请先检查更新'), { status: 409 });
  const m = cached.manifest;
  const url = cached.exeUrl;
  installOnExit = false;
  Object.assign(dl, { state: 'downloading', received: 0, total: m.size, version: m.version, file: null, error: null });
  (async () => {
    fs.mkdirSync(updatesDir(), { recursive: true });
    // 只保留这一次的安装包，旧的清掉
    for (const f of fs.readdirSync(updatesDir())) if (f !== m.file) fs.rmSync(path.join(updatesDir(), f), { force: true });
    const final = path.join(updatesDir(), m.file);
    if (fs.existsSync(final) && fs.statSync(final).size === m.size && (await sha256File(final)) === m.sha256) {
      Object.assign(dl, { state: 'ready', received: m.size, file: final });
      return;
    }
    const part = `${final}.part`;
    const r = await safeGet(url, { timeoutMs: 30 * 60 * 1000 });
    const h = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    try {
      for await (const c of r.body) {
        dl.received += c.length;
        if (dl.received > m.size) throw new Error('下载的文件比清单里写的大，已停止');
        h.update(c);
        if (!out.write(c)) await new Promise((res) => out.once('drain', res));
      }
    } finally {
      await new Promise((res) => out.end(res));
    }
    if (dl.received !== m.size || h.digest('hex') !== m.sha256) {
      fs.rmSync(part, { force: true });
      throw new Error('安装包校验失败（大小或 SHA-256 不一致），已删除');
    }
    fs.renameSync(part, final);
    Object.assign(dl, { state: 'ready', file: final });
  })().catch((e) => {
    safeLog(`[update] download failed: ${e.message}`);
    Object.assign(dl, { state: 'error', error: e.message });
  });
  return downloadStatus();
}

/** 再校验一次后启动安装程序（/Update 模式：自动安装到当前目录，装完重新打开）。之后安装程序会关掉本软件。 */
export async function installDownloaded() {
  const dir = installDir();
  if (!dir) throw Object.assign(new Error('当前是开发版运行，不能自动安装；请手动下载安装包。'), { status: 409 });
  if (dl.state !== 'ready' || !dl.file || !cached?.manifest) throw Object.assign(new Error('安装包还没有下载好'), { status: 409 });
  const m = cached.manifest;
  if (path.basename(dl.file) !== m.file || path.dirname(dl.file) !== updatesDir()) throw Object.assign(new Error('安装包路径异常'), { status: 409 });
  if ((await sha256File(dl.file)) !== m.sha256) throw Object.assign(new Error('安装包校验失败，请重新下载'), { status: 409 });
  const child = spawn(dl.file, ['/Update', `/D=${dir}`], { detached: true, stdio: 'ignore', windowsHide: false, cwd: updatesDir() });
  child.unref();
  installOnExit = false;
  return { started: true, version: m.version };
}

/** 测试用 */
export function _resetUpdater() { cached = null; installOnExit = false; Object.assign(dl, { state: 'idle', received: 0, total: 0, version: null, file: null, error: null }); }
