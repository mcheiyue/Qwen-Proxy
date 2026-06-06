const test = require('node:test')
const assert = require('node:assert/strict')

const AccountRotator = require('../../src/utils/account-rotator.js')

function withMockedNow(t, initialNow) {
  const originalNow = Date.now
  let now = initialNow
  Date.now = () => now
  t.after(() => {
    Date.now = originalNow
  })
  return {
    advance(ms) {
      now += ms
    }
  }
}

test('recordRateLimit uses exponential cooldown capped at one hour', (t) => {
  withMockedNow(t, 1700000000000)
  const rotator = new AccountRotator()

  assert.equal(rotator.recordRateLimit('a@example.com').cooldownMs, 600000)
  assert.equal(rotator.recordRateLimit('a@example.com').cooldownMs, 1200000)
  assert.equal(rotator.recordRateLimit('a@example.com').cooldownMs, 2400000)
  assert.equal(rotator.recordRateLimit('a@example.com').cooldownMs, 3600000)
  assert.equal(rotator.recordRateLimit('a@example.com').cooldownMs, 3600000)
})

test('rate limited account is unavailable until cooldown expires', (t) => {
  const clock = withMockedNow(t, 1700000000000)
  const rotator = new AccountRotator()
  rotator.setAccounts([{ email: 'a@example.com', token: 'token-a' }])

  rotator.recordRateLimit('a@example.com')
  assert.equal(rotator.getTokenByEmail('a@example.com'), null)

  clock.advance(600000)
  assert.equal(rotator.getTokenByEmail('a@example.com'), 'token-a')
  assert.equal(rotator.getStats().usageStats['a@example.com'].rateLimitStrikes, 0)
})

test('resetRateLimit clears strikes and availability block', (t) => {
  withMockedNow(t, 1700000000000)
  const rotator = new AccountRotator()
  rotator.setAccounts([{ email: 'a@example.com', token: 'token-a' }])

  rotator.recordRateLimit('a@example.com')
  rotator.recordRateLimit('a@example.com')
  assert.equal(rotator.getTokenByEmail('a@example.com'), null)

  rotator.resetRateLimit('a@example.com')
  assert.equal(rotator.getTokenByEmail('a@example.com'), 'token-a')
  assert.equal(rotator.getStats().usageStats['a@example.com'].rateLimitStrikes, 0)
})

test('ordinary failures do not create rate limit state', (t) => {
  withMockedNow(t, 1700000000000)
  const rotator = new AccountRotator()
  rotator.setAccounts([{ email: 'a@example.com', token: 'token-a' }])

  rotator.recordFailure('a@example.com')
  rotator.recordFailure('a@example.com')

  const stats = rotator.getStats().usageStats['a@example.com']
  assert.equal(stats.failures, 2)
  assert.equal(stats.rateLimitStrikes, 0)
  assert.equal(stats.rateLimitedUntil, null)
  assert.equal(stats.available, true)
})
