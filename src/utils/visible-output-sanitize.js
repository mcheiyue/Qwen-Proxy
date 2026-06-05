'use strict'

const THINKING_PREFIX_PATTERNS = [
  /^(?:thinking process|reasoning process|internal reasoning)\s*:\s*/i,
  /^(?:thinking|thought process)\s*[:：]\s*/i,
  /^(?:let'?s think step by step|let us think step by step)\s*[:：-]?\s*/i,
  /^(?:思考过程|思考|推理过程)\s*[:：]\s*/,
]

const ENUMERATED_THINKING_HEADER_PATTERN = /^(?:thinking process|reasoning process)\s*:\s*\n+/i
const ANALYZE_REQUEST_PATTERN = /^\s*\d+\.\s*\*\*analyze the request\*\*\s*:/i
const ANSWER_MARKER_PATTERN = /(?:^|\n)\s*(?:final answer|answer|最终答案|回答)\s*[:：]\s*/i
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
  out = collapseVisibleWhitespace(out)
  return out
}

module.exports = {
  sanitizeVisibleOutput,
}
