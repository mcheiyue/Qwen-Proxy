const crypto = require('crypto')
const config = require('../config/index.js')

// 对齐真实浏览器 Chrome 149 指纹
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const DEFAULT_SEC_CH_UA = '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"'

function formatQwenTimezone(date = new Date()) {
    const utcMs = date.getTime() + date.getTimezoneOffset() * 60 * 1000
    return new Date(utcMs + 8 * 60 * 60 * 1000)
        .toUTCString()
        .replace(/,/, '')
        .replace('GMT', 'GMT+0800')
}

function buildQwenBrowserHeaders(options = {}) {
    const chatBaseUrl = options.chatBaseUrl || config.qwenChatProxyUrl
    const headers = {
        'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
        'Accept': options.accept || 'application/json, text/plain, */*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Content-Type': options.contentType || 'application/json',
        'Timezone': options.timezone || formatQwenTimezone(),
        'sec-ch-ua': options.secChUa || DEFAULT_SEC_CH_UA,
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'source': 'web',
        'Version': options.version || config.qwenBrowserVersion,
        'bx-v': options.bxV || config.qwenBrowserBxV,
        'X-Request-Id': crypto.randomUUID(),
        'Origin': 'https://chat.qwen.ai',
        'Referer': options.referer || `https://chat.qwen.ai/`,
    }

    if (options.authorization) {
        headers.Authorization = options.authorization
    }

    if (options.cookie) {
        headers.Cookie = options.cookie
    }

    return headers
}

module.exports = {
    buildQwenBrowserHeaders,
}
