const express = require('express')
const router = express.Router()

const { apiKeyVerify } = require('../middlewares/authorization.js')
const { processRequestBody } = require('../middlewares/chat-middleware.js')
const { sendChatRequest } = require('../utils/request.js')
const { logger } = require('../utils/logger')
const { generateUUID, isJson } = require('../utils/tools.js')
const { createUsageObject } = require('../utils/precise-tokenizer.js')
const { createSieve, parseToolCallsFromText } = require('../utils/toolcall.js')
const { createResponseStore } = require('../utils/response-store.js')
const config = require('../config/index.js')

const responseStoreApi = createResponseStore({
  backend: config.responsesStoreBackend,
  ttlMs: config.responsesStoreTtlSeconds * 1000,
  filePath: config.responsesStoreFile,
  redisKey: config.responsesStoreRedisKey,
})
const activeResponses = new Map()
const saveResponseObject = (req, responseObject) => responseStoreApi.save(req, responseObject)
const getStoredResponse = (req, responseId) => responseStoreApi.get(req, responseId)
const deleteStoredResponse = (req, responseId) => responseStoreApi.remove(req, responseId)
const listStoredResponses = (req, query = {}) => responseStoreApi.list(req, query)

function getResponseStoreStatus() {
  return {
    backend: responseStoreApi.backend || 'memory',
    ttl_seconds: Math.floor((responseStoreApi.ttlMs || 0) / 1000),
    file_path: responseStoreApi.filePath || null,
    redis_key: responseStoreApi.redisKey || null,
  }
}

function buildRequestLogMeta(req, extra = null) {
  const base = {
    request_id: req?.requestId || null,
  }
  return extra && typeof extra === 'object'
    ? { ...base, ...extra }
    : base
}

function buildRouteErrorBody(req, message, code) {
  return {
    error: message,
    code,
    request_id: req?.requestId || null,
  }
}

function normalizeResponseContentPart(part) {
  if (!part || typeof part !== 'object') return null

  if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
    const text = typeof part.text === 'string' ? part.text : ''
    return text ? { kind: 'text', value: text, item: { type: 'text', text } } : null
  }

  if (part.type === 'reasoning' && Array.isArray(part.summary)) {
    const text = part.summary
      .map((item) => (item && item.type === 'summary_text' && typeof item.text === 'string') ? item.text : '')
      .filter(Boolean)
      .join('\n')
    return text ? { kind: 'text', value: text, item: { type: 'text', text } } : null
  }

  if (part.type === 'input_image' || part.type === 'image' || part.type === 'image_url') {
    const url = part.image_url?.url || part.image_url || part.url || part.image || null
    if (!url || typeof url !== 'string') return null
    return { kind: 'media', item: { type: 'image_url', image_url: { url } } }
  }

  if (part.type === 'input_file') {
    const fileURL = part.file_url || part.url || part.file?.url || null
    const mimeType = typeof part.mime_type === 'string' ? part.mime_type.toLowerCase() : ''
    if (fileURL && typeof fileURL === 'string' && mimeType.startsWith('image/')) {
      return { kind: 'media', item: { type: 'image_url', image_url: { url: fileURL } } }
    }

    const label = part.filename || part.file_id || fileURL || 'attached file'
    const text = `[input_file] ${label}`
    return { kind: 'text', value: text, item: { type: 'text', text } }
  }

  if (part.type === 'function_call') {
    return {
      kind: 'tool_call',
      item: {
        id: part.call_id || '',
        type: 'function',
        function: {
          name: part.name || '',
          arguments: part.arguments || '{}',
        }
      }
    }
  }

  return null
}

function buildUserMessageFromParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) {
    return null
  }

  const hasMedia = parts.some((part) => part?.type !== 'text')
  if (!hasMedia) {
    return {
      role: 'user',
      content: parts.map((part) => part.text || '').filter(Boolean).join('\n\n')
    }
  }

  return {
    role: 'user',
    content: parts,
  }
}

function flattenResponseInput(input) {
  if (typeof input === 'string') {
    return [{ role: 'user', content: input }]
  }

  if (!Array.isArray(input)) {
    return []
  }

  const messages = []
  let pendingUserParts = []

  const flushPendingUserParts = () => {
    const message = buildUserMessageFromParts(pendingUserParts)
    if (message) {
      messages.push(message)
    }
    pendingUserParts = []
  }

  for (const item of input) {
    if (typeof item === 'string') {
      pendingUserParts.push({ type: 'text', text: item })
      continue
    }

    if (!item || typeof item !== 'object') {
      continue
    }

    if (item.type === 'function_call_output') {
      flushPendingUserParts()
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || '',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      })
      continue
    }

    if (item.type === 'input_text' || item.type === 'input_image' || item.type === 'image' || item.type === 'image_url' || item.type === 'input_file') {
      const normalized = normalizeResponseContentPart(item)
      if (normalized?.item) {
        pendingUserParts.push(normalized.item)
      }
      continue
    }

    if (item.type === 'message') {
      flushPendingUserParts()
      const role = item.role || 'user'
      if (!Array.isArray(item.content)) {
        messages.push({
          role,
          content: typeof item.content === 'string' ? item.content : '',
        })
        continue
      }

      const normalizedParts = item.content
        .map((part) => normalizeResponseContentPart(part))
        .filter(Boolean)

      if (role === 'assistant') {
        const content = normalizedParts
          .filter((part) => part.kind === 'text')
          .map((part) => part.value || '')
          .filter(Boolean)
          .join('\n\n')
        const message = { role, content }
        const toolCalls = normalizedParts
          .filter((part) => part.kind === 'tool_call')
          .map((part, index) => ({
            id: part.item.id || `call_${index}`,
            type: 'function',
            function: {
              name: part.item.function?.name || '',
              arguments: part.item.function?.arguments || '{}',
            }
          }))
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls
        }
        messages.push(message)
        continue
      }

      const contentItems = normalizedParts.map((part) => part.item).filter(Boolean)
      messages.push({
        role,
        content: contentItems.some((part) => part.type !== 'text')
          ? contentItems
          : contentItems.map((part) => part.text || '').join(''),
      })
      continue
    }

    flushPendingUserParts()
    messages.push({
      role: item.role || 'user',
      content: typeof item.content === 'string' ? item.content : '',
    })
  }

  flushPendingUserParts()
  return messages
}

function responsesToOpenAIBody(body) {
  return {
    model: body.model,
    stream: Boolean(body.stream),
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    tool_choice: body.tool_choice,
    parallel_tool_calls: body.parallel_tool_calls,
    instructions: body.instructions,
    messages: [
      ...(body.instructions ? [{ role: 'system', content: body.instructions }] : []),
      ...flattenResponseInput(body.input),
    ],
  }
}

function buildResponseUsage(usage) {
  const promptTokens = Math.max(0, usage?.prompt_tokens || 0)
  const completionTokens = Math.max(0, usage?.completion_tokens || 0)
  const reasoningTokens = Math.max(0, usage?.completion_tokens_details?.reasoning_tokens || usage?.reasoning_tokens || 0)
  return {
    input_tokens: promptTokens,
    output_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    output_tokens_details: {
      reasoning_tokens: reasoningTokens,
    }
  }
}

function buildReasoningOutputItem(reasoningContent) {
  if (!reasoningContent) return null
  return {
    type: 'reasoning',
    id: `rs_${generateUUID()}`,
    summary: [{ type: 'summary_text', text: reasoningContent }],
  }
}

function buildResponseOutputFromMessage(message) {
  const output = []

  if (message?.content) {
    output.push({
      type: 'message',
      id: `msg_${generateUUID()}`,
      role: 'assistant',
      content: [{ type: 'output_text', text: message.content }],
    })
  }

  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      output.push({
        type: 'function_call',
        id: tc.id || generateUUID(),
        call_id: tc.id || generateUUID(),
        name: tc.function?.name || '',
        arguments: tc.function?.arguments || '{}',
      })
    }
  }

  const reasoningItem = buildReasoningOutputItem(message?.reasoning_content)
  if (reasoningItem) {
    output.push(reasoningItem)
  }

  return output
}

function buildResponseObject(model, openaiResponse) {
  const choice = openaiResponse?.choices?.[0] || {}
  const message = choice.message || { role: 'assistant', content: '' }
  return {
    id: `resp_${generateUUID()}`,
    object: 'response',
    created_at: Math.round(Date.now() / 1000),
    status: 'completed',
    model,
    output: buildResponseOutputFromMessage(message),
    usage: buildResponseUsage(openaiResponse?.usage),
  }
}

function buildInProgressResponseObject(model, responseId) {
  return {
    id: responseId || `resp_${generateUUID()}`,
    object: 'response',
    created_at: Math.round(Date.now() / 1000),
    status: 'in_progress',
    model,
    output: [],
  }
}

function buildFailedResponseObject(model, responseId, error) {
  const message = error?.message || String(error || 'Internal server error')
  return {
    id: responseId || `resp_${generateUUID()}`,
    object: 'response',
    created_at: Math.round(Date.now() / 1000),
    status: 'failed',
    model,
    error: {
      message,
      type: 'server_error',
    },
  }
}

function buildCancelledResponseObject(baseResponse, metadata = null) {
  const response = {
    id: baseResponse?.id || `resp_${generateUUID()}`,
    object: 'response',
    created_at: Number(baseResponse?.created_at) || Math.round(Date.now() / 1000),
    status: 'cancelled',
    model: baseResponse?.model || 'unknown',
    output: Array.isArray(baseResponse?.output) ? baseResponse.output : [],
  }
  if (baseResponse?.usage) {
    response.usage = baseResponse.usage
  }
  return attachResponseMetadata(response, metadata || baseResponse?.metadata || null)
}

function attachResponseMetadata(responseObject, metadata) {
  if (!responseObject || typeof responseObject !== 'object') return responseObject
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return responseObject
  const normalized = { ...metadata }
  if (Object.keys(normalized).length === 0) return responseObject
  return {
    ...responseObject,
    metadata: normalized,
  }
}

async function sendFailedResponsesStream(res, req, model, error, responseId = null, metadata = null) {
  const failedResponse = await saveResponseObject(req, attachResponseMetadata(buildFailedResponseObject(model, responseId, error), metadata))
  res.write(`event: response.failed\ndata: ${JSON.stringify({
    type: 'response.failed',
    response: failedResponse,
  })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
  return failedResponse
}

function registerActiveResponse(responseId, owner, cancel) {
  activeResponses.set(responseId, {
    owner,
    cancel,
  })
}

function clearActiveResponse(responseId) {
  activeResponses.delete(responseId)
}

async function cancelActiveResponse(req, responseId) {
  const active = activeResponses.get(responseId)
  if (!active) {
    return null
  }
  const requester = responseStoreApi.ownerOf(req)
  if (active.owner !== requester) {
    return { status: 404, response: null }
  }
  const response = await active.cancel(req)
  return { status: 200, response }
}

function accumulateOpenAIChatResponse(response, requestBody = null, toolcallEnabled = false) {
  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let fullContent = ''
    let reasoningContent = ''
    let totalTokens = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    const toolCallsByIndex = new Map()

    response.on('data', (chunk) => {
      const decodeText = decoder.decode(chunk, { stream: true })
      buffer += decodeText

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data)
          if (parsed.usage) {
            totalTokens = {
              prompt_tokens: parsed.usage.prompt_tokens || totalTokens.prompt_tokens,
              completion_tokens: parsed.usage.completion_tokens || totalTokens.completion_tokens,
              total_tokens: parsed.usage.total_tokens || totalTokens.total_tokens,
            }
          }

          const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta
          if (!delta) continue

          if (delta.reasoning_content) reasoningContent += delta.reasoning_content
          if (delta.content) fullContent += delta.content
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = typeof tc?.index === 'number' ? tc.index : 0
              const existing = toolCallsByIndex.get(idx) || { id: '', name: '', arguments: '' }
              if (tc.id) existing.id = tc.id
              if (tc.function?.name) existing.name = tc.function.name
              if (typeof tc.function?.arguments === 'string') {
                existing.arguments += tc.function.arguments
              }
              toolCallsByIndex.set(idx, existing)
            }
          }
        } catch (error) {
          logger.debug('Responses stream JSON chunk parse skipped', 'RESPONSES', '', buildRequestLogMeta(null, { error: error && error.message ? error.message : error }))
        }
      }
    })

    response.on('end', async () => {
      const message = { role: 'assistant', content: fullContent }
      if (reasoningContent) {
        message.reasoning_content = reasoningContent
      }

      let finish_reason = 'stop'
      if (toolCallsByIndex.size > 0) {
        const sortedIndices = [...toolCallsByIndex.keys()].sort((a, b) => a - b)
        message.tool_calls = sortedIndices.map((index) => {
          const tc = toolCallsByIndex.get(index)
          return {
            id: tc.id || `call_${Date.now()}_${index}`,
            type: 'function',
            function: {
              name: tc.name,
              arguments: tc.arguments || '{}',
            }
          }
        })
        finish_reason = 'tool_calls'
      } else if (toolcallEnabled && fullContent) {
        const parsed = parseToolCallsFromText(fullContent)
        if (parsed.toolCalls.length > 0) {
          message.content = parsed.content
          message.tool_calls = parsed.toolCalls
          finish_reason = 'tool_calls'
        }
      }

      if (totalTokens.prompt_tokens === 0 && totalTokens.completion_tokens === 0) {
        totalTokens = createUsageObject(requestBody?.messages || '', fullContent + reasoningContent, null)
      }

      totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0)
      totalTokens.completion_tokens = Math.max(0, totalTokens.completion_tokens || 0)
      totalTokens.total_tokens = totalTokens.prompt_tokens + totalTokens.completion_tokens

      resolve({
        id: `chatcmpl-${generateUUID()}`,
        object: 'chat.completion',
        created: Math.round(Date.now() / 1000),
        choices: [{ index: 0, message, finish_reason }],
        usage: totalTokens,
      })
    })

    response.on('error', (err) => reject(err))
  })
}

function streamChatToResponses(res, response, model, responseId, requestBody = null, toolcallEnabled = false, req = null, responseMetadata = null) {
  return new Promise((resolve, reject) => {
    let settled = false
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let textBuffer = ''
    let reasoningBuffer = ''
    let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    const toolCallsByIndex = new Map()
    const sieve = toolcallEnabled ? createSieve() : null
    const outputItems = []
    let messageItem = null
    let messageContentPart = null

    const writeEvent = (event, data) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    registerActiveResponse(responseId, responseStoreApi.ownerOf(req), async (cancelReq) => {
      if (settled) {
        const existing = await getStoredResponse(cancelReq || req, responseId)
        return existing.response || null
      }
      settled = true
      clearActiveResponse(responseId)
      const current = await getStoredResponse(cancelReq || req, responseId)
      const cancelledResponse = await saveResponseObject(req, buildCancelledResponseObject(current.response || buildInProgressResponseObject(model, responseId), responseMetadata))
      try {
        writeEvent('response.cancelled', {
          type: 'response.cancelled',
          response: cancelledResponse,
        })
        res.write('data: [DONE]\n\n')
        res.end()
      } catch (error) {
        logger.warn('Responses cancel stream finalize failed', 'RESPONSES', '', buildRequestLogMeta(req, { error: error && error.message ? error.message : error, response_id: responseId }))
      }
      if (response && typeof response.destroy === 'function') {
        response.destroy(new Error('Response cancelled'))
      }
      resolve()
      return cancelledResponse
    })

    const failStream = async (error) => {
      if (settled) return
      settled = true
      clearActiveResponse(responseId)
      try {
        logger.error('Responses stream failed', 'RESPONSES', '', buildRequestLogMeta(req, { error: error && error.message ? error.message : error, model }))
        await sendFailedResponsesStream(res, req, model, error, responseId, responseMetadata)
        resolve()
      } catch (streamError) {
        reject(streamError)
      }
    }

    const ensureMessageItem = () => {
      if (messageItem) return messageItem
      messageItem = {
        type: 'message',
        id: `msg_${generateUUID()}`,
        role: 'assistant',
        content: [],
      }
      outputItems.push(messageItem)
      writeEvent('response.output_item.added', {
        type: 'response.output_item.added',
        id: responseId,
        response_id: responseId,
        output_index: outputItems.length - 1,
        item_id: messageItem.id,
        item: messageItem,
      })
      return messageItem
    }

    const ensureMessageContentPart = () => {
      const item = ensureMessageItem()
      if (messageContentPart) return messageContentPart
      messageContentPart = { type: 'output_text', text: '' }
      item.content.push(messageContentPart)
      writeEvent('response.content_part.added', {
        type: 'response.content_part.added',
        id: responseId,
        response_id: responseId,
        item_id: item.id,
        output_index: outputItems.indexOf(item),
        content_index: item.content.length - 1,
        part: messageContentPart,
      })
      return messageContentPart
    }

    const emitOutputText = (text) => {
      if (!text) return
      const item = ensureMessageItem()
      const part = ensureMessageContentPart()
      textBuffer += text
      part.text += text
      writeEvent('response.output_text.delta', {
        type: 'response.output_text.delta',
        id: responseId,
        response_id: responseId,
        item_id: item.id,
        output_index: outputItems.indexOf(item),
        content_index: item.content.indexOf(part),
        delta: text,
      })
    }

    const emitReasoningText = (text) => {
      if (!text) return
      reasoningBuffer += text
      writeEvent('response.reasoning.delta', {
        type: 'response.reasoning.delta',
        id: responseId,
        response_id: responseId,
        delta: text,
      })
    }

    const ensureToolCallItem = (index, delta) => {
      const existing = toolCallsByIndex.get(index)
      if (existing) return existing
      const item = {
        id: delta?.id || `call_${generateUUID()}`,
        name: '',
        arguments: '',
        outputIndex: outputItems.length,
        added: false,
      }
      toolCallsByIndex.set(index, item)
      return item
    }

    const emitToolCalls = (deltas) => {
      if (!Array.isArray(deltas) || deltas.length === 0) return
      for (const delta of deltas) {
        const index = typeof delta.index === 'number' ? delta.index : 0
        const existing = ensureToolCallItem(index, delta)
        if (delta.id) existing.id = delta.id
        if (delta.function?.name) existing.name = delta.function.name
        if (!existing.added) {
          const item = {
            type: 'function_call',
            id: existing.id,
            call_id: existing.id,
            name: existing.name || '',
            arguments: '',
          }
          outputItems.push(item)
          existing.outputIndex = outputItems.length - 1
          existing.added = true
          writeEvent('response.output_item.added', {
            type: 'response.output_item.added',
            id: responseId,
            response_id: responseId,
            output_index: existing.outputIndex,
            item_id: existing.id,
            item,
          })
        }
        if (typeof delta.function?.arguments === 'string') {
          existing.arguments += delta.function.arguments
          writeEvent('response.function_call_arguments.delta', {
            type: 'response.function_call_arguments.delta',
            id: responseId,
            response_id: responseId,
            item_id: existing.id,
            output_index: existing.outputIndex,
            call_id: existing.id,
            delta: delta.function.arguments,
          })
        }
        toolCallsByIndex.set(index, existing)
      }
    }

    writeEvent('response.created', {
      type: 'response.created',
      id: responseId,
      response_id: responseId,
      object: 'response',
      model,
      status: 'in_progress',
    })

    response.on('data', (chunk) => {
      const decodeText = decoder.decode(chunk, { stream: true })
      buffer += decodeText

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        const data = trimmed.slice(6)
        if (data === '[DONE]') continue
        if (!isJson(data)) continue

        try {
          const parsed = JSON.parse(data)
          if (parsed.usage) {
            usage = {
              prompt_tokens: parsed.usage.prompt_tokens || usage.prompt_tokens,
              completion_tokens: parsed.usage.completion_tokens || usage.completion_tokens,
              total_tokens: parsed.usage.total_tokens || usage.total_tokens,
            }
          }

          if (!Array.isArray(parsed.choices) || parsed.choices.length === 0) continue
          const delta = parsed.choices[0].delta
          if (!delta) continue

          if (delta.reasoning_content) {
            emitReasoningText(delta.reasoning_content)
          }

          if (delta.content) {
            if (sieve) {
              const out = sieve.push(delta.content)
              if (out.textDelta) emitOutputText(out.textDelta)
              if (out.toolCallsDelta) emitToolCalls(out.toolCallsDelta)
            } else {
              emitOutputText(delta.content)
            }
          }

          if (Array.isArray(delta.tool_calls)) {
            emitToolCalls(delta.tool_calls)
          }
        } catch (error) {
          logger.debug('Responses stream JSON chunk parse skipped', 'RESPONSES', '', buildRequestLogMeta(req, { error: error && error.message ? error.message : error }))
        }
      }
    })

    response.on('end', async () => {
      if (settled) return
      try {
        if (sieve) {
          const out = sieve.flush()
          if (out.textDelta) emitOutputText(out.textDelta)
          if (out.toolCallsDelta) emitToolCalls(out.toolCallsDelta)
        }

        const output = []
        if (messageItem) {
          output.push({
            type: 'message',
            id: messageItem.id,
            role: 'assistant',
            content: [{ type: 'output_text', text: textBuffer }],
          })
        }

        const sortedToolCalls = [...toolCallsByIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, tc]) => tc)

        for (const tc of sortedToolCalls) {
          const item = {
            type: 'function_call',
            id: tc.id,
            call_id: tc.id,
            name: tc.name || '',
            arguments: tc.arguments || '{}',
          }
          output.push(item)
          writeEvent('response.function_call_arguments.done', {
            type: 'response.function_call_arguments.done',
            id: responseId,
            response_id: responseId,
            item_id: tc.id,
            output_index: tc.outputIndex,
            call_id: tc.id,
            name: item.name,
            arguments: item.arguments,
          })
          writeEvent('response.output_item.done', {
            type: 'response.output_item.done',
            id: responseId,
            response_id: responseId,
            output_index: tc.outputIndex,
            item_id: tc.id,
            item,
          })
        }

        const reasoningItem = buildReasoningOutputItem(reasoningBuffer)
        if (reasoningItem) {
          output.push(reasoningItem)
        }

        if (messageItem && messageContentPart) {
          writeEvent('response.output_text.done', {
            type: 'response.output_text.done',
            id: responseId,
            response_id: responseId,
            item_id: messageItem.id,
            output_index: output.findIndex((item) => item.id === messageItem.id),
            content_index: 0,
            text: textBuffer,
          })
          writeEvent('response.content_part.done', {
            type: 'response.content_part.done',
            id: responseId,
            response_id: responseId,
            item_id: messageItem.id,
            output_index: output.findIndex((item) => item.id === messageItem.id),
            content_index: 0,
            part: { type: 'output_text', text: textBuffer },
          })
          writeEvent('response.output_item.done', {
            type: 'response.output_item.done',
            id: responseId,
            response_id: responseId,
            output_index: output.findIndex((item) => item.id === messageItem.id),
            item_id: messageItem.id,
            item: output.find((item) => item.id === messageItem.id),
          })
        }

        if (usage.prompt_tokens === 0 && usage.completion_tokens === 0) {
          const computed = createUsageObject(requestBody?.messages || '', textBuffer, null)
          usage = {
            prompt_tokens: Math.max(0, computed.prompt_tokens || 0),
            completion_tokens: Math.max(0, computed.completion_tokens || 0),
            total_tokens: Math.max(0, computed.total_tokens || 0),
          }
        }

        const responseObject = await saveResponseObject(req, attachResponseMetadata({
          id: responseId,
          object: 'response',
          created_at: Math.round(Date.now() / 1000),
          status: 'completed',
          model,
          output,
          usage: buildResponseUsage(usage),
        }, responseMetadata))

        writeEvent('response.completed', {
          type: 'response.completed',
          response: responseObject,
        })
        res.write('data: [DONE]\n\n')
        res.end()
        settled = true
        clearActiveResponse(responseId)
        resolve()
      } catch (err) {
        clearActiveResponse(responseId)
        reject(err)
      }
    })

    response.on('error', (err) => failStream(err))
  })
}

async function handleResponses(req, res) {
  try {
    const requestedBody = req.body
    const responseMetadata = requestedBody?.metadata && typeof requestedBody.metadata === 'object' && !Array.isArray(requestedBody.metadata)
      ? { ...requestedBody.metadata }
      : null
    req.responses_metadata = responseMetadata
    const openaiBody = responsesToOpenAIBody(requestedBody)
    req.body = openaiBody

    await new Promise((resolve, reject) => {
      processRequestBody(req, res, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    const responseData = await sendChatRequest(req.body)
    const responseId = `resp_${generateUUID()}`
    if (!responseData.status || !responseData.response) {
      const failedResponse = await saveResponseObject(req, attachResponseMetadata(buildFailedResponseObject(requestedBody.model || openaiBody.model || req.body.model, responseId, new Error('Failed to send request to upstream')), responseMetadata))
      if (requestedBody.stream) {
        res.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        })
        await sendFailedResponsesStream(res, req, requestedBody.model || openaiBody.model || req.body.model, new Error('Failed to send request to upstream'), failedResponse.id, responseMetadata)
        return
      }
      return res.status(500).json(failedResponse)
    }

    const requestedModel = requestedBody.model || openaiBody.model || req.body.model
    if (requestedBody.stream) {
      await saveResponseObject(req, attachResponseMetadata(buildInProgressResponseObject(requestedModel, responseId), responseMetadata))
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      await streamChatToResponses(res, responseData.response, requestedModel, responseId, req.body, req.toolcall_enabled, req, responseMetadata)
      return
    }

    const openaiResponse = await accumulateOpenAIChatResponse(responseData.response, req.body, req.toolcall_enabled)
    const completedResponse = attachResponseMetadata(buildResponseObject(requestedModel, openaiResponse), responseMetadata)
    completedResponse.id = responseId
    res.json(await saveResponseObject(req, completedResponse))
  } catch (error) {
    logger.error('Responses API error', 'RESPONSES', '', buildRequestLogMeta(req, { error: error && error.message ? error.message : error, model: req.body?.model || 'unknown' }))
    const failedResponse = await saveResponseObject(req, attachResponseMetadata(buildFailedResponseObject(req.body?.model || 'unknown', null, error), req.responses_metadata))
    if (req.body?.stream && !res.headersSent) {
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      })
      await sendFailedResponsesStream(res, req, req.body?.model || 'unknown', error, failedResponse.id, req.responses_metadata)
      return
    }
    if (res.headersSent) {
      return
    }
    res.status(500).json(failedResponse)
  }
}

async function handleCancelResponse(req, res) {
  const activeResult = await cancelActiveResponse(req, req.params.responseId)
  if (activeResult?.status === 200 && activeResult.response) {
    return res.json(activeResult.response)
  }
  if (activeResult?.status === 404) {
    return res.status(404).json(buildRouteErrorBody(req, 'Response not found', 'response_not_found'))
  }

  const stored = await getStoredResponse(req, req.params.responseId)
  if (stored.status !== 200 || !stored.response) {
    return res.status(404).json(buildRouteErrorBody(req, 'Response not found', 'response_not_found'))
  }

  if (String(stored.response.status || '').toLowerCase() === 'cancelled') {
    return res.json(stored.response)
  }

  return res.status(409).json(buildRouteErrorBody(req, 'Response is not in progress', 'response_not_cancellable'))
}

async function handleGetResponse(req, res) {
  const result = await getStoredResponse(req, req.params.responseId)
  if (result.status !== 200 || !result.response) {
    return res.status(404).json(buildRouteErrorBody(req, 'Response not found', 'response_not_found'))
  }
  return res.json(result.response)
}

async function handleListResponses(req, res) {
  const result = await listStoredResponses(req, req.query || {})
  if (result.status && result.status !== 200) {
    return res.status(result.status).json(buildRouteErrorBody(req, result.error?.message || 'Invalid request', result.error?.type || 'invalid_request_error'))
  }
  return res.json(result)
}

async function handleDeleteResponse(req, res) {
  const result = await deleteStoredResponse(req, req.params.responseId)
  if (result.status !== 200) {
    return res.status(404).json(buildRouteErrorBody(req, 'Response not found', 'response_not_found'))
  }
  return res.json({
    id: req.params.responseId,
    object: 'response.deleted',
    deleted: true,
  })
}

router.post('/v1/responses', apiKeyVerify, handleResponses)
router.get('/v1/responses', apiKeyVerify, handleListResponses)
router.get('/v1/responses/:responseId', apiKeyVerify, handleGetResponse)
router.post('/v1/responses/:responseId/cancel', apiKeyVerify, handleCancelResponse)
router.delete('/v1/responses/:responseId', apiKeyVerify, handleDeleteResponse)

module.exports = router
module.exports.getResponseStoreStatus = getResponseStoreStatus
