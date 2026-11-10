// 生成发布签名密钥（只需做一次）。
//   node scripts/release-keygen.mjs [私钥保存目录]
// 私钥写到仓库之外（默认 ../Ezlearn-release-key/ezlearn-release-private.pem），千万不要提交、不要上传；
// 公钥写进 server/update-key.js，随软件发布，用来验证更新清单的签名。
// 已有私钥时拒绝覆盖——换钥匙会让已经装好的旧版本再也收不到更新。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.resolve(process.argv[2] || path.join(ROOT, '..', 'Ezlearn-release-key'));
const privFile = path.join(dir, 'ezlearn-release-private.pem');
if (dir.startsWith(ROOT + path.sep) || dir === ROOT) throw new Error('私钥不能放在仓库里面');
if (fs.existsSync(privFile)) throw new Error(`私钥已存在：${privFile}（不覆盖）`);

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
const pub = publicKey.export({ type: 'spki', format: 'pem' }).trim();
fs.writeFileSync(path.join(ROOT, 'server', 'update-key.js'),
  `// 发布者的 Ed25519 公钥：用来验证更新清单（ezlearn-update.json）的签名。由 scripts/release-keygen.mjs 生成。\n// 对应的私钥只保存在发布者电脑上（仓库之外），不能提交。\nexport const UPDATE_PUBLIC_KEY = ${JSON.stringify(pub + '\n')};\n`);
console.log(`私钥：${privFile}\n公钥已写入 server/update-key.js`);
