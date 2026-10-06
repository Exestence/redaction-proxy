// Renders docs/media/before-after.png and docs/media/intro.{mp4,gif} from
// captured.json with Playwright and ffmpeg. Neither is a repository
// dependency; pass their locations in:
//
//   PLAYWRIGHT=/path/to/node_modules/playwright FFMPEG=/path/to/ffmpeg node docs/media/src/render.mjs
//
// Without a global install: `npm i playwright@1.62.1` in a scratch folder
// outside the repository (1.62.1 drives Chromium build 1234; run
// `npx playwright install chromium` there for another version), and
// FFMPEG=$(uvx --from imageio-ffmpeg python -c 'import imageio_ffmpeg as i; print(i.get_ffmpeg_exe())').
// Run capture.mjs first when the proxy's output changes.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { PLAYWRIGHT, FFMPEG } = process.env
if (!PLAYWRIGHT || !FFMPEG) throw new Error('set PLAYWRIGHT (playwright package directory) and FFMPEG (ffmpeg binary)')
const { chromium } = (await import(pathToFileURL(join(PLAYWRIGHT, 'index.js')).href)).default

const src = fileURLToPath(new URL('.', import.meta.url))
const media = join(src, '..')
const captured = readFileSync(join(src, 'captured.json'), 'utf8')
const inject = `window.CAPTURED = ${captured}`

const browser = await chromium.launch()

// Before/after screenshot at 2x for sharp text.
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: 2 })
  await page.addInitScript(inject)
  await page.goto(pathToFileURL(join(src, 'before-after.html')).href)
  await page.locator('main').screenshot({ path: join(media, 'before-after.png') })
  await page.close()
}

// Intro video: the page plays itself and sets window.done at the end.
const videoDir = mkdtempSync(join(tmpdir(), 'redaction-intro-'))
{
  const size = { width: 1280, height: 720 }
  const context = await browser.newContext({ viewport: size, recordVideo: { dir: videoDir, size } })
  const page = await context.newPage()
  await page.addInitScript(inject)
  await page.goto(pathToFileURL(join(src, 'intro.html')).href)
  await page.waitForFunction(() => window.done, null, { timeout: 120_000, polling: 200 })
  await context.close()
}
await browser.close()

const webm = join(videoDir, readdirSync(videoDir).find(name => name.endsWith('.webm')))
const mp4 = join(media, 'intro.mp4')
const gif = join(media, 'intro.gif')
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-ss', '0.4', '-i', webm,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', '-an', mp4])
execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-i', mp4, '-vf',
  'fps=8,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
  gif])
rmSync(videoDir, { recursive: true, force: true })

for (const file of ['before-after.png', 'intro.mp4', 'intro.gif']) {
  console.log(`${file}: ${(statSync(join(media, file)).size / 1024).toFixed(0)} KB`)
}
