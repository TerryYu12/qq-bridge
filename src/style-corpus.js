// 群聊语料库（append-only）：给「语感学习 / few-shot 样本 / 反馈打分」提供原始数据。
//
// 为什么必须有：state/social-v2.json 的 recentMessages 是滚动窗口（默认 100 条），
// qq-activity.log 只记「发送成功 2/2」，不记内容。也就是说现在聊过的话是边生成边丢的，
// 任何「训练数据迭代」都无源之水。
//
// 设计取舍：
// - append-only JSONL，单条一行，便于 grep / 增量读取 / 控制台分页；
// - 内存缓冲 + 定时 flush，避免每条消息一次同步 IO；
// - 30 天滚动（隐私约定）+ 单条 120 字截断；
// - 只采显式允许的会话（默认跟随 allow.groups），私聊不采；
// - 短键名压缩体积：t=time k=key u=userId n=name x=text s=isSelf q=quoteSelf m=messageId b=burst
import fs from 'node:fs';
import path from 'node:path';

export const CORPUS_TEXT_MAX = 120;
export const CORPUS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const BURST_WINDOW_MS = 30 * 1000;
const MAX_BUFFER = 200;

function normalizeText(value, max) {
  const s = String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * @param {object} opts
 * @param {string} opts.dir 语料目录（通常 state/style）
 * @param {() => number} [opts.now]
 * @param {number} [opts.maxAgeMs]
 * @param {number} [opts.textMax]
 * @param {number} [opts.flushIntervalMs]
 * @param {(msg: string) => void} [opts.log]
 */
export function createStyleCorpus(opts = {}) {
  const dir = String(opts.dir || '');
  if (!dir) throw new Error('style-corpus 需要 dir');
  const file = path.join(dir, 'corpus.jsonl');
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const maxAgeMs = Number(opts.maxAgeMs) || CORPUS_MAX_AGE_MS;
  const textMax = Math.max(20, Number(opts.textMax) || CORPUS_TEXT_MAX);
  const flushIntervalMs = Math.max(500, Number(opts.flushIntervalMs) || 5000);
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  fs.mkdirSync(dir, { recursive: true });

  let buffer = [];
  let timer = null;
  let closed = false;
  let written = 0;
  let dropped = 0;
  const lastByKey = new Map(); // `${key}:${uid}` -> { time, name }
  const seenIds = new Set();   // 最近 messageId，防重复入库
  const seenOrder = [];

  function markSeen(messageId) {
    if (!messageId) return false;
    if (seenIds.has(messageId)) return true;
    seenIds.add(messageId);
    seenOrder.push(messageId);
    if (seenOrder.length > 2000) {
      const old = seenOrder.shift();
      seenIds.delete(old);
    }
    return false;
  }

  function appendLines(lines) {
    if (!lines.length) return;
    try {
      fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8');
      written += lines.length;
    } catch (error) {
      log(`语料库写入失败：${error?.message ?? error}`);
    }
  }

  function flush() {
    if (!buffer.length) return;
    const lines = buffer;
    buffer = [];
    appendLines(lines);
  }

  function ensureTimer() {
    if (timer || closed) return;
    timer = setInterval(() => {
      try { flush(); } catch (error) { log(`语料库 flush 失败：${error?.message ?? error}`); }
    }, flushIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * 记录一条消息。
   * @param {{key: string, userId?: string|null, name?: string, text?: string, isSelf?: boolean, quoteSelf?: boolean, messageId?: string|null}} entry
   * @returns {boolean} 是否真的入队（重复 / 空文本 / 未授权由调用方先过滤）
   */
  function record(entry = {}) {
    if (closed) return false;
    const key = String(entry.key || '').trim();
    const text = normalizeText(entry.text, textMax);
    if (!key || !text) return false;
    const messageId = entry.messageId != null ? String(entry.messageId) : null;
    if (markSeen(messageId)) return false;
    const t = Number(entry.time) || now();
    const uid = entry.userId != null ? String(entry.userId) : '';
    const isSelf = !!entry.isSelf;
    const name = normalizeText(entry.name, 40) || (isSelf ? '我' : (uid || '未知'));
    let burst = false;
    if (!isSelf) {
      const slot = `${key}:${uid}`;
      const prev = lastByKey.get(slot);
      if (prev && t - prev.time < BURST_WINDOW_MS) burst = true;
      lastByKey.set(slot, { time: t, name });
    }
    const row = {
      t,
      k: key,
      u: uid,
      n: name,
      x: text,
      s: isSelf ? 1 : 0,
      q: entry.quoteSelf ? 1 : 0,
      m: messageId || undefined,
      b: burst ? 1 : undefined,
    };
    buffer.push(JSON.stringify(row));
    if (buffer.length >= MAX_BUFFER) flush();
    ensureTimer();
    return true;
  }

  function readAll() {
    flush();
    if (!fs.existsSync(file)) return [];
    const out = [];
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
      log(`语料库读取失败：${error?.message ?? error}`);
      return [];
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const row = JSON.parse(trimmed);
        if (row && typeof row === 'object' && row.t) out.push(row);
      } catch { /* 坏行跳过，不让一行坏数据拖垮整个语料 */ }
    }
    return out;
  }

  /** 丢弃超过 maxAgeMs 的行并原子重写；返回保留行数。 */
  function prune(referenceTime) {
    flush();
    if (!fs.existsSync(file)) return 0;
    const cutoff = (Number(referenceTime) || now()) - maxAgeMs;
    const rows = readAll();
    const kept = rows.filter((row) => Number(row.t) >= cutoff);
    dropped += rows.length - kept.length;
    if (kept.length === rows.length) return kept.length;
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmp, kept.map((row) => JSON.stringify(row)).join('\n') + (kept.length ? '\n' : ''), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      log(`语料库裁剪失败：${error?.message || error}`);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
    return kept.length;
  }

  function clear() {
    buffer = [];
    dropped += 0;
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (error) {
      log(`语料库清空失败：${error?.message ?? error}`);
      return false;
    }
    seenIds.clear();
    seenOrder.length = 0;
    lastByKey.clear();
    return true;
  }

  function stats() {
    const rows = readAll();
    const human = rows.filter((r) => !r.s);
    const times = human.map((r) => Number(r.t)).filter(Boolean);
    return {
      file,
      total: rows.length,
      human: human.length,
      self: rows.length - human.length,
      firstAt: times.length ? Math.min(...times) : null,
      lastAt: times.length ? Math.max(...times) : null,
      buffered: buffer.length,
      written,
      dropped,
      sizeBytes: fs.existsSync(file) ? fs.statSync(file).size : 0,
    };
  }

  function close() {
    closed = true;
    if (timer) { clearInterval(timer); timer = null; }
    flush();
  }

  return { file, record, flush, readAll, prune, clear, stats, close };
}
