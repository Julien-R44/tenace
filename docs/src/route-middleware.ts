import { defineRouteMiddleware } from '@astrojs/starlight/route-data'

// Points every page at its generated Open Graph image, see src/pages/og/[...slug].png.ts
export const onRequest = defineRouteMiddleware(context => {
  const { entry, head } = context.locals.starlightRoute
  // The 404 page has no image of its own, it shares the landing one
  const slug = entry.id === '404' ? 'index' : entry.id
  const image = new URL(`/og/${slug}.png`, context.site).href
  head.push(
    { tag: 'meta', attrs: { property: 'og:image', content: image } },
    { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
    { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
    { tag: 'meta', attrs: { name: 'twitter:image', content: image } },
  )
})
