// 「本群语感」统计卡：把群聊语料压成一组可测的说话习惯，供 prompt 注入。
//
// 为什么不用 LLM 生成：这些全是可精确计算的统计量（分位数、比率），
// 用模型去做等于花 token 换误差。先出确定性的 v0，等语料多了再让离线会话补
// 「什么场景该接/不该接」这类模型更擅长的判断。
//
// 输入是 style-corpus 的行（t/k/u/n/x/s/q/b），全部来自真人消息（s=0）。

export const STYLE_MIN_SAMPLES = 20;

const FILLERS = [
  '啊', '呀', '吧', '呗', '嘛', '哈', '呢', '哦', '噢', '诶', '欸',
  '草', '笑死', '绷', '离谱', '绝了', '好家伙', '卧槽', 'woc', '牛',
];

// QQ 里的 [图片] / [表情] / [语音] 占位不算说话内容。
function plainText(x) {
  return String(x ?? '').replace(/\[[^\]]{1,8}\]/g, '').trim();
}

function charLen(s) {
  return Array.from(s).length;
}

function ratio(list, fn) {
  if (!list.length) return 0;
  return list.filter(fn).length / list.length;
}

function round(n, digits = 2) {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/**
 * @param {Array<object>} rows style-corpus 行
 * @param {{minSamples?: number}} [opts]
 * @returns {null | object}
 */
export function computeStyleProfile(rows, opts = {}) {
  const minSamples = Math.max(5, Number(opts.minSamples) || STYLE_MIN_SAMPLES);
  const human = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && !r.s && typeof r.x === 'string')
    .map((r) => ({ ...r, text: plainText(r.x) }))
    .filter((r) => r.text);

  const n = human.length;
  if (n < minSamples) return null;

  const lens = human.map((r) => charLen(r.text)).sort((a, b) => a - b);
  const quantile = (q) => lens[Math.min(lens.length - 1, Math.max(0, Math.floor(lens.length * q)))];

  const fillerCounts = new Map();
  for (const f of FILLERS) {
    const hits = human.filter((r) => r.text.includes(f)).length;
    if (hits > 0) fillerCounts.set(f, hits);
  }
  const topFillers = [...fillerCounts.entries()]
    .filter(([, hits]) => hits / n >= 0.05)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([f]) => f);

  const texts = human.map((r) => r.text);
  let repeated = 0;
  for (let i = 1; i < texts.length; i += 1) {
    if (texts[i] === texts[i - 1]) repeated += 1;
  }

  return {
    sampleCount: n,
    lenMedian: quantile(0.5),
    lenP90: quantile(0.9),
    lenMean: round(lens.reduce((a, b) => a + b, 0) / n, 1),
    burstRate: round(ratio(human, (r) => r.b === 1)),
    periodRate: round(ratio(human, (r) => r.text.includes('。'))),
    questionRate: round(ratio(human, (r) => /[?？]$/.test(r.text))),
    emojiRate: round(ratio(human, (r) => /[\u2600-\u27BF\u2B00-\u2BFF\u{1F000}-\u{1FAFF}]/u.test(r.text))),
    quoteRate: round(ratio(human, (r) => r.q === 1)),
    repeatRate: round(repeated / Math.max(1, n - 1)),
    topFillers,
    generatedAt: Date.now(),
  };
}

/** 把统计卡渲染成注入 prompt 的一段文本（控制在 300 字内）。 */
export function formatStyleBlock(profile) {
  if (!profile || !profile.sampleCount) return '';
  const pct = (v) => `${Math.round(Number(v) * 100)}%`;
  const bits = [`句长中位 ${profile.lenMedian} 字、九成在 ${profile.lenP90} 字内`];
  if (profile.burstRate >= 0.15) bits.push(`连发常见（${pct(profile.burstRate)} 是同人 30 秒内续话）`);
  if (profile.periodRate <= 0.2) bits.push(`很少用句号（只有 ${pct(profile.periodRate)} 的消息带句号）`);
  else bits.push(`句号使用率 ${pct(profile.periodRate)}`);
  if (profile.questionRate >= 0.1) bits.push(`问句占 ${pct(profile.questionRate)}`);
  if (profile.topFillers.length) bits.push(`常用语气词：${profile.topFillers.join('、')}`);

  const rules = [
    `按这个节奏说话：一条一到两句短句，常态别超过 ${Math.max(12, Math.min(40, profile.lenP90 + 8))} 字`,
    profile.periodRate <= 0.2 ? '句尾不用句号' : '',
    profile.burstRate >= 0.15 ? '想补充就隔几秒再发一条，别把几句塞进同一坨' : '',
    '不用每句都接，冷场时沉默也正常',
  ].filter(Boolean);

  return `【本群语感】样本 ${profile.sampleCount} 条：${bits.join('；')}。\n${rules.join('；')}。`;
}
