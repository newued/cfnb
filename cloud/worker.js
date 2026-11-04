/**
 * CFNB Cloud Subscription Worker
 * 全云端订阅分发：Cron 定时抓取优选 IP -> 生成 VLESS 订阅 -> 存 KV -> HTTP 输出
 * 不依赖任何本机进程、不依赖 GitHub Actions。
 */

const SOURCES = [
  'https://zip.cm.edu.kg/all.txt',
  'https://countrymerge.pages.dev/all.txt',
  'https://raw.githubusercontent.com/cmliu/CloudFlareIPSelector/main/ip.txt',
];

// 后端 WS 服务（已验证存活：https://xiaogoutiaowuji.pages.dev/ 返回 200）
const TARGET_HOST = 'xiaogoutiaowuji.pages.dev';
const TARGET_PATH = '/';
const UUID = 'b04f91ee-39e5-4b7c-87cb-722b326ac009';

const NODE_COUNT = 30;
const PORT_PREFERRED = 443;
const PORT_OTHERS = [2053, 2083, 2087, 2096, 8443];
const FETCH_TIMEOUT_MS = 12000;
const MAX_SCAN_LINES = 20000;

// 来源标签中需要排除的地区（与 config.json 的 PRE_FILTER_BLOCKED_COUNTRIES 保持一致）
const BLOCKED_TAGS = new Set(['CN', 'IR', 'KP', 'CU', 'RU', 'VN', 'PK', 'BD']);

function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

const CF_CIDR_RAW = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];

const CF_RANGES = CF_CIDR_RAW.map((c) => {
  const [ip, bits] = c.split('/');
  const mask = bits === '0' ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return { base: (ipToInt(ip) & mask) >>> 0, mask };
});

function isCloudflareIP(ip) {
  const n = ipToInt(ip);
  if (n === null) return false;
  return CF_RANGES.some((r) => ((n & r.mask) >>> 0) === r.base);
}

function isPrivateIP(ip) {
  const n = ipToInt(ip);
  if (n === null) return true;
  const top = (n >>> 24) & 0xff;
  const s2 = (n >>> 16) & 0xff;
  if (top === 10 || top === 127 || top === 0) return true;
  if (top === 172 && s2 >= 16 && s2 <= 31) return true;
  if (top === 192 && s2 === 168) return true;
  if (top === 169 && s2 === 254) return true;
  if (top >= 224) return true;
  return false;
}

/** 解析一行 -> { ip, port, tag } */
function parseLine(line) {
  const raw = line.trim();
  if (!raw || raw.startsWith('#')) return null;

  let body = raw;
  let tag = '';
  const hashIdx = raw.indexOf('#');
  if (hashIdx > -1) {
    body = raw.slice(0, hashIdx).trim();
    tag = raw.slice(hashIdx + 1).trim();
  }

  let ip = '';
  let port = 443;

  // 形式1: ip:port
  const m1 = body.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
  if (m1) {
    ip = m1[1];
    port = Number(m2port(m1[2]));
  } else {
    // 形式2: 纯 IP
    const m2 = body.match(/^(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (m2) {
      ip = m2[1];
      port = 443;
    } else {
      // 形式3: 其它串里提取 ip:port
      const m3 = body.match(/(\d{1,3}(?:\.\d{1,3}){3})[:\s]+(\d{1,5})?/);
      if (!m3) return null;
      ip = m3[1];
      port = m3[2] ? Number(m3[2]) : 443;
    }
  }

  function m2port(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n < 65536 ? n : 443;
  }

  if (!ipToInt(ip) && ipToInt(ip) !== 0) return null;
  if (isPrivateIP(ip)) return null;
  return { ip, port, tag };
}

function shouldSkipTag(tag) {
  if (!tag) return false;
  const t = tag.toUpperCase();
  for (const b of BLOCKED_TAGS) {
    if (t === b || t.includes(b)) return true;
  }
  return false;
}

/** 稳定的伪随机排序，保证同一 bucket 内结果一致 */
function bucketSeed(date) {
  const bucket = Math.floor(date.getTime() / (6 * 3600 * 1000)); // 每 6 小时轮换一批
  return bucket;
}

function hash32(str, seed) {
  let h = 2166136261 ^ seed;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function buildNode(ip, port, idx, region) {
  const params = new URLSearchParams({
    encryption: 'none',
    security: 'tls',
    type: 'ws',
    host: TARGET_HOST,
    path: TARGET_PATH,
    sni: TARGET_HOST,
    fp: 'chrome',
  });
  const name = `CF-${region || 'XX'}-${String(idx + 1).padStart(2, '0')}`;
  return `vless://${UUID}@${ip}:${port}?${params.toString()}#${encodeURIComponent(name)}`;
}

async function fetchSource(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'cfnb-sub/1.0' },
      cf: { cacheTtl: 0 },
    });
    if (!res.ok) return { url, ok: false, error: `HTTP ${res.status}`, text: '' };
    const text = await res.text();
    return { url, ok: true, text };
  } catch (e) {
    return { url, ok: false, error: String(e && e.message ? e.message : e), text: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function buildSubscription(env) {
  const results = await Promise.all(SOURCES.map(fetchSource));
  const report = [];

  const seen = new Set();
  const cfPool = [];
  const otherPool = [];

  for (const r of results) {
    report.push({ url: r.url, ok: r.ok, error: r.error || null, bytes: r.text.length });
    if (!r.ok || !r.text) continue;

    const lines = r.text.split('\n');
    const limit = Math.min(lines.length, MAX_SCAN_LINES);
    for (let i = 0; i < limit; i++) {
      const item = parseLine(lines[i]);
      if (!item) continue;
      if (shouldSkipTag(item.tag)) continue;
      const key = `${item.ip}:${item.port}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const node = { ip: item.ip, port: item.port, region: (item.tag || '').slice(0, 6) || 'XX' };
      if (isCloudflareIP(item.ip)) cfPool.push(node);
      else otherPool.push(node);
    }
  }

  if (cfPool.length === 0 && otherPool.length === 0) {
    const meta = {
      updated_at: new Date().toISOString(),
      ok: false,
      reason: 'all sources empty',
      sources: report,
    };
    await env.SUB_KV.put('meta', JSON.stringify(meta));
    return null;
  }

  const seed = bucketSeed(new Date());
  const sorter = (a, b) => hash32(a.ip, seed) - hash32(b.ip, seed);
  cfPool.sort(sorter);
  otherPool.sort(sorter);

  // 端口优化：443 优先排前面（稳定且兼容性最好）
  const prioritizePort = (list) =>
    list.slice().sort((a, b) => (a.port === PORT_PREFERRED ? 0 : 1) - (b.port === PORT_PREFERRED ? 0 : 1));

  const cfSorted = prioritizePort(cfPool);
  const otherSorted = prioritizePort(otherPool);

  // 混合：CF 官方段占 40%，第三方中转占 60%（国内常用中转往往更快）
  const cfQuota = Math.min(Math.ceil(NODE_COUNT * 0.4), cfSorted.length);
  const otherQuota = NODE_COUNT - cfQuota;

  const picked = [
    ...cfSorted.slice(0, cfQuota),
    ...otherSorted.slice(0, Math.max(0, Math.min(otherQuota, otherSorted.length))),
  ];

  // 若仍不足，从剩余池补齐
  if (picked.length < NODE_COUNT) {
    const usedKeys = new Set(picked.map((n) => `${n.ip}:${n.port}`));
    for (const n of [...cfSorted, ...otherSorted]) {
      if (picked.length >= NODE_COUNT) break;
      const k = `${n.ip}:${n.port}`;
      if (usedKeys.has(k)) continue;
      usedKeys.add(k);
      picked.push(n);
    }
  }

  const lines = picked.map((n, i) => buildNode(n.ip, n.port, i, n.region));
  const body = lines.join('\n') + '\n';

  const meta = {
    updated_at: new Date().toISOString(),
    ok: true,
    nodes: picked.length,
    candidates: { cf: cfPool.length, other: otherPool.length, total: seen.size },
    sources: report,
  };

  await env.SUB_KV.put('sub', body);
  await env.SUB_KV.put('meta', JSON.stringify(meta, null, 2));
  return { body, meta };
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/' || path === '/status') {
      const meta = await env.SUB_KV.get('meta');
      if (!meta) {
        return jsonResp({ status: 'initializing', hint: '等待首次 Cron 运行，或访问 /refresh?token=...' }, 503);
      }
      return new Response(
        `CFNB Cloud Sub — OK\n\n${meta}\n\n订阅地址: https://${url.host}/sub/${env.SUB_KEY || 'sub-key-001'}\n`,
        { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    }

    if (path === '/refresh') {
      const token = url.searchParams.get('token') || '';
      if (env.REFRESH_TOKEN && token !== env.REFRESH_TOKEN) {
        return jsonResp({ ok: false, error: 'invalid token' }, 403);
      }
      const r = await buildSubscription(env);
      if (!r) return jsonResp({ ok: false, error: 'no nodes produced' }, 502);
      return jsonResp({ ok: true, meta: r.meta }, 200);
    }

    if (path.startsWith('/sub')) {
      const body = await env.SUB_KV.get('sub');
      if (!body) {
        return new Response('subscription not ready\n', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
      const wantB64 = url.searchParams.get('b64') === '1';
      const out = wantB64 ? btoa(unescape(encodeURIComponent(body))) : body;
      return new Response(out, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'profile-update-interval': '1',
          'subscription-userinfo': `upload=0; download=0; total=107374182400; expire=${Math.floor(Date.now() / 1000) + 86400 * 365}`,
        },
      });
    }

    return new Response('CFNB Cloud Sub\n', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      buildSubscription(env).catch(async (e) => {
        await env.SUB_KV.put(
          'meta',
          JSON.stringify({ updated_at: new Date().toISOString(), ok: false, error: String(e) }, null, 2)
        );
      })
    );
  },
};
