import express from 'express';
import fs from 'node:fs';
import util from 'node:util';
import path from 'node:path';
import { createRequire } from 'node:module';
import { config, ROOT } from './config.js';
import { hostGuard, securityHeaders, apiGuard, SESSION_TOKEN, safeLog, safeEqual } from './security.js';
import { ensureDataDir } from './storage.js';
import { api } from './routes.js';
import { llmStatus } from './llm.js';
import { setShutdown, idleMs, touch, requestShutdown, canShutdown } from './lifecycle.js';
import { runningJobCount } from './pipeline.js';
import { runPendingInstall } from './updater.js';

const require = createRequire(import.meta.url);

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.set('etag', false);
  app.use(hostGuard);
  app.use(securityHeaders);

  // 启动器用来判断服务是否已在运行；不含任何信息
  app.get('/healthz', (_req, res) => res.type('text/plain').send('ezlearn'));

  // 桌面启动器专用：关窗时请服务退出。凭启动器生成的一次性控制口令（自定义请求头，网页无法跨站伪造），
  // 带 Origin 的请求（来自网页）一律拒绝；有任务在运行时不退出。
  app.post('/control/shutdown', (req, res) => {
    const token = process.env.EZLEARN_CONTROL_TOKEN || '';
    if (req.headers.origin || token.length < 32 || !safeEqual(req.get('x-ezlearn-control'), token) || !canShutdown()) return res.status(403).end();
    if (runningJobCount() > 0) return res.status(409).json({ running: true });
    res.json({ ok: true });
    setTimeout(requestShutdown, 100);
  });

  // API：令牌 + Origin 校验，JSON 体积上限
  app.use('/api', apiGuard, express.json({ limit: config.limits.jsonBody, strict: true }), api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

  // 静态资源：只开放明确的目录，不列目录、不暴露点文件
  const stat = { dotfiles: 'deny', index: false, redirect: false, fallthrough: false };
  app.use('/web', express.static(path.join(ROOT, 'web'), stat));
  app.use('/shared', express.static(path.join(ROOT, 'shared'), stat));
  app.use('/vendor/katex', express.static(path.dirname(require.resolve('katex/dist/katex.min.js')), stat));
  const sqljsDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.js'));
  app.get('/vendor/sqljs/sql-wasm.js', (_req, res) => res.sendFile(path.join(sqljsDir, 'sql-wasm.js')));
  app.get('/vendor/sqljs/worker.sql-wasm.js', (_req, res) => res.sendFile(path.join(sqljsDir, 'worker.sql-wasm.js')));
  app.get('/vendor/sqljs/sql-wasm.wasm', (_req, res) => res.type('application/wasm').sendFile(path.join(sqljsDir, 'sql-wasm.wasm')));

  // 首页：把会话令牌放进 meta 标签（同源页面才能读到）
  const tpl = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const page = tpl.replace('__EZLEARN_TOKEN__', SESSION_TOKEN);
  app.get('/', (_req, res) => res.type('html').send(page));
  app.get('/favicon.ico', (_req, res) => res.status(204).end());

  // 统一错误处理：不向前端泄露堆栈或内部路径
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || (err.code === 'LIMIT_FILE_SIZE' ? 413 : err.name === 'MulterError' ? 400 : 500);
    if (status >= 500) safeLog(`[error] ${req.method} ${req.path} ${err.message}`);
    const msg = status >= 500 ? '服务器内部错误' : err.code === 'LIMIT_FILE_SIZE' ? `文件超过 ${config.limits.uploadBytes / 1024 / 1024}MB 上限` : err.message;
    if (req.path.startsWith('/api')) res.status(status).json({ error: msg });
    else res.status(status).type('text/plain').send(status === 404 ? 'Not found' : msg);
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(path.join(ROOT, 'server', 'index.js'))) {
  // 桌面启动器没有命令行窗口：输出写进日志文件（超过 5MB 时清空重来）
  const logFile = process.env.EZLEARN_LOG_FILE;
  if (logFile) {
    try { if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.truncateSync(logFile, 0); } catch { /* 文件还不存在 */ }
    const write = (...a) => { try { fs.appendFileSync(logFile, `${util.format(...a)}\n`); } catch { /* 日志写不进去不影响运行 */ } };
    console.log = write; console.error = write; console.warn = write;
  }
  ensureDataDir();
  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    const s = llmStatus();
    safeLog(`Ezlearn 已启动：http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}/`);
    safeLog(`数据目录：${config.dataDir}`);
    const cred = { fake: '假模型（测试模式）', api: '已配置', unknown: '未检测到环境变量（若已运行 ant auth login 仍可用）', missing: "未配置——请在软件的“设置”页填写", error: `配置有误：${s.error}` }[s.mode];
    safeLog(`模型：${s.provider_label} / ${s.model}${s.host ? `（${s.host}）` : ''}；密钥：${cred}`);
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`端口 ${config.port} 已被占用：Ezlearn 可能已经在另一个窗口运行。请直接在浏览器打开 http://127.0.0.1:${config.port}/ ，或先关掉另一个窗口。`);
    } else {
      console.error(`启动失败：${e.message}`);
    }
    process.exit(1);
  });
  server.requestTimeout = 5 * 60 * 1000;

  // 由桌面启动器（Ezlearn.exe）拉起时：窗口关掉后没有心跳、也没有任务在跑，就自动退出，不留后台进程。
  const shutdown = () => { safeLog('Ezlearn 退出'); runPendingInstall(); server.close(); setTimeout(() => process.exit(0), 1500).unref(); };
  if (process.env.EZLEARN_LAUNCHER === '1') {
    setShutdown(shutdown);
    touch();
    const IDLE_MS = 2 * 60 * 1000;
    setInterval(() => { if (idleMs() > IDLE_MS && runningJobCount() === 0) shutdown(); }, 15 * 1000).unref();
  }
  server.headersTimeout = 60 * 1000;
}
