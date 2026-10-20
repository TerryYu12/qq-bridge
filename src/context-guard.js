// 上下文守卫：长寿命会话的上下文监控与处置（纯逻辑，便于单测）。
//
// 背景（2026-10-18 实测）：一条连续运行两天的 DSH 会话，输入上下文可涨到 12 万+（DSH 面板口径）
// / 24 万+（provider 口径 = cacheHit+cacheMiss）。此后每步首字延迟 30 秒起步，provider 对大
// 请求的流也更容易断——单步被拖到分钟级，回复体感从"秒级"掉到"几分钟"。
//
// 本模块只做「决策 + 文案」：给定当前规模与历史提醒记录，输出 none / notify / auto-reset。
// 读数与执行（发 QQ 提醒、走 /reset 流程）由 bridge.js 的 contextGuardTick 负责。

/**
 * 决定一次上下文守卫动作。
 * @param {object} p
 * @param {number} p.tokens            该会话当前输入上下文（provider 口径）
 * @param {number} p.warnTokens        提醒阈值（<=0 关闭提醒）
 * @param {number} p.autoResetTokens   自动重置阈值（<=0 关闭自动重置）
 * @param {number} p.notifyCooldownMs  两次提醒的最小间隔
 * @param {number} p.lastNotifyAt      上次提醒时间戳（0 = 从未提醒）
 * @param {number} p.notifiedTokens    上次提醒时的规模（涨幅 ≥1.5x 时无视冷却再提醒）
 * @param {boolean} p.quiet            会话是否空闲（自动重置要求；由调用方判定）
 * @param {number} p.now               当前时间戳
 * @returns {{action: 'none'|'notify'|'auto-reset'}}
 */
export function decideGuardAction({ tokens, warnTokens, autoResetTokens = 0, notifyCooldownMs = 0, lastNotifyAt = 0, notifiedTokens = 0, quiet = false, now = 0 }) {
  const t = Number(tokens);
  if (!Number.isFinite(t) || t <= 0) return { action: 'none' };

  const resetAt = Number(autoResetTokens) || 0;
  if (resetAt > 0 && t >= resetAt && quiet) return { action: 'auto-reset' };

  const warn = Number(warnTokens) || 0;
  if (warn <= 0 || t < warn) return { action: 'none' };

  const grewALot = Number(notifiedTokens) > 0 && t >= Number(notifiedTokens) * 1.5;
  const cooled = !lastNotifyAt || now - Number(lastNotifyAt) >= Math.max(0, Number(notifyCooldownMs) || 0);
  if (!cooled && !grewALot) return { action: 'none' };
  return { action: 'notify' };
}

/** 给管理员的普通提醒文案。 */
export function formatGuardNotify(key, tokens) {
  const wan = (Number(tokens) / 10000).toFixed(1);
  return `⚠️【系统】会话 ${key} 的对话上下文已达约 ${wan} 万 tokens，模型每步响应会明显变慢。方便时建议重置该会话（在对应聊天发 /reset，或到控制台「会话」里点重置）。本提醒为自动发送，同一会话一段时间内不会重复。`;
}

/** 自动重置后的告知文案。 */
export function formatGuardReset(key, tokens) {
  const wan = (Number(tokens) / 10000).toFixed(1);
  return `♻️【系统】会话 ${key} 上下文过大（约 ${wan} 万 tokens），已自动重置；下次消息将从新上下文开始（该会话的 AI 记忆也一并清空）。`;
}
