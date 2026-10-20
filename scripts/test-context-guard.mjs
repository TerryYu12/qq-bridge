// 上下文守卫逻辑测试。
// 验证：
// 1. 低于阈值不动作；超阈值 → notify；
// 2. 冷却期内不重复提醒；涨幅 ≥1.5x 无视冷却；冷却结束可再提醒；
// 3. autoResetTokens>0 且会话空闲 → auto-reset；不空闲时降级为 notify；0=关闭；
// 4. 异常输入安全；提醒/重置文案可生成且含关键信息。
import { decideGuardAction, formatGuardNotify, formatGuardReset } from '../src/context-guard.js';

let failed = 0;
function assert(cond, label) {
  if (cond) {
    console.log(`✅ ${label}`);
  } else {
    console.error(`❌ ${label}`);
    failed = 1;
  }
}

const NOW = 1_800_000_000_000;
const base = {
  warnTokens: 140000,
  autoResetTokens: 0,
  notifyCooldownMs: 6 * 3600 * 1000,
  quiet: true,
  now: NOW
};

// 1. 阈值判定
assert(decideGuardAction({ ...base, tokens: 100000 }).action === 'none', '低于阈值 → none');
assert(decideGuardAction({ ...base, tokens: 150000 }).action === 'notify', '超阈值 → notify');

// 2. 冷却与涨幅
assert(
  decideGuardAction({ ...base, tokens: 150000, lastNotifyAt: NOW - 60_000, notifiedTokens: 150000 }).action === 'none',
  '冷却期内、涨幅不足 → none'
);
assert(
  decideGuardAction({ ...base, tokens: 230000, lastNotifyAt: NOW - 60_000, notifiedTokens: 150000 }).action === 'notify',
  '涨幅 ≥1.5x → 无视冷却再提醒'
);
assert(
  decideGuardAction({ ...base, tokens: 150000, lastNotifyAt: NOW - 7 * 3600 * 1000, notifiedTokens: 150000 }).action === 'notify',
  '冷却结束 → 再提醒'
);

// 3. 自动重置
assert(
  decideGuardAction({ ...base, tokens: 210000, autoResetTokens: 200000 }).action === 'auto-reset',
  '空闲 + 达自动重置阈值 → auto-reset'
);
assert(
  decideGuardAction({ ...base, tokens: 210000, autoResetTokens: 200000, quiet: false }).action === 'notify',
  '不空闲 → 降级 notify'
);
assert(
  decideGuardAction({ ...base, tokens: 210000, autoResetTokens: 200000, quiet: false, lastNotifyAt: NOW - 60_000, notifiedTokens: 210000 }).action === 'none',
  '不空闲且冷却中 → none（等待空闲/冷却）'
);
assert(
  decideGuardAction({ ...base, tokens: 210000, autoResetTokens: 0 }).action === 'notify',
  'autoResetTokens=0 → 仅提醒'
);
assert(
  decideGuardAction({ ...base, tokens: 190000, autoResetTokens: 200000 }).action === 'notify',
  '未达自动重置阈值 → notify'
);

// 4. 异常输入安全
assert(decideGuardAction({ ...base, tokens: 0 }).action === 'none', 'tokens=0 → none');
assert(decideGuardAction({ ...base, tokens: NaN }).action === 'none', 'tokens=NaN → none');
assert(decideGuardAction({ ...base, tokens: 150000, warnTokens: 0 }).action === 'none', 'warnTokens=0 → none（关闭提醒）');

// 5. 文案
const n = formatGuardNotify('group:123', 155000);
assert(n.includes('group:123') && n.includes('15.5'), '提醒文案含会话与规模');
const r = formatGuardReset('private:456', 250000);
assert(r.includes('private:456') && r.includes('25.0'), '重置文案含会话与规模');

if (failed) {
  console.error('\n❌ 测试失败');
  process.exit(1);
}
console.log('\n🎉 上下文守卫逻辑测试通过');
