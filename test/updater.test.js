// 自动更新：签名校验、版本比较、只访问 GitHub 域名、下载后 SHA-256 校验。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.EZLEARN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ezl-upd-'));
process.env.EZLEARN_UPDATE_REPO = 'example-owner/ezlearn';
const U = await import('../server/updater.js');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'pem' });
const sign = (raw) => crypto.sign(null, raw, privateKey).toString('base64');

function release(version, exe) {
  const file = `Ezlearn-Setup-${version}.exe`;
  const raw = Buffer.from(JSON.stringify({ app: 'ezlearn', version, file, size: exe.length, sha256: crypto.createHash('sha256').update(exe).digest('hex'), notes: '修复若干问题', published: '2026-11-10T00:00:00Z' }));
  return { file, raw, sig: sign(raw) };
}

function fakeGitHub(files, { redirectTo = 'objects.githubusercontent.com' } = {}) {
  const calls = [];
  U.setFetch(async (url) => {
    calls.push(url);
    const u = new URL(url);
    const body = (buf) => new Response(buf, { status: 200, headers: { 'content-length': String(buf.length) } });
    if (u.hostname === 'api.github.com') {
      return body(Buffer.from(JSON.stringify({ assets: Object.keys(files).map((name) => ({ name, browser_download_url: `https://github.com/example-owner/ezlearn/releases/download/v/${name}` })) })));
    }
    if (u.hostname === 'github.com') return new Response(null, { status: 302, headers: { location: `https://${redirectTo}/x/${path.basename(u.pathname)}` } });
    const name = path.basename(u.pathname);
    return files[name] !== undefined ? body(Buffer.from(files[name])) : new Response('no', { status: 404 });
  });
  return calls;
}

beforeEach(() => { U._resetUpdater(); U.setPublicKey(PUB); });

test('compareVersions', () => {
  assert.equal(U.compareVersions('0.6.0', '0.5.2'), 1);
  assert.equal(U.compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(U.compareVersions('0.5.2', '0.5.2'), 0);
  assert.equal(U.compareVersions('0.5.1', '0.5.2'), -1);
});

test('verifyManifest accepts a correct signature and rejects tampering', () => {
  const { raw, sig } = release('9.0.0', Buffer.from('exe'));
  assert.equal(U.verifyManifest(raw, sig).version, '9.0.0');
  const tampered = Buffer.from(raw.toString().replace('9.0.0', '9.0.1'));
  assert.throws(() => U.verifyManifest(tampered, sig), /签名不正确/);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => U.verifyManifest(raw, crypto.sign(null, raw, other).toString('base64')), /签名不正确/);
});

test('verifyManifest rejects a signed manifest with a bad file name', () => {
  const raw = Buffer.from(JSON.stringify({ app: 'ezlearn', version: '9.0.0', file: '..\\evil.exe', size: 3, sha256: 'a'.repeat(64) }));
  assert.throws(() => U.verifyManifest(raw, sign(raw)), /不合规/);
});

test('check → download → ready when everything matches', async () => {
  const exe = Buffer.from('MZ fake installer bytes');
  const r = release('9.0.0', exe);
  const calls = fakeGitHub({ 'ezlearn-update.json': r.raw, 'ezlearn-update.json.sig': r.sig, [r.file]: exe });
  const c = await U.checkForUpdate({ force: true });
  assert.equal(c.newer, true);
  assert.equal(c.latest, '9.0.0');
  assert.equal(c.notes, '修复若干问题');
  U.startDownload();
  for (let i = 0; i < 50 && U.downloadStatus().state === 'downloading'; i++) await new Promise((res) => setTimeout(res, 20));
  const st = U.downloadStatus();
  assert.equal(st.state, 'ready', st.error);
  assert.deepEqual(fs.readFileSync(st.file), exe);
  assert.ok(calls.every((u) => new URL(u).protocol === 'https:'));
});

test('download with wrong bytes is rejected and deleted', async () => {
  const r = release('9.0.1', Buffer.from('the real installer'));
  fakeGitHub({ 'ezlearn-update.json': r.raw, 'ezlearn-update.json.sig': r.sig, [r.file]: Buffer.from('the evil installer') });
  await U.checkForUpdate({ force: true });
  U.startDownload();
  for (let i = 0; i < 50 && U.downloadStatus().state === 'downloading'; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(U.downloadStatus().state, 'error');
  assert.match(U.downloadStatus().error, /校验失败|比清单/);
  const dir = path.join(process.env.EZLEARN_DATA_DIR, 'local', 'updates');
  assert.ok(!fs.readdirSync(dir).some((f) => f.includes('9.0.1') && !f.endsWith('.part')));
});

test('redirects to a non-GitHub host are refused', async () => {
  const r = release('9.0.2', Buffer.from('x'));
  fakeGitHub({ 'ezlearn-update.json': r.raw, 'ezlearn-update.json.sig': r.sig, [r.file]: Buffer.from('x') }, { redirectTo: 'evil.example.com' });
  await assert.rejects(U.checkForUpdate({ force: true }), /非 GitHub/);
});

test('an older or equal release is not offered', async () => {
  const r = release('0.0.1', Buffer.from('x'));
  fakeGitHub({ 'ezlearn-update.json': r.raw, 'ezlearn-update.json.sig': r.sig, [r.file]: Buffer.from('x') });
  const c = await U.checkForUpdate({ force: true });
  assert.equal(c.newer, false);
  assert.throws(() => U.startDownload(), /请先检查更新/);
});

test('installing is refused when not running from an installed copy', async () => {
  await assert.rejects(U.installDownloaded(), /开发版/);
});
