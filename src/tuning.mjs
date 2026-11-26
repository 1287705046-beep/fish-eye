// 陪看参数：一个文件，三处读写。
//
//   · 设置页（DSH 插件「陪看」分区）
//   · 播放器左侧那块面板（player-guard 注入）
//   · 抓帧脚本启动时的默认值（watch-frames）
//
// 改哪一处都一样 —— 三个地方读写的都是下面这个文件。
// 命令行的显式参数永远优先：脚本先取 tuning，再被 argv 覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 参数文件。想放别处就设 FISH_EYE_TUNING（老名字 FISH_EYE_TUNING_FILE 也认）。 */
export const TUNING_FILE = process.env.FISH_EYE_TUNING
  || process.env.FISH_EYE_TUNING_FILE
  || path.join(os.homedir(), '.dsh', 'see-now', 'watch-tuning.json');

export const TUNING_DEFAULTS = { scan: 0.5, th: 20, forceGap: 20, maxGrids: 20 };

/** 每一项允许的范围。滑块和写接口都按这个夹，别让人把自己调进坑里。 */
export const TUNING_RANGE = {
  scan: [0.2, 3],
  th: [5, 60],
  forceGap: [5, 60],
  maxGrids: [6, 20],
};

/** 界面上的一句话说明（设置页和播放器面板共用）。 */
export const TUNING_LABELS = {
  scan: '抓取间隔（秒）：隔多久看一次画面。越小越不容易漏，但白扫的帧也多',
  th: '运动捕捉：画面变化大到多少才留一格。数越小越灵敏，越大越迟钝',
  forceGap: '兜底间隔（秒）：画面再不动，最多隔这么久也留一格，免得一段定格全丢',
  maxGrids: '每批张数：一批最多几张图。实际还会被体积闸卡住（更小的那张才是真的上限）',
};

export const TUNING_KEYS = Object.keys(TUNING_DEFAULTS);

/** 夹到合法范围。非数字返回 null，由调用方决定报错还是忽略。 */
export function clampTuning(key, value) {
  const range = TUNING_RANGE[key];
  const number = Number(value);
  if (!range || !Number.isFinite(number)) return null;
  const [min, max] = range;
  const rounded = key === 'scan' ? Math.round(number * 10) / 10 : Math.round(number);
  return Math.max(min, Math.min(max, rounded));
}

/** 读参数文件；坏了、缺了、字段不是数字，都退回默认值，绝不抛。 */
export function readTuning(file = TUNING_FILE) {
  const out = { ...TUNING_DEFAULTS };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of TUNING_KEYS) {
      const value = Number(saved?.[key]);
      if (Number.isFinite(value) && value > 0) out[key] = value;
    }
  } catch {}
  return out;
}

/** 只写认识的字段，写前先夹。返回落盘的最终值；写失败返回 null。 */
export function writeTuning(patch, file = TUNING_FILE) {
  const next = readTuning(file);
  for (const key of TUNING_KEYS) {
    if (patch?.[key] === undefined) continue;
    const value = clampTuning(key, patch[key]);
    if (value !== null) next[key] = value;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  } catch {
    return null;
  }
}
