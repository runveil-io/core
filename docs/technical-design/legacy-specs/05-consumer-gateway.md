# 05 — Consumer Gateway Design

> 本地OpenAI兼容HTTP网关 + 请求加密 + Provider选择 + 流式转发
> Date: 2026-04-01
> Status: Draft
> Depends on: 04-crypto-envelope, 00-architecture-review-v0.2
> Source: `src/consumer/index.ts` (423行), `src/consumer/anthropic-stream.ts` (37行)

## 0. 关键设计决策

**Veil Consumer网关起在 localhost:4000，完全兼容 litellm 协议。**

OpenClaw已有litellm provider支持（默认localhost:4000），自带failover机制。
用户只需：
```bash
# 安装Veil Consumer（起在:4000）
npx veil init && veil start

# OpenClaw加一个litellm profile
openclaw onboard --auth-choice litellm-api-key --litellm-api-key dummy
```

之后：直连打满 → 429 → OpenClaw自动failover到litellm(Veil) → 用户无感。

——

## 1. 职责边界

### 做什么
- **HTTP网关**：在本地启动OpenAI兼容的HTTP server（Hono），监听 `/v1/chat/completions`, `/v1/models`, `/health`
- **API Key认证**：可选的Bearer token认证（本地网关保护）
- **Provider选择**：从Relay获取在线Provider列表，按model+capacity选择
- **请求加密**：将用户请求构造为InnerPlaintext → seal加密 → 签名 → 发送到Relay
- **响应解密**：接收Provider加密响应 → open解密 → 转换为OpenAI格式返回
- **流式转发**：SSE stream_chunk逐块解密 → 转换为OpenAI stream chunk格式
- **连接管理**：与Relay的WebSocket连接（自动重连）

### 不做什么
- ❌ 不直接调用AI API（Provider的事）
- ❌ 不持久化任何数据（无DB）
- ❌ 不做token计量（Day 1不需要，后续metering模块）
- ❌ 不做多Relay负载均衡（Day 1单Relay）
- ❌ 不做请求缓存
- ❌ 不做用户管理/多租户

## 2. 接口定义

### 2.1 启动接口

```typescript
interface GatewayOptions {
  port: number;             // HTTP监听端口，默认9960
  wallet: Wallet;           // 包含signing+encryption密钥对
  relayUrl: string;         // Relay WebSocket地址，如 wss://relay-jp.runveil.io
  apiKey?: string;          // 可选的本地API key保护
}

interface Wallet {
  signingPublicKey: Uint8Array;    // Ed25519, 32B
  signingSecretKey: Uint8Array;    // Ed25519, 64B
  encryptionPublicKey: Uint8Array; // X25519, 32B
  encryptionSecretKey: Uint8Array; // X25519, 32B
}

function startGateway(options: GatewayOptions): Promise<{
  close(): Promise<void>;
  port: number;
}>;
```

### 2.2 HTTP端点

```typescript
// GET /health
interface HealthResponse {
  status: 'ok';
  version: string;              // "0.1.0"
  uptime_seconds: number;
  providers_online: number;
  relay_connected: boolean;
}

// GET /v1/models — OpenAI兼容
interface ModelsResponse {
  object: 'list';
  data: Array<{
    id: string;                 // "claude-sonnet-4-20250514"
    object: 'model';
    created: number;            // unix timestamp
    owned_by: 'veil';
  }>;
}

// POST /v1/chat/completions — OpenAI兼容
// 输入: ChatCompletionRequest (见types.ts)
// 输出: ChatCompletionResponse | SSE stream
```

### 2.3 内部函数

```typescript
/** 从Provider列表中选择一个能处理指定model的Provider */
function selectProvider(model: string): ProviderInfo | null;
// 当前实现：filter by model + capacity > 0，取第一个
// [GAP] 应考虑：延迟优先、负载均衡、声誉权重

/** 构造加密请求消息 */
function buildRequest(
  requestId: string,
  req: ChatCompletionRequest,
  provider: ProviderInfo,
): WsMessage;
// 内部流程：
// 1. 构造InnerPlaintext
// 2. JSON.stringify → UTF-8 → seal(providerEncPubkey, consumerEncSecretKey)
// 3. base64(sealed) → inner
// 4. sha256(sealed) → innerHash
// 5. sign({requestId, consumerPubkey, providerId, model, timestamp, innerHash})
// 6. 组装WsMessage{type:'request', payload: RequestPayload}

/** 常量时间字符串比较（API key验证用） */
function constantTimeCompare(a: string, b: string): boolean;

/** 构造错误响应 */
function errorResponse(
  message: string, 
  type: string, 
  code: string | null, 
  status: number,
): Response;
```

### 2.4 流式辅助（anthropic-stream.ts）

```typescript
interface OpenAIChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

/** 构造一个SSE chunk */
function makeChunk(
  id: string,
  model: string,
  created: number,
  delta: { role?: string; content?: string },
  finishReason: string | null,
): string;  // 返回 "data: {json}\n\n"

/** 构造SSE结束标记 */
function makeDone(): string;  // 返回 "data: [DONE]\n\n"
```

### 2.5 缺失接口 [GAP]

```typescript
/** [GAP] Provider选择策略 — 当前只取第一个 */
interface ProviderSelector {
  select(model: string, providers: ProviderInfo[]): ProviderInfo | null;
}

// 应实现的策略：
// - LatencyFirst: 选最近/最快的Provider
// - RoundRobin: 轮询分配负载
// - WeightedRandom: 按capacity/reputation加权随机
// - Failover: 主Provider失败自动切换

/** [GAP] 请求超时可配置 */
// 当前硬编码 process.env['VEIL_REQUEST_TIMEOUT'] ?? 120000
// 应支持per-model超时（大模型需要更长时间）

/** [GAP] 请求重试 */
// Consumer端无重试逻辑，Provider不可用时直接返回503
// 应支持：换一个Provider重试

/** [GAP] 本地usage跟踪 */
interface LocalUsageTracker {
  record(requestId: string, model: string, usage: NormalizedUsage): void;
  getDaily(): { model: string; tokens: number; cost: number }[];
  getTotal(): { tokens: number; cost: number };
}

/** [GAP] 请求队列/限流 */
// 无限并发会导致relay和provider过载
interface RateLimiter {
  acquire(): Promise<void>;  // 阻塞等待slot
  release(): void;
}

/** [GAP] 多Relay支持 */
// 当前只连一个Relay，应支持fallback
```

## 3. 数据流

### 3.1 非流式请求

```
Cursor/IDE                 Consumer Gateway              Relay           Provider
    │                           │                          │                │
    │  POST /v1/chat/completions│                          │                │
    │  Authorization: Bearer X  │                          │                │
    │  {model, messages}        │                          │                │
    │─────────────────────────>│                          │                │
    │                           │                          │                │
    │                    1. 验证API key                    │                │
    │                    2. 验证model存在                   │                │
    │                    3. 检查relay连接                   │                │
    │                    4. selectProvider(model)           │                │
    │                    5. buildRequest():                 │                │
    │                       a. InnerPlaintext构造           │                │
    │                       b. seal(provider_enc_pubkey)    │                │
    │                       c. sign(consumer_signing_key)   │                │
    │                    6. pendingRequests.set(reqId)      │                │
    │                    7. relayConn.send(WsMessage)       │                │
    │                           │───── type:request ──────>│                │
    │                           │                          │──── forward ──>│
    │                           │                          │                │
    │                           │                          │<── response ───│
    │                           │<── type:response ────────│                │
    │                           │                          │                │
    │                    8. pendingRequests.resolve()       │                │
    │                    9. open(encrypted_body)            │                │
    │                   10. JSON.parse → result             │                │
    │                   11. 构造ChatCompletionResponse      │                │
    │                           │                          │                │
    │  200 OK                   │                          │                │
    │  {id,model,choices,usage} │                          │                │
    │<─────────────────────────│                          │                │
```

### 3.2 流式请求

```
Cursor/IDE                 Consumer Gateway              Relay           Provider
    │                           │                          │                │
    │  POST /v1/chat/completions│                          │                │
    │  {model,messages,stream:true}                        │                │
    │─────────────────────────>│                          │                │
    │                           │                          │                │
    │                    1-7. (同上，buildRequest时inner.stream=true)        │
    │                           │───── type:request ──────>│                │
    │                           │                          │──── forward ──>│
    │                           │                          │                │
    │  200 OK (text/event-stream)                          │                │
    │<─ headers ───────────────│                          │                │
    │                           │                          │                │
    │                           │<── stream_chunk[0] ──────│  (role chunk)  │
    │                    open(encrypted_chunk) → {role}     │                │
    │  data: {delta:{role}}     │                          │                │
    │<─────────────────────────│                          │                │
    │                           │                          │                │
    │                           │<── stream_chunk[1..N] ───│  (content)     │
    │                    open(encrypted_chunk) → text       │                │
    │  data: {delta:{content}}  │                          │                │
    │<─────────────────────────│  (每个chunk重复)           │                │
    │                           │                          │                │
    │                           │<── stream_chunk[N+1] ────│  (finish)      │
    │                    open → {finish_reason}             │                │
    │  data: {finish_reason}    │                          │                │
    │<─────────────────────────│                          │                │
    │                           │                          │                │
    │                           │<── stream_end ───────────│                │
    │  data: [DONE]             │                          │                │
    │<─────────────────────────│                          │                │
```

### 3.3 Provider列表获取

```
Consumer Gateway                          Relay
    │                                       │
    │  connectRelay() → WebSocket open      │
    │──── type:list_providers ─────────────>│
    │                                       │
    │<──── type:provider_list ─────────────│
    │  providers = payload.providers        │
    │  (后续按需刷新，目前无定时刷新[GAP])    │
```

## 4. 状态管理

### 持久化
- **无**。Consumer Gateway是无状态进程，重启后重新连接Relay获取Provider列表

### 内存

| 状态 | 类型 | 生命周期 | 说明 |
|------|------|---------|------|
| `providers` | `ProviderInfo[]` | 进程级 | Relay推送的在线Provider列表 |
| `relayConnected` | `boolean` | 进程级 | Relay连接状态 |
| `relayConn` | `Connection` | 进程级 | WebSocket连接对象 |
| `pendingRequests` | `Map<requestId, {resolve,reject,onChunk}>` | 请求级 | 等待响应的请求回调 |
| `wallet` | `Wallet` | 进程级 | 密钥对（来自options） |
| `startTime` | `number` | 模块级（全局） | 进程启动时间，用于uptime计算 |

### [GAP] 内存泄漏风险
- `pendingRequests` — 如果Provider永远不响应且timeout未触发，Map会无限增长
- 非流式有120s timeout（会清理），但流式请求**没有超时机制** [GAP]
- 应加全局Map大小限制 + 流式超时

## 5. 错误处理

### HTTP层错误

| HTTP状态 | 错误码 | 触发条件 |
|---------|--------|---------|
| 400 | `null` | JSON解析失败 / messages为空 / model未指定 |
| 401 | `null` | API key缺失或不匹配 |
| 404 | `model_not_found` | 请求的model不在MODELS列表中 |
| 429 | `rate_limit` | Provider返回rate_limit错误 |
| 500 | `null` | buildRequest失败 / 解密失败 |
| 502 | `null` | Relay未连接 |
| 503 | `no_providers` | 没有可用Provider |
| 504 | `timeout` | 120秒超时 |

### WebSocket层错误

| 场景 | 处理 |
|------|------|
| Relay断开 | `relayConnected=false`，日志warn，自动重连（network模块） |
| Relay连接失败 | 日志error，不重试首次连接 |
| Provider返回error消息 | 解析error.code，映射到HTTP错误码 |
| 消息解析失败 | 忽略该消息 |

### [GAP] 缺失的错误处理

1. **流式解密失败**：`open(encrypted_chunk)` 返回null时，当前直接`return`跳过该chunk。客户端会收到不完整的响应但不知道出错了
2. **JSON.parse失败**：解密后的chunk如果不是合法JSON，当前try/catch后当作纯文本。应记录警告
3. **Provider列表为空**：连上Relay但没有Provider时，所有请求返回503。应有更明确的提示
4. **pendingRequests并发冲突**：理论上requestId(nanoid 24字符)冲突概率极低，但未防御

## 6. 安全约束

### 🔴 红线

1. **API key验证必须常量时间**：已实现`constantTimeCompare`。不能用`===`比较API key（防timing attack）
2. **seal的senderSecretKey是encryption key**：不能误用signingSecretKey做加密。密钥类型不能混用
3. **wallet密钥不能出现在日志/响应中**：buildRequest失败时，err.message可能包含密钥相关信息，需脱敏
4. **请求明文不经过Relay**：Relay只能看到sealed密文 + outer元数据。InnerPlaintext对Relay不可见
5. **innerHash防篡改**：签名包含innerHash，Relay或中间人无法替换inner内容

### ⚠️ 注意

1. **本地网关默认无认证**：`apiKey`是可选的。如果不设，任何能访问localhost:9960的程序都能发请求
2. **model硬编码**：MODELS列表在bootstrap.ts中硬编码，不从Relay动态获取。新增model需要更新代码
3. **consumer_pubkey明文传输**：outer中的consumer_pubkey不加密。Relay能看到哪个Consumer在发请求（但看不到内容）

## 7. 测试要求

### 场景1：基本往返
- 启动Gateway + mock Relay + mock Provider
- POST /v1/chat/completions → 收到合法的ChatCompletionResponse
- 验证response.choices[0].message.content正确

### 场景2：流式往返
- stream:true请求 → 收到SSE格式的多个chunk
- 验证：第一个chunk有role:'assistant'
- 验证：中间chunks有content
- 验证：倒数第二个chunk有finish_reason
- 验证：最后一行是"data: [DONE]"

### 场景3：API key认证
- 设置apiKey="test-key"
- 无Authorization header → 401
- Bearer wrong-key → 401
- Bearer test-key → 通过认证

### 场景4：Relay断开
- 断开Relay连接 → 请求返回502
- Relay重连后 → 请求恢复正常

### 场景5：无Provider
- Relay连接正常但Provider列表为空 → 503 no_providers
- 请求model不在任何Provider的models列表中 → 503

### 场景6：超时
- mock Provider不返回响应 → 120秒后返回504

### 场景7：加密验证
- 抓取Gateway发给Relay的WsMessage
- 验证outer.signature可以用consumer_pubkey验签
- 验证inner(base64解码后)无法被第三方密钥解密
- 用Provider的密钥可以解密

### 场景8：并发请求
- 同时发送10个请求 → 所有请求都应正确路由和响应
- pendingRequests Map正确管理（无泄漏）

## 8. 模块依赖

### 调用谁
- `crypto/` — seal, open, sign, sha256, toHex, fromHex
- `network/` — connect (WebSocket客户端)
- `config/bootstrap` — MODELS, MODEL_MAP
- `consumer/anthropic-stream` — makeChunk, makeDone
- `types` — 所有类型定义
- 外部：`hono`, `@hono/node-server`, `nanoid`

### 被谁调用
- CLI入口 (`veil init` / `veil start`) — 调用startGateway()
- [GAP] 无热重载/优雅关闭信号处理

### 依赖图

```
                    ┌─────────────────────┐
                    │   CLI / main.ts     │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  consumer/index.ts  │
                    │  (startGateway)     │
                    └──┬──┬──┬──┬──┬─────┘
                       │  │  │  │  │
          ┌────────────┘  │  │  │  └──────────┐
          ▼               ▼  │  ▼              ▼
    ┌──────────┐  ┌────────┐ │ ┌──────────┐ ┌─────────────────┐
    │ crypto/  │  │network/│ │ │bootstrap │ │anthropic-stream │
    │seal,open │  │connect │ │ │MODELS    │ │makeChunk,Done   │
    │sign,sha  │  └────────┘ │ └──────────┘ └─────────────────┘
    └──────────┘             │
                    ┌────────▼────────┐
                    │    types.ts     │
                    └─────────────────┘
```

---

*Consumer Gateway = 用户唯一触点。它的API兼容性决定了用户体验。保持OpenAI格式100%兼容。*
