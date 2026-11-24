/**
 * fish-eye · 宿主半。
 *
 * 只做一件事：给设置页的「陪看」分区提供读写陪看参数的接口。
 * 页面本身在 client.js（浏览器半）；参数文件在 src/tuning.mjs 里定义。
 *
 * 接口：
 *   GET  /fish-eye/api/tuning   读（当前值 / 默认值 / 范围 / 说明 / 文件路径）
 *   POST /fish-eye/api/tuning   写（只写认识的字段，写前按范围夹）
 */
import {
  TUNING_DEFAULTS,
  TUNING_FILE,
  TUNING_LABELS,
  TUNING_RANGE,
  readTuning,
  writeTuning,
} from './src/tuning.mjs';

const API = '/fish-eye/api';

/** 只接受本机回环。 */
function isLoopback(req) {
  const address = String(req.socket?.remoteAddress ?? '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** 写操作要求同源；非浏览器客户端（没有 Origin）放行。 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === (req.headers.host ?? '');
  } catch {
    return false;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname !== `${API}/tuning`) {
    sendJson(res, 404, { ok: false, error: '没有这个接口' });
    return;
  }

  if (req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      file: TUNING_FILE,
      tuning: readTuning(),
      defaults: TUNING_DEFAULTS,
      range: TUNING_RANGE,
      labels: TUNING_LABELS,
    });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, error: '只支持 GET/POST' });
    return;
  }

  let body = {};
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
    return;
  }

  const next = writeTuning(body?.tuning ?? body ?? {});
  if (!next) {
    sendJson(res, 500, { ok: false, error: `写不进 ${TUNING_FILE}` });
    return;
  }
  sendJson(res, 200, { ok: true, file: TUNING_FILE, tuning: next });
}

export const inject = ['webServer'];

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: API,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          sendJson(res, 403, { ok: false, error: '只接受本机回环访问' });
          return;
        }
        if (req.method !== 'GET' && !sameOrigin(req)) {
          sendJson(res, 403, { ok: false, error: '跨站请求被拒绝' });
          return;
        }
        if (req.method !== 'GET'
          && !String(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
          sendJson(res, 415, { ok: false, error: '写操作必须是 application/json' });
          return;
        }
        try {
          await handle(req, res);
        } catch (error) {
          sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      },
    }),
    'fish-eye: tuning api',
  );
}
