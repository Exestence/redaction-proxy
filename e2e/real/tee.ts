/**
 * A local pass-through between the proxy and a real service that records
 * what crossed the wire: the request body the service received and the
 * response body it sent back. Responses are relayed chunk by chunk, so
 * streaming reaches the proxy as the service produced it.
 *
 * @module e2e/real/tee
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { listen } from '../../src/proxy/server.ts'

/** One request the service received and its response. */
export interface Exchange {
  path: string
  requestBody: string
  responseBody: string
}

/** A running tee. */
export interface Tee {
  url: string
  /** Completed exchanges, in completion order. */
  exchanges: Exchange[]
  close(): Promise<void>
}

/** Headers that describe one connection or the body encoding; `fetch` sets its own. */
const CONNECTION_HEADERS = new Set(['host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'content-encoding'])

/**
 * Start a tee on 127.0.0.1 in front of one service.
 * @param targetBaseUrl - the service's base URL; request paths are appended to it.
 * @returns the running tee.
 */
export async function startTee(targetBaseUrl: string): Promise<Tee> {
  const exchanges: Exchange[] = []
  const server = createServer((req, res) => {
    relay(req, res, targetBaseUrl).then(exchange => exchanges.push(exchange), (error: unknown) => {
      res.destroy(error instanceof Error ? error : undefined)
    })
  })
  const port = await listen(server, 0)
  return {
    url: `http://127.0.0.1:${port}`,
    exchanges,
    close: () => new Promise(resolve => server.close(() => resolve())),
  }
}

async function relay(req: IncomingMessage, res: ServerResponse, targetBaseUrl: string): Promise<Exchange> {
  const requestBody = await readBody(req)
  const upstream = await fetch(targetBaseUrl + (req.url ?? '/'), {
    method: req.method ?? 'POST',
    headers: forwardableHeaders(req),
    ...(requestBody === '' ? {} : { body: requestBody }),
  })
  res.writeHead(upstream.status, Object.fromEntries([...upstream.headers].filter(([name]) => !CONNECTION_HEADERS.has(name))))
  let responseBody = ''
  const decoder = new TextDecoder()
  for await (const chunk of upstream.body ?? []) {
    res.write(chunk)
    responseBody += decoder.decode(chunk as Uint8Array, { stream: true })
  }
  res.end()
  return { path: req.url ?? '/', requestBody, responseBody: responseBody + decoder.decode() }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = ''
  req.setEncoding('utf8')
  for await (const part of req) body += part
  return body
}

function forwardableHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    if (!CONNECTION_HEADERS.has(name) && value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}
