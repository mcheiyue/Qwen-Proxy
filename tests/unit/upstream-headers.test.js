const test = require('node:test')
const assert = require('node:assert/strict')

function loadHeadersWithEnv(env = {}) {
  const previous = {
    QWEN_BROWSER_VERSION: process.env.QWEN_BROWSER_VERSION,
    QWEN_BROWSER_BX_V: process.env.QWEN_BROWSER_BX_V,
  }

  for (const key of Object.keys(previous)) {
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      process.env[key] = env[key]
    } else {
      delete process.env[key]
    }
  }

  delete require.cache[require.resolve('../../src/config/index.js')]
  delete require.cache[require.resolve('../../src/utils/upstream-headers.js')]
  const loaded = require('../../src/utils/upstream-headers.js')

  return {
    ...loaded,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
      delete require.cache[require.resolve('../../src/config/index.js')]
      delete require.cache[require.resolve('../../src/utils/upstream-headers.js')]
    },
  }
}

test('buildQwenBrowserHeaders preserves current default browser version fields', (t) => {
  const { buildQwenBrowserHeaders, restore } = loadHeadersWithEnv()
  t.after(restore)

  const headers = buildQwenBrowserHeaders({
    authorization: 'Bearer token',
    chatBaseUrl: 'https://chat.qwen.ai',
    cookie: 'ssxmod_itna=a;ssxmod_itna2=b',
  })

  assert.equal(headers.Version, '0.1.13')
  assert.equal(headers['bx-v'], '2.5.31')
  assert.equal(headers.Authorization, 'Bearer token')
  assert.equal(headers.Cookie, 'ssxmod_itna=a;ssxmod_itna2=b')
  assert.equal(headers.Accept, 'application/json')
  assert.equal(headers.Origin, 'https://chat.qwen.ai')
  assert.equal(headers.Referer, 'https://chat.qwen.ai/c/guest')
  assert.match(headers.Timezone, /GMT/)
  assert.notEqual(headers.Timezone, 'Mon Dec 08 2025 17:28:55 GMT+0800')
})

test('buildQwenBrowserHeaders applies env overrides for gray browser versions', (t) => {
  const { buildQwenBrowserHeaders, restore } = loadHeadersWithEnv({
    QWEN_BROWSER_VERSION: '0.2.57',
    QWEN_BROWSER_BX_V: '2.5.36',
  })
  t.after(restore)

  const headers = buildQwenBrowserHeaders({ chatBaseUrl: 'https://example.test' })

  assert.equal(headers.Version, '0.2.57')
  assert.equal(headers['bx-v'], '2.5.36')
  assert.equal(headers.Origin, 'https://example.test')
})

test('buildQwenBrowserHeaders falls back when env overrides are blank', (t) => {
  const { buildQwenBrowserHeaders, restore } = loadHeadersWithEnv({
    QWEN_BROWSER_VERSION: '   ',
    QWEN_BROWSER_BX_V: '',
  })
  t.after(restore)

  const headers = buildQwenBrowserHeaders()

  assert.equal(headers.Version, '0.1.13')
  assert.equal(headers['bx-v'], '2.5.31')
})

test('buildQwenBrowserHeaders preserves per-call accept and omits empty optional headers', (t) => {
  const { buildQwenBrowserHeaders, restore } = loadHeadersWithEnv()
  t.after(restore)

  const headers = buildQwenBrowserHeaders({
    accept: 'text/event-stream',
    chatBaseUrl: 'https://chat.qwen.ai',
  })

  assert.equal(headers.Accept, 'text/event-stream')
  assert.equal(headers.Authorization, undefined)
  assert.equal(headers.Cookie, undefined)
})
