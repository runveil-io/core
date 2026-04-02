# 07 — Relay Routing Design

> Relay中继：认证转发、Provider注册、见证记录、请求路由
> Date: 2026-04-01
> Status: Draft
> Depends on: 00-architecture-review-v0.2, 04-crypto-envelope, 03-metering-billing
> Source: `src/relay/index.ts` (375行), `src/db.ts` (63行)

## 1. 职责边界

### 做什么
- **Provider注册管理**：验证`provider_hello`签名，维护在线Provider列表
- **请求签名验证**：验证Consumer请求的Ed25519签名+时间戳新鲜度
- **盲转发**：将Consumer请求转发给目标Provider，**不解密请求内容**
- **身份剥离**：转发时将`consumer_pubkey`替换为`'redacted'`，Provider不知道Consumer身份
- **响应路由**：将Provider的response/stream_chunk/stream_end路由回正确的Consumer
- **见证生成**：请求完成后生成signed witness记录（含token usage），写入SQLite
- **Provider状态持久化**：在`provider_state`表中维护Provider连接状态
- **Provider列表查询**：响应`list_providers`请求，返回在线Provider信息
- **心跳处理**：响应`ping`消息

### 不做什么
- ❌ 请求内容解密/读取（Relay是"盲"的）
- ❌ 计费/扣费（metering模块的事）
- ❌ Provider选择/负载均衡（Consumer在outer.provider_id中指定目标）
- ❌ 密钥管理（wallet模块的事）
- ❌ API调用（Provider的事）
- ❌ [GAP] Consumer余额/额度检查（请求验证仅验签，不查余额）
- ❌ [GAP] Consumer身份注册/认证（任何有效签名都可以发请求）
- ❌ [GAP] Provider负载均衡（Consumer必须自己选Provider）
- ❌ [GAP] 请求限流/DDoS防护
- ❌ [GAP] 见证的链上提交（只写本地SQLite）

## 2. 接口定义

### 2.1 现有接口（基于源码）

```typescript
// === 配置 ===

interface RelayOptions {
  port: number;            // WebSocket监听端口
  wallet: Wallet;          // Relay自身的签名密钥对（用于签witness）
  dbPath: string;          // SQLite数据库路径
}

// === 启动/关闭 ===

/** 启动Relay服务器 */
async function startRelay(options: RelayOptions): Promise<{ close(): Promise<void> }>;

// === 请求验证（导出，可独立测试） ===

/**
 * 验证Consumer请求签名
 * 检查: 1) 时间戳新鲜度 2) inner_hash匹配 3) Ed25519签名
 */
function verifyRequest(
  outer: RequestPayload['outer'],
  requestId: string,
  timestamp: number,
  innerBase64: string,
): boolean;

// === 见证生成（导出，可独立测试） ===

/**
 * 创建Relay签名的见证记录
 * consumer_pubkey → daily-salted SHA-256 hash（隐私保护）
 */
function createWitness(
  requestId: string,
  consumerPubkey: string,
  providerId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  relayWallet: Wallet,
): WitnessRecord;

interface WitnessRecord {
  request_id: string;
  consumer_hash: string;     // SHA-256(consumer_pubkey + dailySalt)
  provider_id: string;
  relay_id: string;          // hex(relay.signingPublicKey)
  model: string;
  input_tokens: number;
  output_tokens: number;
  timestamp: number;
  relay_signature: string;   // hex(Ed25519签名)
}
```

### 2.2 数据库Schema（来自db.ts）

```sql
-- Provider连接状态（Relay维护）
CREATE TABLE provider_state (
  provider_id TEXT PRIMARY KEY,         -- Ed25519公钥hex
  encryption_pubkey TEXT NOT NULL,      -- X25519公钥hex
  models TEXT NOT NULL,                 -- JSON数组 e.g. '["claude-sonnet"]'
  capacity INTEGER NOT NULL DEFAULT 100,
  connected_at INTEGER NOT NULL,        -- 首次连接时间戳
  last_heartbeat INTEGER NOT NULL,      -- 最后心跳时间戳
  status TEXT NOT NULL CHECK(status IN ('online', 'offline')) DEFAULT 'online'
);

-- 见证记录（不可篡改日志）
CREATE TABLE witness (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,      -- 全局唯一请求ID
  consumer_hash TEXT NOT NULL,          -- 匿名化Consumer身份
  provider_id TEXT NOT NULL,
  relay_id TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  timestamp INTEGER NOT NULL,
  relay_signature TEXT NOT NULL          -- Relay签名，链上可验证
);

-- 用量日志
CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL CHECK(direction IN ('outbound', 'inbound')),
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('ok', 'error', 'timeout')),
  error_code TEXT,
  provider_id TEXT,
  consumer_id TEXT,
  created_at INTEGER NOT NULL
);
```

### 2.3 [GAP] 应有但缺失的接口

```typescript
// [GAP] Consumer余额检查
interface BalanceChecker {
  hasCredit(consumerPubkey: string, estimatedCost: number): Promise<boolean>;
  deduct(consumerPubkey: string, witness: WitnessRecord): Promise<void>;
}

// [GAP] Provider负载均衡
interface ProviderSelector {
  selectBest(model: string, preferences?: {
    latency?: 'low' | 'any';
    region?: string;
  }): ProviderInfo | null;
}

// [GAP] 请求限流
interface RateLimiter {
  check(consumerPubkey: string): { allowed: boolean; retryAfterMs?: number };
  record(consumerPubkey: string): void;
}

// [GAP] 见证批量提交
interface WitnessBatchSubmitter {
  flush(): Promise<{ submitted: number; failed: number }>;
  getPending(): WitnessRecord[];
}

// [GAP] Provider健康监控
interface ProviderHealth {
  recordLatency(providerId: string, latencyMs: number): void;
  recordError(providerId: string, code: string): void;
  getScore(providerId: string): number;  // 0-100
}
```

## 3. 数据流

### 3.1 Provider注册流程

```
Provider                         Relay                           SQLite
   │                               │                               │
   │  provider_hello               │                               │
   │  ┌────────────────────────┐   │                               │
   │  │ provider_pubkey        │   │                               │
   │  │ encryption_pubkey      │   │                               │
   │  │ models: ["sonnet",...] │   │                               │
   │  │ capacity: 100          │   │                               │
   │  │ signature: sign(JSON)  │   │                               │
   │  └────────────────────────┘   │                               │
   │──────────────────────────────>│                               │
   │                               │                               │
   │                        验证签名:                               │
   │                        signable = JSON.stringify({             │
   │                          provider_pubkey,                      │
   │                          encryption_pubkey,                    │
   │                          models, capacity,                     │
   │                          timestamp                             │
   │                        })                                      │
   │                        verify(signable, sig, pubkey)           │
   │                               │                               │
   │                               │  UPSERT provider_state        │
   │                               │──────────────────────────────>│
   │                               │                               │
   │                        providers.set(id, {conn, info})        │
   │                               │                               │
   │  provider_ack{accepted}       │                               │
   │<──────────────────────────────│                               │
```

### 3.2 Consumer请求→Provider→响应 完整流程

```
Consumer                     Relay                        Provider
   │                           │                               │
   │  request                  │                               │
   │  ┌─────────────────────┐  │                               │
   │  │ outer:              │  │                               │
   │  │   consumer_pubkey   │  │                               │
   │  │   provider_id       │  │                               │
   │  │   model             │  │                               │
   │  │   signature         │  │                               │
   │  │ inner: base64(...)  │  │                               │
   │  └─────────────────────┘  │                               │
   │──────────────────────────>│                               │
   │                           │                               │
   │                    ① verifyRequest():                     │
   │                    - |now - timestamp| < MAX_REQUEST_AGE  │
   │                    - inner_hash = SHA256(base64decode)    │
   │                    - verify(signable, sig, consumer_pub)  │
   │                           │                               │
   │                    ② 查找Provider:                        │
   │                    providers.get(outer.provider_id)       │
   │                    检查conn.readyState === 'open'        │
   │                           │                               │
   │                    ③ 存储路由映射:                         │
   │                    consumers.set(requestId, consumerConn) │
   │                    requestMeta.set(requestId, {meta})     │
   │                           │                               │
   │                    ④ 转发（身份剥离）:                     │
   │                    outer.consumer_pubkey = 'redacted'     │
   │                           │  request (redacted)           │
   │                           │──────────────────────────────>│
   │                           │                               │
   │                           │  response / stream_*          │
   │                           │<──────────────────────────────│
   │                           │                               │
   │                    ⑤ 路由回Consumer:                      │
   │  response / stream_*      │                               │
   │<──────────────────────────│                               │
   │                           │                               │
   │                    ⑥ 生成见证（仅response/stream_end）:   │
   │                    createWitness(requestId, ...)          │
   │                    INSERT INTO witness                    │
   │                           │                               │
   │                    ⑦ 清理:                                │
   │                    consumers.delete(requestId)            │
   │                    requestMeta.delete(requestId)          │
```

### 3.3 见证记录生成

```
                    createWitness()
                         │
                         ▼
              dailySalt = "2026-04-01"
              consumer_hash = SHA256(consumer_pubkey + dailySalt)
              relay_id = hex(relay.signingPublicKey)
                         │
                         ▼
              witnessData = JSON.stringify({
                request_id, consumer_hash, provider_id,
                relay_id, model, input_tokens, output_tokens,
                timestamp
              })
                         │
                         ▼
              relay_signature = sign(witnessData, relay.signingSecretKey)
                         │
                         ▼
              INSERT INTO witness (...)
              [GAP: 无链上提交，仅本地存储]
```

## 4. 状态管理

### 4.1 运行时状态（内存）

```typescript
// Provider连接池
const providers = new Map<string, ConnectedProvider>();
// ConnectedProvider = { conn: Connection, info: ProviderInfo }

// 请求路由表
const consumers = new Map<string, Connection>();       // requestId → Consumer连接
const requestMeta = new Map<string, {                  // requestId → 请求元数据
  consumerPubkey: string;
  providerId: string;
  model: string;
}>();

// SQLite prepared statements
const insertWitness: Statement;
const upsertProvider: Statement;
const removeProvider: Statement;
```

### 4.2 Provider生命周期

```
                    provider_hello (签名有效)
                           │
        ┌──────────────────▼──────────────────┐
        │              ONLINE                  │
        │  providers.set(id, {conn, info})     │
        │  DB: status='online'                 │
        │  可接受request转发                    │
        └──────────────────┬──────────────────┘
                           │
                    WebSocket close事件
                           │
        ┌──────────────────▼──────────────────┐
        │              OFFLINE                 │
        │  providers.delete(id)                │
        │  DB: status='offline'                │
        │  不再接受request                     │
        └─────────────────────────────────────┘

[GAP] 缺失的状态:
- 无 DRAINING 状态（优雅下线，完成进行中请求后再标offline）
- 无 UNHEALTHY 状态（错误率高，临时停止转发）
- 无 heartbeat超时检测（Provider静默断开时无法发现）
```

### 4.3 请求生命周期

```
Consumer发送request
        │
  ┌─────▼─────┐
  │  RECEIVED  │  验签+查Provider
  └─────┬─────┘
        │
  ┌─────▼─────┐
  │  ROUTED    │  consumers.set() + requestMeta.set()
  └─────┬─────┘          转发给Provider
        │
  ┌─────▼──────────────────────────────┐
  │  STREAMING / WAITING               │  等Provider响应
  │  (stream_start → chunk* → end)     │
  └─────┬──────────────────────────────┘
        │
  ┌─────▼─────┐
  │ WITNESSED  │  createWitness() → INSERT
  └─────┬─────┘  consumers.delete() + requestMeta.delete()
        │
       完成

[GAP] 无请求超时机制：
  如果Provider不响应，requestMeta永远留在Map中（内存泄漏）
```

## 5. 错误处理

### 5.1 签名验证失败

```typescript
// 时间戳过期
if (Math.abs(now - timestamp) > MAX_REQUEST_AGE_MS) → return false
// Consumer请求被拒，返回 code:'invalid_signature'

// 签名不匹配
if (!verify(signable, signature, pubkey)) → return false
// 同上
```

### 5.2 Provider不可用

```typescript
// Provider未注册或连接已关
if (!provider || provider.conn.readyState !== 'open') {
  → code:'no_provider', message:'Provider not available'
}
```

### 5.3 错误分类表

| 场景 | 错误码 | 行为 |
|------|--------|------|
| 签名验证失败 | `invalid_signature` | 拒绝请求，返回Consumer |
| 时间戳过期 | `invalid_signature` | 拒绝请求（防重放） |
| Provider离线 | `no_provider` | 拒绝请求 |
| Provider响应error | 原样转发 | 透传给Consumer |
| JSON解析失败 | (静默) | console.log错误，丢弃消息 |
| Consumer请求处理异常 | `api_error` | try-catch包裹，返回错误 |
| witness INSERT冲突 | (静默) | duplicate request_id，catch忽略 |

### 5.4 [GAP] 缺失的错误处理

- **[GAP] 无请求超时清理**：转发给Provider后，若Provider无响应，consumers/requestMeta Map永不清理
- **[GAP] 无Consumer断开检测**：Consumer WebSocket关闭后，已转发的请求继续处理但结果无处投递
- **[GAP] 无Provider错误率追踪**：某Provider持续返回error不会被自动下线
- **[GAP] 无见证写入失败处理**：除了duplicate忽略，其他DB错误也被catch空吞
- **[GAP] 无消息大小限制**：不限制inner payload大小，潜在OOM风险

## 6. 安全约束

### 6.1 已实现

| 约束 | 实现方式 | 代码位置 |
|------|---------|---------|
| **请求签名验证** | Ed25519 detached verify | `verifyRequest()` |
| **时间戳新鲜度** | `\|now - timestamp\| < MAX_REQUEST_AGE_MS` | `verifyRequest()` |
| **内容完整性** | `SHA256(inner_bytes)` vs outer.inner_hash | `verifyRequest()` |
| **身份剥离** | `consumer_pubkey = 'redacted'` 转发给Provider | `handleConsumerRequest()` |
| **Consumer匿名化** | `SHA256(pubkey + dailySalt)` 写入witness | `createWitness()` |
| **见证不可伪造** | Relay用自己的Ed25519私钥签witness | `createWitness()` |
| **Provider签名验证** | provider_hello的Ed25519签名验证 | `handleProviderHello()` |
| **DB安全配置** | WAL mode + foreign_keys + CHECK约束 | `initDatabase()` |
| **请求盲转发** | Relay不解密inner payload | 架构设计 |

### 6.2 身份剥离深度分析

```
Consumer请求:
  outer.consumer_pubkey = "abc123..."    ← Consumer真实公钥
  outer.signature = sign(..., secretKey) ← 验签用

Relay处理后转发:
  outer.consumer_pubkey = "redacted"     ← Provider看不到Consumer身份

Witness记录:
  consumer_hash = SHA256("abc123..." + "2026-04-01")
  ← 同一Consumer每日hash不同（dailySalt变化）
  ← 不同Consumer无法关联
  [GAP] dailySalt粒度为天，同一天内的请求可被关联
```

### 6.3 [GAP] 缺失的安全措施

- **[GAP] 无Consumer认证/准入**：任何能生成有效Ed25519签名的人都能发请求，无余额/白名单检查
- **[GAP] 无TLS证书验证**：WebSocket连接层面不在Relay代码中处理（依赖部署层nginx/caddy）
- **[GAP] 无请求限流**：单个Consumer可以发无限请求，无速率限制
- **[GAP] 无IP层防护**：无IP黑名单/地理围栏
- **[GAP] 无消息重放完整防护**：虽有时间戳检查，但无nonce/request_id去重（同一时间窗口内可重放）
- **[GAP] Provider连接无双向认证**：Relay验证Provider签名，但Provider不验证Relay身份
- **[GAP] 无审计日志**：除witness外，无操作审计记录（谁连了/谁被拒了/签名失败统计）
- **[GAP] witness仅本地存储**：无链上提交机制，Relay作恶可篡改/删除witness

## 7. 测试要求

### 7.1 单元测试

| 测试项 | 描述 | 优先级 |
|-------|------|-------|
| `verifyRequest` 正常 | 有效签名+时间戳 → return true | P0 |
| `verifyRequest` 过期 | timestamp超过MAX_AGE → return false | P0 |
| `verifyRequest` 签名错 | 篡改inner后签名不匹配 → return false | P0 |
| `verifyRequest` inner篡改 | 修改inner但不改签名 → return false | P0 |
| `createWitness` 正常 | 验证所有字段填充+签名可验证 | P0 |
| `createWitness` dailySalt | 不同日期 → 不同consumer_hash | P1 |
| `createWitness` 签名验证 | 用relay公钥验证relay_signature → true | P0 |

### 7.2 集成测试

| 测试项 | 描述 | 优先级 |
|-------|------|-------|
| Provider注册全流程 | hello → 签名验证 → ack → DB写入 → providers Map更新 | P0 |
| Provider注册失败 | 无效签名 → rejected ack | P0 |
| Consumer请求全流程 | request → 验签 → 转发 → response → 路由回 → witness写入 | P0 |
| 流式请求全流程 | request → stream_start → chunks → stream_end → witness | P0 |
| Provider断开 | close事件 → providers删除 → DB标offline | P0 |
| Provider不可用 | 请求指定不存在的Provider → error响应 | P1 |
| 多Provider注册 | 2+个Provider注册 → list_providers返回全部 | P1 |
| 并发请求 | 多个Consumer同时请求不同Provider → 正确路由 | P1 |
| witness去重 | 相同request_id → INSERT忽略 | P2 |

### 7.3 安全测试

| 测试项 | 描述 | 优先级 |
|-------|------|-------|
| 重放攻击 | 重发相同请求（时间戳过期） → 拒绝 | P0 |
| 签名伪造 | 随机签名 → 拒绝 | P0 |
| 身份剥离验证 | 转发给Provider的消息中consumer_pubkey确实是'redacted' | P0 |
| Consumer匿名性 | 不同dailySalt → 不同hash → 无法关联 | P1 |

### 7.4 [GAP] 缺失的测试需求

- **内存泄漏测试**：长时间运行consumers/requestMeta Map大小监控
- **大规模Provider测试**：100+ Provider同时在线的注册/断开性能
- **DB WAL性能**：高并发witness写入的SQLite性能
- **恶意消息测试**：超大payload/畸形JSON/非法type的处理

## 8. 模块依赖

```
relay/index.ts
    │
    ├── network/index.ts       ← createServer() WebSocket服务器
    │     └── ws               ← WebSocket底层库
    │
    ├── crypto/index.ts        ← verify(), sign(), sha256(), toHex(), fromHex()
    │     └── tweetnacl        ← NaCl加密原语
    │     └── node:crypto      ← SHA-256
    │
    ├── db.ts                  ← initDatabase() SQLite初始化
    │     └── better-sqlite3   ← SQLite引擎 (WAL mode)
    │     └── node:fs          ← mkdirSync
    │     └── node:path        ← dirname
    │
    ├── config/bootstrap.ts    ← MAX_REQUEST_AGE_MS
    │
    ├── wallet/index.ts        ← Wallet类型
    │
    └── types.ts               ← WsMessage, ProviderHelloPayload,
                                  RequestPayload, ProviderInfo,
                                  StreamEndPayload
```

### 依赖方向规则

```
relay → crypto     ✅ (验签+hash+见证签名)
relay → network    ✅ (WebSocket服务器)
relay → db         ✅ (witness+provider_state持久化)
relay → types      ✅ (共享类型定义)
relay → config     ✅ (读取配置)
relay → provider   ❌ (禁止! Relay不依赖Provider实现)
relay → consumer   ❌ (禁止! Relay不依赖Consumer实现)
relay → wallet     ⚠️ (仅类型引用, 不调用wallet方法)
```

### 与其他模块的交互边界

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│  Consumer   │◄──ws──►│    Relay     │◄──ws──►│  Provider   │
│             │         │             │         │             │
│ 选Provider  │         │ 验签+转发   │         │ 解密+API    │
│ 加密请求    │         │ 身份剥离    │         │ 加密响应    │
│ 解密响应    │         │ 见证记录    │         │             │
└─────────────┘         └──────┬──────┘         └─────────────┘
                               │
                        ┌──────▼──────┐
                        │   SQLite    │
                        │             │
                        │ witness     │
                        │ provider_st │
                        │ usage_log   │
                        └─────────────┘
                               │
                        [GAP: 链上提交]
                               │
                        ┌──────▼──────┐
                        │  Solana     │
                        │ (Stage 2)  │
                        └─────────────┘
```

---

*基于 src/relay/index.ts (375行) + src/db.ts (63行) 逆向分析。[GAP] 标注共16处，反映Day 1极简实现与生产级要求之间的差距，将在Stage 1-2中逐步补齐。*
