const test = require('node:test')
const assert = require('node:assert/strict')

const { buildReadinessPayload } = require('../../src/utils/readiness.js')

function readyHealth(overrides = {}) {
  return {
    initialized: true,
    accounts: { total: 2, valid: 1, expired: 0, expiringSoon: 0, invalid: 1 },
    rotation: { total: 2, available: 1, inCooldown: 1 },
    ...overrides,
  }
}

function readyCookies(overrides = {}) {
  return {
    ssxmod_itna: 'itna',
    ssxmod_itna2: 'itna2',
    timestamp: 1700000000000,
    ...overrides,
  }
}

test('readiness returns 200 when accounts and ssxmod are ready', () => {
  const result = buildReadinessPayload({
    health: readyHealth(),
    cookies: readyCookies(),
    baseHealth: { service: 'qwen-proxy' },
  })

  assert.equal(result.statusCode, 200)
  assert.equal(result.payload.status, 'ready')
  assert.deepEqual(result.payload.reasons, [])
  assert.equal(result.payload.service, 'qwen-proxy')
})

test('readiness returns 503 when accounts are not initialized', () => {
  const result = buildReadinessPayload({
    health: readyHealth({ initialized: false }),
    cookies: readyCookies(),
  })

  assert.equal(result.statusCode, 503)
  assert.equal(result.payload.status, 'not_ready')
  assert.deepEqual(result.payload.reasons, ['accounts_not_initialized'])
})

test('readiness returns 503 when no valid tokens exist', () => {
  const result = buildReadinessPayload({
    health: readyHealth({ accounts: { total: 2, valid: 0, expired: 1, expiringSoon: 0, invalid: 1 } }),
    cookies: readyCookies(),
  })

  assert.equal(result.statusCode, 503)
  assert.deepEqual(result.payload.reasons, ['no_valid_tokens'])
})

test('readiness returns 503 when ssxmod cookies are missing', () => {
  const result = buildReadinessPayload({
    health: readyHealth(),
    cookies: readyCookies({ ssxmod_itna2: '' }),
  })

  assert.equal(result.statusCode, 503)
  assert.deepEqual(result.payload.reasons, ['ssxmod_cookies_empty'])
})

test('readiness accumulates all not ready reasons', () => {
  const result = buildReadinessPayload({
    health: readyHealth({
      initialized: false,
      accounts: { total: 0, valid: 0, expired: 0, expiringSoon: 0, invalid: 0 },
    }),
    cookies: {},
  })

  assert.equal(result.statusCode, 503)
  assert.deepEqual(result.payload.reasons, [
    'accounts_not_initialized',
    'no_valid_tokens',
    'ssxmod_cookies_empty',
  ])
})
