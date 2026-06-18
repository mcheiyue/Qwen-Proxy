const dotenv = require('dotenv')
dotenv.config()

/**
 * Parse API_KEY env var, supports comma-separated multiple keys
 * @returns {Object} Object containing apiKeys array and adminKey
 */
const parseApiKeys = () => {
    const apiKeyEnv = process.env.API_KEY
    if (!apiKeyEnv) {
        return { apiKeys: [], adminKey: null }
    }

    const keys = apiKeyEnv.split(',').map(key => key.trim()).filter(key => key.length > 0)
    return {
        apiKeys: keys,
        adminKey: keys.length > 0 ? keys[0] : null
    }
}

/**
 * Parse proxy list from env. Accepts:
 *   PROXIES=socks5://1.2.3.4:1080,http://user:pass@host:port,...
 *   (legacy) PROXY_URL=<single>
 * Returns deduped array of normalized URLs. Each entry must be a parseable
 * URL with a known scheme (socks5/socks4/socks/http/https).
 */
const parseProxies = () => {
    const raw = []
    const env = process.env.PROXIES
    if (env) {
        raw.push(...env.split(',').map(s => s.trim()).filter(Boolean))
    }
    if (process.env.PROXY_URL) {
        raw.push(String(process.env.PROXY_URL).trim())
    }
    const seen = new Set()
    const out = []
    for (const url of raw) {
        if (!url || seen.has(url)) continue
        try {
            const u = new URL(url)
            if (!/^(socks5h?|socks4a?|socks|http|https):$/.test(u.protocol)) continue
            seen.add(url)
            out.push(url)
        } catch { /* invalid url — skip */ }
    }
    return out
}

/**
 * Parse a list of emails (comma or newline separated). Used by the
 * disabled-account list — see DISABLED_ACCOUNTS env. Stored separately
 * from ACCOUNTS so toggling disabled is reversible without losing the
 * email/password credential.
 */
const parseEmailList = (raw) => {
    if (!raw) return []
    return String(raw)
        .split(/[,\n]/)
        .map(s => s.trim())
        .filter(Boolean)
}

const { apiKeys, adminKey } = parseApiKeys()

const normalizeResponsesStoreBackend = () => {
  const raw = String(process.env.RESPONSES_STORE_BACKEND || '').trim().toLowerCase()
  if (raw === 'file' || raw === 'memory' || raw === 'redis') {
    return raw
  }
  if (process.env.DATA_SAVE_MODE === 'redis') {
    return 'redis'
  }
  return process.env.DATA_SAVE_MODE === 'file' ? 'file' : 'memory'
}

const normalizeChatReasoningEffortPolicy = () => {
  const raw = String(process.env.CHAT_REASONING_EFFORT_POLICY || 'ignore').trim().toLowerCase()
  if (raw === 'downgrade' || raw === 'passthrough') {
    return raw
  }
  return 'ignore'
}

const normalizeOptionalHeaderValue = (value, fallback) => {
  const normalized = String(value || '').trim()
  return normalized || fallback
}

const config = {
    dataSaveMode: process.env.DATA_SAVE_MODE || "none",
    defaultModel: process.env.DEFAULT_MODEL || 'qwen3.6-plus',
    cliCoderModel: process.env.CLI_CODER_MODEL || 'qwen3-coder-plus',
    enableResponsesApi: process.env.ENABLE_RESPONSES_API === 'false' ? false : true,
    enableCliApi: process.env.ENABLE_CLI_API === 'false' ? false : true,
    responsesDebugDump: process.env.RESPONSES_DEBUG_DUMP === 'true',
    responsesDebugDumpDir: process.env.RESPONSES_DEBUG_DUMP_DIR || './logs/responses-debug',
    responsesAllowTopLevelToolReplay: process.env.RESPONSES_ALLOW_TOP_LEVEL_TOOL_REPLAY === 'true',
    responsesAllowAssistantToolReplay: process.env.RESPONSES_ALLOW_ASSISTANT_TOOL_REPLAY === 'true',
    responsesAllowReasoningReplay: process.env.RESPONSES_ALLOW_REASONING_REPLAY === 'true',
    responsesAllowReasoningEffort: process.env.RESPONSES_ALLOW_REASONING_EFFORT === 'true',
    chatReasoningEffortPolicy: normalizeChatReasoningEffortPolicy(),
    sanitizeVisibleOutput: process.env.SANITIZE_VISIBLE_OUTPUT === 'false' ? false : true,
    responsesStoreBackend: normalizeResponsesStoreBackend(),
    responsesStoreTtlSeconds: Math.max(60, parseInt(process.env.RESPONSES_STORE_TTL_SECONDS) || 1800),
    responsesStoreFile: process.env.RESPONSES_STORE_FILE || './data/responses-store.json',
    responsesStoreRedisKey: process.env.RESPONSES_STORE_REDIS_KEY || 'qwen2api:responses',
    toolResultMaxChars: Math.max(0, parseInt(process.env.TOOL_RESULT_MAX_CHARS) || 12000),
    toolResultTailChars: Math.max(0, parseInt(process.env.TOOL_RESULT_TAIL_CHARS) || 2000),
    apiKeys: apiKeys,
    adminKey: adminKey,
    batchLoginConcurrency: Math.max(1, parseInt(process.env.BATCH_LOGIN_CONCURRENCY) || 5),
    simpleModelMap: process.env.SIMPLE_MODEL_MAP === 'true' ? true : false,
    listenAddress: process.env.LISTEN_ADDRESS || null,
    listenPort: process.env.SERVICE_PORT || process.env.PORT || 3000,
    searchInfoMode: process.env.SEARCH_INFO_MODE === 'table' ? "table" : "text",
    outThink: process.env.OUTPUT_THINK === 'true' ? true : false,
    autoRefresh: true,
    autoRefreshInterval: 6 * 60 * 60,
    cacheMode: "default",
    logLevel: process.env.LOG_LEVEL || "INFO",
    enableFileLog: process.env.ENABLE_FILE_LOG === 'true',
    logDir: process.env.LOG_DIR || "./logs",
    maxLogFileSize: parseInt(process.env.MAX_LOG_FILE_SIZE) || 10,
    maxLogFiles: parseInt(process.env.MAX_LOG_FILES) || 5,
    // Custom reverse proxy URL config
    qwenChatProxyUrl: process.env.QWEN_CHAT_PROXY_URL || "https://chat.qwen.ai",
    qwenBrowserVersion: normalizeOptionalHeaderValue(process.env.QWEN_BROWSER_VERSION, '0.2.64'),
    qwenBrowserBxV: normalizeOptionalHeaderValue(process.env.QWEN_BROWSER_BX_V, '2.5.36'),
    // Single-proxy legacy field (kept for getProxyAgent backward compat)
    proxyUrl: process.env.PROXY_URL || null,
    // Smart proxy pool: list of proxy URLs (PROXIES env + PROXY_URL fallback,
    // deduped). Each account gets bound to one entry from this pool.
    proxies: parseProxies(),
    // Disabled-account email allow-list. Accounts whose email matches
    // any entry here are kept in the list (so toggling back on doesn't
    // lose password) but skipped by the rotator. The list is editable
    // at runtime via the admin API; serverless deploys also persist it
    // back to a Vercel env var so it survives cold starts.
    disabledAccounts: parseEmailList(process.env.DISABLED_ACCOUNTS),
    // Maximum upstream-request retries when network errors look proxy-related
    proxyMaxRetries: Math.max(1, parseInt(process.env.PROXY_MAX_RETRIES) || 3),
    // Serverless platform detection — Vercel, Netlify, AWS Lambda all
    // share the same "ephemeral container, no persistent disk" property
    // that makes DATA_SAVE_MODE=file unsafe.
    isServerless: !!(
        process.env.VERCEL
        || process.env.NETLIFY
        || process.env.AWS_LAMBDA_FUNCTION_NAME
    )
}

module.exports = config
