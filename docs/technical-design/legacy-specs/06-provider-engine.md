# 06 — Provider Engine Design

> Provider端请求处理引擎：解密、API调用、流式转发、重试
> Date: 2026-04-01
> Status: Draft
> Depends on: 00-architecture-review-v0.2, 04-crypto-envelope
> Source: `src/provider/index.ts` (397行), `src/crypto/index.ts` (69行)

## 1. 职责边界

### 做什么
- **WebSocket生命周期管理**：连接Relay、发送`provider_hello`、处理握手确认
- **请求解密**：从`request`消息中用NaCl box解密`InnerPlaintext`
- **API调用**：将解密后的请求转为Anthropic API格式，发起HTTP调用
- **流式处理**：解析SSE流，逐chunk加密转发回Relay
- **非流式处理**：一次性调用、加密响应、返回
- **重试与退避**：指数退避+jitter处理429/529/500
- **并发控制**：基于`maxConcurrent`限制同时处理的请求数
- **OAuth伪装**：支持OAuth token模式，注入Claude Code专属headers [反检测]
- **代理模式**：支持通过`proxyUrl`转发请求到本地代理

### 不做什么
- ❌ Provider选择/路由（Relay或Consumer的事）
- ❌ 计费/结算（metering模块的事）
- ❌ 密钥持久化（wallet模块的事）
- ❌ 网络底层连接管理（network模块的事）
- ❌ 多Provider协调（src/provider只管自己）
- ❌ [GAP] 请求队列管理（当前超容量直接拒绝，无排队机制）
- ❌ [GAP] API Key轮换/池化（当前只取第一个anthropic key）
- ❌ [GAP] 多厂商适配（仅支持Anthropic，无OpenAI/Google）
- ❌ [GAP] usage计量上报（响应中包含usage但未写本地DB）

## 2. 接口定义

### 2.1 现有接口（基于源码）

```typescript
// === 配置 ===

interface ProviderOptions {
  wallet: Wallet;                                  // 签名+加密密钥对
  relayUrl: string;                                // ws(s)://relay地址
  apiKeys: Array<{ provider: 'anthropic'; key: string }>;  // API密钥列表
  maxConcurrent: number;                           // 最大并发数
  proxyUrl?: string;                               // 本地代理地址 (e.g. http://127.0.0.1:4000)
  proxySecret?: string;                            // 代理认证shared secret
}

interface HandleRequestResult {
  content: string;                                 // 响应文本
  usage: { input_tokens: number; output_tokens: number };
  finish_reason: string;                           // 'stop' | 'length'
}

// === 启动/关闭 ===

/** 启动Provider，连接Relay并开始处理请求 */
async function startProvider(options: ProviderOptions): Promise<{ close(): Promise<void> }>;

// === 请求处理（内部导出，可单独测试） ===

/** 处理单个API请求（解密后的明文 → Anthropic API → 结果） */
async function handleRequest(
  inner: InnerPlaintext,           // 解密后的请求体
  apiKey: string,                  // Anthropic API key
  onChunk?: (chunk: string) => void, // 流式回调
  apiBase?: string,                // 自定义API base URL
  proxySecret?: string,            // 代理认证secret
): Promise<HandleRequestResult>;

// === 辅助 ===

/** 计算重试延迟（指数退避+jitter） */
function getRetryDelay(attempt: number): number;
```

### 2.2 InnerPlaintext（来自types.ts）

```typescript
interface InnerPlaintext {
  messages: Array<{ role: string; content: string }>;
  model: string;           // 通用模型名，经MODEL_MAP映射为anthropic模型ID
  max_tokens: number;
  temperature: number;
  top_p: number;
  stop_sequences: string[];
  stream: boolean;
}
```

### 2.3 [GAP] 应有但缺失的接口

```typescript
// [GAP] 多厂商适配接口
interface UpstreamAdapter {
  name: string;                    // 'anthropic' | 'openai' | 'google'
  mapRequest(inner: InnerPlaintext): { url: string; headers: Record<string, string>; body: unknown };
  parseResponse(res: Response): Promise<HandleRequestResult>;
  parseStream(res: Response, onChunk: (text: string) => void): Promise<HandleRequestResult>;
}

// [GAP] API Key池管理
interface KeyPool {
  acquire(provider: string): { key: string; release(): void };
  reportError(key: string, code: string): void;  // 标记key状态
  rotate(): void;                                  // 轮换到下一个key
}

// [GAP] 请求队列
interface RequestQueue {
  enqueue(msg: WsMessage): Promise<void>;
  size(): number;
  drain(): void;
}

// [GAP] 健康检查
interface HealthStatus {
  uptime: number;
  activeRequests: number;
  totalProcessed: number;
  errorRate: number;
  lastError?: { code: string; timestamp: number };
}
```

## 3. 数据流

### 3.1 Provider启动流程

```
startProvider(options)
      │
      ▼
 connect(relayUrl) ────────────── WebSocket连接Relay
      │
      ▼
 构造 provider_hello
 ┌──────────────────────────────────────────┐
 │ provider_pubkey: hex(wallet.signingPubKey)│
 │ encryption_pubkey: hex(wallet.encPubKey)  │
 │ models: Object.keys(MODEL_MAP)           │
 │ capacity: 100                            │
 │ signature: sign(JSON, signingSecretKey)  │
 └──────────────────────────────────────────┘
      │
      ▼
 conn.send({type:'provider_hello'})
      │
      ▼
 等待 provider_ack
      ├── accepted → 开始监听 request
      └── rejected → console.log(reason) [GAP: 应抛错或重试]
```

### 3.2 请求处理流程（流式）

```
Relay                          Provider                        Anthropic API
  │                               │                               │
  │  request{inner(base64)}       │                               │
  │──────────────────────────────>│                               │
  │                               │                               │
  │                        activeRequests++                       │
  │                        检查并发≤maxConcurrent                 │
  │                               │                               │
  │                        inner = base64→bytes                   │
  │                        plaintext = open(inner, encSecretKey)  │
  │                        consumerEncPub = inner[0:32]           │
  │                        parsed = JSON.parse(plaintext)         │
  │                               │                               │
  │   stream_start                │                               │
  │<──────────────────────────────│                               │
  │                               │                               │
  │   stream_chunk[0]             │  (role chunk, encrypted)      │
  │<──────────────────────────────│                               │
  │                               │                               │
  │                               │  POST /v1/messages (stream)   │
  │                               │──────────────────────────────>│
  │                               │                               │
  │                               │  data: message_start          │
  │                               │<──────────────────────────────│
  │                               │                               │
  │   stream_chunk[1..N]          │  data: content_block_delta    │
  │<──────────────────────────────│<──────────────────────────────│
  │   (每个chunk独立加密)          │  text → seal() → base64      │
  │                               │                               │
  │                               │  data: message_delta          │
  │                               │<──────────────────────────────│
  │                               │                               │
  │   stream_chunk[N+1]           │  (finish_reason chunk)        │
  │<──────────────────────────────│                               │
  │                               │                               │
  │   stream_end{usage}           │                               │
  │<──────────────────────────────│                               │
  │                        activeRequests--                       │
```

### 3.3 请求处理流程（非流式）

```
Relay                          Provider                        Anthropic API
  │   request                     │                               │
  │──────────────────────────────>│                               │
  │                        解密 → 解析                             │
  │                               │  POST /v1/messages            │
  │                               │──────────────────────────────>│
  │                               │  { content, usage }           │
  │                               │<──────────────────────────────│
  │                        seal(responseJSON, consumerEncPub)      │
  │   response{encrypted_body}    │                               │
  │<──────────────────────────────│                               │
```

## 4. 状态管理

### 4.1 运行时状态

```typescript
// 进程内状态（无持久化）
let activeRequests: number = 0;      // 当前并发请求数
const conn: Connection;              // 与Relay的WebSocket连接
const apiKey: string;                // 使用中的API key
```

**特点：极简，无复杂状态机。**

### 4.2 状态转换

```
INIT ──(connect)──> CONNECTING ──(provider_ack:accepted)──> ONLINE
                                   │
                      (provider_ack:rejected) → LOG_AND_STAY
                                                [GAP: 应有REJECTED状态]
ONLINE ──(request)──> PROCESSING ──(response/error)──> ONLINE
       ──(ws close)──> DISCONNECTED
                        [GAP: 无自动重连逻辑]
```

### 4.3 [GAP] 缺失的状态管理

- **无Provider状态枚举**：没有`ONLINE/OFFLINE/DRAINING`等状态定义
- **无连接重连**：WebSocket断开后直接结束，需要外部重启
- **无优雅关闭**：`close()`直接关连接，不等待进行中的请求完成
- **无持久化统计**：处理总数/错误率/延迟等指标未记录

## 5. 错误处理

### 5.1 重试策略（已实现）

```typescript
// 来自 RETRY_CONFIG（config/bootstrap.ts）
{
  maxRetries: number,     // 最大重试次数
  baseDelayMs: number,    // 基础延迟
  maxDelayMs: number,     // 最大延迟
  jitterFactor: number,   // 抖动因子
}

// 延迟计算公式
delay = min(baseDelay × 2^attempt, maxDelay) ± jitter
jitter = delay × jitterFactor × random(-1, 1)
```

### 5.2 错误分类

| HTTP状态码 | 错误类型 | 行为 |
|-----------|---------|------|
| 429 | rate_limit | 重试（指数退避） |
| 529 | overloaded | 重试（指数退避） |
| 500 | server_error | 重试（指数退避） |
| 400 | invalid_request | **不重试**，立即抛错 |
| 401 | upstream_auth | **不重试**，API key问题 |
| fetch异常 | network_error | 重试（网络级失败） |

### 5.3 错误传播

```
API错误 → handleRequest throws → handleIncomingRequest catch
                                         │
                                  映射为error code:
                                  ├── 'decrypt_failed' → code:'decrypt_failed'
                                  ├── 'upstream_auth' → code:'api_error'
                                  ├── 'anthropic_4XX' → code:'api_error'
                                  └── 其他 → code:'api_error'
                                         │
                                  conn.send({type:'error', code, message})
                                         │
                                  activeRequests--（finally）
```

### 5.4 [GAP] 缺失的错误处理

- **无超容量排队**：`activeRequests >= maxConcurrent`时直接拒绝，无队列缓冲
- **无API key失效处理**：401错误后不标记key为失效，不切换备用key
- **无请求超时**：单个请求无超时限制，流式请求可能无限挂起
- **无部分流失败恢复**：流式传输中途失败，已发送的chunk无法撤回
- **provider_ack rejected后无处理**：只打日志，不退出不重试

## 6. 安全约束

### 6.1 已实现

| 约束 | 实现方式 |
|------|---------|
| **API key本地化** | key仅在Provider进程内使用，不通过WebSocket发送 |
| **请求解密隔离** | NaCl box解密，Relay无法读取请求内容 |
| **响应加密** | 每个chunk/response用consumer的公钥加密，Provider也无法重放 |
| **身份签名** | provider_hello用Ed25519签名，Relay可验证Provider身份 |
| **OAuth伪装** | 检测`sk-ant-oat`前缀，自动注入Claude Code headers以规避API检测 |

### 6.2 反检测措施（基于协议大纲Section 5）

```typescript
// OAuth token模式 — 模拟Claude Code CLI
if (isOAuthToken) {
  headers['Authorization'] = `Bearer ${apiKey}`;
  headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20,...';
  headers['anthropic-dangerous-direct-browser-access'] = 'true';
  headers['user-agent'] = 'claude-cli/2.1.75';
  headers['x-app'] = 'cli';
}

// OAuth要求注入Claude Code system prompt
if (isOAuthToken && !anthropicRequest.system) {
  anthropicRequest.system = [{ type: 'text', text: "You are Claude Code..." }];
}
```

### 6.3 [GAP] 缺失的安全措施

- **[GAP] 无请求来源验证**：Provider不验证请求的consumer签名（由Relay代理验证）
- **[GAP] 无consumerEncPubkey可信性验证**：直接从inner前32字节取公钥，无独立验证
- **[GAP] 无API调用频率自保护**：不限制对Anthropic API的调用频率，可能触发账号级封禁
- **[GAP] 无prompt内容审查**：不检查解密后的prompt内容（可能含违规内容导致账号封禁）
- **[GAP] 无指纹多样化**：`user-agent`版本号硬编码`2.1.75`，多Provider使用相同指纹
- **[GAP] 无IP/地理位置验证**：不检查请求来源地区与API账号注册地区的一致性
- **[GAP] 无响应内容清洗**：API错误响应可能泄漏Provider的账号信息

## 7. 测试要求

### 7.1 单元测试

| 测试项 | 描述 | 优先级 |
|-------|------|-------|
| `handleRequest` 非流式 | mock fetch → 验证正确解析content/usage/finish_reason | P0 |
| `handleRequest` 流式 | mock SSE reader → 验证逐chunk回调+最终usage | P0 |
| `getRetryDelay` | 验证指数退避+jitter范围 | P1 |
| 重试逻辑 | mock 429/529 → 验证重试次数和延迟 | P0 |
| 400/401不重试 | mock 400/401 → 验证立即抛错 | P0 |
| OAuth header注入 | `sk-ant-oat` token → 验证正确headers | P1 |
| MODEL_MAP映射 | 通用模型名 → anthropic模型ID | P1 |
| system消息分离 | messages中有system → 正确提取到anthropic.system | P0 |

### 7.2 集成测试

| 测试项 | 描述 | 优先级 |
|-------|------|-------|
| `startProvider` 全流程 | mock Relay WebSocket → hello → ack → request → response | P0 |
| 解密+API+加密 | 端到端信封加密/解密验证 | P0 |
| 并发控制 | 发N+1个并发请求，验证第N+1个被拒绝 | P1 |
| 连接断开 | Relay关闭WebSocket → 验证onClose回调 | P1 |
| 代理模式 | proxyUrl设置 → 请求发到代理地址 | P2 |

### 7.3 [GAP] 缺失的测试需求

- **压力测试**：高并发下的内存和CPU表现
- **长连接稳定性**：24h+ WebSocket连接不退化
- **大payload测试**：>100KB的prompt/response处理
- **网络中断恢复**：模拟网络闪断后的行为

## 8. 模块依赖

```
provider/index.ts
    │
    ├── network/index.ts      ← connect() WebSocket连接
    │     └── ws              ← WebSocket底层库
    │
    ├── crypto/index.ts       ← open(), seal(), sign(), toHex(), fromHex()
    │     └── tweetnacl       ← NaCl加密原语
    │
    ├── config/bootstrap.ts   ← MODEL_MAP, RETRY_CONFIG
    │
    ├── wallet/index.ts       ← Wallet类型（密钥对）
    │
    └── types.ts              ← WsMessage, RequestPayload, InnerPlaintext,
                                 StreamChunkPayload
```

### 依赖方向规则

```
provider → crypto   ✅ (provider用crypto加解密)
provider → network  ✅ (provider用network连接Relay)
provider → types    ✅ (共享类型定义)
provider → config   ✅ (读取配置)
provider → relay    ❌ (禁止! provider不依赖relay)
provider → db       ❌ (禁止! provider不直接操作DB)
                         [GAP: 但应该有本地usage日志能力]
```

---

*基于 src/provider/index.ts (397行) 逆向分析。[GAP] 标注共14处，需在v0.3迭代中逐步补齐。*
