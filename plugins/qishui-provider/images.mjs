export function imageUrl(value) {
  if (!value) return ''
  if (typeof value === 'string') return /^https?:\/\//i.test(value) ? value : ''
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const url = imageUrl(candidate)
      if (url) return url
    }
    return ''
  }
  if (typeof value !== 'object') return ''
  const uri = typeof value.uri === 'string' ? value.uri : ''
  for (const candidate of value.urls || []) {
    const base = imageUrl(candidate)
    if (!base) continue
    if (!new URL(base).pathname.endsWith('/')) return base
    if (!uri) continue
    if (imageUrl(uri)) return uri
    const url = new URL(uri.replace(/^\/+/, ''), base)
    if (!url.pathname.includes('~')) {
      url.pathname += '~c5_500x500.jpg'
    }
    return url.href
  }
  return imageUrl(value.url) || imageUrl(uri)
}
