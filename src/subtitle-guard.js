// 字幕轨守卫：判断 B站 返回的字幕轨到底是不是这条视频的。
//
// 起因（2026-11-24）：BV1Poyaz8Ep4 挂了一条 ai-zh 字幕，内容是英雄联盟解说
// （428 条、跨度 765 秒、片长 6969 秒），她把这段当台词拿去陪看。
//
// 实测三个判据里**只有覆盖率抓得住这条**：密度 5.59 条/10 秒、最大断层 25.8 秒都"正常"。
// 所以三条都做，但别指望密度和断层能挡错轨——它们挡的是残轨。
//
// 原则：拿不到判断依据时**跳过**那条判据，不因为 API 少给一个字段就把字幕全杀了。

/** 阈值。想调就改这里，别散在函数里。 */
export const SUB_LIMITS = {
  minCoverage: 0.3,        // 字幕跨度 / 片长，低于这个判错轨
  minDensityPer10s: 1,     // 平均每 10 秒至少几条
  // 断层放到 120 秒：30 秒会误杀正常的纪录片/番剧（实测 BV1T74361EKj 中间有 41 秒纯音乐没人说话）。
  // 错轨本身抓不到断层（LoL 那条最大断层才 25.8 秒），所以这条只是兜残轨，宁可松。
  maxGapSec: 120,
};

const lanOf = (t) => String(t?.lan ?? '');
const isAi = (t) => /^ai-/i.test(lanOf(t));
const isZh = (t) => /^(zh|cmn|ai-zh)/i.test(lanOf(t));

/**
 * 轨道优先级：人工中文 > 任意人工 > ai 中文 > 任意 ai > 第一条。
 * 原来 ai-zh 排第一是反的——B站 机器字幕本来最不可信。
 */
export function pickSubtitleTrack(tracks) {
  const list = (Array.isArray(tracks) ? tracks : [])
    .filter((t) => t && String(t.subtitle_url ?? '') !== '');
  if (!list.length) return null;
  const human = list.filter((t) => !isAi(t));
  const ai = list.filter(isAi);
  return human.find(isZh)
    || human[0]
    || ai.find(isZh)
    || ai[0]
    || list[0];
}

/**
 * 校验一组字幕 cue 是不是干净的。
 * @param {Array<{from:number,to:number,text:string}>} cues
 * @param {number} durationSec 这条视频（当前分P）的总时长；0/未知时跳过覆盖率判据
 * @returns {{ok:boolean, reason:string, count:number, span:number, duration:number,
 *            coverage:number|null, densityPer10s:number, maxGap:number}}
 */
export function validateSubtitleCues(cues, durationSec, limits = SUB_LIMITS) {
  const rows = (Array.isArray(cues) ? cues : [])
    .map((c) => ({ from: Number(c?.from) || 0, to: Number(c?.to) || 0, text: String(c?.text ?? '').trim() }))
    .filter((c) => c.to > c.from && c.text)
    .sort((a, b) => a.from - b.from);

  if (rows.length < 2) {
    return { ok: false, reason: '字幕条数太少', count: rows.length, span: 0, duration: Number(durationSec) || 0, coverage: null, densityPer10s: 0, maxGap: 0 };
  }

  const span = rows[rows.length - 1].to - rows[0].from;
  const duration = Number(durationSec) || 0;
  const coverage = duration > 0 ? span / duration : null;
  const densityPer10s = span > 0 ? rows.length / (span / 10) : 0;

  let maxGap = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const gap = rows[i].from - rows[i - 1].to;
    if (gap > maxGap) maxGap = gap;
  }

  const detail = {
    count: rows.length,
    span: +span.toFixed(1),
    duration,
    coverage: coverage === null ? null : +coverage.toFixed(3),
    densityPer10s: +densityPer10s.toFixed(2),
    maxGap: +maxGap.toFixed(1),
  };

  // 片长未知 → 跳过覆盖率（不误杀）
  if (coverage !== null && coverage < limits.minCoverage) {
    return { ok: false, reason: `字幕只覆盖片长的 ${(coverage * 100).toFixed(0)}%`, ...detail };
  }
  if (densityPer10s < limits.minDensityPer10s) {
    return { ok: false, reason: `字幕太稀（${densityPer10s.toFixed(2)} 条/10 秒）`, ...detail };
  }
  if (maxGap > limits.maxGapSec) {
    return { ok: false, reason: `字幕中间断了 ${maxGap.toFixed(0)} 秒`, ...detail };
  }
  return { ok: true, reason: '', ...detail };
}
