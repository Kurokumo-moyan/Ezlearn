// 文本编码自检：上传的 TXT / 转录 / CSV / SQL 不是 UTF-8 时，自动识别常见编码并转成 UTF-8 副本。
// 原始字节原样保存（raw/<id>.bin），转换后的文字要用户确认没有乱码后才参与生成。
// 只用 Node 内置 TextDecoder（官方构建自带完整 ICU），不引入第三方库。

export const ENCODINGS = Object.freeze({
  'utf-8': 'UTF-8',
  'utf-16le': 'UTF-16 LE（Windows "Unicode"）',
  'utf-16be': 'UTF-16 BE',
  gb18030: '简体中文 GBK / GB18030',
  big5: '繁体中文 Big5',
  shift_jis: '日文 Shift-JIS',
  'euc-kr': '韩文 EUC-KR',
  'windows-1252': '西欧 Windows-1252 / Latin-1',
});

// 简体与繁体共用的高频汉字：用来判断"解出来的是正常中文还是乱码"
const COMMON_HAN = new Set('的一是不了人我在有他中大上子和你地出道也年得就那要下以生自着去之家可里后小么心多天而能好都然没日于起还成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知样分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走四第门相次东海口使教西再平真听世气信北少关并内加化由却代军产入先山五太水万市眼体别处总才场师书比住员九笑性通目报立马命张活难神数件安表原车白应路期叫死常提感金何更反合放做系计或司利受光王果亲界及今京务制解各任至清物台象记边共风战干接它许八特觉望直服毛林题建南度统色字请交爱让认算论百吃义科怎元社术结六功指思非流每青管夫连远资队跟带花快条院变联言权往展该领传近留红治决周保达办运武半候七必城父强步完革深区即求品士转量空甚众技轻程告江语英基派满式李息写呢识极令黄德收脸钱倒未持取设始版双历越史商千片容研像找友孩站广改议形委早房音火际则首单导影失拿网香似斯专石若兵弟谁校读志飞观争究包组造落视济喜离虽坐集编宝谈府拉黑且随格尽剑讲布杀微怕母调局根曾准团段终乐切级克精哪官示冷域假們為個這說時來國過對會後還開關點樣進從動現發實問題學說應經麼種長門裡頭見無與東車馬電話們為讓認識課數據');

function score(text) {
  if (!text) return -1;
  let han = 0; let common = 0; let kana = 0; let hangul = 0; let latin = 0; let bad = 0; let total = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) continue;
    total++;
    if (c === 0xfffd || (c < 0x20) || (c >= 0x7f && c < 0xa0) || (c >= 0xe000 && c <= 0xf8ff)) bad++;
    else if (c >= 0x4e00 && c <= 0x9fff) { han++; if (COMMON_HAN.has(ch)) common++; }
    else if (c >= 0x3040 && c <= 0x30ff) kana++;
    else if (c >= 0xac00 && c <= 0xd7af) hangul++;
    else if (c < 0x80) latin++;
  }
  if (!total) return 0;
  // 正常中文里高频字占比通常 > 30%；乱码里的汉字大多是生僻字
  const cjk = han ? (common / han) * (han / total) : 0;
  // 用错编码解出来的往往是"假名 / 韩文 + 一堆生僻汉字"：生僻汉字越多扣分越多
  const rareHan = (han - common) / total;
  return Math.max(cjk, kana / total, hangul / total, (latin / total) * 0.3) - (bad / total) * 3 - rareHan * 0.6;
}

function tryDecode(buf, enc) {
  try { return new TextDecoder(enc, { fatal: true }).decode(buf); } catch { return null; }
}

/** 用指定编码解码（不严格，坏字节变成 �）。 */
export function decodeAs(buf, enc) {
  if (!ENCODINGS[enc]) throw Object.assign(new Error('不支持的编码'), { status: 400 });
  return new TextDecoder(enc).decode(buf);
}

/**
 * 识别编码。返回 { encoding, label, text, needsConfirm, candidates }。
 * UTF-8（含 BOM）直接通过；其他编码 needsConfirm=true，要用户看一眼预览。
 */
export function detectText(buf) {
  const head = buf.subarray(0, 3);
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) return done('utf-8', tryDecode(buf.subarray(3), 'utf-8') ?? decodeAs(buf.subarray(3), 'utf-8'), false);
  if (head[0] === 0xff && head[1] === 0xfe) return done('utf-16le', decodeAs(buf.subarray(2), 'utf-16le'), true);
  if (head[0] === 0xfe && head[1] === 0xff) return done('utf-16be', decodeAs(buf.subarray(2), 'utf-16be'), true);

  const utf8 = tryDecode(buf, 'utf-8');
  if (utf8 !== null && !utf8.includes('\u0000')) return done('utf-8', utf8, false);

  // 没有 BOM 的 UTF-16：偶数 / 奇数位置大量 0 字节
  const sample = buf.subarray(0, 4096);
  let evenZero = 0; let oddZero = 0;
  for (let i = 0; i < sample.length; i++) if (sample[i] === 0) { if (i % 2) oddZero++; else evenZero++; }
  if (oddZero > sample.length / 6 && evenZero < oddZero / 4) return done('utf-16le', decodeAs(buf, 'utf-16le'), true);
  if (evenZero > sample.length / 6 && oddZero < evenZero / 4) return done('utf-16be', decodeAs(buf, 'utf-16be'), true);
  if (buf.includes(0)) throw Object.assign(new Error('文件里有二进制内容，不像文本文件（可能是 Word / 图片改了扩展名）'), { status: 415 });

  const ranked = ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']
    .map((enc) => ({ enc, text: tryDecode(buf, enc) }))
    .filter((x) => x.text !== null)
    .map((x) => ({ ...x, s: score(x.text.slice(0, 20000)) }))
    .sort((a, b) => b.s - a.s);
  const best = ranked[0] || { enc: 'windows-1252', text: decodeAs(buf, 'windows-1252') };
  return done(best.enc, best.text, true, ranked.map((r) => r.enc));

  function done(encoding, text, needsConfirm, order) {
    const candidates = order ? [...new Set([...order, ...Object.keys(ENCODINGS)])] : Object.keys(ENCODINGS);
    return { encoding, label: ENCODINGS[encoding], text: text.replace(/^﻿/, '').replace(/\r\n?/g, '\n'), needsConfirm, candidates };
  }
}
