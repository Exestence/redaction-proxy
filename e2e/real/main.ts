/**
 * Real-service harness entry point: `pnpm run e2e:real`. Runs every service
 * whose key is set, skips the others, and exits non-zero when a scenario fails
 * or errors. Prints scenario outcomes only, never a key or a prompt.
 *
 * @module e2e/real/main
 */

import { runProvider } from './harness.ts'
import type { CaseResult } from './harness.ts'
import { PROVIDERS } from './providers.ts'

const results: CaseResult[] = []
for (const provider of PROVIDERS) {
  const providerResults = await runProvider(provider, process.env)
  if (providerResults.length === 0) console.log(`skip  ${provider.name}: ${provider.keyVariable} is not set`)
  for (const result of providerResults) console.log(`${result.status.padEnd(12)} ${result.provider} ${result.scenario}: ${result.detail}`)
  results.push(...providerResults)
}
const failed = results.filter(result => result.status === 'fail' || result.status === 'error')
console.log(`\n${results.length - failed.length} of ${results.length} scenarios without failure`)
process.exitCode = failed.length === 0 ? 0 : 1
