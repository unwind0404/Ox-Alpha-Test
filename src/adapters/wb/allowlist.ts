// WB API allowlist. Только production и sandbox домены.
// Если URL не из этого списка — throw.

const ALLOWED_HOSTS = new Set([
  'feedbacks-api.wildberries.ru',
  'feedbacks-api-sandbox.wildberries.ru',
])

export function isAllowedWbHost(host: string): boolean {
  return ALLOWED_HOSTS.has(host)
}

export function assertAllowedWbUrl(url: string): void {
  const u = new URL(url)
  if (!isAllowedWbHost(u.host)) {
    throw new Error(`WB host not in allowlist: ${u.host}. Allowed: ${[...ALLOWED_HOSTS].join(', ')}`)
  }
}
