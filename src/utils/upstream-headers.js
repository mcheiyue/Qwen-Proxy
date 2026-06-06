const config = require('../config/index.js')

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
const DEFAULT_SEC_CH_UA = '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"'

function buildQwenBrowserHeaders(options = {}) {
    const chatBaseUrl = options.chatBaseUrl || config.qwenChatProxyUrl
    const headers = {
        'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
        'Connection': 'keep-alive',
        'Accept': options.accept || 'application/json',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Content-Type': options.contentType || 'application/json',
        'Timezone': new Date().toString(),
        'sec-ch-ua': options.secChUa || DEFAULT_SEC_CH_UA,
        'source': 'web',
        'Version': options.version || config.qwenBrowserVersion,
        'bx-v': options.bxV || config.qwenBrowserBxV,
        'Origin': chatBaseUrl,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        'Referer': options.referer || `${chatBaseUrl}/c/guest`,
        'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
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
