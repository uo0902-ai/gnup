// 계남중 파일업다운 서비스워커
//  1) 다른 앱의 [공유하기]로 들어온 파일/링크를 받아 임시 보관한 뒤 앱 화면으로 넘김
//  2) 백그라운드 알림(다운로드 버튼) 클릭 처리
const INBOX_CACHE = 'gyenam-share-inbox-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(handleShareTarget(req));
  }
});

async function handleShareTarget(request) {
  try {
    const form = await request.formData();
    const cache = await caches.open(INBOX_CACHE);
    for (const k of await cache.keys()) await cache.delete(k);

    const meta = {
      title: form.get('title') || '',
      text: form.get('text') || '',
      url: form.get('url') || '',
      files: []
    };
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && 'name' in f);
    let i = 0;
    for (const f of files) {
      const key = new URL('./__shared__/' + i, self.registration.scope).href;
      await cache.put(key, new Response(f, {
        headers: {
          'Content-Type': f.type || 'application/octet-stream',
          'X-Filename': encodeURIComponent(f.name),
          'X-Lastmod': String(f.lastModified || Date.now())
        }
      }));
      meta.files.push(key);
      i++;
    }
    await cache.put(
      new URL('./__shared__/meta.json', self.registration.scope).href,
      new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } })
    );
  } catch (e) {
    // 실패해도 앱 화면으로는 이동
  }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (list.length > 0) {
      const c = list[0];
      try { await c.focus(); } catch (e) {}
      c.postMessage({ type: 'NOTIF_CLICK', action: event.action || 'open', itemId: data.itemId });
    } else {
      await self.clients.openWindow('./');
    }
  })());
});
