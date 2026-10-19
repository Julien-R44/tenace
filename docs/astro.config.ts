import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://tenace.julr.dev',
  integrations: [
    starlight({
      title: 'Tenace',
      description:
        'Typed, composable resilience policies for TypeScript: timeout, retry, circuit breaker, bulkhead, fallback and more.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/julien-r44/tenace' }],
      routeMiddleware: './src/route-middleware.ts',
      editLink: { baseUrl: 'https://github.com/julien-r44/tenace/edit/v2/docs/' },
      lastUpdated: true,
      logo: { src: './src/assets/logo.svg' },
      customCss: [
        '@fontsource-variable/geist',
        '@fontsource-variable/geist-mono',
        './src/styles/theme.css',
      ],
      components: {
        Header: './src/components/Header.astro',
        Hero: './src/components/Hero.astro',
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      expressiveCode: {
        themes: ['github-dark-default'],
        styleOverrides: {
          borderRadius: '0.625rem',
          borderColor: 'rgb(255 255 255 / 0.08)',
          codeBackground: '#0b0c0f',
          codeFontFamily: "'Geist Mono Variable', ui-monospace, monospace",
          codeFontSize: '0.8125rem',
          codeLineHeight: '1.7',
          uiFontFamily: "'Geist Variable', ui-sans-serif, system-ui, sans-serif",
          frames: {
            shadowColor: 'transparent',
            editorTabBarBackground: '#0b0c0f',
            editorActiveTabBackground: '#0b0c0f',
            editorActiveTabIndicatorTopColor: 'transparent',
            editorActiveTabIndicatorBottomColor: 'var(--tn-accent)',
            editorTabBarBorderBottomColor: 'rgb(255 255 255 / 0.08)',
            terminalBackground: '#0b0c0f',
            terminalTitlebarBackground: '#0b0c0f',
            terminalTitlebarBorderBottomColor: 'rgb(255 255 255 / 0.08)',
            frameBoxShadowCssValue: 'none',
          },
        },
      },
      sidebar: [
        {
          label: 'Start here',
          items: ['getting-started'],
        },
        {
          label: 'Concepts',
          items: [
            'concepts/strategy-order',
            'concepts/execute-and-settle',
            'concepts/typed-errors',
            'concepts/reusable-and-bound-policies',
            'concepts/composition',
            'concepts/cancellation',
          ],
        },
        {
          label: 'Strategies',
          items: [
            'strategies/timeout',
            'strategies/retry',
            'strategies/circuit-breaker',
            'strategies/bulkhead',
            'strategies/fallback',
            'strategies/rate-limit',
            'strategies/lock',
            'strategies/dedupe',
            'strategies/cache',
            'strategies/stale-fallback',
            'strategies/chaos',
          ],
        },
        {
          label: 'Guides',
          items: [
            'guides/batches',
            'guides/keys-and-adapters',
            'guides/testing',
            'guides/custom-strategies',
            'guides/custom-result-types',
          ],
        },
        {
          label: 'Observability',
          items: [
            'observability/instrumentation',
            'observability/diagnostics-channel',
            'observability/opentelemetry',
          ],
        },
        {
          label: 'Reference',
          items: ['reference/api', 'reference/errors', 'reference/events', 'reference/runtimes'],
        },
      ],
    }),
  ],
})
