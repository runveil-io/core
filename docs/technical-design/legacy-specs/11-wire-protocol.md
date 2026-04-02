# 11 — Wire Protocol 详细设计

> 模块: network/wire-protocol
> 版本: v0.1.0
> 状态: Draft
> 依赖源码: /tmp/veil-src/src/types.ts, relay/index.ts, consumer/index.ts, provider/index.ts

---

## 1. 职责边界

### 范围内
- Consumer↔Relay↔Provider 之间所有 WebSocket 消息的格式定义
- 消息类型枚举、字段规范、序列化格式
- 版本协商机制
- 消息签名与验证
- 流式传输协议

### 范围外
- 传输层选择（WebSocket vs QUIC）— 见 [GAP: 14-transport.md]
- E2E 加密的密码学细节 — 见 crypto 模块设计
- 链上结算协议 — 见 contracts 设计
- 业务逻辑（Provider 选择、负载均衡）— 见各角色模块设计

---

## 2. 详细规范

### 2.1 消息信封（Envelope）

所有 WebSocket 消息使用 JSON 编码，遵循统一信封格式：

```typescript
interface WsMessage {
  type: MessageType;          // 必填，消息类型
  request_id?: string;        // 请求关联ID，格式 "veil-" + nanoid(24)
  payload?: unknown;          // 类型特定的载荷
  timestamp: number;          // Unix毫秒时间戳
  version?: string;           // 协议版本，如 "0.1.0" [GAP: 版本协商未实现]
}
```

### 2.2 消息类型枚举

```typescript
type MessageType =
  // 连接建立
  | 'provider_hello'      // Provider → Relay: 注册
  | 'provider_ack'        // Relay → Provider: 注册确认
  // 请求/响应
  | 'request'             // Consumer → Relay → Provider: 推理请求
  | 'response'            // Provider → Relay → Consumer: 非流式响应
  // 流式传输
  | 'stream_start'        // Provider → Relay → Consumer: 流开始
  | 'stream_chunk'        // Provider → Relay → Consumer: 流数据块
  | 'stream_end'          // Provider → Relay → Consumer: 流结束
  // 错误
  | 'error'               // 任意方向: 错误通知
  // 心跳
  | 'ping'                // 双向: 心跳探测
  | 'pong'                // 双向: 心跳响应
  // 发现
  | 'list_providers'      // Consumer → Relay: 查询在线Provider
  | 'provider_list';      // Relay → Consumer: Provider列表
```

### 2.3 各消息载荷定义

#### 2.3.1 provider_hello

Provider 连接 Relay 后发送的注册消息。

```typescript
interface ProviderHelloPayload {
  provider_pubkey: string;      // hex, Ed25519签名公钥
  encryption_pubkey: string;    // hex, X25519加密公钥
  models: string[];             // 支持的模型列表，如 ["claude-3.5-sonnet", "claude-3-opus"]
  capacity: number;             // 并发容量（当前固定100）
  signature: string;            // hex, 对 {provider_pubkey, encryption_pubkey, models, capacity, timestamp} 的签名
}
```

**签名构造:**
```
signable = JSON.stringify({
  provider_pubkey,
  encryption_pubkey,
  models,
  capacity,
  timestamp   // 取自外层 WsMessage.timestamp
})
signature = Ed25519.sign(signable, provider_secret_key)
```

#### 2.3.2 provider_ack

```typescript
interface ProviderAckPayload {
  status: 'accepted' | 'rejected';
  reason?: string;    // 拒绝原因: 'invalid_signature' | [GAP: 其他拒绝原因]
}
```

#### 2.3.3 request

双层信封设计（红队审计修正 §20.1）：

```typescript
interface RequestPayload {
  outer: {
    consumer_pubkey: string;    // hex, Consumer签名公钥（Relay验证后剥离）
    provider_id: string;        // hex, 目标Provider公钥
    model: string;              // 请求的模型名
    signature: string;          // hex, 对请求元数据的签名
  };
  inner: string;                // base64, 加密的 InnerPlaintext
}
```

**outer.signature 构造:**
```
inner_hash = SHA256(base64decode(inner))
signable = JSON.stringify({
  request_id,
  consumer_pubkey: outer.consumer_pubkey,
  provider_id: outer.provider_id,
  model: outer.model,
  timestamp,          // 外层 WsMessage.timestamp
  inner_hash: hex(inner_hash)
})
signature = Ed25519.sign(signable, consumer_secret_key)
```

**inner 解密后结构:**
```typescript
interface InnerPlaintext {
  messages: Array<{ role: string; content: string }>;
  model: string;
  max_tokens: number;
  temperature: number;
  top_p: number;
  stop_sequences: string[];
  stream: boolean;
}
```

**加密方式:** NaCl box (X25519-XSalsa20-Poly1305)
- Consumer 用 Provider 的 encryption_pubkey + 自己的 encryption_secret_key 做 seal
- inner 的前32字节是 Consumer 的 encryption_pubkey（供 Provider 解密用）

**Relay 转发时的修改:**
```typescript
// Relay 验证签名后，将 consumer_pubkey 替换为 'redacted'
forwardMsg.payload.outer.consumer_pubkey = 'redacted';
```

#### 2.3.4 response（非流式）

```typescript
interface ResponsePayload {
  encrypted_body: string;   // base64, NaCl sealed box
}

// 解密后:
interface ResponsePlaintext {
  content: string;
  usage: { input_tokens: number; output_tokens: number };
  finish_reason: string;    // 'stop' | 'length'
}
```

#### 2.3.5 stream_start

```typescript
interface StreamStartPayload {
  model: string;
}
```

#### 2.3.6 stream_chunk

```typescript
interface StreamChunkPayload {
  encrypted_chunk: string;  // base64, NaCl sealed box
  index: number;            // 从0开始的序号
}

// 解密后: 纯文本内容 或 JSON
// index=0: JSON { role: "assistant" }
// index=1..N-1: 纯文本（增量内容）
// index=N: JSON { finish_reason: "stop" | "length" }
```

#### 2.3.7 stream_end

```typescript
interface StreamEndPayload {
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}
```

**注意:** usage 在 stream_end 中是明文（非加密），因为 Relay 需要读取它来生成 witness。

#### 2.3.8 error

```typescript
interface ErrorPayload {
  code: string;     // 错误代码
  message: string;  // 人类可读描述
}
```

**已定义错误代码:**

| code | 来源 | 含义 |
|------|------|------|
| `invalid_signature` | Relay | 请求签名验证失败 |
| `no_provider` | Relay | 目标Provider不在线 |
| `decrypt_failed` | Provider | 无法解密inner信封 |
| `rate_limit` | Provider | Provider达到并发上限 |
| `api_error` | Provider | 上游API调用失败 |
| `timeout` | Consumer Gateway | 请求超时（默认120s） |
| [GAP] | — | 需要定义更多错误代码 |

#### 2.3.9 ping / pong

```typescript
// ping: 无载荷或空对象
// pong: 无载荷或空对象
```

[GAP: 心跳间隔、超时断连策略未在代码中定义]

#### 2.3.10 list_providers

```typescript
// 请求: 无载荷
// 响应:
interface ProviderListPayload {
  providers: Array<{
    provider_id: string;        // hex公钥
    encryption_pubkey: string;  // hex
    models: string[];
    capacity: number;
  }>;
}
```

---

## 3. 消息序列图

### 3.1 Provider 注册

```
Provider                    Relay
   |                          |
   |--- provider_hello ------>|  (含签名)
   |                          |  验证签名
   |                          |  存入provider_state表
   |<-- provider_ack ---------|  status: accepted/rejected
   |                          |
   |--- ping ---------------->|  (周期性)
   |<-- pong -----------------|
   |                          |
   |     [断线]                |
   |                          |  providers.delete(id)
   |                          |  UPDATE status='offline'
```

### 3.2 非流式请求

```
Consumer GW          Relay                Provider
    |                  |                      |
    |-- request ------>|                      |
    |                  | 验证签名              |
    |                  | 验证时间戳(±MAX_AGE)  |
    |                  | 存储 request_id→conn  |
    |                  | 剥离consumer_pubkey   |
    |                  |--- request --------->|
    |                  |                      | 解密inner
    |                  |                      | 调用上游API
    |                  |                      | 加密response
    |                  |<-- response ---------|
    |                  | 生成witness           |
    |                  | 写入witness表          |
    |<-- response -----|                      |
    |                  | 清理映射              |
```

### 3.3 流式请求

```
Consumer GW          Relay                Provider
    |                  |                      |
    |-- request ------>|                      |
    |                  |--- request --------->|
    |                  |                      | 解密inner
    |                  |<-- stream_start -----|
    |<-- stream_start--|                      |
    |                  |<-- stream_chunk[0] --| (role)
    |<-- stream_chunk--|                      |
    |                  |<-- stream_chunk[1] --| (text)
    |<-- stream_chunk--|                      |
    |        ...       |        ...           |
    |                  |<-- stream_chunk[N] --| (finish_reason)
    |<-- stream_chunk--|                      |
    |                  |<-- stream_end -------| (usage)
    |<-- stream_end ---|                      |
    |                  | 生成witness           |
```

### 3.4 Provider 发现

```
Consumer GW          Relay
    |                  |
    |-- list_providers>|
    |                  | 收集在线Provider
    |<- provider_list -|
```

---

## 4. 状态管理

### 4.1 Relay 状态

```
providers: Map<provider_id, { conn, info }>    // 在线Provider连接池
consumers: Map<request_id, Connection>          // 请求→Consumer连接映射
requestMeta: Map<request_id, {                  // 请求元数据（witness用）
  consumerPubkey, providerId, model
}>
```

**生命周期:**
- Provider 连接 → `providers.set()`
- Provider 断开 → `providers.delete()` + DB status='offline'
- 请求到达 → `consumers.set()` + `requestMeta.set()`
- 响应/stream_end → `consumers.delete()` + `requestMeta.delete()`

### 4.2 Consumer Gateway 状态

```
pendingRequests: Map<request_id, {
  resolve, reject, onChunk?
}>
providers: ProviderInfo[]       // 缓存的Provider列表
relayConnected: boolean
```

### 4.3 Provider 状态

```
activeRequests: number          // 当前活跃请求数
maxConcurrent: number           // 最大并发（配置项）
```

---

## 5. 错误处理与边界情况

### 5.1 请求签名验证失败
- Relay 返回 `error` + code `invalid_signature`
- 不转发给 Provider

### 5.2 时间戳过期
- `MAX_REQUEST_AGE_MS` 限制（来自 config/bootstrap.ts）
- `|now - timestamp| > MAX_REQUEST_AGE_MS` → 拒绝
- 防止重放攻击

### 5.3 Provider 不在线
- Relay 返回 `error` + code `no_provider`
- [GAP: 应该自动选择其他Provider还是由Consumer重试？当前直接报错]

### 5.4 Provider 容量满
- Provider 返回 `error` + code `rate_limit`
- Consumer Gateway 收到后可以选择重试其他Provider

### 5.5 解密失败
- Provider 返回 `error` + code `decrypt_failed`
- 可能原因：加密公钥不匹配、密文损坏

### 5.6 请求超时
- Consumer Gateway 默认 120s 超时 (`VEIL_REQUEST_TIMEOUT` env)
- 超时后从 `pendingRequests` 清理

### 5.7 连接断开
- Provider 断开 → Relay 标记为 offline
- Relay 断开 → Consumer Gateway 设 `relayConnected=false`，支持自动重连 (`reconnect: true`)

### 5.8 JSON 解析失败
- Relay 捕获并记录错误，不转发
- [GAP: 应该回复 error 消息还是静默丢弃？当前静默]

### 5.9 重复 request_id
- witness 表用 request_id 做唯一约束
- 重复插入静默忽略（catch 空 block）

---

## 6. 安全约束

### 6.1 身份剥离（Relay侧执行）
- Relay 收到 request 后，**必须**将 `outer.consumer_pubkey` 替换为 `'redacted'` 再转发
- Provider 只能看到 request_id + 加密的inner，无法知道请求者身份

### 6.2 签名验证
- Relay 验证 Consumer 的 outer.signature（Ed25519）
- Relay 验证 Provider 的 provider_hello.signature
- 签名覆盖 inner_hash（SHA256），防止篡改加密内容

### 6.3 时间戳验证
- 防重放：`MAX_REQUEST_AGE_MS` 窗口内的请求才被接受

### 6.4 E2E 加密
- inner 信封使用 NaCl box 加密
- 流式 chunk 每个独立加密
- Relay 无法解密内容（仅中转密文）
- usage（在 stream_end 中）是明文 — 这是有意为之，Relay 需要生成 witness

### 6.5 Witness 生成
- Relay 在 response/stream_end 时创建 witness
- consumer_hash = SHA256(consumer_pubkey + daily_salt)，日级匿名化
- witness 由 Relay 私钥签名

```typescript
interface Witness {
  request_id: string;
  consumer_hash: string;      // 日级匿名hash
  provider_id: string;
  relay_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  timestamp: number;
  relay_signature: string;    // hex, Relay签名
}
```

---

## 7. 测试要求

### 7.1 单元测试
- [ ] `verifyRequest()`: 有效签名→true, 过期时间戳→false, 无效签名→false
- [ ] `createWitness()`: 正确字段、签名可验证、consumer_hash日级变化
- [ ] 消息序列化/反序列化：每种 MessageType 的 roundtrip
- [ ] 错误代码覆盖：每种 ErrorPayload.code 场景

### 7.2 集成测试
- [ ] Provider注册流程：hello → ack(accepted)
- [ ] 非流式请求全链路：request → response + witness生成
- [ ] 流式请求全链路：request → stream_start → chunks → stream_end + witness
- [ ] Provider断线后从列表移除
- [ ] 并发请求互不干扰（不同request_id隔离）
- [ ] 重放攻击被拒绝（相同消息重发）

### 7.3 Fuzz测试
- [ ] 随机JSON → 解析不崩溃
- [ ] 缺失字段 → 优雅错误
- [ ] 超大payload → [GAP: 没有消息大小限制]

---

## 8. 与其他模块的依赖

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐
│  crypto/     │    │  wallet/     │    │  config/     │
│  sign/verify │◄───│  密钥对管理   │    │  bootstrap   │
│  seal/open   │    │              │    │ MAX_REQ_AGE  │
│  sha256      │    │              │    │ MODEL_MAP    │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │
       └───────────┬───────┴───────────────────┘
                   │
           ┌───────▼───────┐
           │ wire-protocol │ ← 本模块
           │ (消息格式定义)  │
           └───────┬───────┘
                   │
       ┌───────────┼───────────┐
       │           │           │
┌──────▼──┐  ┌────▼────┐  ┌───▼──────┐
│consumer/ │  │ relay/  │  │provider/ │
│本地网关   │  │中继转发  │  │矿工引擎   │
└─────────┘  └─────────┘  └──────────┘
       │           │
       │     ┌─────▼─────┐
       │     │   db.ts   │
       │     │ witness表  │
       │     │ provider_  │
       │     │ state表    │
       │     └───────────┘
       │
  ┌────▼──────────┐
  │ network/      │
  │ WebSocket连接  │
  │ 重连/超时      │
  └───────────────┘
```

### 上游依赖
| 模块 | 用途 |
|------|------|
| `crypto/` | Ed25519签名验证、NaCl box加解密、SHA256 |
| `wallet/` | 提供密钥对（签名+加密） |
| `config/bootstrap` | `MAX_REQUEST_AGE_MS`, `MODEL_MAP`, `MODELS`, `RETRY_CONFIG` |
| `network/` | WebSocket连接管理（createServer, connect） |
| `db.ts` | SQLite — witness表、provider_state表 |

### 下游消费者
| 模块 | 消费方式 |
|------|---------|
| `consumer/index.ts` | 构造request消息、解密response/stream_chunk |
| `relay/index.ts` | 路由所有消息类型、验证签名、生成witness |
| `provider/index.ts` | 发送provider_hello、接收request、返回response/stream |

---

## 附录 A: 已知GAP

| GAP | 优先级 | 说明 |
|-----|--------|------|
| 版本协商 | P1 | WsMessage.version 字段已预留但未实现协商握手 |
| 消息大小限制 | P1 | 无 max payload size，可能被滥用 |
| 心跳策略 | P2 | ping/pong 间隔、超时断连阈值未定义 |
| 更多错误代码 | P2 | 如 `invalid_model`, `escrow_insufficient`, `provider_busy` |
| Provider不在线的重试 | P2 | 当前直接报错，应支持自动选择其他Provider |
| JSON解析失败处理 | P3 | 当前静默丢弃，应回复error |
| 消息压缩 | P3 | 大prompt可考虑启用WebSocket per-message deflate |
| 二进制序列化 | P3 | JSON开销大，v2可考虑protobuf/msgpack |
| QUIC迁移 | P2 | spec提到QUIC但代码是WebSocket，需迁移计划 |
| Consumer GW→Relay重连 | P2 | reconnect:true已设但重连后需重新list_providers |

---

*v0.1.0 — 基于现有代码提取，非新设计。*
