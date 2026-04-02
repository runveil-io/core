# 09 — Wallet & Identity Design

> 密钥对生成、加密存储、身份管理、API Key加密
> Date: 2026-04-01
> Status: Draft
> Depends on: 00-architecture-review-v0.2, crypto/ (tweetnacl封装)

## 1. 职责边界

Wallet模块是Veil协议的身份基础层，负责"你是谁"和"你的秘密怎么存"。

**管（DO）：**
- 双密钥对生成（Ed25519签名 + X25519加密）
- 密钥加密存储（scrypt KDF + AES-256-GCM）
- 钱包文件读写（`~/.veil/wallet.json`）
- 配置文件初始化（`~/.veil/config.json`）
- API Key加密/解密（Provider的第三方密钥保护）
- 公钥查询（无需密码的只读操作）

**不管（DON'T）：**
- 签名/验签（crypto模块的事）
- 密钥交换/信封加密（crypto/envelope.ts）
- 链上身份注册（Stage 2+）
- 多钱包管理/HD派生（Day 1只有一个身份）
- 密码强度评估（只检查>=8字符）

**安全红线：** 私钥永远只在内存中明文存在，落盘必须加密。

## 2. 接口定义

### 2.1 核心类型

```typescript
// 解锁后的钱包（全部密钥在内存）
export interface Wallet {
  signingPublicKey: Uint8Array;    // Ed25519公钥 — 身份标识
  signingSecretKey: Uint8Array;    // Ed25519私钥 — 消息签名
  encryptionPublicKey: Uint8Array; // X25519公钥 — 密钥交换
  encryptionSecretKey: Uint8Array; // X25519私钥 — 解密
}

// 公开信息（不需要密码即可读取）
export interface WalletPublicInfo {
  signingPublicKey: string;        // hex编码
  encryptionPublicKey: string;     // hex编码
}

// 钱包文件格式（wallet.json on disk）
interface WalletFile {
  version: number;                  // 文件格式版本，当前=1
  kdf: string;                      // KDF算法标识，当前="scrypt"
  kdf_params: {                     // KDF参数（文件自描述，迁移安全）
    N: number;                      // CPU/memory cost (默认2^14测试, 生产应2^17)
    r: number;                      // block size (8)
    p: number;                      // parallelization (1)
  };
  salt: string;                     // hex, 16字节随机
  iv: string;                       // hex, 12字节随机
  ciphertext: string;               // hex, AES-256-GCM加密后的密钥JSON
  tag: string;                      // hex, GCM认证标签
}
```

### 2.2 函数签名

```typescript
// 创建钱包 — 生成密钥对+加密存储+写配置
export async function createWallet(
  password: string,                 // 最少8字符
  veilHome?: string                 // 默认 ~/.veil
): Promise<WalletPublicInfo>;

// 加载钱包 — 密码解密+返回全部密钥
export async function loadWallet(
  password: string,
  veilHome?: string
): Promise<Wallet>;

// 查询公钥 — 从config.json读取，不需要密码
export function getPublicKeys(
  veilHome?: string
): WalletPublicInfo;

// API Key加密 — Provider用同一密码保护第三方API Key
export function encryptApiKey(
  apiKey: string,
  password: string
): { salt: string; iv: string; ciphertext: string; tag: string };

// API Key解密
export function decryptApiKey(
  enc: { salt: string; iv: string; ciphertext: string; tag: string },
  password: string
): string;
```

### 2.3 [GAP] 缺失接口

```typescript
// [GAP] 密码修改 — 当前只能 --force 重建，会丢失身份
export async function changePassword(
  oldPassword: string,
  newPassword: string,
  veilHome?: string
): Promise<void>;

// [GAP] 密钥导出/导入 — 设备迁移必需
export async function exportWallet(
  password: string,
  format: 'json' | 'mnemonic',
  veilHome?: string
): Promise<string>;

export async function importWallet(
  data: string,
  password: string,
  format: 'json' | 'mnemonic',
  veilHome?: string
): Promise<WalletPublicInfo>;

// [GAP] 内存安全清理 — 用完私钥后应擦除
export function zeroize(wallet: Wallet): void;

// [GAP] 钱包锁定/自动锁定
export interface WalletSession {
  wallet: Wallet;
  lock(): void;                     // 擦除内存中的私钥
  isLocked(): boolean;
  unlock(password: string): Promise<void>;
  autoLockAfter(ms: number): void;  // N毫秒无活动自动锁定
}

// [GAP] 密码强度验证
export function validatePasswordStrength(password: string): {
  valid: boolean;
  score: number;       // 0-4
  feedback: string[];
};
```

## 3. 数据流

### 3.1 钱包创建（`veil init`）

```
用户输入密码
      │
      ▼
密码长度检查 (>=8)
      │
      ▼
检查wallet.json是否存在
      │ 已存在且无--force → 报错退出
      │ 不存在或有--force
      ▼
┌──────────────────────────────┐
│ crypto/index.ts              │
│  generateSigningKeyPair()    │──▶ Ed25519 keypair
│  generateEncryptionKeyPair() │──▶ X25519 keypair
└──────────────────────────────┘
      │
      ▼
4个key拼成JSON字符串
      │
      ▼
┌──────────────────────────────┐
│ encrypt(keysJSON, password)  │
│  salt = randomBytes(16)      │
│  key  = scrypt(pwd, salt)    │
│  iv   = randomBytes(12)      │
│  cipher = AES-256-GCM       │
│  tag  = getAuthTag()         │
└──────────────────────────────┘
      │
      ├──▶ ~/.veil/wallet.json   (mode: 0o600)
      │    { version, kdf, kdf_params, salt, iv, ciphertext, tag }
      │
      └──▶ ~/.veil/config.json   (mode: 0o600)
           { relay_url, gateway_port, consumer_pubkey, encryption_pubkey }
```

### 3.2 钱包解锁（每次启动服务）

```
用户输入密码
      │
      ▼
读取 ~/.veil/wallet.json
      │
      ▼
┌──────────────────────────────┐
│ decrypt(walletFile, password)│
│  salt = fromHex(file.salt)   │
│  key  = scrypt(pwd, salt,    │
│         file.kdf_params)     │ ◀── KDF参数从文件读取（自描述）
│  iv   = fromHex(file.iv)     │
│  decipher = AES-256-GCM     │
│  setAuthTag(file.tag)        │
│  plaintext = decipher.final()│
└──────────────────────────────┘
      │
      │ 密码错误 → GCM认证失败 → 抛Error
      │ 密码正确
      ▼
JSON.parse(plaintext)
      │
      ▼
fromHex()还原4个Uint8Array
      │
      ▼
返回 Wallet { signingPub, signingSec, encPub, encSec }
      │
      ▼
[GAP] 私钥在内存中驻留至进程退出，无主动清除机制
```

### 3.3 API Key加密（Provider）

```
Provider输入API Key + 钱包密码
      │
      ▼
先用loadWallet验证密码正确
      │
      ▼
encryptApiKey(apiKey, password)
      │  （独立salt/iv，和wallet.json互不影响）
      ▼
写入 ~/.veil/provider.json
      { api_keys: [{ provider: "anthropic", salt, iv, ciphertext, tag }] }
```

## 4. 状态管理

### 4.1 文件系统状态

```
~/.veil/                    (mode: 0o700)
  ├── wallet.json           (mode: 0o600) — 加密的密钥对
  ├── config.json           (mode: 0o600) — 公钥+连接配置
  ├── provider.json         (mode: 0o600) — Provider配置+加密的API keys
  └── data/                 — 数据目录
      └── usage.db          — Relay用量数据库
```

### 4.2 内存状态

| 状态 | 生命周期 | 安全要求 |
|------|---------|---------|
| 密码字符串 | promptPassword()返回 → 传入create/load → 调用结束 | [GAP] 无主动清除，依赖GC |
| scrypt派生密钥 | encrypt/decrypt函数内 → 函数返回 | 同上 |
| Wallet私钥 | loadWallet()返回 → 进程退出 | **[GAP] 应有session+自动锁定** |
| API Key明文 | decryptApiKey()返回 → Provider持有 → 进程退出 | [GAP] 同上 |

### 4.3 状态迁移

```
未初始化 ──veil init──▶ 已初始化(锁定) ──loadWallet──▶ 已解锁
                              │                           │
                        getPublicKeys()              使用中(签名/加密)
                        (不需要密码)                       │
                                                    进程退出 → 锁定
                                                    [GAP] 无运行时重新锁定
```

## 5. 错误处理

### 5.1 当前错误处理

| 错误场景 | 处理 | 错误消息 |
|----------|------|---------|
| 已存在wallet.json（无--force） | 抛Error | "Already initialized. Use --force to reinitialize." |
| 密码<8字符 | 抛Error | "Password must be at least 8 characters." |
| wallet.json不存在时load | 抛Error | "Run 'veil init' first." |
| 密码错误（GCM解密失败） | 抛Error | Node crypto模块原始错误 |
| config.json不存在时getPublicKeys | 抛Error | "Not initialized. Run 'veil init'." |

### 5.2 [GAP] 缺失的错误处理

| 缺失 | 风险 | 建议 |
|------|------|------|
| **密码错误无友好提示** | GCM失败抛"Unsupported state or unable to authenticate data"，用户困惑 | 捕获并重新抛"Wrong password" |
| **wallet.json损坏** | JSON.parse失败，原始错误 | 检测+提示从备份恢复 |
| **磁盘空间不足** | writeFileSync失败 | 捕获ENOSPC |
| **权限不足** | mkdirSync/writeFileSync失败 | 捕获EACCES并提示 |
| **KDF参数不识别** | 未来迁移到argon2id时，旧代码读新文件 | version字段已预留，但无分支处理 |
| **并发创建钱包** | 两个进程同时init可能互相覆盖 | 文件锁(flock) |

## 6. 安全约束

### 6.1 加密方案评估

| 组件 | 当前实现 | 评价 |
|------|---------|------|
| KDF | scrypt (N=2^14, r=8, p=1) | ⚠️ N=2^14偏低，注释说"test compat"，生产应>=2^17 |
| 对称加密 | AES-256-GCM | ✅ 工业标准 |
| salt | 16字节随机 | ✅ 足够 |
| IV | 12字节随机 | ✅ GCM标准 |
| 认证 | GCM auth tag | ✅ 防篡改 |
| 文件权限 | 0o600 (owner读写) | ✅ |
| 目录权限 | 0o700 (owner全权) | ✅ |

### 6.2 [GAP] 安全缺失

| 缺失 | 风险级别 | 说明 |
|------|---------|------|
| **KDF生产参数未强制** | 🔴 HIGH | `VEIL_KDF_N` env可覆盖，恶意设N=1极度削弱 |
| **无密钥内存擦除** | 🔴 HIGH | Wallet对象在内存中明文驻留直到GC，进程core dump可泄露 |
| **无密码尝试限制** | 🟡 MEDIUM | 可暴力穷举loadWallet()，靠KDF慢速抵御但无计数器 |
| **config.json明文公钥** | 🟢 LOW | 公钥本就公开，但关联到本机文件系统的身份映射 |
| **无钱包备份机制** | 🟡 MEDIUM | wallet.json丢失=身份永久丢失 |
| **无密钥轮换** | 🟡 MEDIUM | 密钥泄露只能重建身份，旧身份的链上记录无法关联 |
| **API Key与钱包共用密码** | 🟡 MEDIUM | 钱包密码泄露=API Key也泄露 |

### 6.3 KDF参数建议

```typescript
// 生产环境建议
const PRODUCTION_KDF = {
  N: 131072,  // 2^17, ~200ms on modern CPU
  r: 8,
  p: 1,
};

// 测试环境
const TEST_KDF = {
  N: 16384,   // 2^14, ~25ms
  r: 8,
  p: 1,
};

// [GAP] 架构review建议用argon2id替代scrypt
// argon2id抗GPU/ASIC更强，但需native依赖
// Day 1: scrypt够用 (纯JS, 零依赖)
// Stage 2: 迁移到argon2id (wallet.json version=2)
```

### 6.4 文件布局安全

```
~/.veil/
  wallet.json    ── 加密密钥，最敏感
  config.json    ── 公钥+配置，中敏感
  provider.json  ── 加密API Key，高敏感

所有文件 mode: 0o600
目录 mode: 0o700

[GAP] 无完整性校验 — 文件被篡改时（如修改kdf_params降低N）无法检测
建议: wallet.json增加HMAC字段，或用签名保护kdf_params
```

## 7. 测试要求

### 7.1 单元测试

| 测试用例 | 覆盖点 |
|----------|--------|
| createWallet成功 | 文件创建+格式正确+权限正确 |
| createWallet密码太短 | 拒绝<8字符 |
| createWallet已存在 | 无--force时报错 |
| loadWallet正确密码 | 解密成功+密钥可用 |
| loadWallet错误密码 | 解密失败+明确错误 |
| loadWallet未初始化 | 提示veil init |
| getPublicKeys成功 | 从config.json读取 |
| encryptApiKey↔decryptApiKey | 加密后解密一致 |
| 不同密码解密失败 | API Key的密码隔离 |
| KDF参数从文件读取 | 自描述KDF确保前向兼容 |

### 7.2 安全测试

| 测试用例 | 覆盖点 |
|----------|--------|
| wallet.json不含明文私钥 | 加密存储验证 |
| 文件权限=0o600 | 防止其他用户读取 |
| 目录权限=0o700 | 防止其他用户列目录 |
| 不同password产生不同salt | 随机性验证 |
| 篡改ciphertext后load失败 | GCM完整性 |
| 篡改tag后load失败 | GCM认证 |
| 篡改iv后load失败 | GCM认证 |

### 7.3 [GAP] 缺失测试

- **密钥对实际可用性**：创建后用公钥加密→私钥解密验证
- **大密码处理**：超长密码(>1KB)的行为
- **并发创建**：两个进程同时init
- **磁盘满时行为**：写入失败后的状态一致性（半写问题）
- **跨平台路径**：Windows路径处理（HOME vs USERPROFILE）

## 8. 模块依赖

```
┌───────────────────┐
│ wallet/index.ts   │
└──────┬────────────┘
       │
       │ imports
       ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
│ node:fs      │    │ node:crypto      │    │ crypto/      │
│ mkdirSync    │    │ scryptSync       │    │ index.ts     │
│ writeFileSync│    │ randomBytes      │    │ generateSign-│
│ readFileSync │    │ createCipheriv   │    │ ingKeyPair() │
│ existsSync   │    │ createDecipheriv │    │ generateEnc- │
└──────────────┘    └──────────────────┘    │ ryptionKP()  │
                                            │ toHex()      │
                                            │ fromHex()    │
                                            └──────────────┘
       │
       │ node:path
       ▼
┌──────────────┐
│ join()       │
│ HOME/.veil/  │
└──────────────┘

被依赖:
  cli.ts        ── createWallet, loadWallet, getPublicKeys, encryptApiKey
  consumer/     ── loadWallet (获取密钥做加密)
  provider/     ── loadWallet + decryptApiKey
  relay/        ── loadWallet (Relay自身身份)
```

### 依赖链安全

```
wallet → crypto/ → tweetnacl (纯JS, 零native依赖)
wallet → node:crypto (Node.js内置, scrypt+AES)

无第三方npm依赖 ✅
密码学由两层提供:
  tweetnacl: Ed25519/X25519 密钥对
  node:crypto: scrypt KDF + AES-256-GCM 加密存储
```

### [GAP] 依赖风险

| 风险 | 说明 | 缓解 |
|------|------|------|
| scrypt→argon2id迁移 | 架构review建议迁移，但argon2id需要native依赖 | version字段预留，渐进迁移 |
| tweetnacl维护状态 | 最近更新较少 | 纯JS+简单代码，安全审计过 |
| 同步文件I/O | writeFileSync/readFileSync阻塞事件循环 | Day 1钱包操作低频，可接受；Stage 2改async |

---

*钱包是用户身份的根。搞砸了=用户丢失身份+资金。每行代码都要带着"这会不会泄露私钥"的心态写。*
