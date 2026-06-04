#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:17860'

const args = new Set(process.argv.slice(2))
const fullMode = args.has('--full')
const streamMode = args.has('--stream')
const helpMode = args.has('--help') || args.has('-h')

const baseUrl = (process.env.SMOKE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
const apiKey = process.env.SMOKE_API_KEY || process.env.API_KEY || ''
const model = process.env.SMOKE_MODEL || process.env.DEFAULT_MODEL || 'qwen3.6-plus'
const timeoutMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || '30000', 10)

function printHelp() {
  console.log(`Usage: npm run smoke:gray -- [--full] [--stream]\n\nEnvironment:\n  SMOKE_BASE_URL       Base URL to test. Default: ${DEFAULT_BASE_URL}\n  SMOKE_API_KEY        API key for protected endpoints. Falls back to API_KEY.\n  SMOKE_MODEL          Model for full chat/responses tests. Default: qwen3.6-plus\n  SMOKE_TIMEOUT_MS     Per-request timeout. Default: 30000\n\nModes:\n  default              Test /health, /v1/models, GET+POST /cli/v1/models.\n  --full               Also test non-stream /v1/chat/completions and /v1/responses.\n  --stream             Also test streaming chat/responses SSE endpoints.\n`)
}

function authHeaders(extra = {}) {
  return apiKey ? { ...extra, Authorization: `Bearer ${apiKey}` } : extra
}

async function requestJSON(label, path, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.headers || {}),
      },
    })
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch (_) {
      body = text
    }
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
    }
    return { label, status: response.status, ms: Date.now() - started, body }
  } finally {
    clearTimeout(timer)
  }
}

async function requestSSE(label, path, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.headers || {}),
      },
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}: ${text}`)
    }
    const events = parseSSE(text)
    if (!events.some(event => event.data === '[DONE]')) {
      throw new Error(`${label}: expected SSE [DONE] marker`)
    }
    return { label, status: response.status, ms: Date.now() - started, events, text }
  } finally {
    clearTimeout(timer)
  }
}

function parseSSE(text) {
  return String(text || '')
    .split(/\n\n+/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => {
      const event = { event: null, data: '' }
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event.event = line.slice('event:'.length).trim()
        if (line.startsWith('data:')) {
          const data = line.slice('data:'.length).trimStart()
          event.data = event.data ? `${event.data}\n${data}` : data
        }
      }
      return event
    })
}

function assertObject(result, message) {
  if (!result || typeof result.body !== 'object' || Array.isArray(result.body)) {
    throw new Error(`${message}: expected JSON object`)
  }
}

function assertModelList(result, label) {
  assertObject(result, label)
  if (result.body.object !== 'list' || !Array.isArray(result.body.data)) {
    throw new Error(`${label}: expected object=list with data array`)
  }
}

async function run() {
  if (helpMode) {
    printHelp()
    return
  }

  console.log(`Gray smoke target: ${baseUrl}`)
  console.log(`Mode: ${fullMode ? 'full' : 'quick'}${streamMode ? '+stream' : ''}`)
  if (!apiKey) {
    console.log('No SMOKE_API_KEY/API_KEY provided; protected endpoint checks will be skipped.')
  }

  const results = []
  const health = await requestJSON('health', '/health')
  assertObject(health, 'health')
  if (health.body.status !== 'ok') {
    throw new Error(`health: expected status=ok, got ${JSON.stringify(health.body.status)}`)
  }
  results.push(health)

  if (apiKey) {
    const models = await requestJSON('models', '/v1/models', {
      headers: authHeaders(),
    })
    assertModelList(models, 'models')
    results.push(models)

    const cliModelsGet = await requestJSON('cli models get', '/cli/v1/models', {
      headers: authHeaders(),
    })
    assertModelList(cliModelsGet, 'cli models get')
    results.push(cliModelsGet)

    const cliModelsPost = await requestJSON('cli models post', '/cli/v1/models', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
    })
    assertModelList(cliModelsPost, 'cli models post')
    results.push(cliModelsPost)

    if (fullMode) {
      const chat = await requestJSON('chat completions', '/v1/chat/completions', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: 'user', content: 'Reply with ok.' }],
        }),
      })
      assertObject(chat, 'chat completions')
      if (!Array.isArray(chat.body.choices)) {
        throw new Error('chat completions: expected choices array')
      }
      results.push(chat)

      const responses = await requestJSON('responses', '/v1/responses', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          model,
          input: 'Reply with ok.',
          stream: false,
          metadata: { smoke: 'gray' },
        }),
      })
      assertObject(responses, 'responses')
      if (responses.body.object !== 'response' || responses.body.status !== 'completed') {
        throw new Error(`responses: expected completed response, got ${JSON.stringify(responses.body)}`)
      }
      results.push(responses)
    }

    if (streamMode) {
      const chatStream = await requestSSE('chat completions stream', '/v1/chat/completions', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          model,
          stream: true,
          messages: [{ role: 'user', content: 'Reply with ok.' }],
        }),
      })
      const hasChatChunk = chatStream.events.some(event => {
        if (event.data === '[DONE]') return false
        try {
          const payload = JSON.parse(event.data)
          return Array.isArray(payload.choices)
        } catch (_) {
          return false
        }
      })
      if (!hasChatChunk) {
        throw new Error('chat completions stream: expected at least one choices chunk')
      }
      results.push(chatStream)

      const responsesStream = await requestSSE('responses stream', '/v1/responses', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          model,
          input: 'Reply with ok.',
          stream: true,
          metadata: { smoke: 'gray-stream' },
        }),
      })
      const responseEvents = new Set(responsesStream.events.map(event => event.event).filter(Boolean))
      if (!responseEvents.has('response.created') || !responseEvents.has('response.completed')) {
        throw new Error(`responses stream: expected response.created and response.completed, got ${Array.from(responseEvents).join(',')}`)
      }
      results.push(responsesStream)
    }
  }

  for (const result of results) {
    console.log(`PASS ${result.label} (${result.status}, ${result.ms}ms)`)
  }
}

run().catch((error) => {
  console.error(`FAIL ${error && error.message ? error.message : error}`)
  process.exit(1)
})
