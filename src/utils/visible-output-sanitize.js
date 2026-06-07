'use strict'

const THINKING_PREFIX_PATTERNS = [
  /^(?:thinking process|reasoning process|internal reasoning)\s*:\s*/i,
  /^here(?:'s| is)\s+(?:a\s+)?(?:thinking|reasoning|thought)\s+process\s*:\s*/i,
  /^(?:thinking|thought process)\s*[:：]\s*/i,
  /^(?:let'?s think step by step|let us think step by step)\s*[:：-]?\s*/i,
  /^(?:思考过程|思考|推理过程)\s*[:：]\s*/,
  /^\s*\*\*(?:thinking process|reasoning process|thought process|思考过程|推理过程)\*\*\s*[:：]\s*/i,
]

const ENUMERATED_THINKING_HEADER_PATTERN = /^(?:thinking process|reasoning process)\s*:\s*\n+/i
const ANALYZE_REQUEST_PATTERN = /^\s*\d+\.\s*\*\*analyze the request\*\*\s*:/i
const ANSWER_MARKER_PATTERN = /(?:^|\n)\s*(?:final answer|answer|最终答案|回答|一句话介绍)\s*[:：]\s*/i
const META_ANALYSIS_PATTERNS = [
  /^\s*(?:the user wants me to|the user asked me to|the user is asking me to)\b[\s\S]*?(?=\n\s*(?:i am|i'm|我是|the safest approach is|最稳妥的做法是)|$)/i,
  /^\s*(?:用户设定了我的身份为|用户将我的身份设定为|用户要求我|用户希望我|用户现在要我)[\s\S]*?(?=\n\s*(?:我是|我会|最稳妥的做法是)|$)/,
  /^\s*\*\*(?:思考过程|thinking process|reasoning process)\*\*\s*[:：][\s\S]*?(?=\n\s*\*\*(?:最终答案|一句话介绍|answer|final answer)\*\*\s*[:：]|$)/i,
]
const MALFORMED_PROTOCOL_PATTERNS = [
  /<\|DSML\|[^>\n]*>?/gi,
  /<\/\|DSML\|[^>\n]*>?/gi,
  /<parameter=[^>\n]*(?:>|$)/gi,
  /<\/?tool_calls>/gi,
  /<\/?invoke[^>]*>/gi,
  /<\/?parameter[^>]*>/gi,
  /<\/function>/gi,
  /<\/?think>/gi,
  /<\|tool\|>\s*\{[\s\S]*?"tool_call_id"\s*:\s*"call[^"]*"\s*\}/gi,
]

function collapseVisibleWhitespace(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stripThinkingPrefix(text) {
  let out = text
  let matchedPrefix = false
  for (const pattern of THINKING_PREFIX_PATTERNS) {
    const next = out.replace(pattern, '')
    if (next !== out) matchedPrefix = true
    out = next
  }

  const hasEnumeratedThinking = ENUMERATED_THINKING_HEADER_PATTERN.test(out) || ANALYZE_REQUEST_PATTERN.test(out)
  if (matchedPrefix || hasEnumeratedThinking) {
    const answerMarker = ANSWER_MARKER_PATTERN.exec(out)
    if (answerMarker && typeof answerMarker.index === 'number') {
      out = out.slice(answerMarker.index + answerMarker[0].length).trim()
      return out
    }

    const answerStarters = [
      /^\s*(?:i am|我是|the safest approach is|最稳妥的做法是)\b/i,
    ]
    for (const starter of answerStarters) {
      if (starter.test(out)) {
        return out.trim()
      }
    }

    if (ANALYZE_REQUEST_PATTERN.test(out)) {
      out = out.replace(/^\s*(?:\d+\.\s*\*\*analyze the request\*\*\s*:[\s\S]*)$/i, '').trim()
    }
  }

  return out
}

function stripMetaAnalysis(text) {
  let out = text
  for (const pattern of META_ANALYSIS_PATTERNS) {
    const next = out.replace(pattern, '')
    out = next
  }

  const markdownAnswerMarkers = [
    /(?:^|\n)\s*\*\*(?:最终答案|answer|final answer|一句话介绍)\*\*\s*[:：]\s*/i,
  ]
  for (const marker of markdownAnswerMarkers) {
    const hit = marker.exec(out)
    if (hit && typeof hit.index === 'number') {
      out = out.slice(hit.index + hit[0].length).trim()
      break
    }
  }

  return out
}

function stripMalformedProtocol(text) {
  let out = text
  for (const pattern of MALFORMED_PROTOCOL_PATTERNS) {
    out = out.replace(pattern, '')
  }
  return out
}

function sanitizeVisibleOutput(text) {
  if (typeof text !== 'string' || !text) return text || ''
  let out = text
  out = stripMalformedProtocol(out)
  out = stripThinkingPrefix(out)
  out = stripMetaAnalysis(out)
  out = collapseVisibleWhitespace(out)
  return out
}

function sanitizeVisibleDelta(text) {
  if (typeof text !== 'string' || !text) return text || ''
  let out = text
  out = stripMalformedProtocol(out)
  out = out
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
  return out
}

function isThinkingTag(tag) {
  return /^<\/?(?:think|thinking)>$/i.test(tag)
}

function isOpeningThinkingTag(tag) {
  return /^<(?:think|thinking)>$/i.test(tag)
}

function isPartialThinkingTag(text) {
  if (typeof text !== 'string' || !text.startsWith('<')) return false
  const lower = text.toLowerCase()
  return ['<think>', '</think>', '<thinking>', '</thinking>'].some((tag) => tag.startsWith(lower))
}

function createThinkingBlockStripper() {
  let pending = ''
  let insideThinking = false

  const push = (chunk) => {
    if (typeof chunk !== 'string' || !chunk) return ''
    const input = pending + chunk
    pending = ''
    let output = ''
    let index = 0

    while (index < input.length) {
      const char = input[index]
      if (char !== '<') {
        if (!insideThinking) output += char
        index += 1
        continue
      }

      const closeIndex = input.indexOf('>', index)
      if (closeIndex === -1) {
        pending = input.slice(index)
        break
      }

      const tag = input.slice(index, closeIndex + 1)
      if (isThinkingTag(tag)) {
        insideThinking = isOpeningThinkingTag(tag)
        index = closeIndex + 1
        continue
      }

      if (!insideThinking) output += tag
      index = closeIndex + 1
    }

    return output
  }

  const flush = () => {
    const tail = pending
    pending = ''
    if (insideThinking) {
      insideThinking = false
      return ''
    }
    if (isPartialThinkingTag(tail)) return ''
    return tail
  }

  return { push, flush }
}

module.exports = {
  createThinkingBlockStripper,
  sanitizeVisibleDelta,
  sanitizeVisibleOutput,
}
