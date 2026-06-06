function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function buildReadinessPayload({ health, cookies, baseHealth }) {
  const accountStats = health?.accounts || { total: 0, valid: 0, expired: 0, expiringSoon: 0, invalid: 0 }
  const rotationStats = health?.rotation || { total: 0, available: 0, inCooldown: 0 }
  const ssxmodReady = hasText(cookies?.ssxmod_itna) && hasText(cookies?.ssxmod_itna2)
  const reasons = []

  if (health?.initialized !== true) {
    reasons.push('accounts_not_initialized')
  }
  if ((accountStats.valid || 0) < 1) {
    reasons.push('no_valid_tokens')
  }
  if (!ssxmodReady) {
    reasons.push('ssxmod_cookies_empty')
  }

  const ready = reasons.length === 0

  return {
    statusCode: ready ? 200 : 503,
    payload: {
      ...(baseHealth || {}),
      status: ready ? 'ready' : 'not_ready',
      reasons,
      accounts: accountStats,
      rotation: rotationStats,
      ssxmod: {
        ready: ssxmodReady,
        timestamp: cookies?.timestamp || 0,
      },
    },
  }
}

module.exports = {
  buildReadinessPayload,
}
