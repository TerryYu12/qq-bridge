// 反馈打分（L3）：给 bot 的每条发言算「有没有人接」。
//
// 为什么要单独成模块：这是唯一能自动获得的 reward，决定 few-shot 样本取舍。
// 但它是**粗代理**，必须诚实标注口径：
// - replied：发言后 replyWindowMs 内同会话出现真人消息（不代表在回你，可能只是群聊继续）
// - quoted：quotedWindowMs 内有人引用这条（q=1），这是强信号
// - ignored：窗口内没有任何真人消息
// 群聊场景无法得到"精确被回应率"，所以按长度分桶看相对差异，而不是看绝对值。

export const DEFAULT_REPLY_WINDOW_MS = 5 * 60 * 1000;
export const DEFAULT_QUOTE_WINDOW_MS = 10 * 60 * 1000;

const LENGTH_BUCKETS = [
  { label: '1-10 字', min: 1, max: 10 },
  { label: '11-20 字', min: 11, max: 20 },
  { label: '21-40 字', min: 21, max: 40 },
  { label: '41+ 字', min: 41, max: Number.POSITIVE_INFINITY },
];

function charLen(s) {
  return Array.from(String(s ?? '')).length;
}

function median(list) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * @param {Array<object>} rows style-corpus 行（{t,k,u,n,x,s,q,m,b}）
 * @param {{replyWindowMs?: number, quoteWindowMs?: number}} [opts]
 */
export function computeFeedback(rows, opts = {}) {
  const replyWindowMs = Math.max(1, Number(opts.replyWindowMs) || DEFAULT_REPLY_WINDOW_MS);
  const quoteWindowMs = Math.max(1, Number(opts.quoteWindowMs) || DEFAULT_QUOTE_WINDOW_MS);

  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !row.k || !Number(row.t)) continue;
    if (!byKey.has(row.k)) byKey.set(row.k, []);
    byKey.get(row.k).push(row);
  }

  const samples = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => Number(a.t) - Number(b.t));
    for (let i = 0; i < sorted.length; i += 1) {
      const row = sorted[i];
      if (!row.s) continue; // 只看 bot 发言
      const after = sorted.slice(i + 1);
      const firstHuman = after.find((x) => !x.s && Number(x.t) - Number(row.t) <= replyWindowMs);
      const quoted = after.some(
        (x) => !x.s && x.q === 1 && Number(x.t) - Number(row.t) <= quoteWindowMs,
      );
      samples.push({
        t: Number(row.t),
        key,
        text: String(row.x ?? ''),
        len: charLen(row.x),
        replied: !!firstHuman,
        quoted,
        latencyMs: firstHuman ? Number(firstHuman.t) - Number(row.t) : null,
      });
    }
  }

  const total = samples.length;
  const replied = samples.filter((s) => s.replied).length;
  const quoted = samples.filter((s) => s.quoted).length;
  const latencies = samples.map((s) => s.latencyMs).filter((n) => Number.isFinite(n));

  const buckets = LENGTH_BUCKETS.map((bucket) => {
    const list = samples.filter((s) => s.len >= bucket.min && s.len <= bucket.max);
    return {
      label: bucket.label,
      n: list.length,
      repliedRate: list.length ? list.filter((s) => s.replied).length / list.length : null,
      quotedRate: list.length ? list.filter((s) => s.quoted).length / list.length : null,
      avgLen: list.length ? Math.round(list.reduce((sum, s) => sum + s.len, 0) / list.length) : null,
    };
  });

  return {
    total,
    replied,
    quoted,
    ignored: total - replied,
    repliedRate: total ? replied / total : null,
    quotedRate: total ? quoted / total : null,
    medianLatencyMs: median(latencies),
    replyWindowMs,
    quoteWindowMs,
    buckets,
    samples,
  };
}

/** 渲染成给控制台/日志看的短文本。 */
export function formatFeedbackSummary(report) {
  if (!report || !report.total) return '暂无 bot 发言样本';
  const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);
  const lines = [
    `bot 发言 ${report.total} 条：5 分钟内有人接 ${pct(report.repliedRate)}，被引用 ${pct(report.quotedRate)}，冷落 ${report.total - report.replied} 条`,
  ];
  const buckets = report.buckets.filter((b) => b.n > 0).map((b) => `${b.label} ${b.n}条/${pct(b.repliedRate)}`);
  if (buckets.length) lines.push(`按长度：${buckets.join('，')}`);
  return lines.join('\n');
}
