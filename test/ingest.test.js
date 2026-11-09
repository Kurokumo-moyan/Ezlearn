import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testEnv } from './helpers.js';

testEnv(5904);
const { parseFile, guessRole, csvToSql, pagesForRole } = await import('../server/ingest.js');
const { runSQL } = await import('../server/sandbox/index.js');

test('PDF text extraction keeps page numbers and flags textless pages', async () => {
  const r = await parseFile('lec.pdf', fs.readFileSync(new URL('./fixtures/two-pages.pdf', import.meta.url)));
  assert.equal(r.pages.length, 2);
  assert.equal(r.pages[0].text, 'GROUP BY is not examinable here');
  assert.equal(r.pages[1].needs_vision, true);
});

test('transcripts are split into numbered paragraphs; VTT keeps timestamps', async () => {
  const buf = Buffer.from('para one\n\npara two important\n\npara three');
  const parsed = await parseFile('week1_transcript.txt', buf);
  const pages = pagesForRole('transcript', parsed, 'week1_transcript.txt', buf);
  assert.deepEqual(pages.map((p) => p.n), [1, 2, 3]);
  const vtt = await parseFile('a.vtt', Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nhello there\n\n00:00:04.000 --> 00:00:05.000\nthis is not examinable\n'));
  assert.equal(vtt.pages[0].timestamp, '00:00:01.000');
  assert.match(vtt.pages[0].text, /not examinable/);
});

test('role guessing from filenames', () => {
  assert.equal(guessRole('Week5_Lecture_Transcript.txt'), 'transcript');
  assert.equal(guessRole('final_2024_solutions.pdf'), 'past_exam_solution');
  assert.equal(guessRole('Assignment2.pdf'), 'assignment');
  assert.equal(guessRole('tut3_sol.pdf'), 'tutorial_solution');
  assert.equal(guessRole('data.csv'), 'dataset');
});

test('CSV becomes a loadable SQL table with escaped literals', async () => {
  const sql = csvToSql('people list.csv', 'name,age,"note, with comma"\n"O\'Brien",30,"say ""hi"""\nAnn,,x\n');
  const r = await runSQL(sql, 'SELECT name, age, note__with_comma FROM people_list ORDER BY name');
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.rows, [['Ann', null, 'x'], ["O'Brien", 30, 'say "hi"']]);
});
