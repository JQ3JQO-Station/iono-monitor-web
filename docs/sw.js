// CB DX Iono Monitor — Service Worker
const CACHE_NAME = 'iono-monitor-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(clients.claim()));

// ── プッシュ通知受信 ──────────────────────────────────────────
self.addEventListener('push', event => {
  let data = { title: '⚠ CB DX Iono Monitor', body: 'Es発生を検出しました', url: './monitor.html' };
  try { Object.assign(data, event.data?.json()); } catch {}

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: 'https://jq3jqo-station.github.io/iono-monitor-web/favicon.ico',
      tag: 'iono-alert',
      renotify: true,
      data: { url: data.url },
    })
  );
});

// ── 通知タップ → モニター画面を開く ─────────────────────────
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || './monitor.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const existing = list.find(c => c.url.includes('monitor.html'));
      if (existing) return existing.focus();
      return clients.openWindow(url);
    })
  );
});
