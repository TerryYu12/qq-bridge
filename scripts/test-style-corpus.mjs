// 语料库的回归测试：写入、去重、连发判定、30 天裁剪、清空。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStyleCorpus, CORPUS_TEXT_MAX } from '../src/style-corpus.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-style-'));
let clock = Date.parse('2026-10-19T12:00:00Z');
const now = () => clock;
const corpus = createStyleCorpus({ dir: tmp, now, flushIntervalMs: 999999 });

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('写入并读回', () => {
  assert.equal(corpus.record({ key: 'group:1', userId: '42', name: '阿狸', text: '测试消息' }), true);
  assert.equal(corpus.record({ key: 'group:1', userId: '43', name: '老王', text: '晚安', isSelf: false }), true);
  const rows = corpus.readAll();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].n, '阿狸');
  assert.equal(rows[0].x, '测试消息');
  assert.equal(rows[0].s, 0);
});

test('单条文本截断', () => {
  corpus.record({ key: 'group:1', userId: '44', name: '长', text: '字'.repeat(500) });
  const row = corpus.readAll().find((r) => r.u === '44');
  assert.equal(row.x.length, CORPUS_TEXT_MAX);
});

test('重复 messageId 只记一次', () => {
  const before = corpus.readAll().length;
  corpus.record({ key: 'group:1', userId: '45', name: 'a', text: 'hi', messageId: 'm1' });
  corpus.record({ key: 'group:1', userId: '45', name: 'a', text: 'hi', messageId: 'm1' });
  assert.equal(corpus.readAll().length, before + 1);
});

test('30 秒内同人连发标记 burst', () => {
  clock += 1000;
  corpus.record({ key: 'group:2', userId: '46', name: 'b', text: '第一句' });
  clock += 5000;
  corpus.record({ key: 'group:2', userId: '46', name: 'b', text: '第二句' });
  clock += 31000;
  corpus.record({ key: 'group:2', userId: '46', name: 'b', text: '隔很久' });
  const rows = corpus.readAll().filter((r) => r.k === 'group:2');
  assert.equal(rows[0].b, undefined);
  assert.equal(rows[1].b, 1);
  assert.equal(rows[2].b, undefined);
});

test('空文本与空 key 被丢弃', () => {
  const before = corpus.readAll().length;
  assert.equal(corpus.record({ key: 'group:1', text: '   ' }), false);
  assert.equal(corpus.record({ key: '', text: 'hi' }), false);
  assert.equal(corpus.readAll().length, before);
});

test('显式 time 优先于记录时刻（历史补录不能伪造连发）', () => {
  const stamp = clock - 3600_000;
  corpus.record({ key: 'group:3', userId: '50', name: 'd', text: '旧消息', time: stamp });
  const row = corpus.readAll().find((r) => r.u === '50');
  assert.equal(row.t, stamp);
});

test('30 天裁剪保留新行', () => {
  const before = corpus.readAll().length;
  clock += 31 * 24 * 60 * 60 * 1000;
  corpus.record({ key: 'group:1', userId: '47', name: '新', text: '新消息' });
  const kept = corpus.prune(clock);
  assert.equal(kept, 1, `旧行应被裁掉，实际保留 ${kept}/${before + 1}`);
  const rows = corpus.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].u, '47');
});

test('清空', () => {
  assert.equal(corpus.clear(), true);
  assert.equal(corpus.readAll().length, 0);
});

test('stats 字段齐全', () => {
  corpus.record({ key: 'group:1', userId: '48', name: 'c', text: 'x' });
  const s = corpus.stats();
  for (const key of ['file', 'total', 'human', 'self', 'buffered', 'written', 'dropped', 'sizeBytes']) {
    assert.ok(key in s, `缺少 ${key}`);
  }
  assert.equal(s.total, 1);
});

let failed = 0;
for (const [name, fn] of cases) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${error.message}`);
  }
}
corpus.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
