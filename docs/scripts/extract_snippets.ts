/**
 * Writes every TypeScript code block of the docs and the READMEs to `.snippets/`, one module per block, so
 * `tsc -p tsconfig.snippets.json` typechecks them against the package sources. Names the
 * snippets use without defining them, such as `getUser`, are declared in `snippets.d.ts`.
 *
 * Blocks indented inside lists are dedented. A block whose meta contains `nocheck`
 * (```ts nocheck) is skipped, for fragments that are not valid on their own. A generated
 * file is named after its page and the line of its opening fence:
 * `.snippets/strategies/retry.md.L42.ts` is the block at line 42 of `strategies/retry.md`.
 * The READMEs of the repository are checked too, under `.snippets/readmes/`.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const contentDir = fileURLToPath(new URL('../src/content/docs/', import.meta.url))
const outDir = fileURLToPath(new URL('../.snippets/', import.meta.url))
const repoDir = fileURLToPath(new URL('../../', import.meta.url))
const READMES = ['README.md', 'packages/tenace/README.md', 'packages/tenace-otel/README.md']
const FENCE = /^( *)```(?:ts|typescript)\b([^\n]*)\n([\s\S]*?)^\1```$/gm

await rm(outDir, { recursive: true, force: true })

let written = 0

/**
 * Writes the TypeScript blocks of `source` to `.snippets/<name>.L<line>.ts`.
 */
async function extract(source: string, name: string): Promise<void> {
  for (const block of source.matchAll(FENCE)) {
    const [, indent = '', meta = '', code = ''] = block
    if (/\bnocheck\b/.test(meta)) continue

    const line = source.slice(0, block.index).split('\n').length
    const file = join(outDir, `${name}.L${line}.ts`)
    await mkdir(dirname(file), { recursive: true })
    const dedented = code.replaceAll(new RegExp(`^${indent}`, 'gm'), '')
    await writeFile(file, `${dedented}\nexport {}\n`)
    written++
  }
}

const pages = await readdir(contentDir, { recursive: true })
for (const page of pages.filter(file => /\.mdx?$/.test(file)).toSorted()) {
  await extract(await readFile(join(contentDir, page), 'utf8'), page)
}

for (const readme of READMES) {
  await extract(await readFile(join(repoDir, readme), 'utf8'), join('readmes', readme))
}

process.stdout.write(`Extracted ${written} snippets to .snippets/\n`)
