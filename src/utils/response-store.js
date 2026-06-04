const fs = require('fs')
const path = require('path')
const redisClient = require('./redis-client.js')

const DEFAULT_RESPONSE_STORE_TTL_MS = 30 * 60 * 1000
const DEFAULT_RESPONSE_STORE_FILE = path.join(__dirname, '../../data/responses-store.json')
const REDIS_RESPONSE_STORE_KEY = 'qwen2api:responses'

function normalizeStoreEntryMap(rawEntries) {
  if (!rawEntries || typeof rawEntries !== 'object') return new Map()
  const entries = rawEntries instanceof Map ? [...rawEntries.entries()] : Object.entries(rawEntries)
  return new Map(entries.filter(([key, value]) => key && value && typeof value === 'object'))
}

function sanitizeStoreEntry(value) {
  if (!value || typeof value !== 'object') return null
  if (!value.response || typeof value.response !== 'object' || !value.response.id) return null
  return {
    owner: typeof value.owner === 'string' ? value.owner : '__anonymous__',
    response: value.response,
    expiresAt: Number.isFinite(value.expiresAt) ? value.expiresAt : 0,
  }
}

function readFileStore(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return new Map()
    }
    const raw = fs.readFileSync(filePath, 'utf-8')
    if (!raw.trim()) return new Map()
    const parsed = JSON.parse(raw)
    return normalizeStoreEntryMap(parsed.entries)
  } catch {
    return new Map()
  }
}

function writeFileStore(filePath, store) {
  const dirPath = path.dirname(filePath)
  fs.mkdirSync(dirPath, { recursive: true })
  const entries = {}
  for (const [key, value] of store.entries()) {
    const sanitized = sanitizeStoreEntry(value)
    if (sanitized) {
      entries[key] = sanitized
    }
  }
  fs.writeFileSync(filePath, JSON.stringify({ entries }, null, 2), 'utf-8')
}

function normalizeResponseStoreBackend(backend) {
  return backend === 'file' || backend === 'redis' ? backend : 'memory'
}

function readRedisStore(key) {
  return redisClient.getJSON(key)
}

function writeRedisStore(key, store) {
  const entries = {}
  for (const [entryKey, value] of store.entries()) {
    const sanitized = sanitizeStoreEntry(value)
    if (sanitized) {
      entries[entryKey] = sanitized
    }
  }
  return redisClient.setJSON(key, { entries })
}

function createInMemoryResponseStore(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs
    : DEFAULT_RESPONSE_STORE_TTL_MS
  const store = options.store instanceof Map ? options.store : new Map()
  const ownerResolver = typeof options.ownerResolver === 'function'
    ? options.ownerResolver
    : ((req) => req?.apiKey || '__anonymous__')

  function ownerOf(req) {
    return ownerResolver(req)
  }

  function prune() {
    const now = Date.now()
    for (const [key, value] of store.entries()) {
      if (!value || value.expiresAt <= now) {
        store.delete(key)
      }
    }
  }

  function save(req, responseObject) {
    if (!responseObject?.id) return responseObject
    prune()
    store.set(responseObject.id, {
      owner: ownerOf(req),
      response: responseObject,
      expiresAt: Date.now() + ttlMs,
    })
    return responseObject
  }

  function get(req, responseId) {
    prune()
    const stored = store.get(responseId)
    if (!stored) return { status: 404, response: null }
    if (stored.owner !== ownerOf(req)) {
      return { status: 404, response: null }
    }
    return { status: 200, response: stored.response }
  }

  function remove(req, responseId) {
    prune()
    const stored = store.get(responseId)
    if (!stored) return { status: 404 }
    if (stored.owner !== ownerOf(req)) {
      return { status: 404 }
    }
    store.delete(responseId)
    return { status: 200 }
  }

  function list(req, query = {}) {
    prune()
    const owner = ownerOf(req)
    const maxLimit = 100
    const rawLimit = Number.parseInt(query.limit, 10)
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), maxLimit) : 20
    const after = typeof query.after === 'string' && query.after.trim() ? query.after.trim() : null
    const before = typeof query.before === 'string' && query.before.trim() ? query.before.trim() : null
    const rawOrder = typeof query.order === 'string' ? query.order.trim().toLowerCase() : ''
    const order = rawOrder === 'asc' ? 'asc' : 'desc'
    const rawStatus = typeof query.status === 'string' ? query.status.trim().toLowerCase() : ''
    const status = rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'in_progress' || rawStatus === 'cancelled' || rawStatus === 'incomplete'
      ? rawStatus
      : null

    if (after && before) {
      return {
        status: 400,
        error: {
          message: 'Query parameters after and before are mutually exclusive',
          type: 'invalid_request_error',
        }
      }
    }

    const items = [...store.values()]
      .filter((entry) => entry && entry.owner === owner && entry.response)
      .map((entry) => entry.response)
      .filter((response) => !status || String(response?.status || '').toLowerCase() === status)
      .sort((a, b) => {
        const createdA = Number(a?.created_at || 0)
        const createdB = Number(b?.created_at || 0)
        if (createdA !== createdB) return order === 'asc' ? createdA - createdB : createdB - createdA
        const byId = String(a?.id || '').localeCompare(String(b?.id || ''))
        return order === 'asc' ? byId : -byId
      })

    let startIndex = 0
    let endIndex = items.length
    if (after) {
      const cursorIndex = items.findIndex((item) => item?.id === after)
      startIndex = cursorIndex >= 0 ? cursorIndex + 1 : items.length
    } else if (before) {
      const cursorIndex = items.findIndex((item) => item?.id === before)
      if (cursorIndex >= 0) {
        endIndex = cursorIndex
        startIndex = Math.max(endIndex - limit, 0)
      } else {
        startIndex = items.length
        endIndex = items.length
      }
    }

    const page = before
      ? items.slice(startIndex, endIndex)
      : items.slice(startIndex, startIndex + limit)

    const hasMore = before
      ? startIndex > 0
      : startIndex + limit < items.length

    return {
      status: 200,
      object: 'list',
      data: page,
      first_id: page[0]?.id || null,
      last_id: page[page.length - 1]?.id || null,
      has_more: hasMore,
    }
  }

  return {
    ttlMs,
    store,
    ownerOf,
    prune,
    save,
    get,
    remove,
    list,
  }
}

function createFileResponseStore(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs
    : DEFAULT_RESPONSE_STORE_TTL_MS
  const filePath = typeof options.filePath === 'string' && options.filePath.trim()
    ? options.filePath.trim()
    : DEFAULT_RESPONSE_STORE_FILE
  const ownerResolver = typeof options.ownerResolver === 'function'
    ? options.ownerResolver
    : ((req) => req?.apiKey || '__anonymous__')

  function ownerOf(req) {
    return ownerResolver(req)
  }

  function loadStore() {
    return readFileStore(filePath)
  }

  function persistStore(store) {
    writeFileStore(filePath, store)
  }

  function prune() {
    const store = loadStore()
    const now = Date.now()
    let changed = false
    for (const [key, value] of store.entries()) {
      const sanitized = sanitizeStoreEntry(value)
      if (!sanitized || sanitized.expiresAt <= now) {
        store.delete(key)
        changed = true
      } else if (sanitized !== value) {
        store.set(key, sanitized)
        changed = true
      }
    }
    if (changed) {
      persistStore(store)
    }
    return store
  }

  function save(req, responseObject) {
    if (!responseObject?.id) return responseObject
    const store = prune()
    store.set(responseObject.id, {
      owner: ownerOf(req),
      response: responseObject,
      expiresAt: Date.now() + ttlMs,
    })
    persistStore(store)
    return responseObject
  }

  function get(req, responseId) {
    const store = prune()
    const stored = sanitizeStoreEntry(store.get(responseId))
    if (!stored) return { status: 404, response: null }
    if (stored.owner !== ownerOf(req)) {
      return { status: 404, response: null }
    }
    return { status: 200, response: stored.response }
  }

  function remove(req, responseId) {
    const store = prune()
    const stored = sanitizeStoreEntry(store.get(responseId))
    if (!stored) return { status: 404 }
    if (stored.owner !== ownerOf(req)) {
      return { status: 404 }
    }
    store.delete(responseId)
    persistStore(store)
    return { status: 200 }
  }

  function list(req, query = {}) {
    const store = prune()
    return createInMemoryResponseStore({ ttlMs, store, ownerResolver }).list(req, query)
  }

  return {
    backend: 'file',
    ttlMs,
    filePath,
    ownerOf,
    prune,
    save,
    get,
    remove,
    list,
  }
}

function createRedisResponseStore(options = {}) {
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
    ? options.ttlMs
    : DEFAULT_RESPONSE_STORE_TTL_MS
  const redisKey = typeof options.redisKey === 'string' && options.redisKey.trim()
    ? options.redisKey.trim()
    : REDIS_RESPONSE_STORE_KEY
  const ownerResolver = typeof options.ownerResolver === 'function'
    ? options.ownerResolver
    : ((req) => req?.apiKey || '__anonymous__')

  function ownerOf(req) {
    return ownerResolver(req)
  }

  async function loadStore() {
    const raw = await readRedisStore(redisKey)
    if (!raw || typeof raw !== 'object') {
      return new Map()
    }
    return normalizeStoreEntryMap(raw.entries)
  }

  async function persistStore(store) {
    return writeRedisStore(redisKey, store)
  }

  async function prune() {
    const store = await loadStore()
    const now = Date.now()
    let changed = false
    for (const [key, value] of store.entries()) {
      const sanitized = sanitizeStoreEntry(value)
      if (!sanitized || sanitized.expiresAt <= now) {
        store.delete(key)
        changed = true
      } else if (sanitized !== value) {
        store.set(key, sanitized)
        changed = true
      }
    }
    if (changed) {
      await persistStore(store)
    }
    return store
  }

  async function save(req, responseObject) {
    if (!responseObject?.id) return responseObject
    const store = await prune()
    store.set(responseObject.id, {
      owner: ownerOf(req),
      response: responseObject,
      expiresAt: Date.now() + ttlMs,
    })
    await persistStore(store)
    return responseObject
  }

  async function get(req, responseId) {
    const store = await prune()
    const stored = sanitizeStoreEntry(store.get(responseId))
    if (!stored) return { status: 404, response: null }
    if (stored.owner !== ownerOf(req)) {
      return { status: 404, response: null }
    }
    return { status: 200, response: stored.response }
  }

  async function remove(req, responseId) {
    const store = await prune()
    const stored = sanitizeStoreEntry(store.get(responseId))
    if (!stored) return { status: 404 }
    if (stored.owner !== ownerOf(req)) {
      return { status: 404 }
    }
    store.delete(responseId)
    await persistStore(store)
    return { status: 200 }
  }

  async function list(req, query = {}) {
    const store = await prune()
    return createInMemoryResponseStore({ ttlMs, store, ownerResolver }).list(req, query)
  }

  return {
    backend: 'redis',
    ttlMs,
    redisKey,
    ownerOf,
    prune,
    save,
    get,
    remove,
    list,
  }
}

function createResponseStore(options = {}) {
  const backend = normalizeResponseStoreBackend(options.backend)
  if (backend === 'file') {
    return createFileResponseStore(options)
  }
  if (backend === 'redis') {
    return createRedisResponseStore(options)
  }
  return {
    backend: 'memory',
    ...createInMemoryResponseStore(options),
  }
}

module.exports = {
  DEFAULT_RESPONSE_STORE_TTL_MS,
  DEFAULT_RESPONSE_STORE_FILE,
  REDIS_RESPONSE_STORE_KEY,
  normalizeResponseStoreBackend,
  createInMemoryResponseStore,
  createFileResponseStore,
  createRedisResponseStore,
  createResponseStore,
}
