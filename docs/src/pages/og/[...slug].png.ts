import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import type { APIRoute, GetStaticPaths } from 'astro'
import { getCollection, type CollectionEntry } from 'astro:content'
import satori from 'satori'

const WIDTH = 1200
const HEIGHT = 630

const SECTIONS: Record<string, string> = {
  concepts: 'Concepts',
  guides: 'Guides',
  observability: 'Observability',
  reference: 'Reference',
  strategies: 'Strategies',
}

const require = createRequire(import.meta.url)
const font = (name: string) => readFile(require.resolve(name))
// Read from the project root, this module is bundled elsewhere at build time
const asset = (name: string) => readFile(join(process.cwd(), 'src/assets', name))

const [sans500, sans600, mono500, background, logo] = await Promise.all([
  font('@fontsource/geist/files/geist-latin-500-normal.woff'),
  font('@fontsource/geist/files/geist-latin-600-normal.woff'),
  font('@fontsource/geist-mono/files/geist-mono-latin-500-normal.woff'),
  asset('og-background.png'),
  asset('logo.svg'),
])

const dataUri = (type: string, data: Buffer) => `data:${type};base64,${data.toString('base64')}`

type Node = { type: string; props: Record<string, unknown> }
const h = (type: string, style: Record<string, unknown>, ...children: unknown[]): Node => ({
  type,
  props: { style, children },
})
const img = (src: string, style: Record<string, unknown>): Node => ({
  type: 'img',
  props: { src, width: style['width'], height: style['height'], style },
})

export const getStaticPaths = (async () => {
  const entries = await getCollection('docs')
  return entries.map(entry => ({ params: { slug: entry.id }, props: { entry } }))
}) satisfies GetStaticPaths

export const GET: APIRoute<{ entry: CollectionEntry<'docs'> }> = async ({ props }) => {
  const { entry } = props
  const isLanding = entry.id === 'index'
  // The landing headline keeps the line break of the hero
  const lines = isLanding ? (entry.data.hero?.title ?? '').split('<br />') : [entry.data.title]
  const title = lines.join(' ')
  const description = isLanding ? entry.data.hero?.tagline : entry.data.description
  const section = isLanding ? 'Docs' : (SECTIONS[entry.id.split('/')[0]!] ?? 'Docs')

  const svg = await satori(
    h(
      'div',
      {
        position: 'relative',
        display: 'flex',
        width: '100%',
        height: '100%',
        backgroundColor: '#07080a',
        fontFamily: 'Geist',
        color: '#f4f4f5',
      },
      img(dataUri('image/png', background), {
        position: 'absolute',
        inset: 0,
        width: WIDTH,
        height: HEIGHT,
        opacity: 0.85,
      }),
      // Keeps the text side dark enough to read over the dither
      h('div', {
        position: 'absolute',
        inset: 0,
        backgroundImage:
          'linear-gradient(90deg, #07080a 0%, #07080a 38%, rgba(7, 8, 10, 0.55) 66%, rgba(7, 8, 10, 0) 92%)',
      }),
      h(
        'div',
        {
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '100%',
          padding: '64px 72px',
        },
        h(
          'div',
          { display: 'flex', alignItems: 'center', gap: 16 },
          img(dataUri('image/svg+xml', logo), { width: 32, height: 32 }),
          h('div', { fontSize: 30, fontWeight: 600, letterSpacing: '-0.02em' }, 'Tenace'),
        ),
        h(
          'div',
          { display: 'flex', flexDirection: 'column', maxWidth: 760 },
          h(
            'div',
            {
              fontFamily: 'Geist Mono',
              fontSize: 20,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: '#8b8cff',
              marginBottom: 20,
            },
            section,
          ),
          h(
            'div',
            {
              display: 'flex',
              flexDirection: 'column',
              fontSize: title.length > 28 ? 68 : 80,
              fontWeight: 600,
              lineHeight: 1.04,
              letterSpacing: '-0.04em',
            },
            ...lines.map(line => h('div', {}, line)),
          ),
          description
            ? h(
                'div',
                {
                  marginTop: 24,
                  fontSize: 26,
                  fontWeight: 500,
                  lineHeight: 1.45,
                  color: '#a1a1aa',
                  maxWidth: 700,
                  lineClamp: 3,
                },
                description,
              )
            : null,
        ),
        h(
          'div',
          { fontFamily: 'Geist Mono', fontSize: 18, color: '#71717a', letterSpacing: '0.02em' },
          'tenace.julr.dev',
        ),
      ),
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      fonts: [
        { name: 'Geist', data: sans500, weight: 500 },
        { name: 'Geist', data: sans600, weight: 600 },
        { name: 'Geist Mono', data: mono500, weight: 500 },
      ],
    },
  )

  const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng()
  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } })
}
