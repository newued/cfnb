export default {
  async scheduled(controller, env, ctx) {
    // 30min cron: 实测 IP → 生成 VLESS base64 → 写 KV
    const usable = await testUsableIPs();
    const payload = buildVlessSubscription(usable);
    await env.CFNB_SUB.put('sub', payload); // KV namespace bound as CFNB_SUB
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/sub/')) {
      const key = url.pathname.split('/')[2] || 'default';
      const data = await env.CFNB_SUB.get('sub');
      if (!data) return new Response('Not ready', {status:503});
      return new Response(data, {headers:{'Content-Type':'text/plain; charset=utf-8'}});
    }
    return new Response('OK');
  }
};
function testUsableIPs() { return ['192.0.2.1','198.51.100.2']; } // 真实流程替换
function buildVlessSubscription(ips) { return 'vmess://...'; }
