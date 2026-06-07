const test = require('node:test')
const assert = require('node:assert/strict')

const { parseToolCallsFromText, parseToolCallsFromTextSources, resolveToolCallTools } = require('../../src/utils/toolcall.js')
const { sanitizeVisibleOutput } = require('../../src/utils/visible-output-sanitize.js')

const smokeTools = [{
  type: 'function',
  function: {
    name: 'get_smoke_status',
    description: 'Return the current gray smoke status.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
      },
      required: ['target'],
    },
  },
}]

const multiTools = [
  ...smokeTools,
  {
    type: 'function',
    function: {
      name: 'search_files',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
    },
  },
]

test('fallback parses bare CDATA JSON as tool call for single tool', () => {
  const parsed = parseToolCallsFromText('<![CDATA[{"target":"gray-smoke"}]]>', smokeTools)

  assert.equal(parsed.content, '')
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].type, 'function')
  assert.equal(parsed.toolCalls[0].function.name, 'get_smoke_status')
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { target: 'gray-smoke' })
})

test('fallback preserves surrounding content while removing CDATA tool payload', () => {
  const parsed = parseToolCallsFromText('calling now <![CDATA[{"target":"gray-smoke"}]]>', smokeTools)

  assert.equal(parsed.content, 'calling now')
  assert.equal(parsed.toolCalls.length, 1)
})

test('fallback parses QNML-like named JSON block', () => {
  const parsed = parseToolCallsFromText('<get_smoke_status>{"target":"gray-smoke"}</get_smoke_status>', multiTools)

  assert.equal(parsed.content, '')
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'get_smoke_status')
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { target: 'gray-smoke' })
})

test('fallback parses bare JSON only when schema keys identify a tool', () => {
  const parsed = parseToolCallsFromText('{"query":"needle"}', multiTools)

  assert.equal(parsed.content, '')
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'search_files')
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { query: 'needle' })
})

test('fallback does not treat unrelated bare JSON as a single-tool call', () => {
  const parsed = parseToolCallsFromText('{"message":"hello"}', smokeTools)

  assert.equal(parsed.content, '{"message":"hello"}')
  assert.equal(parsed.toolCalls.length, 0)
})

test('fallback ignores invalid CDATA JSON', () => {
  const parsed = parseToolCallsFromText('<![CDATA[not json]]>', smokeTools)

  assert.equal(parsed.content, '<![CDATA[not json]]>')
  assert.equal(parsed.toolCalls.length, 0)
})

test('existing DSML parser still takes precedence over fallback', () => {
  const dsml = [
    '<|DSML|tool_calls>',
    '  <|DSML|invoke name="get_smoke_status">',
    '    <|DSML|parameter name="target"><![CDATA[gray-smoke]]></|DSML|parameter>',
    '  </|DSML|invoke>',
    '</|DSML|tool_calls>',
  ].join('\n')
  const parsed = parseToolCallsFromText(dsml, smokeTools)

  assert.equal(parsed.content, '')
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'get_smoke_status')
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { target: 'gray-smoke' })
})

test('tool calls must be parsed before visible output sanitization strips DSML markers', () => {
  const dsml = [
    '<|DSML|tool_calls>',
    '  <|DSML|invoke name="get_smoke_status">',
    '    <|DSML|parameter name="target"><![CDATA[opencode-tool-check]]></|DSML|parameter>',
    '  </|DSML|invoke>',
    '</|DSML|tool_calls>',
  ].join('\n')

  const parsedRaw = parseToolCallsFromText(dsml, smokeTools)
  const sanitized = sanitizeVisibleOutput(dsml)
  const parsedSanitized = parseToolCallsFromText(sanitized, smokeTools)

  assert.equal(parsedRaw.content, '')
  assert.equal(parsedRaw.toolCalls.length, 1)
  assert.equal(parsedRaw.toolCalls[0].function.name, 'get_smoke_status')
  assert.deepEqual(JSON.parse(parsedRaw.toolCalls[0].function.arguments), { target: 'opencode-tool-check' })
  assert.equal(parsedSanitized.toolCalls.length, 0)
})

test('resolveToolCallTools falls back to middleware preserved tools', () => {
  const upstreamBodyAfterMiddleware = { messages: [{ role: 'user', content: 'hi' }] }
  const req = { toolcall_tools: smokeTools }

  assert.equal(resolveToolCallTools(upstreamBodyAfterMiddleware, req), smokeTools)
})

test('fallback parses CDATA when middleware removed tools from request body', () => {
  const upstreamBodyAfterMiddleware = { messages: [{ role: 'user', content: 'hi' }] }
  const req = { toolcall_tools: smokeTools }
  const parsed = parseToolCallsFromText(
    '<![CDATA[{"target": "gray-smoke"}]]>',
    resolveToolCallTools(upstreamBodyAfterMiddleware, req)
  )

  assert.equal(parsed.content, '')
  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'get_smoke_status')
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { target: 'gray-smoke' })
})

test('fallback scans reasoning source when visible prose has no tool call', () => {
  const visible = 'I will call the required tool now.'
  const reasoning = [
    'Need to satisfy tool_choice=required.',
    '<|DSML|tool_calls>',
    '  <|DSML|invoke name="get_smoke_status">',
    '    <|DSML|parameter name="target"><![CDATA[opencode-tool-check]]></|DSML|parameter>',
    '  </|DSML|invoke>',
    '</|DSML|tool_calls>',
  ].join('\n')

  const parsed = parseToolCallsFromTextSources([visible, reasoning], smokeTools)

  assert.equal(parsed.toolCalls.length, 1)
  assert.equal(parsed.toolCalls[0].function.name, 'get_smoke_status')
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), { target: 'opencode-tool-check' })
})
