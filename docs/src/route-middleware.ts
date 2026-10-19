import { defineRouteMiddleware } from '@astrojs/starlight/route-data'

export const onRequest = defineRouteMiddleware(context => {
  const { entry, head } = context.locals.starlightRoute
  // The landing has an empty id here, while the content collection calls it "index"
  const id = entry.id || 'index'

  // Starlight titles pages "<page> | <site>", which reads "Tenace | Tenace" on the landing
  if (id === 'index') {
    const title = head.find(item => item.tag === 'title')
    if (title) title.content = 'Tenace: resilience policies with typed errors for TypeScript'
  }

  // Points every page at its generated Open Graph image, see src/pages/og/[...slug].png.ts.
  // The 404 page has no image of its own, it shares the landing one
  const slug = id === '404' ? 'index' : id
  const image = new URL(`/og/${slug}.png`, context.site).href
  head.push(
    { tag: 'meta', attrs: { property: 'og:image', content: image } },
    { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
    { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
    { tag: 'meta', attrs: { name: 'twitter:image', content: image } },
  )
})
