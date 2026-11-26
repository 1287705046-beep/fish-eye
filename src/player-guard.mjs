#!/usr/bin/env node
/**
 * player-guard.mjs —— 陪看期间替模型守着那个播放窗。
 *
 * 检测到 CDP 端口上开着 B站 视频页就运行，连续连不上就退出，不会变成孤儿进程。
 *
 * 四件事：
 *   A 播完兜底：视频 ended 时把「结束页 / 相关推荐」盖掉，画面停在最后一帧，
 *     顶上盖一行「这条播完了」。不然模型会把结束页当成「掉到首页推荐」。
 *   B 导航守卫：页面从 /video/BV... 掉走（到首页/推荐流/搜索）就导航回来，并回到离开时的秒数。
 *     换到**另一条 BV** 不算掉走——那是外部在换片，跟着它走。
 *   C 置顶：播放窗设成 TOPMOST，别的窗口压不住它（Windows 专用；以前会抓到「半张是别的窗口」）。
 *   D 框选（可选）：按 <video> 的真实位置算屏幕像素，写进 FISH_EYE_REGION_FILE，
 *     给「按矩形截图」那类工具有个准框。不设这个环境变量就整块跳过。
 *
 * 环境变量：
 *   FISH_EYE_CDP_PORT            默认 9333
 *   FISH_EYE_EDGE_PROFILE        默认 ~/.cache/fish-eye/edge-profile（关窗时按这个 profile 名杀进程）
 *   FISH_EYE_REGION_FILE         可选；不设就不写框选
 *   FISH_EYE_WATCH_LOG           默认 ~/.cache/fish-eye/guard.log
 *   FISH_EYE_CLOSE_AFTER_MS      播完多久关窗，默认 35000
 *   FISH_EYE_CLOSE_AFTER_PAUSED_MS  一直暂停多久关窗，默认 600000
 *   FISH_EYE_SEGMENT_MS          单段最长多久硬性停一次再接上，默认 840000（14 分钟）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const PORT = Number(process.env.FISH_EYE_CDP_PORT) || 9333;
const POLL_MS = 2000;
const HOME = os.homedir();
const REGION_FILE = process.env.FISH_EYE_REGION_FILE || '';
const LOG_FILE = process.env.FISH_EYE_WATCH_LOG || path.join(HOME, '.cache', 'fish-eye', 'guard.log');
const MAX_FAILS = 5;
// 播完多久自动关窗（默认 35 秒；两分钟太长，模型那边等不及）。换下一条时这个计时会自己清零。
const CLOSE_AFTER_ENDED_MS = Number(process.env.FISH_EYE_CLOSE_AFTER_MS) > 0
  ? Number(process.env.FISH_EYE_CLOSE_AFTER_MS)
  : 35_000;
// 一直暂停着（不是播完）也关：她多半是丢下去干别的了，别让窗和浮窗一直占着
const CLOSE_AFTER_PAUSED_MS = Number(process.env.FISH_EYE_CLOSE_AFTER_PAUSED_MS) > 0
  ? Number(process.env.FISH_EYE_CLOSE_AFTER_PAUSED_MS)
  : 600_000;
const VIDEO_PROFILE = process.env.FISH_EYE_EDGE_PROFILE || path.join(HOME, '.cache', 'fish-eye', 'edge-profile');
// 单段看多久硬性停一次（默认 14 分钟）。到点暂停、盖一行「这一段看完了」，
// 3 秒后从**同一秒**重新打开同一条接着放——看的人不用做任何动作，流也不会断。
const SEGMENT_MS = Number(process.env.FISH_EYE_SEGMENT_MS) > 0
  ? Number(process.env.FISH_EYE_SEGMENT_MS)
  : 14 * 60_000;

function log(msg) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const line = `[${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch { /* 日志写不进去也要继续守 */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- CDP 小客户端 ----------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg = null;
      try { msg = JSON.parse(String(event.data)); } catch { return; }
      const res = this.pending.get(msg.id);
      if (!res) return;
      this.pending.delete(msg.id);
      res(msg);
    });
  }
  static async connect() {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1200) })).json();
    const page = (Array.isArray(list) ? list : []).find((t) => t.type === 'page' && /bilibili\.com/.test(String(t.url || '')))
      || (Array.isArray(list) ? list : []).find((t) => t.type === 'page');
    if (!page?.webSocketDebuggerUrl) throw new Error('没有可用的 page target');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 4000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); }, { once: true });
    });
    return new Cdp(ws);
  }
  call(method, params = {}, timeoutMs = 5000) {
    const id = ++this.id;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression, timeoutMs = 5000) {
    const msg = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (!msg) return undefined;
    if (msg.error) throw new Error(msg.error?.message ?? 'CDP 报错');
    if (msg.result?.exceptionDetails) throw new Error(msg.result.exceptionDetails?.text ?? '页面里报错');
    return msg.result?.result?.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

// ---------- C 置顶 ----------
const PS_TOPMOST = (on) => `
Add-Type -Namespace EyeGuard -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);'
$targets = Get-Process msedge -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'bilibili|哔哩哔哩|哔哩' }
foreach ($t in $targets) { [void][EyeGuard.Win]::SetWindowPos($t.MainWindowHandle, [IntPtr]${on ? '-1' : '-2'}, 0, 0, 0, 0, 0x0003) }
if ($targets) { "ok:$($targets.Count)" } else { "no-window" }
`;

function setTopmost(on) {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', PS_TOPMOST(on)], { timeout: 12_000, windowsHide: true, encoding: 'utf8' });
    const out = String(r.stdout ?? '').trim();
    log(`置顶${on ? '开' : '关'}：${out || r.stderr?.trim() || '(无输出)'}`);
    return out.startsWith('ok');
  } catch (e) {
    log(`置顶${on ? '开' : '关'}失败：${e?.message ?? e}`);
    return false;
  }
}

// ---------- 自动关窗 ----------
// 只杀这个专用 profile 的 Edge，不碰用户自己的浏览器。
function closePlayerWindow(reason) {
  log(`自动关窗：${reason}`);
  if (topmostOn) { setTopmost(false); topmostOn = false; }
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" "
    + `| Where-Object { $_.CommandLine -like '*${path.basename(VIDEO_PROFILE)}*' } `
    + '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 20_000, windowsHide: true });
  } catch (e) {
    log(`关窗失败：${e?.message ?? e}`);
  }
  log('播放窗已关（浮窗和框选由桥接守护下一轮收）');
  process.exit(0);
}

// ---------- D 框选 ----------
// 可选功能：设了 FISH_EYE_REGION_FILE 才会把播放器的屏幕矩形写出去，
// 给「按矩形截图」那类工具有个准框；不设就整块跳过。
function writeRegion(region) {
  if (!REGION_FILE) return false;
  try {
    fs.mkdirSync(path.dirname(REGION_FILE), { recursive: true });
    const tmp = `${REGION_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...region, at: Date.now() }), 'utf8');
    fs.renameSync(tmp, REGION_FILE);
    return true;
  } catch (e) {
    log(`写 region.json 失败：${e?.message ?? e}`);
    return false;
  }
}

const READ_VIDEO = `(() => {
  const v = document.querySelector('video');
  if (!v) return null;
  const r = v.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const b = (window.outerWidth - window.innerWidth) / 2;
  return {
    x: r.x, y: r.y, w: r.width, h: r.height,
    clientX: window.screenX + b,
    clientY: window.screenY + (window.outerHeight - window.innerHeight) - b,
    dpr: window.devicePixelRatio || 1,
  };
})()`;

async function syncRegion(cdp) {
  if (!REGION_FILE) return false;
  const m = await cdp.eval(READ_VIDEO);
  if (!m) return false;
  const dpr = Number(m.dpr) > 0 ? Number(m.dpr) : 1;
  const region = {
    x: Math.max(0, Math.round(m.clientX + m.x)),
    y: Math.max(0, Math.round(m.clientY + m.y)),
    w: Math.round(m.w),
    h: Math.round(m.h),
  };
  if (dpr !== 1) {
    region.x = Math.round(region.x * dpr);
    region.y = Math.round(region.y * dpr);
    region.w = Math.round(region.w * dpr);
    region.h = Math.round(region.h * dpr);
  }
  // 太小的框（还没出画面 / 广告层）先不写，免得把她的眼框成一条缝
  if (region.w < 480 || region.h < 270) return false;
  const prev = (() => {
    try { return JSON.parse(fs.readFileSync(REGION_FILE, 'utf8')); } catch { return null; }
  })();
  if (prev && prev.x === region.x && prev.y === region.y && prev.w === region.w && prev.h === region.h) return true;
  const ok = writeRegion(region);
  if (ok) log(`框选按实测写好：${region.x},${region.y},${region.w},${region.h}`);
  return ok;
}

// ---------- A 播完兜底 + B 状态读回 ----------
const INJECT = `(() => {
  if (window.__fishEyeDone) return 'already';
  const v = document.querySelector('video');
  if (!v) return 'no-video';
  window.__fishEyeDone = 1;
  const HIDE_SEL = [
    '.bpx-player-ending-wrap', '.bpx-player-ending', '.bpx-player-ending-related',
    '.bpx-player-ending-backdrop', '.bpx-player-ending-content', '.bpx-player-ending-panel',
    '.bpx-player-recommend', '.bilibili-player-ending-panel', '.bilibili-player-video-btn-replay',
    '.bpx-player-ctrl-replay', '.bilibili-player-ending', '#bilibili-player-ending-panel',
  ].join(',');
  const hide = () => {
    document.querySelectorAll(HIDE_SEL).forEach((n) => {
      if (n.style.getPropertyValue('display') !== 'none') n.style.setProperty('display', 'none', 'important');
    });
    let box = document.getElementById('qq-eye-done');
    if (!box) {
      box = document.createElement('div');
      box.id = 'qq-eye-done';
      box.textContent = '这条播完了 · 可以换片';
      box.style.cssText = 'position:fixed;left:0;right:0;z-index:2147483647;padding:7px 12px;'
        + 'background:rgba(18,18,18,.9);color:#ffe9a8;font:15px/1.5 system-ui,"Microsoft YaHei";'
        + 'text-align:center;pointer-events:none;letter-spacing:.5px';
      document.body.appendChild(box);
    }
    // 横幅要落在**画面里**：她那只眼只框 video 那一块（见 D），页面顶部的字她看不见
    const r = v.getBoundingClientRect();
    box.style.top = Math.max(0, Math.round(r.top)) + 'px';
    box.style.display = 'block';
  };
  const clear = () => {
    const box = document.getElementById('qq-eye-done');
    if (box) box.style.display = 'none';
  };
  v.addEventListener('ended', hide);
  v.addEventListener('play', clear);
  v.addEventListener('seeking', clear);
  setInterval(() => { if (v.ended) hide(); }, 1500);

  // 黑场标注（全黑多半是片子自己的转场）：
  // 全黑的帧多半是片子自己的转场，不是没抓到。直接在她看的画面里写一句，
  // 她就知道这一段黑是有意的。B站 的 video 带 crossOrigin=anonymous，能读像素。
  const cv = document.createElement('canvas');
  cv.width = 32; cv.height = 18;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  let tag = null;
  const sample = () => {
    try {
      cx.drawImage(v, 0, 0, 32, 18);
      const d = cx.getImageData(0, 0, 32, 18).data;
      let s = 0;
      let bright = 0;
      const n = d.length / 4;
      for (let i = 0; i < d.length; i += 4) {
        const l = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
        s += l;
        if (l > 55) bright += 1;
      }
      return { mean: s / n, brightFrac: bright / n };
    } catch { return null; }
  };
  // 逐帧采样（rAF ≈ 60 次/秒）：转场黑场常常只有两三帧（几十毫秒），
  // 用 250ms 的定时器会漏掉一半。32×18 的取样很便宜。
  const tick = () => {
    const s = sample();
    if (s) {
      // 真黑帧的判据：整片都黑 **并且** 几乎没有亮像素。
      // 只看平均亮度会把「黑底 + 一个小头像」那种暗场也当成转场（11-23 实测误标过）。
      const th = Number(window.__fishEyeBlackThreshold) || 10;
      const isBlack = s.mean < th && s.brightFrac < 0.01;
      if (isBlack) {
        if (!tag) {
          tag = document.createElement('div');
          tag.id = 'qq-eye-transition';
          tag.textContent = '转场 · 黑帧（不是没抓到）';
          tag.style.cssText = 'position:fixed;z-index:2147483646;padding:5px 10px;'
            + 'background:rgba(0,0,0,.8);color:#9fe3ff;font:15px/1.4 system-ui,"Microsoft YaHei";'
            + 'pointer-events:none;border-radius:5px;letter-spacing:.5px';
          document.body.appendChild(tag);
        }
        const r = v.getBoundingClientRect();
        tag.style.left = (Math.round(r.left) + 48) + 'px';
        tag.style.top = (Math.round(r.top) + 14) + 'px';
        tag.style.display = 'block';
      } else if (tag && tag.style.display !== 'none') {
        tag.style.display = 'none';
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return 'ok';
})()`;

const STATE = `(() => {
  const v = document.querySelector('video');
  return {
    href: location.href,
    hasVideo: !!v,
    took: !!window.__fishEyeDone,
    playing: !!v && !v.paused && !v.ended,
    ended: !!v && v.ended && v.paused,
    time: v ? v.currentTime : 0,
    duration: v ? v.duration || 0 : 0,
  };
})()`;

const BV_RE = /\/video\/(BV[0-9A-Za-z]{10})/;

function navUrlFor(bv, time) {
  return `https://www.bilibili.com/video/${bv}${time > 3 ? `?t=${Math.floor(time)}` : ''}`;
}

// ---------- 主循环 ----------
let lastSaved = { bv: null, time: 0 };
let topmostOn = false;
let endedAt = 0;
let pausedAt = 0;
let playedMs = 0;
let segment = 1;

async function main() {
  log(`===== 看片守护启动 PID ${process.pid} =====`);
  let cdp = null;
  let fails = 0;

  const cleanup = (why) => {
    if (topmostOn) { setTopmost(false); topmostOn = false; }
    try { cdp?.close(); } catch {}
    log(`退出：${why}`);
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  while (true) {
    try {
      if (!cdp) {
        cdp = await Cdp.connect();
        fails = 0;
        log('已连上播放窗');
        await sleep(1200);
        await syncRegion(cdp);
        const injected = await cdp.eval(INJECT);
        log(`播完兜底注入：${injected}`);
      }

      const st = await cdp.eval(STATE);
      if (!st) throw new Error('读不到页面状态');
      fails = 0;

      const tag = String(st.href || '').match(BV_RE);
      const onVideo = Boolean(tag) && Boolean(st.hasVideo);

      // 分段：看着的时间累计到 SEGMENT_MS 就硬性停一下，再从同一秒接上
      if (onVideo && st.playing) playedMs += POLL_MS;
      if (onVideo && playedMs >= SEGMENT_MS) {
        const at = Math.floor(st.time);
        const mins = Math.round(SEGMENT_MS / 60_000);
        log(`第 ${segment} 段看满 ${mins} 分钟（片内 ${at}s），停一下再从原处接上`);
        await cdp.eval(`(() => {
          const v = document.querySelector('video');
          try { v.pause(); } catch {}
          const old = document.getElementById('qq-eye-seg');
          if (old) old.remove();
          const t = document.createElement('div');
          t.id = 'qq-eye-seg';
          t.textContent = '这一段看完了 · 自动接下一段';
          const r = v.getBoundingClientRect();
          t.style.cssText = 'position:fixed;left:0;right:0;z-index:2147483645;padding:9px;'
            + 'background:rgba(10,10,10,.88);color:#9fe3ff;font:16px system-ui,"Microsoft YaHei";'
            + 'text-align:center;pointer-events:none';
          // 必须落在**画面里**：她那只眼只框 video 那一块，写页面顶部她看不见
          t.style.top = Math.max(0, Math.round(r.top)) + 'px';
          document.body.appendChild(t);
          return 'ok';
        })()`);
        await sleep(3000);
        await cdp.call('Page.navigate', { url: `https://www.bilibili.com/video/${tag[1]}?t=${at}` });
        await sleep(4500);
        await cdp.eval(INJECT);
        await syncRegion(cdp);
        segment += 1;
        playedMs = 0;
        lastSaved = { bv: tag[1], time: at, playing: true };
        log(`已接上第 ${segment} 段（从 ${at} 秒继续）`);
      }

      // 自动关窗的计时
      if (st.hasVideo && st.ended) {
        pausedAt = 0;
        if (!endedAt) {
          endedAt = Date.now();
          log(`片子播完了，${Math.round(CLOSE_AFTER_ENDED_MS / 1000)} 秒后自动关窗`);
        }
      } else if (st.hasVideo && !st.playing) {
        endedAt = 0;
        if (!pausedAt) pausedAt = Date.now();
      } else {
        endedAt = 0;
        pausedAt = 0;
      }
      if (endedAt && Date.now() - endedAt > CLOSE_AFTER_ENDED_MS) {
        closePlayerWindow(`播完已经 ${Math.round(CLOSE_AFTER_ENDED_MS / 1000)} 秒`);
      }
      if (pausedAt && Date.now() - pausedAt > CLOSE_AFTER_PAUSED_MS) {
        closePlayerWindow(`暂停了 ${Math.round(CLOSE_AFTER_PAUSED_MS / 60_000)} 分钟`);
      }

      // C 置顶只管「正在看片」这一段：她切去刷网页时把它放下来，别老压着主人的窗口
      if (onVideo && !topmostOn) {
        if (setTopmost(true)) topmostOn = true;
      } else if (!onVideo && topmostOn) {
        setTopmost(false);
        topmostOn = false;
      }
      // B 导航守卫：掉到非 /video/ 页（首页/推荐流/搜索）就拉回来。
      // **只在「上一轮还在播」时拉**：播完之后她自己点去别处是正常动作，不该被拽回来。
      if (!tag) {
        if (lastSaved.bv && lastSaved.playing) {
          const back = navUrlFor(lastSaved.bv, lastSaved.time);
          log(`页面掉走了（${String(st.href).slice(0, 90)}）→ 拉回 ${lastSaved.bv} 第 ${Math.floor(lastSaved.time)} 秒`);
          await cdp.call('Page.navigate', { url: back });
          await sleep(3500);
          const injected = await cdp.eval(INJECT);
          await syncRegion(cdp);
          log(`回来之后：注入 ${injected}`);
        }
      } else {
        // 换到另一条 BV = 她在换片，跟着走（重置进度记录）
        if (lastSaved.bv !== tag[1]) {
          lastSaved = { bv: tag[1], time: 0, playing: Boolean(st.playing) };
          log(`当前片：${tag[1]}`);
          await sleep(1500);
          await syncRegion(cdp);
          const injected = await cdp.eval(INJECT);
          if (injected === 'no-video') await sleep(1500);
        } else if (st.hasVideo) {
          lastSaved.time = st.time;
          lastSaved.playing = Boolean(st.playing);
        }
        if (st.hasVideo && !st.took) {
          const injected = await cdp.eval(INJECT);
          if (injected === 'ok') log('播完兜底补注入（页面刷新过）');
        }
      }
    } catch (e) {
      fails += 1;
      log(`第 ${fails} 次出错：${e?.message ?? e}`);
      try { cdp?.close(); } catch {}
      cdp = null;
      if (fails >= MAX_FAILS) cleanup('连续连不上播放窗（窗可能已经关了）');
      await sleep(1500);
      continue;
    }
    await sleep(POLL_MS);
  }
}

main().catch((e) => { log(`崩了：${e?.stack ?? e}`); process.exit(1); });
