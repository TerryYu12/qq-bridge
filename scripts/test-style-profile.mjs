// 语感卡的回归测试：分位数、比率、样本量门槛、注入文本。
import assert from 'node:assert/strict';
import { computeStyleProfile, formatStyleBlock, STYLE_MIN_SAMPLES } from '../src/style-profile.js';

function row(text, extra = {}) {
  return { t: Date.now(), k: 'group:1', u: '1', n: '甲', x: text, s: 0, ...extra };
}

const rows = [
  ...Array.from({ length: 10 }, (_, i) => row(`短句${'啊'.repeat(i % 3)}`)),      // 5~7 字
  ...Array.from({ length: 10 }, (_, i) => row(`这一句大概九个字${i % 2 ? '草' : ''}`)), // ~9 字
  ...Array.from({ length: 10 }, (_, i) => row(`这是一条明显长一点的句子用来验证九十分位${i % 3 === 0 ? '。' : ''}`)),
];

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('样本不足返回 null', () => {
  assert.equal(computeStyleProfile(rows.slice(0, STYLE_MIN_SAMPLES - 1)), null);
  assert.equal(computeStyleProfile([]), null);
  assert.equal(computeStyleProfile(null), null);
});

test('样本足够时输出统计', () => {
  const p = computeStyleProfile(rows);
  assert.ok(p, '应产出语感卡');
  assert.equal(p.sampleCount, 30);
  assert.ok(p.lenMedian > 0 && p.lenMedian <= p.lenP90, `median=${p.lenMedian} p90=${p.lenP90}`);
  assert.ok(p.lenMean > 0);
});

test('分位数按字符数计算', () => {
  const p = computeStyleProfile(rows);
  // 30 条：10 条 5~7 字、10 条约 9 字、10 条约 20+ 字
  assert.ok(p.lenMedian >= 5 && p.lenMedian <= 12, `median=${p.lenMedian}`);
  assert.ok(p.lenP90 >= p.lenMedian, `p90=${p.lenP90}`);
});

test('连发与句号比率', () => {
  const withBurst = rows.map((r, i) => (i < 6 ? { ...r, b: 1 } : r));
  const p = computeStyleProfile(withBurst);
  assert.equal(p.burstRate, 0.2);
});

test('语气词按覆盖率筛选', () => {
  const p = computeStyleProfile(rows);
  assert.ok(Array.isArray(p.topFillers));
  assert.ok(p.topFillers.includes('草'), `topFillers=${p.topFillers.join(',')}`);
});

test('emoji 与 [图片] 不污染长度', () => {
  const p = computeStyleProfile([
    ...rows.slice(0, 25),
    row('[图片]'),
    row('[表情]'),
    row('好'),
    row('好'),
    row('好'),
  ]);
  assert.ok(p.lenMedian <= 12, `median=${p.lenMedian}`);
});

test('formatStyleBlock 输出可注入文本', () => {
  const p = computeStyleProfile(rows);
  const block = formatStyleBlock(p);
  assert.ok(block.startsWith('【本群语感】'), block);
  assert.ok(block.includes('句长中位'), block);
  assert.ok(block.includes('不用每句都接'), block);
  assert.ok(block.length < 400, `过长：${block.length}`);
});

test('空卡不产生注入文本', () => {
  assert.equal(formatStyleBlock(null), '');
  assert.equal(formatStyleBlock({}), '');
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
