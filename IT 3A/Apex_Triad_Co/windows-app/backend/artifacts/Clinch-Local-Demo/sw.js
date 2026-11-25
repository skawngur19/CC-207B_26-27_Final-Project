'use strict';
// Each release has its own complete shell. Activation waits until old tabs close.
const cacheId = 'clinch-shell-0f8d5af10472e183';
const urls = ['index.html','styles.css','icons.js','domain.js','checkout.js','terminal-storage.js',
  'terminal.js','demo-api.js','api.js','views.js','app.js','manifest.webmanifest',
  'assets/study-room.svg','assets/mark.svg','assets/app-192.png','assets/app-512.png']
  .map(path => new URL(path,self.registration.scope).href);
const allowed = new Set(urls);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheId).then(cache => cache.addAll(urls.map(url => new Request(url,{cache:'reload'})))));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(key => key.startsWith('clinch-shell-') && key !== cacheId).map(key => caches.delete(key))
  )));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return;
  const shell = event.request.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === new URL(urls[0]).pathname);
  if (!shell && !allowed.has(url.href)) return;
  event.respondWith(caches.open(cacheId).then(cache => cache.match(shell ? urls[0] : url.href))
    .then(hit => hit || fetch(event.request)));
});
