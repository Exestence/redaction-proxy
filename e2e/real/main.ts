/**
 * Real-service harness entry point: `pnpm run e2e:real`. Runs every service
 * whose key is set, skips the others, and exits non-zero when a service ran but
 * no scenario passed or one failed or errored. With no key set it exits 0. Prints scenario outcomes only, never a key or a prompt.
 *
 * @module e2e/real/main
 */

import { isSuccessfulRun, runProvider } from './harness.ts'
import type { CaseResult } from './harness.ts'
import { PROVIDERS } from './providers.ts'

const results: CaseResult[] = []
for (const provider of PROVIDERS) {
  const providerResults = await runProvider(provider, process.env)
  if (providerResults.length === 0) console.log(`skip  ${provider.name}: ${provider.keyVariable} is not set`)
  for (const result of providerResults) console.log(`${result.status.padEnd(12)} ${result.provider} ${result.scenario}: ${result.detail}`)
  results.push(...providerResults)
}
const countOf = (status: CaseResult['status']): number => results.filter(result => result.status === status).length
console.log(`\n${countOf('pass')} passed, ${countOf('inconclusive')} inconclusive, ${countOf('fail')} failed, ${countOf('error')} errored`)
process.exitCode = results.length === 0 || isSuccessfulRun(results) ? 0 : 1
