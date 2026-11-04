addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const path = url.pathname;

  if (path === '/sub/sub-key-001' || path === '/sub/') {
    // Fetch subscription content from GitHub source
    event.respondWith(
      fetch('https://raw.githubusercontent.com/newued/cfnb/main/sub_final.txt')
        .then(resp => resp.text())
        .then(text => new Response(text, {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'max-age=1800',
          }
        }))
        .catch(() => new Response('CFNB Sub Source - OK', { status: 200 }))
    );
  } else {
    event.respondWith(new Response('CFNB Sub Endpoint - OK', { status: 200 }));
  }
});
