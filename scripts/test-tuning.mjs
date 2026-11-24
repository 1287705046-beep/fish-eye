/**
 * fish-eye 的自检：参数文件 + HTTP 接口。
 *
 *   [1] 文件不存在 → 默认值
 *   [2] 写 → 落盘 → 再读
 *   [3] 超出范围被夹住；非数字不落盘
 *   [4] 多余的字段不写进去
 *   [5] 文件坏了也不抛
 *   [6] 目录不存在会自动建
 *   [7] HTTP GET / POST 走得通；非回环地址被拒；非 GET/POST 不改文件
 *
 * 全程在临时目录里跑，不碰真实的参数文件。
 *
 * 运行：node scripts/test-tuning.mjs
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-eye-test-'));
const TUNING_FILE = path.join(TEMP_DIR, 'nested', 'tuning.json');
process.env.FISH_EYE_TUNING = TUNING_FILE;

const { TUNING_DEFAULTS, clampTuning, readTuning, writeTuning } = await import('../src/tuning.mjs');

let failed = 0;
function check(name, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${name}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${detail}`}`);
}

console.log('[1] 文件不存在 → 默认值');
{
  const tuning = readTuning();
  check('四项都是默认值', JSON.stringify(tuning) === JSON.stringify(TUNING_DEFAULTS), JSON.stringify(tuning));
}

console.log('[2] 写 → 落盘 → 再读');
{
  const written = writeTuning({ scan: 1.2, th: 12, forceGap: 30, maxGrids: 14 });
  check('返回写入后的值', written?.th === 12, JSON.stringify(written));
  check('文件真的建出来了（含目录）', fs.existsSync(TUNING_FILE));
  const onDisk = JSON.parse(fs.readFileSync(TUNING_FILE, 'utf8'));
  check('落盘内容一致', onDisk.scan === 1.2 && onDisk.maxGrids === 14, JSON.stringify(onDisk));
  check('再读是新值', readTuning().forceGap === 30, String(readTuning().forceGap));
}

console.log('[3] 超范围夹住；非数字不落盘');
{
  check('th 999 → 60', clampTuning('th', 999) === 60, String(clampTuning('th', 999)));
  check('maxGrids 1 → 6', clampTuning('maxGrids', 1) === 6, String(clampTuning('maxGrids', 1)));
  check('scan 9 → 3', clampTuning('scan', 9) === 3, String(clampTuning('scan', 9)));
  check('scan 0.17 → 0.2', clampTuning('scan', 0.17) === 0.2, String(clampTuning('scan', 0.17)));
  check('非数字 → null', clampTuning('th', 'abc') === null);
  check('不认识的 key → null', clampTuning('nope', 5) === null);
  const written = writeTuning({ th: 'abc', maxGrids: 3 });
  check('非数字被跳过、合法的照写', written?.maxGrids === 6, JSON.stringify(written));
  check('原来的 th 没被改坏', written?.th === 12, String(written?.th));
}

console.log('[4] 多余的字段不写进去');
{
  writeTuning({ th: 22, 我要捣乱: 1 });
  const onDisk = JSON.parse(fs.readFileSync(TUNING_FILE, 'utf8'));
  check('只有四项', Object.keys(onDisk).length === 4, Object.keys(onDisk).join(','));
  check('th 是 22', onDisk.th === 22, String(onDisk.th));
}

console.log('[5] 文件坏了也不抛');
{
  fs.writeFileSync(TUNING_FILE, '{ 这不是 json', 'utf8');
  const tuning = readTuning();
  check('退回默认值', JSON.stringify(tuning) === JSON.stringify(TUNING_DEFAULTS), JSON.stringify(tuning));
  const written = writeTuning({ th: 30 });
  check('坏文件也能被覆盖回来', written?.th === 30, JSON.stringify(written));
}

console.log('[6] 目录不存在会自动建');
{
  const deeper = path.join(TEMP_DIR, 'a', 'b', 'c', 'tuning.json');
  const written = writeTuning({ th: 18 }, deeper);
  check('写成功', written?.th === 18, JSON.stringify(written));
  check('目录建出来了', fs.existsSync(deeper));
}

console.log('[7] HTTP 接口');
{
  const routes = [];
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {}; } },
    effect(fn) { fn(); return () => {}; },
  };
  const { apply } = await import('../index.js');
  apply(ctx);
  check('注册了一条路由', routes.length === 1, `routes=${routes.length}`);

  const route = routes[0];
  const API = '/fish-eye/api';

  function fakeRes() {
    return {
      statusCode: 200,
      headers: {},
      body: '',
      writeHead(code, headers) { this.statusCode = code; this.headers = headers ?? {}; },
      end(body = '') { this.body += body; },
    };
  }
  function fakeReq(method, url, body, remoteAddress = '127.0.0.1') {
    const req = new EventEmitter();
    req.method = method;
    req.url = url;
    req.socket = { remoteAddress };
    req.headers = {
      host: '127.0.0.1:57350',
      origin: 'http://127.0.0.1:57350',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    if (body !== undefined) {
      process.nextTick(() => {
        req.emit('data', Buffer.from(JSON.stringify(body)));
        req.emit('end');
      });
    }
    return req;
  }
  async function call(method, sub, body, remoteAddress) {
    const res = fakeRes();
    await route.handler(fakeReq(method, `${API}${sub}`, body, remoteAddress), res);
    let data = {};
    try { data = JSON.parse(res.body); } catch {}
    return { status: res.statusCode, data };
  }

  const got = await call('GET', '/tuning');
  check('GET 200', got.status === 200, `status=${got.status}`);
  check('GET 带当前值', got.data.tuning?.th === 30, JSON.stringify(got.data.tuning));
  check('GET 带范围', Array.isArray(got.data.range?.scan), JSON.stringify(got.data.range));
  check('GET 带说明', typeof got.data.labels?.th === 'string');
  check('GET 带文件路径', got.data.file === TUNING_FILE, got.data.file);

  const posted = await call('POST', '/tuning', { tuning: { scan: 0.8, maxGrids: 9 } });
  check('POST 200', posted.status === 200, `status=${posted.status} ${JSON.stringify(posted.data)}`);
  check('POST 回显', posted.data.tuning?.scan === 0.8 && posted.data.tuning?.maxGrids === 9, JSON.stringify(posted.data.tuning));

  const afterPost = JSON.parse(fs.readFileSync(TUNING_FILE, 'utf8'));
  check('POST 落盘', afterPost.scan === 0.8 && afterPost.maxGrids === 9, JSON.stringify(afterPost));

  const notLoopback = await call('GET', '/tuning', undefined, '10.1.2.3');
  check('非本机被拒 403', notLoopback.status === 403, `status=${notLoopback.status}`);

  const before = fs.readFileSync(TUNING_FILE, 'utf8');
  const put = await call('PUT', '/tuning', { tuning: { th: 44 } });
  check('PUT 不是 200', put.status !== 200, `status=${put.status}`);
  check('PUT 没改文件', fs.readFileSync(TUNING_FILE, 'utf8') === before);

  const badPath = await call('GET', '/nope');
  check('未知路径 404', badPath.status === 404, `status=${badPath.status}`);
}

try { fs.rmSync(TEMP_DIR, { recursive: true, force: true }); } catch {}

console.log(failed ? `\nFAILED ${failed}` : '\nFISH-EYE TUNING OK');
process.exit(failed ? 1 : 0);
