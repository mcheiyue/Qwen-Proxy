const EFFORT_BUDGET_MAP = {
    low: 4096,
    medium: 16384,
    high: 81920,
}

const isThinkingEnabled = (model, enable_thinking, thinking_budget, reasoning_effort) => {
    const thinking_config = {
        output_schema: 'phase',
        thinking_enabled: false,
        thinking_budget: 81920,
    }

    if (!model) return thinking_config

    const effortLower = reasoning_effort ? String(reasoning_effort).toLowerCase() : null
    const hasReasoningEffort = effortLower && EFFORT_BUDGET_MAP[effortLower] !== undefined

    if (model.includes('-thinking') || enable_thinking === true || enable_thinking === 'true' || hasReasoningEffort) {
        thinking_config.thinking_enabled = true
    }

    if (thinking_budget && !isNaN(Number(thinking_budget)) && Number(thinking_budget) > 0) {
        thinking_config.thinking_budget = Number(thinking_budget)
    } else if (hasReasoningEffort) {
        thinking_config.thinking_budget = EFFORT_BUDGET_MAP[effortLower]
    }

    return thinking_config
}

const applyReasoningEffortPolicy = (reasoning_effort, policy = 'ignore') => {
    if (!reasoning_effort) return reasoning_effort

    const normalizedPolicy = String(policy || 'ignore').trim().toLowerCase()
    if (normalizedPolicy === 'passthrough') {
        return reasoning_effort
    }
    if (normalizedPolicy === 'downgrade') {
        return 'low'
    }
    return undefined
}

const resolveReasoningEffort = (reasoning_effort, reasoning) => {
    if (typeof reasoning_effort === 'string') {
        const trimmedEffort = reasoning_effort.trim()
        if (trimmedEffort) return trimmedEffort
    } else if (reasoning_effort) {
        return reasoning_effort
    }

    if (reasoning && typeof reasoning === 'object' && !Array.isArray(reasoning)) {
        const effort = reasoning.effort
        if (typeof effort === 'string') {
            const trimmedEffort = effort.trim()
            if (trimmedEffort) return trimmedEffort
        } else if (effort) {
            return effort
        }
    }

    return undefined
}

module.exports = {
    applyReasoningEffortPolicy,
    isThinkingEnabled,
    resolveReasoningEffort,
}
