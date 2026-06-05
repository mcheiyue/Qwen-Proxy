#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:17860'
const DEFAULT_MODEL = 'qwen3.7-plus'

const args = new Set(process.argv.slice(2))
const helpMode = args.has('--help') || args.has('-h')
const thinkingMode = args.has('--thinking')

const baseUrl = (process.env.SMOKE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')
const apiKey = process.env.SMOKE_API_KEY || process.env.API_KEY || ''
const model = process.env.SMOKE_MODEL || process.env.DEFAULT_MODEL || DEFAULT_MODEL
const thinkingModel = process.env.SMOKE_THINKING_MODEL || (model.endsWith('-thinking') ? model : `${model}-thinking`)
const timeoutMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS || '30000', 10)

function printHelp() {
  console.log(`Usage: npm run smoke:opencode -- [--thinking]\n\nEnvironment:\n  SMOKE_BASE_URL         Base URL to test. Default: ${DEFAULT_BASE_URL}\n  SMOKE_API_KEY          API key for protected endpoints. Falls back to API_KEY.\n  SMOKE_MODEL            Base model for OpenCode-like scenarios. Default: ${DEFAULT_MODEL}\n  SMOKE_THINKING_MODEL   Optional explicit thinking model. Defaults to <SMOKE_MODEL>-thinking.\n  SMOKE_TIMEOUT_MS       Per-request timeout. Default: 30000\n\nModes:\n  default                Run the OpenCode request matrix (12 checks) without thinking scenarios.\n  --thinking             Also verify a Responses stream scenario with a thinking-enabled model suffix.\n`)
}

function authHeaders(extra = {}) {
  return apiKey ? { ...extra, Authorization: `Bearer ${apiKey}` } : extra
}

function developerMessage() {
  return {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'You are OpenCode, the best coding agent on the planet.' }],
  }
}

function userMessage(text) {
  return {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text }],
  }
}

function toolCallItem(name, callId, argsObject) {
  return {
    type: 'function_call',
    call_id: callId,
    name,
    arguments: JSON.stringify(argsObject || {}),
  }
}

function toolOutputItem(callId, output) {
  return {
    type: 'function_call_output',
    call_id: callId,
    output: typeof output === 'string' ? output : JSON.stringify(output),
  }
}

function smokeTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'get_smoke_status',
        description: 'Return the current OpenCode smoke status.',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'The smoke scenario identifier.' },
          },
          required: ['target'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Read a file path and return its content.',
        parameters: {
          type: 'object',
          properties: {
            filePath: { type: 'string' },
            offset: { type: 'integer' },
            limit: { type: 'integer' },
          },
          required: ['filePath'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'websearch_web_search_exa',
        description: 'Search the web and return concise results.',
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
}

async function requestJSON(label, path, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.headers || {}),
      },
    })
    const text = await response.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch (_) {
      body = text
    }
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
    }
    return { label, status: response.status, ms: Date.now() - started, body }
  } finally {
    clearTimeout(timer)
  }
}

async function requestSSE(label, path, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.headers || {}),
      },
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${label} returned HTTP ${response.status}: ${text}`)
    }
    const events = parseSSE(text)
    if (!events.some((event) => event.data === '[DONE]')) {
      throw new Error(`${label}: expected SSE [DONE] marker`)
    }
    return { label, status: response.status, ms: Date.now() - started, text, events }
  } finally {
    clearTimeout(timer)
  }
}

function parseSSE(text) {
  return String(text || '')
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = { event: null, data: '' }
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event.event = line.slice('event:'.length).trim()
        if (line.startsWith('data:')) {
          const data = line.slice('data:'.length).trimStart()
          event.data = event.data ? `${event.data}\n${data}` : data
        }
      }
      return event
    })
}

function parseEventData(event, label) {
  if (!event || !event.data || event.data === '[DONE]') return null
  try {
    return JSON.parse(event.data)
  } catch (_) {
    throw new Error(`${label}: expected JSON SSE data, got ${event.data}`)
  }
}

function assertObject(result, label) {
  if (!result || typeof result.body !== 'object' || Array.isArray(result.body) || result.body === null) {
    throw new Error(`${label}: expected JSON object`)
  }
}

function assertModelList(result, label) {
  assertObject(result, label)
  if (result.body.object !== 'list' || !Array.isArray(result.body.data)) {
    throw new Error(`${label}: expected object=list with data array`)
  }
}

function assertHealth(result) {
  assertObject(result, 'health')
  if (result.body.status !== 'ok') {
    throw new Error(`health: expected status=ok, got ${JSON.stringify(result.body.status)}`)
  }
}

function extractResponseOutputText(body) {
  if (!body || !Array.isArray(body.output)) return ''
  return body.output
    .filter((item) => item && item.type === 'message' && Array.isArray(item.content))
    .flatMap((item) => item.content)
    .filter((part) => part && (part.type === 'output_text' || part.type === 'text'))
    .map((part) => part.text || '')
    .join('')
}

function assertNoProtocolLeak(text, label) {
  const value = String(text || '')
  const forbidden = ['<|DSML|tool_calls>', '<parameter=', '</function>']
  if (forbidden.some((token) => value.includes(token))) {
    throw new Error(`${label}: detected malformed protocol fragment in visible output`)
  }
}

function assertFunctionCallOutput(body, label) {
  assertObject({ body }, label)
  if (body.object !== 'response' || !Array.isArray(body.output)) {
    throw new Error(`${label}: expected response object with output array`)
  }
  const functionCall = body.output.find((item) => item && item.type === 'function_call')
  if (!functionCall) {
    throw new Error(`${label}: expected output to include function_call item`)
  }
  if (!functionCall.call_id || !functionCall.name) {
    throw new Error(`${label}: expected function_call item to include call_id and name`)
  }
  if (functionCall.status && functionCall.status !== 'completed') {
    throw new Error(`${label}: expected function_call status=completed when present`)
  }
}

function assertResponseObject(body, label) {
  assertObject({ body }, label)
  if (body.object !== 'response' || typeof body.id !== 'string' || !body.id) {
    throw new Error(`${label}: expected response object with non-empty id`)
  }
}

function assertResponsesToolStream(events, label) {
  const payloads = events
    .map((event) => ({ event: event.event, payload: parseEventData(event, label) }))
    .filter((entry) => entry.payload)
  const eventNames = new Set(payloads.map((entry) => entry.event || entry.payload.type))
  if (!eventNames.has('response.created') || !eventNames.has('response.completed')) {
    throw new Error(`${label}: missing response.created/response.completed events`)
  }
  const addedFunction = payloads.find((entry) => entry.event === 'response.output_item.added' && entry.payload.item?.type === 'function_call')
  if (!addedFunction) {
    throw new Error(`${label}: missing response.output_item.added for function_call`) 
  }
  if (addedFunction.payload.item.status && addedFunction.payload.item.status !== 'in_progress') {
    throw new Error(`${label}: expected added function_call status=in_progress when present`)
  }
  const hasArgsDelta = payloads.some((entry) => entry.event === 'response.function_call_arguments.delta')
  if (!hasArgsDelta) {
    throw new Error(`${label}: missing response.function_call_arguments.delta`) 
  }
  const hasArgsDone = payloads.some((entry) => entry.event === 'response.function_call_arguments.done')
  if (!hasArgsDone) {
    throw new Error(`${label}: missing response.function_call_arguments.done`) 
  }
  const doneFunction = payloads.find((entry) => entry.event === 'response.output_item.done' && entry.payload.item?.type === 'function_call')
  if (!doneFunction) {
    throw new Error(`${label}: missing response.output_item.done for function_call`) 
  }
  if (doneFunction.payload.item.status && doneFunction.payload.item.status !== 'completed') {
    throw new Error(`${label}: expected done function_call status=completed when present`)
  }
}

function assertChatToolCalls(result, label) {
  assertObject(result, label)
  const toolCalls = result.body?.choices?.[0]?.message?.tool_calls
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    throw new Error(`${label}: expected at least one message.tool_calls entry`)
  }
}

function assertChatToolStream(events, label) {
  let sawToolDelta = false
  let sawToolFinish = false
  for (const event of events) {
    if (!event.data || event.data === '[DONE]') continue
    const payload = parseEventData(event, label)
    if (Array.isArray(payload?.choices)) {
      const choice = payload.choices[0] || {}
      if (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0) {
        sawToolDelta = true
      }
      if (choice.finish_reason === 'tool_calls') {
        sawToolFinish = true
      }
    }
  }
  if (!sawToolDelta || !sawToolFinish) {
    throw new Error(`${label}: expected tool_calls delta and finish_reason=tool_calls`)
  }
}

async function runScenario(results, label, fn) {
  const started = Date.now()
  const details = await fn()
  results.push({ label, ms: Date.now() - started, ...details })
}

async function run() {
  if (helpMode) {
    printHelp()
    return
  }

  console.log(`OpenCode smoke target: ${baseUrl}`)
  console.log(`Base model: ${model}`)
  if (thinkingMode) {
    console.log(`Thinking model: ${thinkingModel}`)
  }
  if (!apiKey) {
    console.log('No SMOKE_API_KEY/API_KEY provided; protected endpoint checks will fail.')
  }

  const results = []
  const sharedTools = smokeTools()

  await runScenario(results, 'health', async () => {
    const result = await requestJSON('health', '/health')
    assertHealth(result)
    return { status: result.status }
  })

  await runScenario(results, 'models', async () => {
    const result = await requestJSON('models', '/v1/models', { headers: authHeaders() })
    assertModelList(result, 'models')
    return { status: result.status }
  })

  await runScenario(results, 'responses basic stream', async () => {
    const result = await requestSSE('responses basic stream', '/v1/responses', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'responses-basic-stream' }),
      body: JSON.stringify({
        model,
        input: [developerMessage(), userMessage('你好')],
        stream: true,
        metadata: { smoke: 'opencode-basic-stream' },
      }),
    })
    const eventNames = new Set(result.events.map((event) => event.event).filter(Boolean))
    if (!eventNames.has('response.created') || !eventNames.has('response.completed')) {
      throw new Error('responses basic stream: expected response.created and response.completed')
    }
    const hasTextDelta = result.events.some((event) => {
      if (event.event !== 'response.output_text.delta') return false
      const payload = parseEventData(event, 'responses basic stream')
      return typeof payload?.delta === 'string' && payload.delta.length > 0
    })
    if (!hasTextDelta) {
      throw new Error('responses basic stream: expected non-empty response.output_text.delta')
    }
    return { status: result.status }
  })

  if (thinkingMode) {
    await runScenario(results, 'responses thinking stream', async () => {
      const result = await requestSSE('responses thinking stream', '/v1/responses', {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'responses-thinking-stream' }),
        body: JSON.stringify({
          model: thinkingModel,
          input: [developerMessage(), userMessage('请简单介绍一下自己，并先思考再回答。')],
          stream: true,
          metadata: { smoke: 'opencode-thinking-stream' },
        }),
      })
      const hasReasoning = result.events.some((event) => {
        if (event.event !== 'response.reasoning.delta') return false
        const payload = parseEventData(event, 'responses thinking stream')
        return typeof payload?.delta === 'string' && payload.delta.length > 0
      })
      if (!hasReasoning) {
        throw new Error('responses thinking stream: expected response.reasoning.delta from thinking model')
      }
      return { status: result.status, model: thinkingModel }
    })
  }

  await runScenario(results, 'responses tools non-stream', async () => {
    const result = await requestJSON('responses tools non-stream', '/v1/responses', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'responses-tools-nonstream' }),
      body: JSON.stringify({
        model,
        input: [developerMessage(), userMessage('Call get_smoke_status with target set to opencode-tool-check.')],
        stream: false,
        tools: sharedTools,
        tool_choice: 'required',
        parallel_tool_calls: false,
        metadata: { smoke: 'opencode-tools-nonstream' },
      }),
    })
    assertFunctionCallOutput(result.body, 'responses tools non-stream')
    return { status: result.status }
  })

  await runScenario(results, 'responses store crud', async () => {
    const created = await requestJSON('responses store crud create', '/v1/responses', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'responses-store-crud' }),
      body: JSON.stringify({
        model,
        input: [developerMessage(), userMessage('Reply with ok and store the response.')],
        stream: false,
        metadata: { smoke: 'opencode-store-crud' },
      }),
    })
    assertResponseObject(created.body, 'responses store crud create')

    const responseId = created.body.id
    const fetched = await requestJSON('responses store crud get', `/v1/responses/${responseId}`, {
      headers: authHeaders(),
    })
    assertResponseObject(fetched.body, 'responses store crud get')
    if (fetched.body.id !== responseId) {
      throw new Error('responses store crud get: expected matching response id')
    }

    const listed = await requestJSON('responses store crud list', '/v1/responses?limit=5', {
      headers: authHeaders(),
    })
    assertObject(listed, 'responses store crud list')
    if (listed.body.object !== 'list' || !Array.isArray(listed.body.data)) {
      throw new Error('responses store crud list: expected list payload')
    }
    if (!listed.body.data.some((item) => item && item.id === responseId)) {
      throw new Error('responses store crud list: expected created response id in list')
    }

    const cancel = await requestJSON('responses store crud cancel', `/v1/responses/${responseId}/cancel`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({}),
    })
    assertResponseObject(cancel.body, 'responses store crud cancel')
    if (!['completed', 'cancelled', 'in_progress', 'failed', 'incomplete'].includes(String(cancel.body.status || ''))) {
      throw new Error(`responses store crud cancel: unexpected status ${JSON.stringify(cancel.body.status)}`)
    }

    const deleted = await requestJSON('responses store crud delete', `/v1/responses/${responseId}`, {
      method: 'DELETE',
      headers: authHeaders(),
    })
    assertObject(deleted, 'responses store crud delete')
    if (deleted.body.object !== 'response.deleted' || deleted.body.deleted !== true || deleted.body.id !== responseId) {
      throw new Error('responses store crud delete: expected response.deleted payload')
    }

    return { status: created.status }
  })

  await runScenario(results, 'responses tools stream', async () => {
    const result = await requestSSE('responses tools stream', '/v1/responses', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'responses-tools-stream' }),
      body: JSON.stringify({
        model,
        input: [developerMessage(), userMessage('Call get_smoke_status with target set to opencode-stream-tool-check.')],
        stream: true,
        tools: sharedTools,
        tool_choice: 'required',
        parallel_tool_calls: false,
        metadata: { smoke: 'opencode-tools-stream' },
      }),
    })
    assertResponsesToolStream(result.events, 'responses tools stream')
    return { status: result.status }
  })

  await runScenario(results, 'responses replay single followup', async () => {
    const result = await requestJSON('responses replay single followup', '/v1/responses', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'responses-replay-single' }),
      body: JSON.stringify({
        model,
        stream: false,
        input: [
          developerMessage(),
          userMessage('读读 D:\\A面试\\JD.txt'),
          toolCallItem('read', 'call_read_jd', { filePath: 'D:\\A面试\\JD.txt' }),
          toolOutputItem('call_read_jd', '岗位方向：Java 后端；要求：熟悉 Spring Boot、MySQL、Docker。'),
          userMessage('基于上面的工具结果，只输出三条摘要。'),
        ],
        metadata: { smoke: 'opencode-replay-single' },
      }),
    })
    assertObject(result, 'responses replay single followup')
    if (result.body.object !== 'response') {
      throw new Error('responses replay single followup: expected response object')
    }
    assertNoProtocolLeak(extractResponseOutputText(result.body), 'responses replay single followup')
    return { status: result.status }
  })

  await runScenario(results, 'responses replay multifile followup', async () => {
    const result = await requestJSON('responses replay multifile followup', '/v1/responses', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'responses-replay-multifile' }),
      body: JSON.stringify({
        model,
        stream: false,
        input: [
          developerMessage(),
          userMessage('请帮我看看 D:\\A面试，给我汇总'),
          toolCallItem('read', 'call_read_jianli', { filePath: 'D:\\A面试\\个人简历素材库.md' }),
          toolOutputItem('call_read_jianli', '# 个人简历素材库\n候选人：李仲恺\n方向：Java 后端、全栈。'),
          toolCallItem('read', 'call_read_jd2', { filePath: 'D:\\A面试\\JD.txt' }),
          toolOutputItem('call_read_jd2', '# JD\n岗位：Java 后端\n要求：Spring Boot / MySQL / Docker。'),
          userMessage('只做目录材料汇总，不要延伸成简历优化或投递建议。'),
        ],
        metadata: { smoke: 'opencode-replay-multifile' },
      }),
    })
    assertObject(result, 'responses replay multifile followup')
    if (result.body.object !== 'response') {
      throw new Error('responses replay multifile followup: expected response object')
    }
    assertNoProtocolLeak(extractResponseOutputText(result.body), 'responses replay multifile followup')
    return { status: result.status }
  })

  await runScenario(results, 'responses replay aborted followup', async () => {
    const result = await requestJSON('responses replay aborted followup', '/v1/responses', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'responses-replay-aborted' }),
      body: JSON.stringify({
        model,
        stream: false,
        input: [
          developerMessage(),
          userMessage('继续刚才的工具结果。'),
          toolCallItem('read', 'call_read_abort', { filePath: 'D:\\A面试\\JD.txt' }),
          toolOutputItem('call_read_abort', 'Tool execution aborted'),
          userMessage('如果上一轮工具被中止，请简洁说明并继续回答。'),
        ],
        metadata: { smoke: 'opencode-replay-aborted' },
      }),
    })
    assertObject(result, 'responses replay aborted followup')
    if (result.body.object !== 'response') {
      throw new Error('responses replay aborted followup: expected response object')
    }
    assertNoProtocolLeak(extractResponseOutputText(result.body), 'responses replay aborted followup')
    return { status: result.status }
  })

  await runScenario(results, 'chat tools non-stream', async () => {
    const result = await requestJSON('chat tools non-stream', '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'chat-tools-nonstream' }),
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: 'You are OpenCode, the best coding agent on the planet.' },
          { role: 'user', content: 'Call get_smoke_status with target set to opencode-chat-tool-check.' },
        ],
        tools: sharedTools,
        tool_choice: 'required',
        parallel_tool_calls: false,
      }),
    })
    assertChatToolCalls(result, 'chat tools non-stream')
    return { status: result.status }
  })

  await runScenario(results, 'chat tools stream', async () => {
    const result = await requestSSE('chat tools stream', '/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'chat-tools-stream' }),
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: 'system', content: 'You are OpenCode, the best coding agent on the planet.' },
          { role: 'user', content: 'Call get_smoke_status with target set to opencode-chat-stream-tool-check.' },
        ],
        tools: sharedTools,
        tool_choice: 'required',
        parallel_tool_calls: false,
      }),
    })
    assertChatToolStream(result.events, 'chat tools stream')
    return { status: result.status }
  })

  await runScenario(results, 'cli chat tools non-stream', async () => {
    const result = await requestJSON('cli chat tools non-stream', '/cli/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'cli-chat-tools-nonstream' }),
      body: JSON.stringify({
        stream: false,
        messages: [
          { role: 'system', content: 'You are OpenCode, the best coding agent on the planet.' },
          { role: 'user', content: 'Call get_smoke_status with target set to opencode-cli-chat-tool-check.' },
        ],
        tools: sharedTools,
        tool_choice: 'required',
        parallel_tool_calls: false,
      }),
    })
    assertChatToolCalls(result, 'cli chat tools non-stream')
    return { status: result.status }
  })

  await runScenario(results, 'cli chat tools stream', async () => {
    const result = await requestSSE('cli chat tools stream', '/cli/v1/chat/completions', {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'x-smoke-scenario': 'cli-chat-tools-stream' }),
      body: JSON.stringify({
        stream: true,
        messages: [
          { role: 'system', content: 'You are OpenCode, the best coding agent on the planet.' },
          { role: 'user', content: 'Call get_smoke_status with target set to opencode-cli-chat-stream-tool-check.' },
        ],
        tools: sharedTools,
        tool_choice: 'required',
        parallel_tool_calls: false,
      }),
    })
    assertChatToolStream(result.events, 'cli chat tools stream')
    return { status: result.status }
  })

  for (const result of results) {
    const suffix = result.model ? ` [${result.model}]` : ''
    console.log(`PASS ${result.label}${suffix} (${result.status}, ${result.ms}ms)`)
  }
}

run().catch((error) => {
  console.error(`FAIL ${error && error.message ? error.message : error}`)
  process.exit(1)
})
