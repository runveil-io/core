# 04 — Crypto Envelope Design

> 信封加密/解密、签名验证、密钥管理
> Date: 2026-04-01
> Status: Draft
> Depends on: 00-architecture-review-v0.2
> Source: `src/crypto/index.ts` (69行)

## 1. 职责边界

### 做什么
- **密钥对生成**：Ed25519签名密钥对 + X25519加密密钥对
- **信封加密(seal)**：用NaCl box将明文加密为密文，附带发送方公钥+随机nonce
- **信封解密(open)**：从sealed格式中提取公钥+nonce+密文，解密得明文
- **签名/验签**：Ed25519 detached签名+验证
- **哈希**：SHA-256摘要
- **编码转换**：hex ↔ Uint8Array

### 不做什么
- ❌ 密钥持久化（wallet模块的事）
- ❌ 密钥派生/KDF（wallet模块用argon2id）
- ❌ Ed25519→X25519转换（架构红线：双密钥对独立生成）
- ❌ 消息协议/序列化（types模块的事）
- ❌ 任何网络操作

## 2. 接口定义

### 2.1 现有接口（基于源码）

```typescript
// === 密钥生成 ===

/** 生成Ed25519签名密钥对 */
function generateSigningKeyPair(): {
  publicKey: Uint8Array;   // 32 bytes
  secretKey: Uint8Array;   // 64 bytes
};

/** 生成X25519加密密钥对 */
function generateEncryptionKeyPair(): {
  publicKey: Uint8Array;   // 32 bytes
  secretKey: Uint8Array;   // 32 bytes
};

// === 签名 ===

/** Ed25519 detached签名 */
function sign(message: Uint8Array, secretKey: Uint8Array): Uint8Array;
// secretKey: 64 bytes (Ed25519 secret key)
// 返回: 64 bytes signature

/** Ed25519 detached验签 */
function verify(
  message: Uint8Array,
  signature: Uint8Array,   // 64 bytes
  publicKey: Uint8Array,   // 32 bytes
): boolean;

// === 加密 ===

/**
 * 信封加密
 * 格式: [senderPubkey(32)] [nonce(24)] [ciphertext(N+16)]
 * 总长度: 56 + plaintext.length + 16
 */
function seal(
  plaintext: Uint8Array,
  recipientPubkey: Uint8Array,    // 32 bytes, X25519
  senderSecretKey: Uint8Array,    // 32 bytes, X25519
): Uint8Array;

/**
 * 信封解密
 * 返回null表示解密失败（密钥不匹配/数据损坏）
 */
function open(
  sealed: Uint8Array,             // 最小56 bytes
  recipientSecretKey: Uint8Array, // 32 bytes, X25519
): Uint8Array | null;

// === 工具函数 ===

function sha256(data: Uint8Array): Uint8Array;   // 返回32 bytes
function toHex(bytes: Uint8Array): string;
function fromHex(hex: string): Uint8Array;
```

### 2.2 缺失接口 [GAP]

```typescript
/** [GAP] 批量加密（流式场景每个chunk都seal一次，性能差） */
function createSealStream(
  recipientPubkey: Uint8Array,
  senderSecretKey: Uint8Array,
): {
  seal(plaintext: Uint8Array): Uint8Array;  // 复用密钥对，只换nonce
  close(): void;
};

/** [GAP] 安全清零敏感内存 */
function zeroize(buffer: Uint8Array): void;

/** [GAP] 常量时间比较（防timing attack） */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean;

/** [GAP] 密钥格式校验 */
function validatePublicKey(key: Uint8Array, type: 'signing' | 'encryption'): boolean;
```

## 3. 数据流

### 3.1 信封加密(seal)

```
plaintext (Uint8Array)
    │
    ├── senderSecretKey (X25519, 32B)
    │   └── nacl.box.keyPair.fromSecretKey() → senderPubkey
    │
    ├── recipientPubkey (X25519, 32B)
    │
    └── nonce ← nacl.randomBytes(24)
            │
            ▼
    nacl.box(plaintext, nonce, recipientPubkey, senderSecretKey)
            │
            ▼
    sealed = [senderPubkey(32B)] [nonce(24B)] [ciphertext(N+16B)]
             └──────── 总长度: plaintext.length + 72 ────────┘
```

### 3.2 信封解密(open)

```
sealed (Uint8Array, min 56B)
    │
    ├── slice(0, 32)  → senderPubkey
    ├── slice(32, 56) → nonce
    └── slice(56)     → ciphertext
            │
            ├── recipientSecretKey (X25519, 32B)
            │
            ▼
    nacl.box.open(ciphertext, nonce, senderPubkey, recipientSecretKey)
            │
            ├── 成功 → plaintext (Uint8Array)
            └── 失败 → null
```

### 3.3 Consumer请求加密全流程

```
Consumer                           Provider
  │                                   │
  │  1. 构造InnerPlaintext (JSON)     │
  │  2. JSON.stringify → UTF-8 bytes  │
  │  3. seal(bytes,                   │
  │       providerEncPubkey,          │
  │       consumerEncSecretKey)       │
  │  4. base64(sealed) → inner       │
  │  5. sha256(sealed) → innerHash   │
  │  6. sign({requestId,             │
  │       consumerPubkey,             │
  │       providerId, model,          │
  │       timestamp, innerHash})      │
  │  7. 发送WsMessage{type:request}  │
  │──────────── via Relay ──────────>│
  │                                   │  8.  base64.decode(inner)
  │                                   │  9.  open(decoded, providerEncSecretKey)
  │                                   │  10. JSON.parse → InnerPlaintext
  │                                   │  11. 调用AI API
  │                                   │  12. seal(response,
  │                                   │       consumerEncPubkey,    ← 从sealed[0:32]提取
  │                                   │       providerEncSecretKey)
  │<───────── encrypted response ─────│
  │  13. open(response,               │
  │       consumerEncSecretKey)       │
  │  14. JSON.parse → result          │
```

## 4. 状态管理

### 持久化
- **无**。crypto模块是纯函数，不持久化任何东西
- 密钥持久化由wallet模块负责（加密的wallet.json）

### 内存
- 密钥对在进程生命周期内存活于内存中（通过wallet模块加载）
- [GAP] 进程退出时应清零secretKey内存（Node.js无法保证，但应尽力）

## 5. 错误处理

| 错误场景 | 现有处理 | 建议处理 |
|---------|---------|---------|
| seal加密失败(nacl.box返回null) | `throw new Error('encryption_failed')` | ✅ 合理 |
| open解密失败 | 返回`null` | ✅ 合理（调用者判断） |
| sealed长度<56 | 返回`null` | ✅ 合理 |
| [GAP] fromHex无效hex字符串 | Buffer.from不报错，返回截断结果 | 应校验hex格式，抛出明确错误 |
| [GAP] secretKey长度错误 | nacl内部抛异常 | 应在入口校验密钥长度 |
| [GAP] publicKey格式错误 | nacl内部行为未定义 | 应校验32字节 |

### 建议错误码

```typescript
type CryptoErrorCode =
  | 'ENCRYPTION_FAILED'    // seal失败
  | 'DECRYPTION_FAILED'    // open返回null
  | 'INVALID_KEY_LENGTH'   // 密钥长度不对
  | 'INVALID_HEX'          // hex字符串格式错误
  | 'INVALID_SEALED_DATA'  // sealed数据太短或格式错误
  | 'SIGNATURE_INVALID';   // 验签失败
```

## 6. 安全约束

### 🔴 红线（不可妥协）

1. **不做Ed25519→X25519密钥转换**：双密钥对必须独立生成。转换会创建密钥关联，降低安全性
2. **nonce必须随机**：每次seal用`nacl.randomBytes(24)`，不能用计数器或确定性方法
3. **secretKey不能出现在日志/错误消息中**：任何log输出必须确保不包含密钥材料
4. **不引入非tweetnacl的加密库**：Day 1单一加密依赖，减少供应链攻击面
5. **open返回null不能区分原因**：不泄露解密失败是因为密钥错误还是数据损坏（防oracle attack）

### ⚠️ 已知风险

1. **senderPubkey明文附在sealed数据中**：Relay可以看到谁在和谁通信（但看不到内容）。这是设计选择——Provider需要知道用谁的公钥加密回复
2. **tweetnacl是纯JS**：性能不如native实现，但零native依赖 = 零供应链风险。等性能成瓶颈再换
3. **Node.js无法保证内存清零**：GC可能在清零前已复制secretKey。接受这个风险

## 7. 测试要求

### 场景1：加解密往返
- 生成两对密钥(Alice, Bob)
- Alice seal消息给Bob → Bob open成功 → 明文一致
- Charlie用自己的secretKey open → 返回null

### 场景2：签名往返
- 生成签名密钥对
- sign一条消息 → verify返回true
- 篡改消息任意一个bit → verify返回false
- 用错误公钥verify → 返回false

### 场景3：sealed格式边界
- 空plaintext → seal应成功，open应恢复空Uint8Array
- sealed长度<56 → open返回null
- sealed长度=56（空ciphertext区域）→ open返回null（ciphertext最少16字节MAC）
- 超大plaintext(10MB) → seal/open应在合理时间内完成

### 场景4：hex编码
- toHex(fromHex(validHex)) === validHex
- 奇数长度hex → [GAP] 应报错
- 非hex字符 → [GAP] 应报错

### 场景5：nonce唯一性
- 连续100次seal同一消息+同一密钥对 → 100个不同的sealed输出（因为随机nonce）

### 场景6：跨角色加密
- 模拟Consumer→Provider: consumer seal, provider open
- 模拟Provider→Consumer: provider seal(用consumer pubkey from sealed[0:32]), consumer open
- 验证Relay无法解密（无任何一方的secretKey）

## 8. 模块依赖

### 调用谁
- `tweetnacl` — 所有加密原语
- `node:crypto` — 仅SHA-256（`createHash`）

### 被谁调用
- `consumer/index.ts` — seal请求、open响应、sign请求、sha256计算innerHash
- `provider/index.ts` — open请求、seal响应、sign心跳
- `relay/index.ts` — verify请求签名、verify Provider hello签名、sign见证、sha256计算innerHash
- `wallet/` — 密钥生成

### 依赖图

```
            ┌──────────┐
            │ consumer │──┐
            └──────────┘  │
            ┌──────────┐  │     ┌────────┐     ┌───────────┐
            │ provider │──┼────>│ crypto │────>│ tweetnacl │
            └──────────┘  │     └────────┘     └───────────┘
            ┌──────────┐  │         │
            │  relay   │──┘         │
            └──────────┘            ▼
            ┌──────────┐      ┌───────────┐
            │  wallet  │─────>│ node:crypto│ (sha256 only)
            └──────────┘      └───────────┘
```

---

*crypto模块是信任根基。69行代码，零外部状态，纯函数。保持简单。*
