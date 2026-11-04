/**
 * CFNB Cron Trigger Worker
 *
 * 职责单一：用 Cloudflare 的 Cron 定时器唤醒 GitHub Actions 的订阅更新工作流。
 * 不存数据、不碰订阅内容 —— 订阅仍由 cfnb-sub 仓库的 Actions 生成，经 gh-proxy 分发。
 *
 * 必需的环境变量：
 *   GH_TOKEN  —— GitHub Personal Access Token（repo 权限即可）
 *
 * 可选环境变量：
 *   TARGET_REPO   默认 newued/cfnb-sub
 *   WORKFLOW_FILE 默认 sub_update.yml
 *   WORKFLOW_REF  默认 main
 */

const API = 'https://api.github.com';

async function dispatch(env) {
  const repo = env.TARGET_REPO || 'newued/cfnb-sub';
  const wf = env.WORKFLOW_FILE || 'sub_update.yml';
  const ref = env.WORKFLOW_REF || 'main';

  if (!env.GH_TOKEN) {
    return { ok: false, status: 0, error: 'GH_TOKEN 未配置' };
  }

  const url = `${API}/repos/${repo}/actions/workflows/${wf}/dispatches`;
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'cfnb-cron-worker',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref }),
    });
    const ms = Date.now() - started;
    // GitHub 对成功 dispatch 返回 204，无 body
    if (res.status === 204) {
      return { ok: true, status: 204, ms, repo, workflow: wf, ref, at: new Date().toISOString() };
    }
    const text = await res.text();
    return {
      ok: false,
      status: res.status,
      ms,
      error: text.slice(0, 300),
      remaining: res.headers.get('x-ratelimit-remaining'),
      at: new Date().toISOString(),
    };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - started, error: String((e && e.message) || e) };
  }
}

export default {
  // Cron 触发入口：Cloudflare 到点自动调用
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      dispatch(env).then((r) => {
        console.log('[cron]', JSON.stringify(r));
      })
    );
  },

  // HTTP 入口：用于手动验证与健康检查
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify(
          {
            service: 'cfnb-cron',
            token_configured: Boolean(env.GH_TOKEN),
            now: new Date().toISOString(),
            trigger: `${new Date().toISOString().slice(0, 10)} cron 每 30 分钟`,
          },
          null,
          2
        ),
        { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }
      );
    }

    // 访问根路径即主动触发一次，便于部署后立即验证
    const r = await dispatch(env);
    return new Response(JSON.stringify(r, null, 2), {
      status: r.ok ? 200 : 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
