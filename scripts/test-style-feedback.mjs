// 反馈打分的回归测试：接话/引用判定、窗口边界、长度分桶。
import assert from 'node:assert/strict';
import { computeFeedback, formatFeedbackSummary } from '../src/style-feedback.js';

const MIN = 60 * 1000;
const base = Date.parse('2026-10-19T12:00:00Z');
const T = (m) => base + m * MIN;

let seq = 0;
function bot(m, text, key = 'group:1') { return { t: T(m), k: key, x: text, s: 1, m: `b${seq++}` }; }
function human(m, text, extra = {}, key = 'group:1') { return { t: T(m), k: key, x: text, s: 0, m: `h${seq++}`, ...extra }; }

const rows = [
  bot(0, '这句是测试用的回复'),                 // 有人接 + 被引用
  human(1, '哈哈哈'),
  human(2, '草', { q: 1 }),
  bot(10, '另一句也是测试回复'),         // 5 分钟内无人接
  human(20, '（11 分钟后才有人说话）'),
  bot(30, '超长'.repeat(30)),                        // 41+ 字，且有人接
  human(31, '确实'),
  bot(40, '另一个群里的发言', 'group:2'),            // 不同会话不能互相算接话
  bot(50, '好'),                                     // 私聊里没人接
];

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('总样本只统计 bot 发言', () => {
  const r = computeFeedback(rows);
  assert.equal(r.total, 5);
});

test('5 分钟内有人说话算接话', () => {
  const r = computeFeedback(rows);
  const first = r.samples.find((s) => s.text.startsWith('这句'));
  assert.equal(first.replied, true);
  assert.equal(first.quoted, true);
  assert.equal(first.latencyMs, 1 * MIN);
});

test('超出窗口算冷落', () => {
  const r = computeFeedback(rows);
  const second = r.samples.find((s) => s.text.includes('另一句'));
  assert.equal(second.replied, false);
  assert.equal(second.latencyMs, null);
});

test('不同会话不互相算接话', () => {
  const r = computeFeedback(rows);
  const other = r.samples.find((s) => s.key === 'group:2');
  assert.equal(other.replied, false, 'group:2 里没有真人消息');
});

test('自定义窗口', () => {
  const r = computeFeedback(rows, { replyWindowMs: 30 * 1000 });
  const first = r.samples.find((s) => s.text.startsWith('这句'));
  assert.equal(first.replied, false, '1 分钟 > 30 秒窗口');
});

test('长度分桶', () => {
  const r = computeFeedback(rows);
  const short = r.buckets.find((b) => b.label === '1-10 字');
  const long = r.buckets.find((b) => b.label === '41+ 字');
  assert.equal(short.n, 4, `short.n=${short.n}`);
  assert.equal(long.n, 1);
  assert.equal(long.repliedRate, 1);
});

test('空输入不崩', () => {
  assert.equal(computeFeedback([]).total, 0);
  assert.equal(computeFeedback(null).total, 0);
  assert.equal(formatFeedbackSummary(computeFeedback([])), '暂无 bot 发言样本');
});

test('summary 可读', () => {
  const text = formatFeedbackSummary(computeFeedback(rows));
  assert.ok(text.includes('bot 发言 5 条'), text);
  assert.ok(text.includes('按长度'), text);
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
console.log(`\n${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
