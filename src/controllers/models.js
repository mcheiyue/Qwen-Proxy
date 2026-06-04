const { getLatestModels } = require('../models/models-map.js')
const config = require('../config/index.js')

/**
 * Build public model data
 * @param {object} model - Original model info
 * @param {string} suffix - Variant suffix
 * @returns {object} Public model info
 */
const buildPublicModelData = (model, suffix = '') => {
    const modelData = JSON.parse(JSON.stringify(model))
    const upstreamModelID = String(model?.upstream_id || model?.id || '')
    const displayModelID = String(model?.name || model?.id || '')

    // Force lowercase for compatibility with clients that don't support uppercase model names
    modelData.id = `${displayModelID}${suffix}`.toLowerCase()
    modelData.name = `${upstreamModelID}${suffix}`.toLowerCase()
    modelData.upstream_id = upstreamModelID
    modelData.display_name = displayModelID

    // Keep nested info.id / info.name in sync with the public id/name so
    // clients that look at either field see the same suffix-aware value.
    // The original upstream id (without suffix) is preserved in upstream_id.
    if (modelData.info && typeof modelData.info === 'object') {
        modelData.info.id = modelData.id
        modelData.info.name = modelData.name
    }

    return modelData
}

const buildFallbackModel = (modelId) => ({
    id: modelId,
    name: modelId,
    info: {
        id: modelId,
        name: modelId,
        meta: {
            chat_type: ['t2t'],
            abilities: {
                thinking: false
            }
        }
    }
})

const buildAliasModel = (sourceModel, aliasId) => {
    const normalizedAliasId = String(aliasId || '').trim().toLowerCase()
    const normalizedUpstreamId = String(sourceModel?.id || sourceModel?.name || sourceModel?.upstream_id || normalizedAliasId).trim().toLowerCase()
    const aliasModel = JSON.parse(JSON.stringify(sourceModel || buildFallbackModel(normalizedUpstreamId)))

    aliasModel.id = normalizedAliasId
    aliasModel.name = normalizedAliasId
    aliasModel.upstream_id = normalizedUpstreamId
    aliasModel.display_name = normalizedAliasId

    if (aliasModel.info && typeof aliasModel.info === 'object') {
        aliasModel.info.id = normalizedAliasId
        aliasModel.info.name = normalizedAliasId
    }

    return aliasModel
}

const ensureCliAliasModels = (models) => {
    const hasCoderAlias = models.some(model => String(model?.id || '').trim().toLowerCase() === 'coder-model')
    if (hasCoderAlias) {
        return models
    }

    const coderCandidates = [config.cliCoderModel, 'qwen3-coder-plus', 'qwen3-coder-flash', config.defaultModel]
        .map(candidate => String(candidate || '').trim().toLowerCase())
        .filter(Boolean)

    const matchedCoderModel = models.find(model => {
        const aliases = [model?.id, model?.name, model?.display_name, model?.upstream_id]
        return aliases
            .filter(Boolean)
            .some(alias => coderCandidates.includes(String(alias).trim().toLowerCase()))
    })

    const baseModel = matchedCoderModel || buildFallbackModel(coderCandidates[0] || config.defaultModel)
    return [buildAliasModel(baseModel, 'coder-model'), ...models]
}

const ensureBaseDefaultModel = (models) => {
    const normalizedDefaultModel = String(config.defaultModel || '').trim().toLowerCase()
    if (!normalizedDefaultModel) {
        return models
    }

    const hasDefaultModel = models.some(model => {
        const aliases = [model?.id, model?.name, model?.display_name, model?.upstream_id]
        return aliases
            .filter(Boolean)
            .some(alias => String(alias).trim().toLowerCase() === normalizedDefaultModel)
    })

    if (hasDefaultModel) {
        return models
    }

    return [buildFallbackModel(normalizedDefaultModel), ...models]
}

const handleGetModels = async (req, res) => {
    const models = []

    const ModelsMap = ensureCliAliasModels(ensureBaseDefaultModel(await getLatestModels()))

    for (const model of ModelsMap) {
        models.push(buildPublicModelData(model))

        if (config.simpleModelMap) {
            continue
        }

        const isThinking = model?.info?.meta?.abilities?.thinking
        const isSearch = model?.info?.meta?.chat_type?.includes('search')
        const isImage = model?.info?.meta?.chat_type?.includes('t2i')
        const isVideo = model?.info?.meta?.chat_type?.includes('t2v')
        const isImageEdit = model?.info?.meta?.chat_type?.includes('image_edit')

        if (isThinking) {
            models.push(buildPublicModelData(model, '-thinking'))
        }

        if (isSearch) {
            models.push(buildPublicModelData(model, '-search'))
        }

        if (isThinking && isSearch) {
            models.push(buildPublicModelData(model, '-thinking-search'))
        }

        if (isImage) {
            models.push(buildPublicModelData(model, '-image'))
        }

        if (isVideo) {
            models.push(buildPublicModelData(model, '-video'))
        }

        if (isImageEdit) {
            models.push(buildPublicModelData(model, '-image-edit'))
        }
    }

    res.json({
        "object": "list",
        "data": models
    })
}

module.exports = {
    handleGetModels
}
