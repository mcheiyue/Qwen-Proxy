const express = require('express')
const bodyParser = require('body-parser')
const crypto = require('crypto')
const config = require('./config/index.js')
const cors = require('cors')
const { logger } = require('./utils/logger')
const { initSsxmodManager, getCookies } = require('./utils/ssxmod-manager')
const { buildReadinessPayload } = require('./utils/readiness')
// Single source of truth for the version string. Bumping this in the
// root package.json automatically (a) triggers the release.yml workflow
// because it watches paths: package.json, and (b) gets baked into the
// frontend bundle by Vite's define hook in webui/vite.config.js.
const pkg = require('../package.json')

const modelsRouter = require('./routes/models.js')
const chatRouter = require('./routes/chat.js')
const verifyRouter = require('./routes/verify.js')
const accountsRouter = require('./routes/accounts.js')
const vercelRouter = require('./routes/vercel.js')
const anthropicRouter = require('./routes/anthropic.js')
const geminiRouter = require('./routes/gemini.js')
const responsesRouter = require('./routes/responses.js')
const accountManager = require('./utils/account')

function createRequestId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function summarizeProxyPool() {
  const proxies = typeof accountManager.getProxyStatus === 'function'
    ? accountManager.getProxyStatus()
    : []

  const summary = {
    enabled: Array.isArray(config.proxies) && config.proxies.length > 0,
    total: 0,
    available: 0,
    failed: 0,
    untested: 0,
    assigned_accounts: 0,
  }

  if (!Array.isArray(proxies) || proxies.length === 0) {
    return summary
  }

  summary.total = proxies.length
  for (const proxy of proxies) {
    const status = String(proxy?.status || '').toLowerCase()
    if (status === 'available') summary.available += 1
    else if (status === 'failed') summary.failed += 1
    else summary.untested += 1

    if (Array.isArray(proxy?.assignedAccounts)) {
      summary.assigned_accounts += proxy.assignedAccounts.length
    }
  }

  return summary
}

function shouldLogRequest(req) {
  const path = req.originalUrl || req.url || ''
  if (path === '/' || path === '/health') {
    return false
  }
  if (!path.startsWith('/v1/') && !path.startsWith('/v1beta/') && !path.startsWith('/api/') && !path.startsWith('/anthropic/')) {
    return false
  }
  return true
}

function buildHealthPayload() {
  const responseStoreStatus = typeof responsesRouter.getResponseStoreStatus === 'function'
    ? responsesRouter.getResponseStoreStatus()
    : {
        backend: config.responsesStoreBackend,
        ttl_seconds: config.responsesStoreTtlSeconds,
        file_path: config.responsesStoreBackend === 'file' ? config.responsesStoreFile : null,
        redis_key: config.responsesStoreBackend === 'redis' ? config.responsesStoreRedisKey : null,
      }

  return {
    status: 'ok',
    service: 'qwen-proxy',
    version: pkg.version,
    isVercel: config.isServerless,
    defaultModel: config.defaultModel,
    request_id_header: 'x-request-id',
    persistence: {
      data_save_mode: config.dataSaveMode,
    },
    proxy_pool: summarizeProxyPool(),
    features: {
      responses_api: config.enableResponsesApi,
      cli_api: config.enableCliApi,
    },
    responses: {
      enabled: config.enableResponsesApi,
      store: responseStoreStatus,
    },
  }
}

function buildErrorPayload(req, message, code = null) {
  const payload = {
    error: message,
    request_id: req?.requestId || null,
  }
  if (code) {
    payload.code = code
  }
  return payload
}

const app = express()

// Initialize SSXMOD Cookie manager
initSsxmodManager()

app.use(bodyParser.json({ limit: '128mb' }))
app.use(bodyParser.urlencoded({ limit: '128mb', extended: true }))
app.use(cors())
app.use((req, res, next) => {
  const incomingRequestId = typeof req.headers['x-request-id'] === 'string' && req.headers['x-request-id'].trim()
    ? req.headers['x-request-id'].trim()
    : null
  req.requestId = incomingRequestId || createRequestId()
  res.setHeader('x-request-id', req.requestId)

  const startedAt = Date.now()
  if (shouldLogRequest(req)) {
    logger.info(
      `Incoming ${req.method} ${req.originalUrl || req.url}`,
      'REQUEST',
      '',
      { request_id: req.requestId, method: req.method, path: req.originalUrl || req.url }
    )
    res.on('finish', () => {
      logger.info(
        `Completed ${req.method} ${req.originalUrl || req.url} -> ${res.statusCode}`,
        'REQUEST',
        '',
        {
          request_id: req.requestId,
          method: req.method,
          path: req.originalUrl || req.url,
          status_code: res.statusCode,
          duration_ms: Date.now() - startedAt,
        }
      )
    })
  }
  next()
})

// Health check
app.get('/', (req, res) => {
  res.json(buildHealthPayload())
})

app.get('/health', (req, res) => {
  res.json(buildHealthPayload())
})

app.get('/readyz', (req, res) => {
  const readiness = buildReadinessPayload({
    health: typeof accountManager.getHealthStats === 'function' ? accountManager.getHealthStats() : null,
    cookies: getCookies(),
    baseHealth: buildHealthPayload(),
  })
  res.status(readiness.statusCode).json(readiness.payload)
})

// API routes
app.use(anthropicRouter)
app.use(geminiRouter)
if (config.enableResponsesApi) {
  app.use(responsesRouter)
}
app.use(modelsRouter)
app.use(chatRouter)
app.use(verifyRouter)
app.use('/api', accountsRouter)
app.use('/api', vercelRouter)

// Serve frontend static files in production
const path = require('path')
const frontendDist = path.join(__dirname, '..', 'webui', 'dist')
const fs = require('fs')
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist))
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/v1/') || req.path.startsWith('/v1beta/') || req.path.startsWith('/api/') || req.path.startsWith('/anthropic/') || req.path === '/health' || req.path === '/verify') {
      return next()
    }
    res.sendFile(path.join(frontendDist, 'index.html'))
  })
}

// 404 handler
app.use((req, res) => {
  res.status(404).json(buildErrorPayload(req, 'Not found', 'not_found'))
})

// Error handler (must be after all routes)
app.use((err, req, res, next) => {
  logger.error('Internal server error', 'SERVER', '', {
    request_id: req?.requestId || null,
    error: err,
  })
  res.status(500).json(buildErrorPayload(req, 'Internal server error', 'internal_server_error'))
})

// Only listen when not imported (i.e., not in Vercel serverless mode)
if (require.main === module) {
  const serverInfo = {
    address: config.listenAddress || '0.0.0.0',
    port: config.listenPort
  }

  if (config.listenAddress) {
    app.listen(config.listenPort, config.listenAddress, () => {
      logger.server(`Server started on ${serverInfo.address}:${serverInfo.port}`, 'SERVER')
    })
  } else {
    app.listen(config.listenPort, () => {
      logger.server(`Server started on port ${serverInfo.port}`, 'SERVER')
    })
  }
}

module.exports = app
