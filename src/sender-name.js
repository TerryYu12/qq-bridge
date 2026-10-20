// 群名片/昵称清洗：剥掉 SnowLuma 侧偶发的 protobuf 解码残留，产出可读名字。
//
// 为什么要独立成模块：`sender` 会流进 recentMessages、黑话证据、memberImpressions 的 key、
// 语料库和唤醒 prompt。一个脏名字会同时污染学习数据和记忆索引，而且清洗逻辑必须可单测。
//
// 实测样本（2026-10-19，群 123456789，63/63 条真人消息全脏）：
//   "\n\f\n\n%ĀĀ␇Û\n\u000e\u0012\f阿狸\u0010\u0000" -> "阿狸"
// 真实昵称通常完整地嵌在残留中间，所以策略是「按可读性切段、取最长可读片段」，
// 而不是逐字符过滤——逐字符过滤会把相邻的中文和数字也吃掉。

const CJK_RE = /[\u3400-\u4DBF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/;
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/g;
// Latin Extended / 控制图像 / 替换符：中文群名片里几乎不可能正常出现，视为解码噪声。
const CORRUPTION_RE = /[\u0100-\u02FF\u2400-\u243F\uFFFD]/;

export const SENDER_NAME_MAX = 64;

function isReadableCodePoint(cp, allowLatinExt) {
  // ASCII 可打印区（含空格，最后统一 trim）
  if (cp >= 0x20 && cp <= 0x7E) return true;
  // CJK / 假名 / 韩文
  if ((cp >= 0x3400 && cp <= 0x4DBF) || (cp >= 0x4E00 && cp <= 0x9FFF)) return true;
  if (cp >= 0x3040 && cp <= 0x30FF) return true;
  if (cp >= 0xAC00 && cp <= 0xD7AF) return true;
  // emoji / 杂项符号 / 装饰符号
  if (cp >= 0x2600 && cp <= 0x27BF) return true;
  if (cp >= 0x2B00 && cp <= 0x2BFF) return true;
  if (cp >= 0x1F000 && cp <= 0x1FAFF) return true;
  // 纯拉丁名（无 CJK）时允许 Latin-1 补充与 Latin Extended，避免误伤 José / Müller
  if (allowLatinExt && cp >= 0x00C0 && cp <= 0x02FF) return true;
  return false;
}

function readableSegments(text, allowLatinExt) {
  const out = [];
  let cur = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (isReadableCodePoint(cp, allowLatinExt)) {
      cur += ch;
    } else if (cur) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur) out.push(cur);
  return out;
}

function normalizeWhitespace(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

// 中文名片里紧跟的 ASCII 符号几乎都是残留（实测 "铁蛋 $"），但数字/字母要保留（"铁蛋233"）。
function trimAsciiNoise(s, hasCJK) {
  if (!hasCJK) return s;
  return s.replace(/^[\s$%^~`|\\/]+/, '').replace(/[\s$%^~`|\\/]+$/, '').trim();
}

/**
 * 把可能是 protobuf 残留的 sender 名清洗成可读文本。
 * @param {unknown} raw 原始 sender（card / nickname / userId）
 * @param {string} fallback 清洗后为空时的回退值（通常是 userId）
 * @param {number} [maxLen] 最大保留长度
 * @returns {string}
 */
export function sanitizeSenderName(raw, fallback = '未知', maxLen = SENDER_NAME_MAX) {
  const limit = Math.max(1, Number(maxLen) || SENDER_NAME_MAX);
  const fallbackText = normalizeWhitespace(fallback == null ? '未知' : fallback) || '未知';
  const source = normalizeWhitespace(String(raw ?? '').replace(CONTROL_RE, ' '));
  if (!source) return fallbackText.slice(0, limit);

  // 快路径：干净名字原样返回（保证幂等，也不改动正常昵称里的标点）。
  if (!CORRUPTION_RE.test(source) && source.length <= limit) return source;

  const hasCJK = CJK_RE.test(source);
  // Latin-1/Extended 只在「这看起来像一个拉丁名」时才算可读：
  // 必须同时存在 ASCII 字母，否则单个 "Û" 这类残留会被当成名字保留下来。
  const hasAsciiLetters = /[A-Za-z]/.test(source);
  const segments = readableSegments(source, !hasCJK && hasAsciiLetters)
    .map(normalizeWhitespace)
    .filter(Boolean);
  if (!segments.length) return fallbackText.slice(0, limit);

  // 有 CJK 时优先选含 CJK 的段，避免选中残留里的 "abc123" 之类短噪声。
  const pool = hasCJK ? segments.filter((s) => CJK_RE.test(s)) : segments;
  const candidates = pool.length ? pool : segments;
  candidates.sort((a, b) => b.length - a.length);
  const best = candidates[0];
  const trimmed = trimAsciiNoise(best, hasCJK);
  const result = trimmed || best;
  return (result.length > limit ? result.slice(0, limit) : result) || fallbackText.slice(0, limit);
}

/** 判断一个 sender 是否含解码残留（用于日志与采样统计）。 */
export function isCorruptedSenderName(raw) {
  const source = String(raw ?? '');
  return CORRUPTION_RE.test(source) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(source);
}

/** 从 OneBot 事件里取 sender 名，统一走清洗。 */
export function senderNameFromEvent(event, kind, fallback = '未知') {
  if (kind === 'private') return '私聊';
  const raw = event?.sender?.card || event?.sender?.nickname || null;
  const userId = event?.user_id ?? event?.userId ?? null;
  return sanitizeSenderName(raw, userId != null ? String(userId) : fallback);
}
