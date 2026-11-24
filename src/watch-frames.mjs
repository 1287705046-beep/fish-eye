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
import { spawn } from 'node:child_process';
import { readTuning } from './tuning.mjs';

/** 仓库根（scripts/ 就在它下面）。Node ≥22 才有 import.meta.dirname。 */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
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
// ── 字幕条 + OCR（2026-11-24 定稿）─────────────────────────────────────────
// B站 大量视频的字幕是**烧在画面里**的：没有 <track>、没有 DOM、接口返回 0 条轨。
// 做法：每 --sub-gap 秒看一眼画面底部，变了就裁一条（反色二值化，白字变黑字白底），
// 抓完一次性批量交给 RapidOCR（本地跑、免费），拿回 [时间, 文本]。
// 实测（1080p 源）：有字的帧逐字正确、置信度 1.0；空帧靠 --sub-conf 过滤。
//
// 关掉：--sub-ocr 0。装了 OCR 才有文本，没装就只留画面宫格。
const SUB_OCR = Number(arg('sub-ocr', 1)) !== 0;
const subGapMs = Math.max(600, Math.min(10000, Number(arg('sub-gap', 1.5)) * 1000 || 1500));
const subConf = Math.max(0, Math.min(1, Number(arg('sub-conf', 0.9)) || 0.9));
const PY = process.env.FISH_EYE_PYTHON || 'python';

const wantBv = String(arg('bv', '') || '');
const asJson = process.argv.includes('--json');

// ── OCR：字幕条 → 文本（用 RapidOCR，Python 侧批量跑）──────────────────────
// 为什么是 RapidOCR 不是 tesseract：实测 tesseract 的中文模型是印刷体训练的，
// B站 这种设计字体 + 半透明 + 动态背景它读不准（6 帧只对 1~2 帧）；
// RapidOCR（PaddleOCR 的 onnxruntime 轻量版）同几张图逐字正确、置信度 1.0。
//
// 依赖：python -m pip install rapidocr-onnxruntime
// 没装也不致命 —— 会返回空，链路退回"只有画面宫格"。
const OCR_SCRIPT = path.join(REPO_ROOT, 'scripts', 'ocr-subtitles.py');

/**
 * 批量 OCR。输入 [{ t, file }]，返回 [{ t, text, conf }]。
 *
 * 串行跑：RapidOCR 在 CPU 上约 3.5 秒/张。实测开 4 个并发反而更慢（114s vs 93s），
 * 因为每个进程都要加载一次模型、又抢同一批 CPU。所以老实用一个进程。
 * 代价是慢：5 分钟一批大约多花 1.5~3 分钟。所以只对「接口拿不到字幕」的片子跑。
 * 任何失败都返回空数组，绝不抛——没有 OCR 也要能看片。
 */
async function ocrStrips(items) {
  if (!items.length) return [];
  const CHUNKS = 1;
  const size = Math.ceil(items.length / CHUNKS);
  const parts = [];
  for (let i = 0; i < items.length; i += size) parts.push(items.slice(i, i + size));

  const runOne = (chunk) => new Promise((resolve) => {
    let settled = false;
    const done = (rows) => { if (!settled) { settled = true; resolve(rows); } };
    try {
      const child = spawn(PY, [OCR_SCRIPT], {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', () => done([]));
      child.on('exit', (code) => {
        if (code !== 0) {
          log(`OCR 子进程退出 ${code}：${err.trim().slice(0, 200)}`);
          done([]);
          return;
        }
        try { done(JSON.parse(String(out || '[]').trim() || '[]')); }
        catch { done([]); }
      });
      child.stdin.write(JSON.stringify(chunk.map((x) => ({ t: x.t, path: x.file }))));
      child.stdin.end();
      setTimeout(() => { try { child.kill(); } catch {} done([]); }, 180000).unref?.();
    } catch {
      done([]);
    }
  });

  const results = await Promise.all(parts.map(runOne));
  return results.flat();
}

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
const PAGE_HELPERS = (cols, perGrid, cellW, cellH, subGapMs) => `(() => {
  if (window.__biliEye && window.__biliEye.ok) return { ok: true, reused: true };
  const COLS = ${cols}, PER = ${perGrid}, CW = ${cellW}, CH = ${cellH};
  const SUB_GAP = ${subGapMs};
  const state = { ok: true, prevLum: null, prevSub: null, lastT: -99, lastKeepAt: 0, lastStripAt: 0, strips: 0, cur: null };
  const probe = document.createElement('canvas');
  probe.width = 32; probe.height = 18;
  state.probeCtx = probe.getContext('2d', { willReadFrequently: true });
  // 判断「底部变了没」用的小缩略图（不做识别，只比差异）
  const subProbe = document.createElement('canvas');
  subProbe.width = 64; subProbe.height = 16;
  state.subCtx = subProbe.getContext('2d', { willReadFrequently: true });
  // 裁字幕条：反色二值化（白字→黑字白底），RapidOCR 对这种最准
  state.pickStrip = (v, t) => {
    const W = v.videoWidth, H = v.videoHeight;
    const sx = Math.round(W * 0.15), sy = Math.round(H * 0.80);
    const sw = Math.max(1, Math.round(W * 0.70)), sh = Math.max(1, Math.round(H * 0.18));
    const scale = sh < 60 ? 3 : 1.5;   // 480p 以下放大 3 倍，1080p 只要 1.5
    const c = document.createElement('canvas');
    c.width = Math.round(sw * scale);
    c.height = Math.round(sh * scale);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, sx, sy, sw, sh, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const px = img.data;
    const out = ctx.createImageData(c.width, c.height);
    for (let i = 0; i < px.length; i += 4) {
      const L = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
      const val = L > 220 ? 0 : 255;
      out.data[i] = out.data[i + 1] = out.data[i + 2] = val;
      out.data[i + 3] = 255;
    }
    ctx.putImageData(out, 0, 0);
    state.strips += 1;
    return { url: c.toDataURL('image/png'), t: +t.toFixed(1), w: c.width, h: c.height };
  };

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

    // ①b 字幕条：底部这条带子变了，就把"字幕那一行"裁下来。
    //     不做识别（识别在 node 侧批量做）——这里只负责便宜地挑出"值得 OCR"的时刻。
    let subStrip = null, subDiff = 0;
    const now = Date.now();
    if (SUB_GAP > 0) {
      const sy = Math.round(v.videoHeight * 0.70);
      const sh = Math.max(1, Math.round(v.videoHeight * 0.26));
      const sc = state.subCtx;
      sc.drawImage(v, 0, sy, v.videoWidth, sh, 0, 0, 64, 16);
      const sd = sc.getImageData(0, 0, 64, 16).data;
      const sn = 64 * 16;
      const sub = new Float32Array(sn);
      for (let i = 0, j = 0; i < sd.length; i += 4, j++) sub[j] = sd[i] * 0.299 + sd[i + 1] * 0.587 + sd[i + 2] * 0.114;
      if (state.prevSub) {
        for (let k = 0; k < sn; k++) subDiff += Math.abs(sub[k] - state.prevSub[k]);
        subDiff /= sn;
      }
      state.prevSub = sub;
      if ((now - state.lastStripAt) >= SUB_GAP && subDiff >= 2) {
        state.lastStripAt = now;
        subStrip = state.pickStrip(v, t);
      }
    }

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
    const nearlyStill = diff < 0.3;
    const forceAfter = forceGapMs * (nearlyStill ? 3 : 1);  // 完全不动（<0.3）= 20×3 = 60 秒才留一张
    const forced = (now - state.lastKeepAt) >= forceAfter;
    const tooSoon = state.lastKeepAt > 0 && (now - state.lastKeepAt) < minGapMs;
    // 音量只记录、不抓帧：一声爆炸不该多塞一张图，看片的人会被莫名叫醒
    const keep = first || (!tooSoon && !flat && (diff >= threshold || forced));
    if (!keep) return { t, diff: +diff.toFixed(2), kept: false, flat, subStrip, spike: loud ? loud.spike : 0, paused: v.paused, ended: v.ended };
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

    const out = { t, diff: +diff.toFixed(2), kept: true, cut: diff >= threshold, forced, loudHit, subStrip, spike: loud ? loud.spike : 0, paused: v.paused, ended: v.ended };
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

/** 字幕条落盘（PNG，反色二值化过）。抓完统一 OCR，识别后默认删掉。 */
function saveStrip(dir, bv, strip) {
  try {
    const file = path.join(dir, `sub-${bv}-${Math.round(strip.t * 10)}-${Date.now()}.png`);
    fs.writeFileSync(file, Buffer.from(String(strip.url).split(',')[1], 'base64'));
    return { t: strip.t, file };
  } catch (e) {
    log(`写字幕条失败：${e?.message ?? e}`);
    return null;
  }
}

(async () => {
  const startedAt = Date.now();
  const helpers = PAGE_HELPERS(cols, perGrid, CELL_W, CELL_H, SUB_OCR ? subGapMs : 0);
  const result = {
    ok: false, bv: '', from: 0, to: 0, ended: false,
    scanned: 0, kept: 0, frames: 0, grids: [], subtitles: [], strips: 0, note: '',
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
  const stripFiles = [];
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
      // 字幕条和画面格是两条线：不管这帧留不留画面，字幕变了都要收
      if (g.value.subStrip) {
        const savedStrip = saveStrip(dir, result.bv, g.value.subStrip);
        if (savedStrip) stripFiles.push(savedStrip);
      }
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

  // ── 字幕条 → 文本（RapidOCR，一次性批量）────────────────────────────────
  // 只有「接口拿不到字幕」的片子才会走到这儿；能拿到就直接用接口的文本，一分钱不花。
  if (SUB_OCR && stripFiles.length) {
    const ocrStart = Date.now();
    const rows = await ocrStrips(stripFiles.slice().sort((a, b) => a.t - b.t));
    const good = rows
      .map((row) => ({ t: Number(row?.t) || 0, text: String(row?.text ?? '').trim(), conf: Number(row?.conf) || 0 }))
      .filter((row) => row.text && row.conf >= subConf && /[\u4e00-\u9fa5A-Za-z0-9]/.test(row.text));
    // 同一句连着出现只留第一条：字幕常停 1~2 秒，会被裁两次
    const dedup = [];
    for (const row of good) {
      const last = dedup[dedup.length - 1];
      if (last && row.text === last.text) continue;
      dedup.push(row);
    }
    result.subtitles = dedup;
    result.strips = stripFiles.length;
    result.ocrMs = Date.now() - ocrStart;
    log(`OCR ${stripFiles.length} 条 → 采信 ${dedup.length} 句（${result.ocrMs}ms）`);
    // 识别完把条图删掉：一批几十张，留着占地
    if (Number(arg('keep-strips', 0)) === 0) {
      for (const item of stripFiles) { try { fs.unlinkSync(item.file); } catch {} }
    }
  }

  result.ok = result.frames > 0 && result.grids.length > 0;
  result.cuts = cuts;
  result.forces = forces;
  result.loud = loudTimes.slice(0, 30);
  result.maxSpike = +maxSpike.toFixed(2);
  if (!result.note) {
    const subNote = result.subtitles.length ? `，字幕 ${result.subtitles.length} 句` : '';
    result.note = result.ok
      ? `扫了 ${result.scanned} 次，留 ${result.frames} 个画面（换镜头 ${cuts}、兜底 ${forces}${subNote}），拼成 ${result.grids.length} 张`
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
