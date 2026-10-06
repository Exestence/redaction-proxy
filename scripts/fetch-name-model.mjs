#!/usr/bin/env node
// Download the optional name model into a directory and write the compact tokenizer files the proxy loads.
// Usage: node scripts/fetch-name-model.mjs <dir>
// Files already present with the expected sha256 are not downloaded again. The model is
// Wismut/nym-pii-multilingual-small (MIT), edge-int8 variant, at a pinned revision.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const REPO = 'Wismut/nym-pii-multilingual-small'
const REVISION = '4348999cd3c2e20c49615e9af7c6bbb45b64cd85'
const FILES = [
  { remote: 'edge-int8/model_int8.onnx', local: 'model_int8.onnx', sha256: 'e9a3a8c8cd55b3bcf329de5a9307cfae5053ce93c00330c33facd022e60daa17' },
  { remote: 'edge-int8/config.json', local: 'config.json', sha256: '3f07065571e22bb73eba28ddb1fae4509c0cf703762e3bfa7a6ab2111cf7cb88' },
  { remote: 'edge-int8/tokenizer.json', local: 'tokenizer.json', sha256: 'c299144e68dfec1dc536204a7ae3712710c5c6cade9269a83f5042250d47d8de' },
  // The model card holds the MIT license notice; the repository has no LICENSE file.
  { remote: 'README.md', local: 'README.md', sha256: '74c55f42afcad1e5c1ea9b059f37d9d48e5641e04628642a12444721c57f3d9e' },
]

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(dir, file) {
  const target = join(dir, file.local)
  if (existsSync(target) && await sha256(target) === file.sha256) return console.log(`ok       ${file.local}`)
  const url = `https://huggingface.co/${REPO}/resolve/${REVISION}/${file.remote}`
  console.log(`download ${url}`)
  const response = await fetch(url)
  if (!response.ok || response.body === null) throw new Error(`${url}: HTTP ${response.status}`)
  const partial = `${target}.partial`
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial))
  const actual = await sha256(partial)
  if (actual !== file.sha256) throw new Error(`${file.remote}: sha256 ${actual}, expected ${file.sha256}`)
  await rename(partial, target)
}

// Merges holding a space or a newline never apply: the normalizer turns every space into '▁' and every newline is
// an added token cut out before BPE. Leaving them out keeps merges.txt one space-separated pair per line.
async function writeCompactTokenizer(dir) {
  const tokenizer = JSON.parse(await readFile(join(dir, 'tokenizer.json'), 'utf8'))
  const merges = tokenizer.model.merges.filter(([left, right]) => !/[ \n]/.test(left + right))
  await writeFile(join(dir, 'vocab.json'), JSON.stringify(tokenizer.model.vocab))
  await writeFile(join(dir, 'merges.txt'), `#version: 0.2\n${merges.map(pair => pair.join(' ')).join('\n')}\n`)
  await writeFile(join(dir, 'added_tokens.json'), JSON.stringify(tokenizer.added_tokens))
  console.log('wrote    vocab.json, merges.txt, added_tokens.json')
}

const dir = process.argv[2]
if (dir === undefined) {
  console.error('usage: node scripts/fetch-name-model.mjs <dir>')
  process.exit(2)
}
await mkdir(resolve(dir), { recursive: true })
for (const file of FILES) await download(resolve(dir), file)
await writeCompactTokenizer(resolve(dir))
console.log(`set "nameModel": { "dir": "${resolve(dir)}" } in the proxy config`)
