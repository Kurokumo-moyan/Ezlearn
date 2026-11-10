// 为一个已经构建好的安装包生成更新清单和签名。
//   npm run build:installer
//   node scripts/release.mjs [私钥路径] [--notes "这次更新了什么"]
// 输出到 dist/release-<版本>/：
//   Ezlearn-Setup-<版本>.exe、ezlearn-update.json、ezlearn-update.json.sig
// 然后在 GitHub 仓库新建 Release（tag 写 v<版本>），把这三个文件都作为附件上传并发布。
// 软件启动时会读取“最新发布”（latest release），校验签名后提示用户更新。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const ni = args.indexOf('--notes');
const notes = ni >= 0 ? String(args.splice(ni, 2)[1] || '') : '';
const privFile = path.resolve(args[0] || path.join(ROOT, '..', 'Ezlearn-release-key', 'ezlearn-release-private.pem'));

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = pkg.version;
const file = `Ezlearn-Setup-${version}.exe`;
const exe = path.join(ROOT, 'dist', file);
if (!fs.existsSync(exe)) throw new Error(`找不到 ${exe}，请先 npm run build:installer`);
if (!fs.existsSync(privFile)) throw new Error(`找不到私钥 ${privFile}（先运行 node scripts/release-keygen.mjs）`);

const buf = fs.readFileSync(exe);
const manifest = {
  app: 'ezlearn',
  version,
  file,
  size: buf.length,
  sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  notes: notes.slice(0, 4000),
  published: new Date().toISOString(),
};
const raw = Buffer.from(JSON.stringify(manifest, null, 1), 'utf8');
const priv = crypto.createPrivateKey(fs.readFileSync(privFile));
const sig = crypto.sign(null, raw, priv).toString('base64');

// 用仓库里的公钥自检，防止拿错私钥发布后谁都装不上
const { UPDATE_PUBLIC_KEY } = await import(new URL('../server/update-key.js', import.meta.url));
if (!crypto.verify(null, raw, crypto.createPublicKey(UPDATE_PUBLIC_KEY), Buffer.from(sig, 'base64'))) {
  throw new Error('私钥与 server/update-key.js 里的公钥不匹配，停止发布');
}

const out = path.join(ROOT, 'dist', `release-${version}`);
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(exe, path.join(out, file));
fs.writeFileSync(path.join(out, 'ezlearn-update.json'), raw);
fs.writeFileSync(path.join(out, 'ezlearn-update.json.sig'), sig + '\n');
console.log(`已生成 ${out}\n  ${file}（${(buf.length / 1048576).toFixed(1)} MB，sha256 ${manifest.sha256.slice(0, 16)}…）\n  ezlearn-update.json\n  ezlearn-update.json.sig\n在 GitHub 新建 Release，tag 填 v${version}，上传以上三个文件并发布。`);
