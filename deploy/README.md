# 灰度部署模板说明

本目录只放 **旁路灰度** 部署模板，不直接覆盖当前线上 `qwen-proxy` 生产容器。

## 目标

- 保持当前线上 `qwen2api.mcheiyue.com -> 127.0.0.1:7860` 不变
- 新版本先以旁路容器方式启动
- 复用当前 VPS 的 `cpa_default` 外部网络
- 继续兼容 Resin SOCKS5 代理池、账号粘性绑定、失败换绑逻辑

## 文件

- `docker-compose.prod.yml`：灰度容器模板

## 默认约束

- 容器名默认：`qwen-proxy-test`
- 宿主机端口默认：`127.0.0.1:17860:3000`
- Docker 网络：`cpa_default`
- 数据目录：`../data`
- 日志目录：`../logs`
- 资源限制：`mem_limit=512m`、`pids_limit=512`

## 启动前准备

建议在 `deploy/` 同级或调用目录准备 `.env`，至少包含：

```env
API_KEY=你的对外 API Key
ACCOUNTS=email1:password1,email2:password2
PROXIES=socks5://QWEN2API.QWEN_01:TOKEN@resin:2260,socks5://QWEN2API.QWEN_02:TOKEN@resin:2260
DEFAULT_MODEL=qwen3.6-plus
ENABLE_RESPONSES_API=true
ENABLE_CLI_API=true
RESPONSES_STORE_BACKEND=file
RESPONSES_STORE_FILE=./data/responses-store.json
RESPONSES_STORE_REDIS_KEY=qwen2api:responses
RESPONSES_STORE_TTL_SECONDS=1800
RESPONSES_DEBUG_DUMP=false
RESPONSES_DEBUG_DUMP_DIR=./logs/responses-debug
TOOL_RESULT_MAX_CHARS=12000
TOOL_RESULT_TAIL_CHARS=2000
QWEN_PROXY_HOST_PORT=17860
QWEN_PROXY_CONTAINER_NAME=qwen-proxy-test
QWEN_PROXY_IMAGE=mcheiyue/qwen-proxy-heiyue:latest
```

如果仍沿用旧版单代理模式，也可只给：

```env
PROXY_URL=socks5://QWEN2API.QWEN_01:TOKEN@resin:2260
```

但生产目标仍应优先使用 `PROXIES` 代理池模式。

如果某个账号需要固定优先使用私有代理，可在 `ACCOUNTS` 中写成：

```env
ACCOUNTS=email1:password1|socks5://QWEN2API.QWEN_01:TOKEN@resin:2260,email2:password2
```

该格式只是给账号绑定一个优先代理候选，不会替代 `PROXIES` 代理池；当请求出现网络级代理错误时，仍会复用现有失败标记与换绑逻辑。

## 启动命令

在仓库根目录执行：

```powershell
docker compose -f deploy/docker-compose.prod.yml up -d
```

查看状态：

```powershell
docker ps --filter "name=qwen-proxy-test"
docker logs --tail 200 qwen-proxy-test
```

健康检查：

```powershell
curl http://127.0.0.1:17860/health
```

快速灰度 smoke：

```powershell
$env:SMOKE_BASE_URL = "http://127.0.0.1:17860"
$env:SMOKE_API_KEY = "你的对外 API Key"
npm run smoke:gray
```

快速 smoke 会检查 `/health` 的基础运行摘要，包括 `features.responses_api`、`features.cli_api`、`responses.store.backend`、`responses.store.ttl_seconds`、`persistence.data_save_mode` 与 `proxy_pool`。这些字段用于确认灰度容器的接口开关、Responses store 和代理池观测面是否正常暴露。

完整灰度 smoke 会额外触发一次非流式 chat 和一次 `/v1/responses` 请求，确认账号与代理都准备好后再执行：

```powershell
$env:SMOKE_BASE_URL = "http://127.0.0.1:17860"
$env:SMOKE_API_KEY = "你的对外 API Key"
$env:SMOKE_MODEL = "qwen3.6-plus"
npm run smoke:gray -- --full
```

流式灰度 smoke 会额外触发一次流式 chat 和一次流式 `/v1/responses` 请求，用于确认 SSE 基础协议和 `[DONE]` 收尾：

```powershell
$env:SMOKE_BASE_URL = "http://127.0.0.1:17860"
$env:SMOKE_API_KEY = "你的对外 API Key"
$env:SMOKE_MODEL = "qwen3.6-plus"
npm run smoke:gray -- --stream
```

如需同时覆盖非流式和流式端点：

```powershell
npm run smoke:gray -- --full --stream
```

工具调用灰度 smoke 会额外触发一次非流式 chat 工具调用和一次非流式 `/v1/responses` 工具调用，用于确认 `tools`、`tool_choice=required` 和 `tool_calls/function_call` 输出结构：

```powershell
$env:SMOKE_BASE_URL = "http://127.0.0.1:17860"
$env:SMOKE_API_KEY = "你的对外 API Key"
$env:SMOKE_MODEL = "qwen3.6-plus"
npm run smoke:gray -- --tools
```

如需完整覆盖基础端点、非流式、流式和工具调用：

```powershell
npm run smoke:gray -- --full --stream --tools
```

## 灰度验证建议

至少验证以下内容：

1. `/health` 正常
   应能看到 `responses.store.backend` 与 `responses.store.ttl_seconds`
   以及 `features.responses_api` / `features.cli_api`
2. `/v1/models` 返回模型列表
3. 普通 chat completions 正常
4. 流式输出正常
5. 工具调用正常
6. 代理池场景下账号与代理绑定正常
7. 网络错误时能自动换代理/重试

如果长工具输出容易把上游上下文撑爆，可先收紧：

- `TOOL_RESULT_MAX_CHARS`
- `TOOL_RESULT_TAIL_CHARS`

如果需要让 `/v1/responses` 的 GET/列表回查窗口更短或更长，可调整：

- `RESPONSES_STORE_TTL_SECONDS`

如果需要控制 Responses 查询结果是否跨重启保留，可调整：

- `RESPONSES_STORE_BACKEND`（当前支持 `memory` / `file` / `redis`）
- `RESPONSES_STORE_FILE`
- `RESPONSES_STORE_REDIS_KEY`

如果需要定位 OpenCode / Responses 复杂 input 的串台或工具回灌问题，可临时开启：

- `RESPONSES_DEBUG_DUMP=true`
- `RESPONSES_DEBUG_DUMP_DIR=./logs/responses-debug`

开启后会按 `request_id` 落两份调试文件：raw 请求体和 normalized 结果。只建议短时排障使用，排查完成后关闭，避免长期落敏感上下文。

默认策略是保留前半段主体，再保留尾部结论，中间插入截断标记。

## 切记不要直接做的事

- 不要直接占用当前线上 `127.0.0.1:7860`
- 不要直接复用当前线上容器名 `qwen-proxy`
- 不要跳过 `cpa_default` 网络
- 不要先改 Nginx 指向再做旁路验证

## 回滚

灰度失败时直接停止测试容器：

```powershell
docker compose -f deploy/docker-compose.prod.yml down
```

因为模板默认使用独立端口和独立容器名，所以不会影响当前线上服务。
