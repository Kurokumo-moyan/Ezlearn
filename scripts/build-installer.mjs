// 生成 Windows 安装包：dist/Ezlearn-Setup-<版本>.exe（一个文件，包含软件本体 + 内置 Node.js + 卸载程序）。
// 用法：npm run build:installer
// 只用 Windows 自带的 C# 编译器（.NET Framework 4.x 的 csc.exe）和 PowerShell，不需要安装额外工具。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeIcon } from '../installer/make-icon.mjs';
import { fetchWebView2, WEBVIEW2_VERSION } from './fetch-webview2.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const STAGE = path.join(BUILD, 'stage');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const log = (...a) => console.log('[build]', ...a);

if (process.platform !== 'win32') throw new Error('安装包只能在 Windows 上构建');
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(CSC)) throw new Error(`找不到 C# 编译器：${CSC}`);
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor < 22) throw new Error(`内置的 Node.js 至少要 22，当前 ${process.version}`);

// ---------- 1. 准备目录 ----------
// build/ 和 dist/ 只放生成物，可以随时整个重建（都在 .gitignore 里）
for (const d of [STAGE, DIST]) {
  if (!path.resolve(d).startsWith(ROOT + path.sep)) throw new Error('refusing to clean outside repo');
}
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'app'), { recursive: true });
fs.mkdirSync(path.join(STAGE, 'runtime'), { recursive: true });
fs.mkdirSync(DIST, { recursive: true });

// ---------- 2. 软件本体 ----------
const copy = (rel, dest = path.join(STAGE, 'app', rel)) => fs.cpSync(path.join(ROOT, rel), dest, { recursive: true, dereference: true });
for (const d of ['server', 'web', 'shared', 'prompts', 'samples']) copy(d);
fs.mkdirSync(path.join(STAGE, 'app', 'scripts'));
copy('scripts/seed-demo.js');
copy('package.json');
copy('package-lock.json');
log('copied app files');

// 生产依赖（本项目没有开发依赖，node_modules 全部是运行需要的）；去掉调试符号、类型声明和用不到的构建
copy('node_modules');
const NM = path.join(STAGE, 'app', 'node_modules');
let pruned = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (/\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/.test(e.name)) { fs.rmSync(p); pruned++; }
  }
};
walk(NM);
for (const rel of ['pdfjs-dist/build', 'pdfjs-dist/web', 'pdfjs-dist/types', 'pdfjs-dist/image_decoders', 'katex/src', 'zod/src', '.package-lock.json']) {
  const p = path.join(NM, rel);
  if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); pruned++; }
}
log(`pruned ${pruned} unneeded files from node_modules`);

// ---------- 3. 内置 Node.js（就是当前运行的这个官方 node.exe） ----------
fs.copyFileSync(process.execPath, path.join(STAGE, 'runtime', 'node.exe'));
const nodeLicense = path.join(path.dirname(process.execPath), 'LICENSE');
if (fs.existsSync(nodeLicense)) fs.copyFileSync(nodeLicense, path.join(STAGE, 'runtime', 'LICENSE.txt'));
log(`bundled Node.js ${process.version}`);

// ---------- 4. 冒烟测试：用打包后的文件真正启动一次 ----------
await smokeTest();

// ---------- 5. 编译桌面组件 ----------
const ICO = path.join(BUILD, 'ezlearn.ico');
makeIcon(ICO);
const SRC = path.join(ROOT, 'installer');
const REFS = ['System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll', 'System.Management.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll'];
function csc(out, sources, extra = []) {
  const platform = extra.find((x) => x.startsWith('/platform:')) || '/platform:anycpu';
  extra = extra.filter((x) => !x.startsWith('/platform:'));
  const args = ['/nologo', '/target:winexe', '/optimize+', platform, '/codepage:65001', `/out:${out}`, `/win32icon:${ICO}`, `/win32manifest:${path.join(SRC, 'app.manifest')}`,
    ...REFS.map((r) => `/r:${r}`), ...extra, ...sources.map((s) => path.join(SRC, s))];
  try {
    execFileSync(CSC, args, { stdio: 'pipe' });
  } catch (e) {
    throw new Error(`编译 ${path.basename(out)} 失败：\n${e.stdout?.toString() || ''}${e.stderr?.toString() || ''}`);
  }
  log(`compiled ${path.relative(ROOT, out)}`);
}
// 桌面窗口用 WebView2：SDK 从 nuget.org 下载并校验 Microsoft 签名，3 个 DLL 和 Ezlearn.exe 放在一起
const WV2 = await fetchWebView2();
for (const f of ['Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll']) fs.copyFileSync(path.join(WV2, f), path.join(STAGE, f));
log(`WebView2 SDK ${WEBVIEW2_VERSION} (Microsoft-signed)`);
csc(path.join(STAGE, 'Ezlearn.exe'), ['Common.cs', 'Launcher.cs', 'AppWindow.cs'], [
  '/platform:x64', // WebView2Loader.dll 是 x64 版；内置 Node.js 也是 x64
  `/r:${path.join(WV2, 'Microsoft.Web.WebView2.Core.dll')}`, `/r:${path.join(WV2, 'Microsoft.Web.WebView2.WinForms.dll')}`,
]);
csc(path.join(STAGE, 'Uninstall.exe'), ['Common.cs', 'Uninstall.cs']);

// ---------- 6. 打包 payload.zip，编译安装程序 ----------
const ZIP = path.join(BUILD, 'payload.zip');
fs.rmSync(ZIP, { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${STAGE.replace(/'/g, "''")}', '${ZIP.replace(/'/g, "''")}', [IO.Compression.CompressionLevel]::Optimal, $false)`], { stdio: 'inherit' });
log(`payload ${(fs.statSync(ZIP).size / 1024 / 1024).toFixed(1)} MB`);

const setupSrc = path.join(BUILD, 'Setup.generated.cs');
fs.writeFileSync(setupSrc, fs.readFileSync(path.join(SRC, 'Setup.cs'), 'utf8').replace('__VERSION__', VERSION).replace('__NODE_VERSION__', process.version));
const OUT = path.join(DIST, `Ezlearn-Setup-${VERSION}.exe`);
csc(OUT, ['Common.cs'], [`/resource:${ZIP},payload.zip`, setupSrc]);
const sha = crypto.createHash('sha256').update(fs.readFileSync(OUT)).digest('hex');
fs.writeFileSync(`${OUT}.sha256`, `${sha}  ${path.basename(OUT)}\n`);
log(`done: ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024 / 1024).toFixed(1)} MB)  sha256 ${sha}`);

async function smokeTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ezlearn-smoke-'));
  const port = 5899;
  const node = path.join(STAGE, 'runtime', 'node.exe');
  // 1) 解析一份 PDF（确认裁剪后的 pdfjs 仍可用）
  const fixture = path.join(ROOT, 'test', 'fixtures', 'two-pages.pdf');
  const code = `const m = await import(${JSON.stringify(new URL(`file:///${path.join(STAGE, 'app', 'server', 'ingest.js').replace(/\\/g, '/')}`).href)});
const r = await m.parseFile('a.pdf', (await import('node:fs')).readFileSync(${JSON.stringify(fixture)}));
if (r.pages.length !== 2) throw new Error('pdf pages ' + r.pages.length);
const pr = await import(${JSON.stringify(new URL(`file:///${path.join(STAGE, 'app', 'server', 'pagerender.js').replace(/\\/g, '/')}`).href)});
const doc = await pr.openPdf((await import('node:fs')).readFileSync(${JSON.stringify(fixture)}));
const png = await doc.render(1); await doc.close();
if (png[0] !== 0xff || png[1] !== 0xd8) throw new Error('page render failed');
console.log('pdf ok, page render ok');`;
  execFileSync(node, ['--input-type=module', '-e', code], { env: { ...process.env, EZLEARN_DATA_DIR: tmp }, stdio: 'inherit' });
  // 2) 启动服务，检查 /healthz 与首页
  const child = spawn(node, [path.join(STAGE, 'app', 'server', 'index.js')], {
    cwd: path.join(STAGE, 'app'), env: { ...process.env, EZLEARN_DATA_DIR: tmp, EZLEARN_PORT: String(port), EZLEARN_FAKE_LLM: '1' }, stdio: 'ignore',
  });
  try {
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { ok = (await (await fetch(`http://127.0.0.1:${port}/healthz`)).text()) === 'ezlearn'; } catch { /* not yet */ }
    }
    if (!ok) throw new Error('smoke test: server did not start');
    const home = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    if (!home.includes('ezlearn-token')) throw new Error('smoke test: index page broken');
    for (const asset of ['/web/app.js', '/vendor/katex/katex.min.js', '/vendor/sqljs/sql-wasm.wasm']) {
      const r = await fetch(`http://127.0.0.1:${port}${asset}`);
      if (!r.ok) throw new Error(`smoke test: ${asset} ${r.status}`);
    }
    log('smoke test passed (pdf parsing, server start, static assets)');
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
