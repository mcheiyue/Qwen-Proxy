const express = require('express')
const router = express.Router()
const config = require('../config/index.js')
const { apiKeyVerify } = require('../middlewares/authorization')
const { handleGetModels } = require('../controllers/models.js')

router.get('/v1/models', apiKeyVerify, handleGetModels)
if (config.enableCliApi) {
  router.get('/cli/v1/models', apiKeyVerify, handleGetModels)
  router.post('/cli/v1/models', apiKeyVerify, handleGetModels)
}
router.get('/models', handleGetModels)

module.exports = router
