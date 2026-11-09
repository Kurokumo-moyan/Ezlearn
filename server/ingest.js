// S1 资料解析：确定性文本提取（不经过模型，不总结、不改写）。
// 安全：扩展名白名单 + 魔数校验 + 编码自检（非 UTF-8 自动转换并要求用户确认）+ 页数/字符上限；PDF 解析禁用 eval 与字体加载。
import path from 'node:path';
import { config } from './config.js';
import { MATERIAL_ROLES } from './schemas.js';
import { detectText, decodeAs, ENCODINGS } from './encoding.js';

export const ALLOWED_EXT = new Set(['.pdf', '.txt', '.md', '.vtt', '.srt', '.csv', '.sql']);

export function guessRole(filename) {
  const n = filename.toLowerCase();
  const ext = path.extname(n);
  if (ext === '.sql' || ext === '.csv') return 'dataset';
  if (/transcript|转录|录音|lecture[-_ ]?recording/.test(n) || ext === '.vtt' || ext === '.srt') return 'transcript';
  if (/assign|作业|project|项目/.test(n)) return 'assignment';
  if (/(exam|final|midterm|quiz|真题|期末|期中)/.test(n)) return /sol|ans|答案|解答/.test(n) ? 'past_exam_solution' : 'past_exam';
  if (/(tut|tutorial|习题课)/.test(n)) return /sol|ans|答案/.test(n) ? 'tutorial_solution' : 'tutorial';
  if (/\blab\b|lab\d|实验/.test(n)) return /sol|ans|答案/.test(n) ? 'lab_solution' : 'lab';
  if (/outline|syllabus|大纲/.test(n)) return 'course_outline';
  if (/annot|批注/.test(n)) return 'annotated_slides';
  if (/slide|lec|讲义|课件/.test(n)) return 'slides';
  if (/textbook|book|教材|chapter/.test(n)) return 'textbook';
  if (/note|笔记/.test(n)) return 'lecture_notes';
  return 'other';
}

/** 解码文本文件：指定 encoding 时按它解码，否则自动识别。 */
function decodeText(buf, encoding) {
  if (encoding) {
    const strip = encoding === 'utf-8' && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : (encoding.startsWith('utf-16') && (buf[0] === 0xff || buf[0] === 0xfe) ? 2 : 0);
    const text = decodeAs(buf.subarray(strip), encoding).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    return { encoding, label: ENCODINGS[encoding], text, needsConfirm: encoding !== 'utf-8', candidates: Object.keys(ENCODINGS) };
  }
  return detectText(buf);
}

function capChars(pages) {
  let total = 0;
  const out = [];
  for (const p of pages) {
    if (total >= config.limits.materialChars) break;
    const text = p.text.slice(0, config.limits.materialChars - total);
    total += text.length;
    out.push({ ...p, text });
  }
  return out;
}

async function pdfPages(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw Object.assign(new Error('不是有效的 PDF 文件'), { status: 415 });
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false, // CVE-2024-4367 类问题的防线
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const n = Math.min(doc.numPages, config.limits.pdfPages);
    const pages = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      let text = '';
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        text += it.str + (it.hasEOL ? '\n' : '');
      }
      pages.push({ n: i, text: text.replace(/[ \t]+\n/g, '\n').trim(), needs_vision: text.trim().length < 20 });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

function transcriptPages(text, ext) {
  let body = text;
  if (ext === '.vtt' || ext === '.srt') {
    // 去掉序号行和时间轴，但保留时间戳作为位置信息
    const paras = [];
    let cur = { ts: '', lines: [] };
    for (const line of text.split('\n')) {
      const m = /^(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{3}\s*-->/.exec(line.trim());
      if (m) { if (cur.lines.length) paras.push(cur); cur = { ts: line.trim().split(/\s*-->/)[0], lines: [] }; continue; }
      if (/^WEBVTT|^\d+$/.test(line.trim()) || !line.trim()) continue;
      cur.lines.push(line.trim());
    }
    if (cur.lines.length) paras.push(cur);
    // 合并成约 600 字一段
    const out = [];
    let acc = null;
    for (const p of paras) {
      if (!acc) acc = { ts: p.ts, text: '' };
      acc.text += (acc.text ? ' ' : '') + p.lines.join(' ');
      if (acc.text.length > 600) { out.push(acc); acc = null; }
    }
    if (acc) out.push(acc);
    return out.map((p, i) => ({ n: i + 1, text: p.text, timestamp: p.ts }));
  }
  return body.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((t, i) => ({ n: i + 1, text: t }));
}

function textPages(text) {
  // 支持 "\f" 分页或 "--- page N ---"/"--- slide N ---" 分隔；否则按约 3000 字分块（保持段落完整）
  if (text.includes('\f')) return text.split('\f').map((t, i) => ({ n: i + 1, text: t.trim() }));
  const marked = text.split(/^-{3,}\s*(?:page|slide|幻灯片|第)\s*\d+.*-{3,}\s*$/im);
  if (marked.length > 1) return marked.map((t) => t.trim()).filter(Boolean).map((t, i) => ({ n: i + 1, text: t }));
  const paras = text.split(/\n\s*\n/);
  const out = [];
  let acc = '';
  for (const p of paras) {
    if (acc.length + p.length > 3000 && acc) { out.push(acc); acc = ''; }
    acc += (acc ? '\n\n' : '') + p;
  }
  if (acc) out.push(acc);
  return out.map((t, i) => ({ n: i + 1, text: t.trim() }));
}

// ---- CSV → SQL（用于 SQL 沙箱的数据集） ----
export function parseCSV(text, maxRows = 5000) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; if (rows.length > maxRows) break; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ''));
}

const sqlIdent = (s, fallback) => {
  const v = String(s).trim().replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1').slice(0, 40);
  return v || fallback;
};
const sqlLit = (v) => (v === '' ? 'NULL' : /^-?\d+(\.\d+)?$/.test(v) ? v : `'${v.replace(/'/g, "''")}'`);

export function csvToSql(filename, text) {
  const rows = parseCSV(text);
  if (!rows.length) return '';
  const table = sqlIdent(path.basename(filename, path.extname(filename)), 'data');
  const cols = rows[0].map((c, i) => sqlIdent(c, `c${i + 1}`));
  const body = rows.slice(1).map((r) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => sqlLit(r[i] ?? '')).join(', ')});`);
  return `CREATE TABLE ${table} (${cols.join(', ')});\n${body.join('\n')}\n`;
}

/**
 * 解析一个上传文件为 Material（不含 id）。
 * @returns {{pages: Array, sql?: string, kind: string}}
 */
export async function parseFile(filename, buf, { encoding } = {}) {
  const ext = path.extname(filename).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) throw Object.assign(new Error(`不支持的文件类型 ${ext}`), { status: 415 });
  if (ext === '.pdf') return { kind: 'pdf', pages: capChars(await pdfPages(buf)) };
  const dec = decodeText(buf, encoding);
  const text = dec.text;
  const enc = { encoding: dec.encoding, label: dec.label, needs_confirm: dec.needsConfirm, candidates: dec.candidates };
  if (ext === '.sql') return { kind: 'sql', pages: [{ n: 1, text: text.slice(0, config.limits.materialChars) }], sql: text, text, enc };
  if (ext === '.csv') {
    const sql = csvToSql(filename, text);
    return { kind: 'csv', pages: [{ n: 1, text: text.slice(0, 20000) }], sql, text, enc };
  }
  if (ext === '.vtt' || ext === '.srt') return { kind: 'transcript', pages: capChars(transcriptPages(text, ext)), text, enc };
  return { kind: 'text', pages: capChars(textPages(text)), text, enc };
}

export function pagesForRole(role, parsed, filename) {
  // 纯文本转录按段落切分，便于"第 N 段"这样的证据定位
  if (role === 'transcript' && parsed.kind === 'text') return capChars(transcriptPages(parsed.text, path.extname(filename).toLowerCase()));
  return parsed.pages;
}

export function validRole(r) {
  return MATERIAL_ROLES.includes(r) ? r : null;
}
