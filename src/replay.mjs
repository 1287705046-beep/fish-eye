// 把当前播放页倒回某个秒数接着播（调试用；守护的分段也是靠导航实现的，这里用页面内 seek 图快）。
// 用法：node src/replay.mjs [秒数]
import fs from 'node:fs';

const PORT = Number(process.env.FISH_EYE_CDP_PORT) || 9333;
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m = null; try { m = JSON.parse(String(e.data)); } catch { return; }
      const cb = this.pending.get(m.id); if (!cb) return;
      this.pending.delete(m.id); cb(m);
    });
  }
  call(method, params = {}, timeoutMs = 8000) {
    const id = ++this.id;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(id); resolve(null); }, timeoutMs);
      this.pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const m = await this.call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (!m || m.error) return undefined;
    return m.result?.result?.value;
  }
}

const at = Number(process.argv[2] || 0);
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).catch(() => []);
const page = (list || []).find((t) => t.type === 'page' && /bilibili\.com\/video/.test(String(t.url || '')));
if (!page?.webSocketDebuggerUrl) { console.log('没有视频页'); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
  setTimeout(rej, 5000);
});
const c = new Cdp(ws);
await c.call('Runtime.enable');
const r = await c.eval(`(() => {
  const v = document.querySelector('video');
  if (!v) return { error: 'no video' };
  v.currentTime = ${at};
  const p = v.play();
  if (p && p.catch) p.catch(() => {});
  return { t: v.currentTime, d: Math.round(v.duration || 0), paused: v.paused };
})()`);
console.log(JSON.stringify(r));
try { ws.close(); } catch {}
