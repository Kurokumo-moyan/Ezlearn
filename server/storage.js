// 本地 JSON 存储。所有路径都由已校验的 id 拼出，用户文件名永不进入路径。
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { assertId } from './security.js';

const COURSES = path.join(config.dataDir, 'courses');

export function newId(prefix = '') {
  return (prefix + crypto.randomBytes(6).toString('hex')).toLowerCase();
}

function inside(base, p) {
  const rel = path.relative(base, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Object.assign(new Error('path escape'), { status: 400 });
  return p;
}

export function courseDir(courseId) {
  return inside(COURSES, path.join(COURSES, assertId(courseId, 'course id')));
}

function file(courseId, ...parts) {
  parts.forEach((p) => {
    // 允许 "chapters" 这类固定目录名和 "<id>.json"
    if (!/^[a-z0-9][a-z0-9-]{0,63}(\.(json|pdf|txt|bin))?$/.test(p)) throw Object.assign(new Error('bad path part'), { status: 400 });
  });
  const dir = courseDir(courseId);
  return inside(dir, path.join(dir, ...parts));
}

async function writeAtomic(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, data, { mode: 0o600 });
  await fs.rename(tmp, p);
}

export async function readJSON(courseId, ...parts) {
  try {
    return JSON.parse(await fs.readFile(file(courseId, ...parts), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeJSON(courseId, value, ...parts) {
  await writeAtomic(file(courseId, ...parts), JSON.stringify(value, null, 1));
}

export async function writeRaw(courseId, buf, ...parts) {
  await writeAtomic(file(courseId, ...parts), buf);
}

export async function listJSON(courseId, dir) {
  try {
    const names = await fs.readdir(file(courseId, dir));
    const out = [];
    for (const n of names.filter((n) => n.endsWith('.json')).sort()) out.push(await readJSON(courseId, dir, n));
    return out.filter(Boolean);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/** 目录里有多少个 .json（不读内容）。 */
export async function countJSON(courseId, dir) {
  try { return (await fs.readdir(file(courseId, dir))).filter((n) => n.endsWith('.json')).length; } catch { return 0; }
}

export async function removeFile(courseId, ...parts) {
  await fs.rm(file(courseId, ...parts), { force: true });
}

export async function listCourses() {
  try {
    const ids = await fs.readdir(COURSES);
    const out = [];
    for (const id of ids) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) continue;
      const c = await readJSON(id, 'course.json');
      if (c) out.push(c);
    }
    return out.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

export async function deleteCourse(courseId) {
  await fs.rm(courseDir(courseId), { recursive: true, force: true });
}

export function ensureDataDir() {
  fss.mkdirSync(COURSES, { recursive: true, mode: 0o700 });
}
