// watch-frames.mjs —— 在已经打开的播放器页面里按「画面变化」抓帧，拼成宫格交出来。
//
// 不下载视频、不截屏、不碰播放器以外的窗口：连上 CDP，在页面里用 <video> + drawImage 取帧。
//
// 1) 每 scan 秒取一张 32×18 缩略图，和上一张算平均绝对差，本地打分（不花模型钱）。
// 2) 差异够大（换镜头/动作）就留一格；画面没怎么动就跳过，但每 force-gap 秒强制留一张兜底。
// 3) 攒满 4 格（默认 2×2）立刻交回 node 落盘——页面被导航清掉也不丢。
// 4) 跑满 seconds（默认 300）、攒满 max-grids（默认 8）或播完就收尾，返回每张图的路径和每格的秒数。
//
// 用法：node src/watch-frames.mjs [--seconds 300] [--th 20] [--scan 0.5] [--force-gap 20]
//                                [--cols 2] [--rows 2] [--max-grids 20] [--bv BVxxx] [--json]
// 环境变量：BILI_CDP_PORT（默认 9333）、BILI_FRAME_DIR（默认 ~/.cache/bili-watch-frames）、BILI_WATCH_LOG、
//          FISH_EYE_TUNING（参数文件，默认 ~/.dsh/see-now/watch-tuning.json）
//
// th / scan / force-gap / max-grids 不给就用参数文件里的值 —— 那正是设置页「陪看」调的四个数。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readTuning } from './tuning.mjs';

const TUNING = readTuning();
const PORT = Number(process.env.BILI_CDP_PORT) || 9333;
const HOME = os.homedir();
const FRAME_ROOT = process.env.BILI_FRAME_DIR || path.join(HOME, '.cache', 'bili-watch-frames');
const LOG_FILE = process.env.BILI_WATCH_LOG || path.join(HOME, '.cache', 'bili-watch-frames', 'guard.log');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) return true;
  return v;
}

const seconds = Math.max(10, Math.min(900, Number(arg('seconds', 300)) || 300));
// 下面四项的默认值来自参数文件（设置页「陪看」分区 / 播放器左侧面板改的就是它）。
// 命令行显式给了就用命令行的 —— 脚本永远听调用方的。
const th = Math.max(1, Math.min(120, Number(arg('th', TUNING.th)) || TUNING.th));          // 变化阈值（亮度平均绝对差 0-255）
const scanSec = Math.max(0.2, Math.min(3, Number(arg('scan', TUNING.scan)) || TUNING.scan)); // 扫描间隔
const forceGapSec = Math.max(1, Math.min(120, Number(arg('force-gap', TUNING.forceGap)) || TUNING.forceGap)); // 兜底最长间隔
const loudSpike = Math.max(1.1, Math.min(10, Number(arg('loud-spike', 1.8)) || 1.8)); // 音量比基线高多少倍算'响了'
const minGapMs = Math.max(0, Math.min(30, Number(arg('min-gap', 3)) || 3)) * 1000; // 两次留帧至少隔多久
const cols = Math.max(1, Math.min(4, Number(arg('cols', 2)) || 2));           // 每张几列
const rows = Math.max(1, Math.min(4, Number(arg('rows', 2)) || 2));           // 每张几行
const perGrid = cols * rows;
const maxGrids = Math.max(0, Math.min(40, Number(arg('max-grids', TUNING.maxGrids)) || TUNING.maxGrids));
const wantBv = String(arg('bv', '') || '');
const asJson = process.argv.includes('--json');

// 每格 640×360：实测够看清画面和字幕，整图 2×2 = 1280×720（token 578/张，比 1920×1080 省 53%）。
// 源视频常常只有 852×480，再往上放大只是白花 token。
const CELL_W = 640, CELL_H = 360;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  try {
    fs.appendFileSync(LOG_FILE, `[${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] [frames] ${m}\n`);
  } catch {}
};

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m = null; try { m = JSON.parse(String(e.data)); } catch { return; }
      const cb = this.pending.get(m.id); if (!cb) return;
      this.pending.delete(m.id); cb(m);
    });
  }
  call(method, params = {}, timeoutMs = 20000) {
    const id = ++this.id;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(id); resolve(null); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr, timeoutMs = 20000) {
    const m = await this.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (!m) return { err: 'CDP 无响应' };
    if (m.error) return { err: m.error.message ?? 'CDP 报错' };
    if (m.result?.exceptionDetails) {
      const d = m.result.exceptionDetails;
      return { err: d?.exception?.description ?? d?.text ?? '页内报错' };
    }
    return { value: m.result?.result?.value };
  }
  close() { try { this.ws.close(); } catch {} }
}

// 页面里的扫描器：缩略图打分 → 决定留不留 → 留就画进 3×2 的格子；满一张交回来，node 立刻落盘。
const PAGE_HELPERS = (cols, perGrid, cellW, cellH) => `(() => {
  if (window.__biliEye && window.__biliEye.ok) return { ok: true, reused: true };
  const COLS = ${cols}, PER = ${perGrid}, CW = ${cellW}, CH = ${cellH};
  const state = { ok: true, prevLum: null, lastT: -99, lastKeepAt: 0, cur: null };
  const probe = document.createElement('canvas');
  probe.width = 32; probe.height = 18;
  state.probeCtx = probe.getContext('2d', { willReadFrequently: true });

  // 音量：接管 video 的音频输出，读实时频谱。跨域没被静音（实测 2026-11-23），
  // 但万一被静音（ctx 挂起/报错），就退回不分析音量，画面照抓。
  state.audio = null;
  state.audioError = '';
  state.initAudio = () => {
    try {
      if (state.audio) return true;
      const v = document.querySelector('video');
      if (!v) return false;
      // 同一个 <video> 只能建一次 MediaElementSource（再建会抛 already connected），
      // 所以先认页面里已经有的那套，别自己再建一个。
      const shared = window.__biliAudio;
      if (shared && shared.analyser && (!shared.video || shared.video === v)) {
        state.audio = { ctx: shared.ctx, analyser: shared.analyser, buf: new Uint8Array(shared.analyser.frequencyBinCount), baseline: 0 };
        return true;
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { state.audioError = 'no-audiocontext'; return false; }
      const ctx = new Ctx();
      const src = ctx.createMediaElementSource(v);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      src.connect(analyser);
      analyser.connect(ctx.destination);
      window.__biliAudio = { ctx, analyser, src, video: v };
      state.audio = { ctx, analyser, buf: new Uint8Array(analyser.frequencyBinCount), baseline: 0 };
      return true;
    } catch (e) {
      state.audioError = String((e && e.message) || e);
      return false;
    }
  };
  state.loudness = (h) => {
    if (!state.audio) return null;
    const { ctx, analyser, buf } = state.audio;
    try { if (ctx.state === 'suspended') ctx.resume(); } catch (e) {}
    analyser.getByteFrequencyData(buf);
    let sum = 0;
    for (let k = 0; k < buf.length; k++) sum += buf[k];
    const mean = sum / buf.length;
    const third = Math.floor(buf.length / 3);
    let low = 0;
    for (let k = 0; k < third; k++) low += buf[k];
    low /= third;
    const a = state.audio;
    a.baseline = a.baseline > 0 ? a.baseline * 0.9 + mean * 0.1 : mean;
    const spike = a.baseline > 1 ? mean / a.baseline : 1;
    return { mean: +mean.toFixed(1), low: +low.toFixed(1), base: +a.baseline.toFixed(1), spike: +spike.toFixed(2), hit: spike >= h };
  };
  state.reset = () => {
    const g = document.createElement('canvas');
    g.width = CW * COLS;
    g.height = CH * Math.ceil(PER / COLS);
    const c = g.getContext('2d');
    c.fillStyle = '#000'; c.fillRect(0, 0, g.width, g.height);
    state.cur = { canvas: g, ctx: c, n: 0, times: [] };
  };
  state.reset();
  state.info = () => {
    const v = document.querySelector('video');
    const m = location.href.match(/\\/video\\/(BV[0-9A-Za-z]{10})/);
    let bv = m ? m[1] : '';
    try {
      const st = window.__INITIAL_STATE__;
      if (!bv && st && st.bvid) bv = String(st.bvid);
      if (!bv && st && st.aid) bv = 'av' + st.aid;
    } catch (e) {}
    return {
      bv, hasVideo: !!v,
      t: v ? +v.currentTime.toFixed(1) : 0,
      d: v ? Math.round(v.duration || 0) : 0,
      paused: v ? v.paused : true,
      ended: v ? v.ended : false,
    };
  };
  // 返回很小一个对象；只有拼满一张时带 url
  state.tick = (threshold, forceGapMs, loudSpike, minGapMs) => {
    const v = document.querySelector('video');
    if (!v || !v.videoWidth) return { error: 'no-video' };
    const t = +v.currentTime.toFixed(1);
    if (Math.abs(t - state.lastT) < 0.3) {
      return { t, skipped: true, paused: v.paused, ended: v.ended };
    }
    state.lastT = t;

    // ① 打分
    const pc = state.probeCtx;
    pc.drawImage(v, 0, 0, 32, 18);
    const d = pc.getImageData(0, 0, 32, 18).data;
    const n = 32 * 18;
    const lum = new Float32Array(n);
    for (let i = 0, j = 0; i < d.length; i += 4, j++) lum[j] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    let diff = 0;
    if (state.prevLum) {
      for (let k = 0; k < n; k++) diff += Math.abs(lum[k] - state.prevLum[k]);
      diff /= n;
    }
    const first = !state.prevLum;
    state.prevLum = lum;

    // 纯色转场（白屏/黑屏/闪白）：标准差太小，画面里没有信息，别占格子
    let mL = 0;
    for (let k = 0; k < n; k++) mL += lum[k];
    mL /= n;
    let vSum = 0;
    for (let k = 0; k < n; k++) { const dv = lum[k] - mL; vSum += dv * dv; }
    const flat = Math.sqrt(vSum / n) < 3;

    // ② 听响：音量比最近的基线高一大截 = 爆炸/怒吼/BGM 突然变燃/突然开始说话
    const loud = state.loudness(loudSpike);
    const loudHit = !!(loud && loud.hit);

    // ③ 决定留不留
    //   - 单帧变化够大 = 换镜头/动作，立刻留
    //   - 或者刚响了一下 = 事件点，留
    //   - 否则按时间兜底；但画面几乎完全没动时，兜底时间拉长 6 倍，别把同一片树叶拍六遍
    const now = Date.now();
    const nearlyStill = diff < 0.3;
    const forceAfter = forceGapMs * (nearlyStill ? 3 : 1);  // 完全不动（<0.3）= 20×3 = 60 秒才留一张
    const forced = (now - state.lastKeepAt) >= forceAfter;
    const tooSoon = state.lastKeepAt > 0 && (now - state.lastKeepAt) < minGapMs;
    // 音量只记录、不抓帧：一声爆炸不该多塞一张图，看片的人会被莫名叫醒
    const keep = first || (!tooSoon && !flat && (diff >= threshold || forced));
    if (!keep) return { t, diff: +diff.toFixed(2), kept: false, flat, spike: loud ? loud.spike : 0, paused: v.paused, ended: v.ended };
    state.lastKeepAt = now;

    // ③ 画进格子
    if (state.cur.n >= PER) state.reset();
    const { canvas, ctx } = state.cur;
    const i2 = state.cur.n;
    const x = (i2 % COLS) * CW, y = Math.floor(i2 / COLS) * CH;
    ctx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight, x, y, CW, CH);
    const label = String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(Math.floor(t % 60)).padStart(2, '0');
    ctx.font = 'bold 26px "Microsoft YaHei", sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(x + 8, y + 8, tw + 18, 38);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x + 17, y + 36);
    state.cur.n += 1;
    state.cur.times.push(t);

    const out = { t, diff: +diff.toFixed(2), kept: true, cut: diff >= threshold, forced, loudHit, spike: loud ? loud.spike : 0, paused: v.paused, ended: v.ended };
    if (state.cur.n >= PER) {
      out.grid = canvas.toDataURL('image/jpeg', 0.85);
      out.times6 = state.cur.times.slice();
      state.reset();
    }
    return out;
  };
  state.tail = () => {
    if (!state.cur || state.cur.n <= 0) return null;
    const r = { url: state.cur.canvas.toDataURL('image/jpeg', 0.85), times: state.cur.times.slice(), partial: true };
    state.reset();
    return r;
  };
  window.__biliEye = state;
  return { ok: true, reused: false };
})()`;

async function connect() {
  const list = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(2000) })
    .then((r) => r.json()).catch(() => null);
  if (!Array.isArray(list)) return null;
  const page = list.find((t) => t.type === 'page' && /bilibili\.com\/video/.test(String(t.url || '')));
  if (!page?.webSocketDebuggerUrl) return null;
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    setTimeout(() => rej(new Error('CDP 连接超时')), 5000);
  });
  const c = new Cdp(ws);
  await c.call('Runtime.enable');
  return c;
}

function saveGrid(dir, bv, tag, url, times, partial) {
  try {
    const file = path.join(dir, `grid-${bv}-${tag}-${Date.now()}.jpg`);
    fs.writeFileSync(file, Buffer.from(String(url).split(',')[1], 'base64'));
    return { file, w: CELL_W * cols, h: CELL_H * rows, times, partial: !!partial };
  } catch (e) {
    log(`写宫格失败：${e?.message ?? e}`);
    return null;
  }
}

(async () => {
  const startedAt = Date.now();
  const helpers = PAGE_HELPERS(cols, perGrid, CELL_W, CELL_H);
  const result = {
    ok: false, bv: '', from: 0, to: 0, ended: false,
    scanned: 0, kept: 0, frames: 0, grids: [], note: '',
  };

  let c = null;
  try { c = await connect(); } catch (e) { result.note = e?.message ?? String(e); }
  if (!c) {
    result.note = result.note || `没有可用的播放页（CDP ${PORT} 上找不到 B 站视频标签）`;
    return emit(result);
  }

  let prep = await c.eval(helpers, 8000);
  if (prep.err) { result.note = `页面准备失败：${prep.err}`; c.close(); return emit(result); }

  const meta = await c.eval('window.__biliEye ? window.__biliEye.info() : { error: "helpers-gone" }', 6000);
  if (meta.err || !meta.value || meta.value.error) {
    result.note = `读页面失败：${meta.err || meta.value?.error || '无返回'}`;
    c.close(); return emit(result);
  }
  const info = meta.value;
  result.bv = info.bv || wantBv || 'video';
  result.from = info.t || 0;
  if (!info.hasVideo) { result.note = '页面上没有播放器'; c.close(); return emit(result); }

  await c.eval('window.__biliEye && window.__biliEye.initAudio && window.__biliEye.initAudio()', 8000);
  const audioOk = await c.eval('!!(window.__biliEye && window.__biliEye.audio)', 5000);
  result.audio = !!(audioOk.value);
  const aerr = await c.eval('window.__biliEye && window.__biliEye.audioError || \'\'', 5000);
  result.audioError = String(aerr.value || '');

  const dir = path.join(FRAME_ROOT, result.bv);
  fs.mkdirSync(dir, { recursive: true });

  const deadline = startedAt + seconds * 1000;
  const forceGapMs = forceGapSec * 1000;
  let fails = 0, skips = 0, pausedSince = 0;
  let cuts = 0, forces = 0, maxSpike = 0;
  const loudTimes = [];

  while (Date.now() < deadline) {
    const g = await c.eval(`window.__biliEye ? window.__biliEye.tick(${th}, ${forceGapMs}, ${loudSpike}, ${minGapMs}) : { error: "helpers-gone" }`, 12000);

    if (g.err || g.value?.error) {
      fails += 1;
      if (fails === 1 || fails === 3) {
        const tail = await c.eval('window.__biliEye && window.__biliEye.tail ? window.__biliEye.tail() : null', 20000);
        if (!tail.err && tail.value?.url) {
          const saved = saveGrid(dir, result.bv, 'tail', tail.value.url, tail.value.times, true);
          if (saved) result.grids.push(saved);
        }
        prep = await c.eval(helpers, 8000);
        await c.eval('window.__biliEye && window.__biliEye.initAudio && window.__biliEye.initAudio()', 8000);
      }
      if (fails >= 6) { result.note = `连续 ${fails} 次扫不到画面（${g.err || g.value?.error}）`; break; }
    } else if (g.value.skipped) {
      fails = 0; skips += 1;
      if (g.value.ended) { result.ended = true; break; }
      if (g.value.paused) {
        if (!pausedSince) pausedSince = Date.now();
        else if (Date.now() - pausedSince > 15000) { result.note = '视频暂停了，先把这段交给你'; break; }
      } else if (skips >= 10) {
        result.note = `画面停在 ${g.value.t}s 没动（可能在缓冲，或者播放器卡住了）`;
        break;
      }
    } else {
      fails = 0; skips = 0; pausedSince = 0;
      result.scanned += 1;
      if (typeof g.value.spike === 'number' && g.value.spike > maxSpike) maxSpike = g.value.spike;
      result.to = g.value.t;
      if (g.value.kept) {
        if (g.value.loudHit) loudTimes.push(g.value.t);
        result.kept += 1;
        result.frames += 1;
        if (g.value.cut) cuts += 1;
        if (g.value.forced) forces += 1;
      }
      if (g.value.grid) {
        const saved = saveGrid(dir, result.bv, String(result.frames).padStart(3, '0'), g.value.grid, g.value.times6, false);
        if (saved) result.grids.push(saved);
        if (maxGrids > 0 && result.grids.length >= maxGrids) break;
      }
      if (g.value.ended) { result.ended = true; break; }
    }

    const remain = deadline - Date.now();
    if (remain <= 0) break;
    await sleep(Math.min(scanSec * 1000, remain));
  }

  const tail = await c.eval('window.__biliEye && window.__biliEye.tail ? window.__biliEye.tail() : null', 20000);
  if (!tail.err && tail.value?.url) {
    const saved = saveGrid(dir, result.bv, 'tail', tail.value.url, tail.value.times, true);
    if (saved) result.grids.push(saved);
  }
  await c.eval('try { if (window.__biliEye) window.__biliEye.ok = false } catch (e) {}', 3000);
  c.close();

  result.ok = result.frames > 0 && result.grids.length > 0;
  result.cuts = cuts;
  result.forces = forces;
  result.loud = loudTimes.slice(0, 30);
  result.maxSpike = +maxSpike.toFixed(2);
  if (!result.note) {
    result.note = result.ok
      ? `扫了 ${result.scanned} 次，留 ${result.frames} 个画面（换镜头 ${cuts}、兜底 ${forces}），拼成 ${result.grids.length} 张`
      : '一个画面都没留';
  }
  log(`${result.bv} ${result.from}→${result.to}s 扫${result.scanned} 留${result.frames} 格${result.grids.length} ${result.ended ? '播完' : '到点'}`);
  emit(result);
})();

function emit(r) {
  if (asJson) { console.log(JSON.stringify(r)); return; }
  console.log(r.note);
  for (const g of r.grids) {
    const ts = (g.times || []).map((t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`).join(' ');
    console.log(`  ${g.file}  ${ts}`);
  }
  if (!r.ok && r.note) process.exitCode = 1;
}
