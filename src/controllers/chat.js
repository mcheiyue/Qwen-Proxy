const { isJson, generateUUID } = require('../utils/tools.js')
const { createUsageObject } = require('../utils/precise-tokenizer.js')
const { sendChatRequest } = require('../utils/request.js')
const accountManager = require('../utils/account.js')
const config = require('../config/index.js')
const { logger } = require('../utils/logger')
const { createSieve, parseToolCallsFromText } = require('../utils/toolcall.js')
const { sanitizeVisibleOutput } = require('../utils/visible-output-sanitize.js')

const buildRequestLogMeta = (req, extra = null) => {
    const meta = {
        request_id: req?.requestId || null
    }
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
        Object.assign(meta, extra)
    }
    return meta
}

const buildRequestErrorBody = (req, message, code) => ({
    error: message,
    code,
    request_id: req?.requestId || null
})

const sanitizeVisibleText = (text) => {
    if (!config.sanitizeVisibleOutput) return text
    return sanitizeVisibleOutput(text)
}

const requiresToolCall = (toolChoice) => {
    if (toolChoice === 'required') return true
    if (!toolChoice || typeof toolChoice !== 'object') return false
    return toolChoice.type === 'function' && !!toolChoice.function?.name
}

const buildRequiredRetryHint = (toolChoice) => {
    if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function?.name) {
        return `The previous response did not include the required tool call. You must now call the function named ${toolChoice.function.name}. Return only the tool call in the required DSML format.`
    }
    return 'The previous response did not include a required tool call. You must now call exactly one available tool. Return only the tool call in the required DSML format.'
}

/**
 * Set response headers
 * @param {object} res - Express response object
 * @param {boolean} stream - Whether streaming response
 */
const setResponseHeaders = (res, stream) => {
    try {
        if (stream) {
            res.set({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            })
        } else {
            res.set({
                'Content-Type': 'application/json',
            })
        }
    } catch (e) {
        logger.error('Error setting response headers', 'CHAT', '', e)
    }
}

const getImageMarkdownListFromDelta = (delta) => {
    const imageList = []
    const displayImages = delta?.extra?.image_list || []

    for (const item of displayImages) {
        if (item?.image) {
            imageList.push(`![image](${item.image})`)
        }
    }

    return imageList
}

/**
 * Handle streaming response
 */
const handleStreamResponse = async (req, res, response, enable_thinking, enable_web_search, requestBody = null, toolcallEnabled = false) => {
    try {
        const message_id = generateUUID()
        const decoder = new TextDecoder('utf-8')
        let web_search_info = null
        let currentPhase = null // 'think' or 'answer'
        let buffer = ''
        let emittedImageMarkdownSet = new Set()
        let pendingImageMarkdownList = []

        // Tool-call sieve. Only created when the request was gated as
        // tool-call enabled by the middleware.
        const sieve = toolcallEnabled ? createSieve() : null
        let toolCallsEmitted = false

        let totalTokens = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
        let completionContent = ''

        let promptText = ''
        if (requestBody && requestBody.messages) {
            promptText = requestBody.messages.map(msg => {
                if (typeof msg.content === 'string') return msg.content
                if (Array.isArray(msg.content)) return msg.content.map(item => item.text || '').join('')
                return ''
            }).join('\n')
        }

        const writeChunk = (delta) => {
            const chunk = {
                "id": `chatcmpl-${message_id}`,
                "object": "chat.completion.chunk",
                "created": Math.round(new Date().getTime() / 1000),
                "choices": [{
                    "index": 0,
                    "delta": delta,
                    "finish_reason": null
                }]
            }
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        }

        const writeToolCallDeltas = (deltas) => {
            if (!Array.isArray(deltas) || deltas.length === 0) return
            toolCallsEmitted = true
            writeChunk({ tool_calls: deltas })
        }

        response.on('data', async (chunk) => {
            const decodeText = decoder.decode(chunk, { stream: true })
            buffer += decodeText

            const chunks = []
            let startIndex = 0

            while (true) {
                const dataStart = buffer.indexOf('data: ', startIndex)
                if (dataStart === -1) break

                const dataEnd = buffer.indexOf('\n\n', dataStart)
                if (dataEnd === -1) break

                const dataChunk = buffer.substring(dataStart, dataEnd).trim()
                chunks.push(dataChunk)
                startIndex = dataEnd + 2
            }

            if (startIndex > 0) {
                buffer = buffer.substring(startIndex)
            }

            for (const item of chunks) {
                try {
                    let dataContent = item.replace("data: ", '')
                    let decodeJson = isJson(dataContent) ? JSON.parse(dataContent) : null
                    if (decodeJson === null || !decodeJson.choices || decodeJson.choices.length === 0) {
                        continue
                    }

                    if (decodeJson.usage) {
                        totalTokens = {
                            prompt_tokens: decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                            completion_tokens: decodeJson.usage.completion_tokens || totalTokens.completion_tokens,
                            total_tokens: decodeJson.usage.total_tokens || totalTokens.total_tokens
                        }
                    }

                    const delta = decodeJson.choices[0].delta

                    // Handle web search info
                    if (delta && delta.name === 'web_search') {
                        web_search_info = delta.extra.web_search_info
                    }

                    // Handle inline images
                    const imageMarkdownList = getImageMarkdownListFromDelta(delta)
                    if (imageMarkdownList.length > 0) {
                        const newImageMarkdownList = imageMarkdownList.filter(item => !emittedImageMarkdownSet.has(item))

                        if (currentPhase === 'think') {
                            // Buffer images during thinking phase
                            for (const imageMarkdown of newImageMarkdownList) {
                                if (!pendingImageMarkdownList.includes(imageMarkdown)) {
                                    pendingImageMarkdownList.push(imageMarkdown)
                                }
                            }
                        } else if (newImageMarkdownList.length > 0) {
                            const imageContent = `${newImageMarkdownList.join('\n\n')}\n\n`
                            completionContent += imageContent
                            newImageMarkdownList.forEach(item => emittedImageMarkdownSet.add(item))
                            writeChunk({ "content": sanitizeVisibleText(imageContent) })
                        }
                    }

                    if (!delta || !delta.content ||
                        (delta.phase !== 'think' && delta.phase !== 'answer')) {
                        continue
                    }

                    let content = delta.content
                    completionContent += content

                    if (delta.phase === 'think') {
                        // Thinking phase: send as reasoning_content (OpenAI standard)
                        if (currentPhase !== 'think') {
                            currentPhase = 'think'
                            // Prepend search info to first thinking chunk if available
                            if (web_search_info) {
                                const searchTable = await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)
                                content = searchTable + '\n\n' + content
                            }
                        }
                        writeChunk({ "reasoning_content": content })
                    } else if (delta.phase === 'answer') {
                        // Answer phase: send as content
                        if (currentPhase === 'think') {
                            // Flush pending images when transitioning from think to answer
                            if (pendingImageMarkdownList.length > 0) {
                                const pendingImageContent = `${pendingImageMarkdownList.join('\n\n')}\n\n`
                                completionContent += pendingImageContent
                                pendingImageMarkdownList.forEach(item => emittedImageMarkdownSet.add(item))
                                pendingImageMarkdownList = []
                                writeChunk({ "content": sanitizeVisibleText(pendingImageContent) })
                            }
                        }
                        currentPhase = 'answer'
                        if (sieve) {
                            const out = sieve.push(content)
                            if (out.textDelta) writeChunk({ "content": sanitizeVisibleText(out.textDelta) })
                            if (out.toolCallsDelta) writeToolCallDeltas(out.toolCallsDelta)
                        } else {
                            writeChunk({ "content": sanitizeVisibleText(content) })
                        }
                    }
                } catch (error) {
                    logger.error('Stream data processing error', 'CHAT', '', buildRequestLogMeta(req, {
                        error: error && error.message ? error.message : error
                    }))
                }
            }
        })

        response.on('end', async () => {
            try {
                // Flush any pending content held by the tool-call sieve
                if (sieve) {
                    const out = sieve.flush()
                    if (out.textDelta) writeChunk({ "content": sanitizeVisibleText(out.textDelta) })
                    if (out.toolCallsDelta) writeToolCallDeltas(out.toolCallsDelta)
                }

                // Append search info for non-thinking mode
                if ((config.outThink === false || !enable_thinking) && web_search_info && config.searchInfoMode === "text") {
                    const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, "text")
                    writeChunk({ "content": sanitizeVisibleText(`\n\n---\n${webSearchTable}`) })
                }

                if (totalTokens.prompt_tokens === 0 && totalTokens.completion_tokens === 0) {
                    totalTokens = createUsageObject(requestBody?.messages || promptText, completionContent, null)
                }

                totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0)
                totalTokens.completion_tokens = Math.max(0, totalTokens.completion_tokens || 0)
                totalTokens.total_tokens = totalTokens.prompt_tokens + totalTokens.completion_tokens

                const finishReason = toolCallsEmitted ? 'tool_calls' : 'stop'

                // Finish chunk
                res.write(`data: ${JSON.stringify({
                    "id": `chatcmpl-${message_id}`,
                    "object": "chat.completion.chunk",
                    "created": Math.round(new Date().getTime() / 1000),
                    "choices": [{ "index": 0, "delta": {}, "finish_reason": finishReason }]
                })}\n\n`)

                // Usage chunk
                res.write(`data: ${JSON.stringify({
                    "id": `chatcmpl-${message_id}`,
                    "object": "chat.completion.chunk",
                    "created": Math.round(new Date().getTime() / 1000),
                    "choices": [],
                    "usage": totalTokens
                })}\n\n`)

                res.write(`data: [DONE]\n\n`)
                res.end()
            } catch (e) {
                logger.error('Stream response end error', 'CHAT', '', buildRequestLogMeta(req, {
                    error: e && e.message ? e.message : e
                }))
                if (!res.headersSent) {
                    res.status(500).json(buildRequestErrorBody(req, 'Internal server error', 'chat_stream_finalize_failed'))
                }
            }
        })
    } catch (error) {
        logger.error('Chat processing error', 'CHAT', '', buildRequestLogMeta(req, {
            error: error && error.message ? error.message : error
        }))
        if (!res.headersSent) {
            res.status(500).json(buildRequestErrorBody(req, 'Internal server error', 'chat_stream_processing_failed'))
        }
    }
}

const writeBufferedChatCompletionAsStream = (res, responseData) => {
    const choice = responseData?.choices?.[0] || {}
    const message = choice.message || {}
    const finishReason = choice.finish_reason || responseData?.finish_reason || 'stop'
    const base = {
        id: responseData?.id || `chatcmpl-${generateUUID()}`,
        object: 'chat.completion.chunk',
        created: responseData?.created || Math.round(Date.now() / 1000),
        model: responseData?.model,
    }
    const writeChunk = (delta, finish_reason = null) => {
        res.write(`data: ${JSON.stringify({
            ...base,
            choices: [{ index: 0, delta, finish_reason }]
        })}\n\n`)
    }

    writeChunk({ role: 'assistant' })
    if (message.reasoning_content) {
        writeChunk({ reasoning_content: message.reasoning_content })
    }
    if (message.content) {
        writeChunk({ content: sanitizeVisibleText(message.content) })
    }
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        writeChunk({
            tool_calls: message.tool_calls.map((toolCall, index) => ({
                index,
                id: toolCall.id,
                type: toolCall.type || 'function',
                function: toolCall.function || { name: '', arguments: '{}' }
            }))
        })
    }
    writeChunk({}, finishReason)
    if (responseData?.usage) {
        res.write(`data: ${JSON.stringify({
            ...base,
            choices: [],
            usage: responseData.usage
        })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
}

const handleBufferedRequiredStreamResponse = async (req, res, response, enable_thinking, enable_web_search, model, requestBody = null, toolcallEnabled = false) => {
    let payload = null
    let statusCode = 200
    const captureRes = {
        set: () => captureRes,
        status: (code) => {
            statusCode = code
            return captureRes
        },
        json: (body) => {
            payload = body
            return captureRes
        }
    }

    await handleNonStreamResponse(req, captureRes, response, enable_thinking, enable_web_search, model, requestBody, toolcallEnabled)
    if (statusCode >= 400 || !payload) {
        const errorMessage = payload?.error || 'Required tool call stream buffering failed'
        logger.error('Buffered required stream failed', 'CHAT', '', buildRequestLogMeta(req, { error: errorMessage, status_code: statusCode }))
        res.write(`data: ${JSON.stringify({
            id: `chatcmpl-${generateUUID()}`,
            object: 'chat.completion.chunk',
            created: Math.round(Date.now() / 1000),
            choices: [{ index: 0, delta: { content: '' }, finish_reason: 'stop' }]
        })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
    }
    writeBufferedChatCompletionAsStream(res, payload)
}

/**
 * Handle non-streaming response (accumulate from stream)
 */
const handleNonStreamResponse = async (req, res, response, enable_thinking, enable_web_search, model, requestBody = null, toolcallEnabled = false) => {
    try {
        const consumeUpstreamResponse = async (upstreamResponse) => {
            const decoder = new TextDecoder('utf-8')
            let buffer = ''
            let fullContent = ''
            let reasoningContent = ''
            let web_search_info = null
            let currentPhase = null
            let appendedImageMarkdownSet = new Set()
            let pendingImageMarkdownList = []

            let totalTokens = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

            await new Promise((resolve, reject) => {
                upstreamResponse.on('data', async (chunk) => {
                    const decodeText = decoder.decode(chunk, { stream: true })
                    buffer += decodeText

                    const chunks = []
                    let startIndex = 0

                    while (true) {
                        const dataStart = buffer.indexOf('data: ', startIndex)
                        if (dataStart === -1) break
                        const dataEnd = buffer.indexOf('\n\n', dataStart)
                        if (dataEnd === -1) break
                        chunks.push(buffer.substring(dataStart, dataEnd).trim())
                        startIndex = dataEnd + 2
                    }

                    if (startIndex > 0) buffer = buffer.substring(startIndex)

                    for (const item of chunks) {
                        try {
                            let dataContent = item.replace("data: ", '')
                            let decodeJson = isJson(dataContent) ? JSON.parse(dataContent) : null
                            if (!decodeJson || !decodeJson.choices || decodeJson.choices.length === 0) continue

                            if (decodeJson.usage) {
                                totalTokens = {
                                    prompt_tokens: decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                                    completion_tokens: decodeJson.usage.completion_tokens || totalTokens.completion_tokens,
                                    total_tokens: decodeJson.usage.total_tokens || totalTokens.total_tokens
                                }
                            }

                            const delta = decodeJson.choices[0].delta

                            if (delta && delta.name === 'web_search') {
                                web_search_info = delta.extra.web_search_info
                            }

                            const imageMarkdownList = getImageMarkdownListFromDelta(delta)
                            if (imageMarkdownList.length > 0) {
                                const newList = imageMarkdownList.filter(item => !appendedImageMarkdownSet.has(item))
                                if (currentPhase === 'think') {
                                    for (const md of newList) {
                                        if (!pendingImageMarkdownList.includes(md)) pendingImageMarkdownList.push(md)
                                    }
                                } else if (newList.length > 0) {
                                    fullContent += `${newList.join('\n\n')}\n\n`
                                    newList.forEach(item => appendedImageMarkdownSet.add(item))
                                }
                            }

                            if (!delta || !delta.content || (delta.phase !== 'think' && delta.phase !== 'answer')) continue

                            let content = delta.content

                            if (delta.phase === 'think') {
                                if (currentPhase !== 'think' && web_search_info) {
                                    const searchTable = await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)
                                    reasoningContent += searchTable + '\n\n'
                                }
                                currentPhase = 'think'
                                reasoningContent += content
                            } else if (delta.phase === 'answer') {
                                if (currentPhase === 'think' && pendingImageMarkdownList.length > 0) {
                                    fullContent += `${pendingImageMarkdownList.join('\n\n')}\n\n`
                                    pendingImageMarkdownList.forEach(item => appendedImageMarkdownSet.add(item))
                                    pendingImageMarkdownList = []
                                }
                                currentPhase = 'answer'
                                fullContent += content
                            }
                        } catch (error) {
                            logger.error('Non-stream data processing error', 'CHAT', '', buildRequestLogMeta(req, {
                                error: error && error.message ? error.message : error
                            }))
                        }
                    }
                })

                upstreamResponse.on('end', () => resolve())
                upstreamResponse.on('error', (error) => reject(error))
            })

            if ((config.outThink === false || !enable_thinking) && web_search_info && config.searchInfoMode === "text") {
                const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, "text")
                fullContent += `\n\n---\n${webSearchTable}`
            }

            if (totalTokens.prompt_tokens === 0 && totalTokens.completion_tokens === 0) {
                totalTokens = createUsageObject(requestBody?.messages || '', fullContent + reasoningContent, null)
            }

            totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0)
            totalTokens.completion_tokens = Math.max(0, totalTokens.completion_tokens || 0)
            totalTokens.total_tokens = totalTokens.prompt_tokens + totalTokens.completion_tokens

            const message = { "role": "assistant", "content": sanitizeVisibleText(fullContent) }
            if (reasoningContent) {
                message.reasoning_content = reasoningContent
            }

            let finishReason = "stop"
                if (toolcallEnabled && fullContent) {
                    const parsed = parseToolCallsFromText(fullContent)
                    if (parsed.toolCalls.length > 0) {
                        message.content = sanitizeVisibleText(parsed.content)
                        message.tool_calls = parsed.toolCalls
                        finishReason = "tool_calls"
                    }
                }

            return {
                "id": `chatcmpl-${generateUUID()}`,
                "object": "chat.completion",
                "created": Math.round(new Date().getTime() / 1000),
                "model": model,
                "choices": [{
                    "index": 0,
                    "message": message,
                    "finish_reason": finishReason
                }],
                "usage": totalTokens,
                "finish_reason": finishReason,
                "tool_calls": Array.isArray(message.tool_calls) ? message.tool_calls : []
            }
        }

        let responseData = await consumeUpstreamResponse(response)

        if (toolcallEnabled && requiresToolCall(req.tool_choice) && (!responseData.tool_calls || responseData.tool_calls.length === 0)) {
            const retryMessages = Array.isArray(requestBody?.messages) ? [...requestBody.messages] : []
            retryMessages.push({ role: 'system', content: buildRequiredRetryHint(req.tool_choice) })
            logger.warn('Required tool call missing, retrying non-stream chat once', 'CHAT', '', buildRequestLogMeta(req, {
                model: model || null,
                tool_choice: req.tool_choice || null
            }))

            const retryResponseData = await sendChatRequest({
                ...req.body,
                messages: retryMessages
            })

            if (retryResponseData?.status && retryResponseData.response) {
                responseData = await consumeUpstreamResponse(retryResponseData.response)
            }
        }

        res.json({
            "id": responseData.id,
            "object": responseData.object,
            "created": responseData.created,
            "model": responseData.model,
            "choices": responseData.choices,
            "usage": responseData.usage
        })
    } catch (error) {
        logger.error('Non-stream chat processing error', 'CHAT', '', buildRequestLogMeta(req, {
            error: error && error.message ? error.message : error
        }))
        res.status(500).json(buildRequestErrorBody(req, 'Internal server error', 'chat_nonstream_processing_failed'))
    }
}

/**
 * Main chat completion handler
 */
const handleChatCompletion = async (req, res) => {
    const { stream, model } = req.body
    const enable_thinking = req.enable_thinking
    const enable_web_search = req.enable_web_search

    try {
        const response_data = await sendChatRequest(req.body)

        if (!response_data.status || !response_data.response) {
            logger.error('Chat upstream request failed', 'CHAT', '', buildRequestLogMeta(req, {
                model: model || null
            }))
            res.status(500).json(buildRequestErrorBody(req, 'Failed to send request', 'chat_upstream_request_failed'))
            return
        }

        if (stream) {
            setResponseHeaders(res, true)
            if (req.toolcall_enabled && requiresToolCall(req.tool_choice)) {
                logger.warn('Buffering stream to satisfy required tool choice', 'CHAT', '', buildRequestLogMeta(req, {
                    model: model || null,
                    tool_choice: req.tool_choice || null
                }))
                await handleBufferedRequiredStreamResponse(req, res, response_data.response, enable_thinking, enable_web_search, model, req.body, req.toolcall_enabled)
                return
            }
            await handleStreamResponse(req, res, response_data.response, enable_thinking, enable_web_search, req.body, req.toolcall_enabled)
        } else {
            setResponseHeaders(res, false)
            await handleNonStreamResponse(req, res, response_data.response, enable_thinking, enable_web_search, model, req.body, req.toolcall_enabled)
        }

    } catch (error) {
        logger.error('Chat processing error', 'CHAT', '', buildRequestLogMeta(req, {
            error: error && error.message ? error.message : error,
            model: model || null
        }))
        res.status(500).json(buildRequestErrorBody(req, 'Invalid token, request failed', 'chat_request_failed'))
    }
}

module.exports = {
    handleChatCompletion,
    handleStreamResponse,
    handleNonStreamResponse,
    setResponseHeaders
}
