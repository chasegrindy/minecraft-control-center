const overview = '/?mode=live#observatory/overview'

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))

self.addEventListener('push', (event) => {
  let message
  try { message = event.data?.json()?.notification } catch { /* Use the visible fallback. */ }
  const test = message?.tag === 'mcc-test'
  event.waitUntil(self.registration.showNotification('Minecraft Control Center', {
    body: typeof message?.body === 'string' ? message.body.slice(0, 160) : 'Sprawdź status serwera w MCC.',
    icon: '/favicon.png',
    lang: 'pl',
    tag: test ? 'mcc-test' : 'mcc-status',
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil((async () => {
    const target = new URL(overview, self.location.origin).href
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    const open = windows.find((client) => client.url === target)
    if (open) await open.focus()
    else await self.clients.openWindow(target)
  })())
})
