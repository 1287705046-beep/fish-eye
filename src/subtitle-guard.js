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
 * 候选顺序（不是只挑一条）：人工中文 > 任意人工 > ai 中文 > 任意 ai > 其余。
 * 原来 ai-zh 排第一是反的——B站 机器字幕本来最不可信。
 *
 * 为什么返回列表而不是一条：2026-11-24 改成双接口合并后会有多条，
 * 而且人工字幕常常只有一段（UP 主只标了几个片段）——那条过不了覆盖率校验，
 * 得能退到下一条 AI 字幕。调用方逐条试，别一条不对就整条放弃。
 */
export function rankSubtitleTracks(tracks) {
  const list = (Array.isArray(tracks) ? tracks : [])
    .filter((t) => t && String(t.subtitle_url ?? '') !== '');
  if (!list.length) return [];
  const human = list.filter((t) => !isAi(t));
  const ai = list.filter(isAi);
  return [
    ...human.filter(isZh), ...human.filter((t) => !isZh(t)),
    ...ai.filter(isZh), ...ai.filter((t) => !isZh(t)),
  ];
}

/** 按上面的优先级挑一条。留着给只想要单条的调用方。 */
export function pickSubtitleTrack(tracks) {
  return rankSubtitleTracks(tracks)[0] ?? null;
}

/**
 * 合并两个接口返回的字幕轨（2026-11-24：新老接口的结果是**互补**的）。
 *
 * 实测 4 个样本：
 *   · B站官方人工字幕（lan=zh, ai_status=0）：只有 wbi/v2 给 url，旧 x/player/v2 只给轨道名、url 空
 *   · AI 字幕（lan=ai-zh, ai_status=2）：只有旧 x/player/v2 稳定给 url，wbi/v2 常常直接 0 条轨道
 *
 * 所以两个响应都要喂进来。只留 url 非空的，按 lan+url 去重，再按优先级排序。
 */
export function mergeSubtitleTracks(...responses) {
  const merged = [];
  const seen = new Set();
  for (const json of responses) {
    for (const track of json?.data?.subtitle?.subtitles ?? []) {
      const url = String(track?.subtitle_url ?? '').trim();
      if (!url) continue;
      const key = `${lanOf(track)}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(track);
    }
  }
  return rankSubtitleTracks(merged);
}

/**
 * 逐条试，返回第一条能过校验的字幕。
 *
 * 为什么要逐条：人工字幕常常只标了几个片段（覆盖率过不了 30%），
 * 这时候该退到 AI 字幕，而不是整条放弃。
 *
 * @param {Array} tracks mergeSubtitleTracks 的结果
 * @param {(url:string)=>Promise<Array<{from:number,to:number,text:string}>>} loadCues 由调用方提供（网络在那边）
 * @returns {Promise<{cues:Array, skipped:string, track:object|null, attempts:Array}>}
 */
export async function firstUsableSubtitle(tracks, loadCues, durationSec, limits = SUB_LIMITS) {
  const attempts = [];
  for (const track of tracks ?? []) {
    const raw = String(track?.subtitle_url ?? '');
    const url = raw.startsWith('//') ? `https:${raw}` : raw;
    if (!url) { attempts.push({ lan: lanOf(track), ok: false, reason: '没有 url' }); continue; }
    let cues = [];
    try {
      cues = await loadCues(url);
    } catch {
      attempts.push({ lan: lanOf(track), ok: false, reason: '下载失败' });
      continue;
    }
    if (!cues?.length) { attempts.push({ lan: lanOf(track), ok: false, reason: '下载为空' }); continue; }
    const verdict = validateSubtitleCues(cues, durationSec, limits);
    attempts.push({ lan: lanOf(track), ok: verdict.ok, reason: verdict.reason, verdict });
    if (verdict.ok) return { cues, skipped: '', track, attempts };
  }
  const skipped = attempts.map((a) => `${a.lan}：${a.reason}`).join('；') || '没有可用字幕轨';
  return { cues: [], skipped, track: null, attempts };
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
