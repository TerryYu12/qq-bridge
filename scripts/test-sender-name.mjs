// sender 名清洗的回归测试。真实脏样本来自 2026-10-19 群 123456789 的 recentMessages。
import assert from 'node:assert/strict';
import { sanitizeSenderName, isCorruptedSenderName, senderNameFromEvent, SENDER_NAME_MAX } from '../src/sender-name.js';

// 实测残留：控制字符 + protobuf 长度前缀 + Latin Extended / 控制图像残留，真名在中间。
const DIRTY = '\n\f\n\n%\u0100\u0100\u2407\u00DB\n\u000E\u0012\f阿狸\u0010\u0000';

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

test('实测脏样本 -> 真名', () => {
  assert.equal(sanitizeSenderName(DIRTY, '10001'), '阿狸');
});

test('干净中文名原样', () => {
  assert.equal(sanitizeSenderName('阿狸'), '阿狸');
});

test('英文名原样，且不被 Latin-1 字母误伤', () => {
  assert.equal(sanitizeSenderName('Alice'), 'Alice');
  assert.equal(sanitizeSenderName('Müller'), 'Müller');
});

test('emoji 昵称原样', () => {
  assert.equal(sanitizeSenderName('🐟小鱼'), '🐟小鱼');
});

test('中文 + 数字 + 空格原样', () => {
  assert.equal(sanitizeSenderName('铁蛋233'), '铁蛋233');
  assert.equal(sanitizeSenderName('老 王'), '老 王');
});

test('空值回退到 userId', () => {
  assert.equal(sanitizeSenderName('', '12345'), '12345');
  assert.equal(sanitizeSenderName(null, '12345'), '12345');
  assert.equal(sanitizeSenderName(undefined, undefined), '未知');
});

test('纯噪声回退，不返回空串', () => {
  const noise = '\u0000\u0001\u0002\u2407\u00DB';
  assert.equal(sanitizeSenderName(noise, '999'), '999');
});

test('中文名尾巴的 ASCII 残留被剥掉', () => {
  const dirty = '\n\u000b\u0012\t铁蛋\n\t\n\u0007$\u00FF\u0100\u0011\u0010\u0010\u0000';
  assert.equal(sanitizeSenderName(dirty, '10002'), '铁蛋');
});

test('幂等', () => {
  const once = sanitizeSenderName(DIRTY, 'x');
  assert.equal(sanitizeSenderName(once, 'x'), once);
});

test('超长截断', () => {
  const long = '名'.repeat(SENDER_NAME_MAX + 20);
  assert.equal(sanitizeSenderName(long, 'x').length, SENDER_NAME_MAX);
});

test('isCorruptedSenderName 判定', () => {
  assert.equal(isCorruptedSenderName(DIRTY), true);
  assert.equal(isCorruptedSenderName('阿狸'), false);
  assert.equal(isCorruptedSenderName('Alice'), false);
});

test('senderNameFromEvent：群聊走清洗，私聊固定文案', () => {
  assert.equal(senderNameFromEvent({ sender: { card: DIRTY }, user_id: 10001 }, 'group'), '阿狸');
  assert.equal(senderNameFromEvent({ sender: { nickname: '小红' }, user_id: 1 }, 'group'), '小红');
  assert.equal(senderNameFromEvent({ sender: {} , user_id: 42 }, 'group'), '42');
  assert.equal(senderNameFromEvent({ sender: { nickname: '小红' } }, 'private'), '私聊');
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
