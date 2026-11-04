export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // 订阅路径: /sub/sub-key-001
    if (path === '/sub/sub-key-001' || path === '/sub/') {
      const sub = buildSubscription();
      return new Response(sub, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-cache',
        }
      });
    }
    return new Response('CFNB Sub Endpoint - OK', { status: 200 });
  }
};

function buildSubscription() {
  // 使用已验证可用 IP（来自 cf_usable_ips.txt + 本地测试结果）
  const nodes = [
    { name:'CN-HK-01', ip:'103.21.244.1', vless_uuid:'b04f91ee-39e5-4b7c-87cb-722b326ac009', sni:'xiaogoutiaowuji.pages.dev', host:'english2to3gendu-ux.cc.cd', path:'/sub/', tls:true },
    { name:'CN-HK-02', ip:'103.21.244.65', vless_uuid:'b04f91ee-39e5-4b7c-87cb-722b326ac009', sni:'xiaogoutiaowuji.pages.dev', host:'english2to3gendu-ux.cc.cd', path:'/sub/', tls:true },
    { name:'CN-SG-01', ip:'188.114.96.1', vless_uuid:'b04f91ee-39e5-4b7c-87cb-722b326ac009', sni:'xiaogoutiaowuji.pages.dev', host:'english2to3gendu-ux.cc.cd', path:'/sub/', tls:true },
    { name:'CN-SG-02', ip:'188.114.96.65', vless_uuid:'b04f91ee-39e5-4b7c-87cb-722b326ac009', sni:'xiaogoutiaowuji.pages.dev', host:'english2to3gendu-ux.cc.cd', path:'/sub/', tls:true },
    { name:'CN-JP-01', ip:'103.31.4.1', vless_uuid:'b04f91ee-39e5-4b7c-87cb-722b326ac009', sni:'xiaogoutiaowuji.pages.dev', host:'english2to3gendu-ux.cc.cd', path:'/sub/', tls:true },
  ];
  const lines = nodes.map(n => {
    return 'vless://' + n.vless_uuid + '@' + n.ip + ':443?encryption=none&security=tls&type=ws&host=' + encodeURIComponent(n.host) + '&path=' + encodeURIComponent(n.path) + '&sni=' + encodeURIComponent(n.sni) + '&fp=chrome#' + encodeURIComponent(n.name);
  });
  return lines.join('\n');
}