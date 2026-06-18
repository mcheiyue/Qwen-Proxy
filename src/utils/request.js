const axios = require('axios')
const accountManager = require('./account.js')
const config = require('../config/index.js')
const { logger } = require('./logger')
const { getSsxmodItna, getSsxmodItna2 } = require('./ssxmod-manager')
const { getProxyAgent, getChatBaseUrl, buildAgentForUrl, getProxyHost } = require('./proxy-helper')
const { buildQwenBrowserHeaders } = require('./upstream-headers.js')
const { generateUUID } = require('./tools.js')

// Errors that look like the proxy is dead (TCP-level / DNS / handshake).
// Anything in this set on a proxied request triggers proxy failover.
const NETWORK_ERROR_CODES = new Set([
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND',
    'ENETUNREACH', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH',
])

function isProxyShapedError(err) {
    if (!err) return false
    if (NETWORK_ERROR_CODES.has(err.code)) return true
    const msg = String(err.message || '')
    return /timeout|ECONN|socket|ENETUNREACH|tunneling/.test(msg)
}

function buildWebCompletionMessage(message, body, timestampSeconds) {
    const featureConfig = {
        thinking_enabled: true,
        output_schema: 'phase',
        research_mode: 'normal',
        auto_thinking: true,
        thinking_mode: 'Auto',
        thinking_format: 'summary',
        auto_search: true,
        ...(message && typeof message.feature_config === 'object' ? message.feature_config : {}),
    }

    return {
        fid: message?.fid || generateUUID(),
        parentId: message?.parentId || null,
        childrenIds: Array.isArray(message?.childrenIds) && message.childrenIds.length > 0
            ? message.childrenIds
            : [generateUUID()],
        role: message?.role || 'user',
        content: message?.content || '',
        user_action: message?.user_action || 'chat',
        files: Array.isArray(message?.files) ? message.files : [],
        timestamp: message?.timestamp || timestampSeconds,
        models: Array.isArray(message?.models) && message.models.length > 0 ? message.models : [body.model],
        chat_type: message?.chat_type || body.chat_type || 't2t',
        feature_config: featureConfig,
        extra: {
            ...(message && typeof message.extra === 'object' ? message.extra : {}),
            meta: {
                ...(message?.extra && typeof message.extra.meta === 'object' ? message.extra.meta : {}),
                subChatType: message?.sub_chat_type || body.sub_chat_type || body.chat_type || 't2t',
            },
        },
        sub_chat_type: message?.sub_chat_type || body.sub_chat_type || body.chat_type || 't2t',
    }
}

function buildWebCompletionBody(body, chatId) {
    const timestampSeconds = Math.floor(Date.now() / 1000)
    const messages = Array.isArray(body.messages) && body.messages.length > 0 ? body.messages : []

    return {
        ...body,
        stream: true,
        version: body.version || '2.1',
        incremental_output: true,
        chat_id: chatId,
        chat_mode: body.chat_mode || 'normal',
        parent_id: body.parent_id || null,
        messages: messages.map(message => buildWebCompletionMessage(message, body, timestampSeconds)),
        timestamp: body.timestamp || timestampSeconds,
    }
}

/**
 * Resolve the proxy URL for the current account. If the account has no
 * binding yet, the pool will lazily assign one. When no pool is
 * configured the legacy single-proxy (config.proxyUrl via getProxyAgent)
 * is used instead.
 * @param {string} email
 * @returns {Promise<string|null>}
 */
async function resolveAccountProxy(email) {
    if (!email) return null
    if (!accountManager.proxyPool) return null
    return await accountManager.getProxyForAccount(email)
}

/**
 * Send chat request
 * Retries up to config.proxyMaxRetries times when the proxy looks dead.
 * Each retry asks the smart pool for a fresh binding.
 * @param {Object} body - Request body
 * @returns {Promise<Object>} Response result
 */
const sendChatRequest = async (body) => {
    // Wait for the (lazy, async) account-manager init before doing
    // anything else. Without this, on Vercel's per-request isolated
    // function instances, requests that arrive before _initialize()
    // finishes its first signin call see token === '' and bail out
    // with "Cannot get valid access token", even though the very next
    // request (a few hundred ms later, after signin completes) succeeds.
    if (typeof accountManager.ensureInitialized === 'function') {
        try { await accountManager.ensureInitialized() } catch { /* fall through */ }
    }

    const MAX_RETRIES = Math.max(1, config.proxyMaxRetries || 3)
    let lastError = null

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        // One rotator advance per attempt — picking a fresh account on
        // retry is desirable too (the original token might be the cause).
        const accountInfo = accountManager.accountRotator
            && typeof accountManager.accountRotator.getNextAccountInfo === 'function'
            ? accountManager.accountRotator.getNextAccountInfo()
            : null
        const currentToken = accountInfo ? accountInfo.token : accountManager.getAccountToken()
        const currentEmail = accountInfo ? accountInfo.email : null

        if (!currentToken) {
            logger.error('Cannot get valid access token', 'TOKEN')
            return { status: false, response: null }
        }

        const currentProxy = await resolveAccountProxy(currentEmail)

        try {
            const chatBaseUrl = getChatBaseUrl()

            const requestConfig = {
                headers: buildQwenBrowserHeaders({
                    authorization: `Bearer ${currentToken}`,
                    accept: 'application/json',
                    version: '0.2.64',
                    chatBaseUrl,
                    cookie: `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
                }),
                responseType: 'stream',
                timeout: 60 * 1000,
            }
            requestConfig.headers['x-accel-buffering'] = 'no'

            // Prefer the smart-pool binding when available; fall back to
            // the legacy single-proxy (config.proxyUrl) otherwise.
            const agent = currentProxy ? buildAgentForUrl(currentProxy) : getProxyAgent()
            if (agent) {
                requestConfig.httpAgent = agent
                requestConfig.httpsAgent = agent
                requestConfig.proxy = false
            }

            const chat_id = await generateChatID(currentToken, body.model, currentEmail, currentProxy, body.chat_type)
            if (!chat_id) {
                throw new Error('Failed to generate chat_id — upstream may be unreachable')
            }
            requestConfig.headers.Referer = `${chatBaseUrl}/c/${chat_id}`
            const upstreamBody = buildWebCompletionBody(body, chat_id)

            logger.network(`Sending chat request (attempt ${attempt}/${MAX_RETRIES}, proxy: ${getProxyHost(currentProxy)})`, 'REQUEST')
            const response = await axios.post(`${chatBaseUrl}/api/v2/chat/completions?chat_id=` + chat_id, upstreamBody, requestConfig)

            if (response.status === 200) {
                if (currentEmail && typeof accountManager.resetAccountRateLimit === 'function') {
                    accountManager.resetAccountRateLimit(currentEmail)
                }
                return {
                    currentToken: currentToken,
                    status: true,
                    response: response.data
                }
            }
            lastError = new Error(`Request failed with status code ${response.status}`)
        } catch (error) {
            lastError = error
            logger.error(`Chat request failed (attempt ${attempt}/${MAX_RETRIES}, proxy: ${getProxyHost(currentProxy)}): ${error.message}`, 'REQUEST')

            const statusCode = error?.response?.status
            if (statusCode === 429 && currentEmail && typeof accountManager.recordAccountRateLimit === 'function') {
                const cooldown = accountManager.recordAccountRateLimit(currentEmail)
                logger.warn(`Account ${currentEmail} hit HTTP 429, exponential cooldown ${Math.round((cooldown?.cooldownMs || 0) / 1000)}s`, 'REQUEST')
                break
            }

            // Only proxy-shaped errors are retryable. Auth errors, 4xx and
            // upstream-format failures should bail immediately so the
            // caller sees the real reason instead of "after 3 retries".
            if (currentProxy && currentEmail && isProxyShapedError(error) && attempt < MAX_RETRIES) {
                logger.warn('Proxy-shaped failure — rotating proxy and retrying', 'PROXY')
                await accountManager.handleNetworkFailure(currentEmail, currentProxy)
                continue
            }
            break
        }
    }

    if (lastError) {
        logger.error(`Failed to send chat request: ${lastError.message}`, 'REQUEST', '', lastError)
    }
    return { status: false, response: null }
}

/**
 * Generate chat_id
 * @param {string} currentToken - Current token
 * @param {string} model - Model name
 * @param {string} [email] - Account email (for proxy lookup)
 * @param {string} [proxyUrl] - Proxy URL (overrides legacy single-proxy)
 * @returns {Promise<string|null>} Generated chat_id or null
 */
const generateChatID = async (currentToken, model, email = null, proxyUrl = null, chatType = 't2t') => {
    try {
        const chatBaseUrl = getChatBaseUrl()

        const requestConfig = {
            headers: buildQwenBrowserHeaders({
                authorization: `Bearer ${currentToken}`,
                version: '0.2.64',
                chatBaseUrl,
                cookie: `ssxmod_itna=${getSsxmodItna()};ssxmod_itna2=${getSsxmodItna2()}`,
            })
        }

        const agent = proxyUrl ? buildAgentForUrl(proxyUrl) : getProxyAgent()
        if (agent) {
            requestConfig.httpAgent = agent
            requestConfig.httpsAgent = agent
            requestConfig.proxy = false
        }

        const response_data = await axios.post(`${chatBaseUrl}/api/v2/chats/new`, {
            "title": "New Chat",
            "models": [model],
            "chat_mode": "local",
            "chat_type": chatType || 't2t',
            "timestamp": new Date().getTime()
        }, requestConfig)

        return response_data.data?.data?.id || null

    } catch (error) {
        logger.error('Failed to generate chat_id', 'CHAT', '', error.message)
        return null
    }
}

module.exports = {
    sendChatRequest,
    generateChatID
}
