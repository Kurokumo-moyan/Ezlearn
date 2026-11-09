// 编码自检：常见非 UTF-8 编码都能识别，UTF-8 不需要确认，真正的二进制被拒绝。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectText } from '../server/encoding.js';

const CASES = [
  ['gb18030', 'b5dad2bbd6dca3bacafdbeddbfe2b5c4bbf9b1beb8c5c4eea1a3c0cfcaa6cbb5d5e2d2bbb2bfb7d6cac7bfbccad4d6d8b5e3a3acb4f3bcd2d2aac8cfd5e6b8b4cfb0a1a3', '第一周：数据'],
  ['big5', 'b2c4a440b667a147b8eaaec6ae77aabab0f2a5bbb7a7a9c0a143a6d1ae76bba1b36fa440b3a1a4c0ac4fa6d2b8d5adabc249a141a46aae61ad6ebb7baf75bdc6b2dfa143', '第一週：資料'],
  ['shift_jis', '8366815b835e8378815b835882cc8aee967b8a54944f82f08a7782d182dc82b7814282b182cc959495aa82cd8e8e8cb182c98f6f82dc82b782cc82c5814182b582c182a982e8959c8f4b82b582c482ad82be82b382a28142', 'データベース'],
  ['euc-kr', 'b5a5c0ccc5cdbaa3c0ccbdbac0c720b1e2babb20b0b3b3e4c0bb20b9e8bff3b4cfb4d92e20c0cc20bacebad0c0ba20bdc3c7e8bfa120b3aabfc9b4cfb4d92e', '데이터베이스'],
  ['windows-1252', '4c657320626173657320646520646f6e6ee965732072656c6174696f6e6e656c6c657320736f6e74207472e87320696d706f7274616e74657320706f7572206c276578616d656e2066696e616c2e2052e9766973657a206269656e2e', 'Les ba'],
];

for (const [enc, hex, head] of CASES) {
  test(`detects ${enc}`, () => {
    const r = detectText(Buffer.from(hex, 'hex'));
    assert.equal(r.encoding, enc);
    assert.equal(r.needsConfirm, true);
    assert.ok(r.text.startsWith(head), r.text.slice(0, 20));
  });
}

test('UTF-8 (with or without BOM) passes without confirmation', () => {
  assert.equal(detectText(Buffer.from('中文 text', 'utf8')).needsConfirm, false);
  const r = detectText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文', 'utf8')]));
  assert.equal(r.text, '中文');
  assert.equal(r.needsConfirm, false);
});

test('UTF-16 with BOM is decoded; CRLF normalised', () => {
  const r = detectText(Buffer.from('fffe2c7b004e685420006e006f00740065007300', 'hex'));
  assert.equal(r.encoding, 'utf-16le');
  assert.equal(r.text, '第一周 notes');
  assert.equal(detectText(Buffer.from('a\r\nb', 'utf8')).text, 'a\nb');
});

test('binary content is rejected', () => {
  assert.throws(() => detectText(Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0xb8, 0x00, 0x00, 0x01])), /二进制/);
});
