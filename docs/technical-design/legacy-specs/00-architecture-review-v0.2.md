# Veil Protocol — Architecture Review Conclusions v0.2

> 基于v0.1技术架构总览的圆桌review修正
> Review: Linus Torvalds / Anatoly Yakovenko / Bryan Cantrill / antirez / tptacek
> Date: 2026-03-31

## 核心修正：Day 1极简化

原始v0.1设计了12模块+4合约。Review结论：**Day 1 = 1500行TypeScript + 1台VPS。**

## Day 1 技术栈 (FINAL)

```
Runtime:    Node.js 22+ (LTS)
Language:   TypeScript 5.x (strict mode)
HTTP:       Hono (3KB, edge-compatible)
WebSocket:  ws
Crypto:     tweetnacl (纯JS, 25KB, 零native依赖)
DB:         better-sqlite3 (WAL mode)
Build:      tsup (单文件可执行)
Test:       vitest
Package:    npm (npx veil ...)
```

### 为什么不Rust？
- 小团队+AI agents对TypeScript更熟
- 等有性能数据再选择性重写瓶颈模块
- FFI边界成本对小团队太高

### 为什么不QUIC？
- WebSocket Day 1够用
- QUIC的NAT穿透优势在Stage 2(Community Relay)才需要
- 减少Day 1依赖

## Day 1 模块结构

```
veil/
  src/
    consumer/       ~500行  本地OpenAI网关+选Provider+加密
      mod.ts
      gateway.ts    Hono HTTP server, OpenAI兼容
      selector.ts   Provider选择(延迟/模型/容量)
      
    provider/       ~400行  解密+API调用+容量追踪
      mod.ts
      engine.ts     请求处理+API调用
      accounts.ts   多账号池(config文件)
      
    relay/          ~300行  认证转发+见证
      mod.ts
      auth.ts       验签+余额检查
      witness.ts    见证记录
      
    crypto/         ~100行  [RED LINE] tweetnacl封装
      mod.ts
      envelope.ts   信封加密/解密
      keys.ts       双密钥对生成
      
    wallet/         ~80行   keypair+加密存储
      mod.ts
      store.ts      argon2id+AES加密文件
      
    network/        ~150行  WebSocket封装
      mod.ts
      ws.ts         连接管理+重连
      
  config/
    bootstrap.ts    官方Relay公钥(硬编码)
    
  tests/
    consumer.test.ts
    provider.test.ts
    relay.test.ts
    crypto.test.ts
    
  总计: ~1530行
```

## Day 1 安全最小集 (不可妥协)

1. **tweetnacl加密**: crypto_box_seal加密prompt，Relay看不到内容
2. **双密钥对**: Ed25519(签名) + X25519(加密)，独立生成不做转换
3. **钱包加密**: argon2id KDF + AES-256-GCM加密wallet.json
4. **Relay TOFU**: 官方Relay公钥硬编码在bootstrap.ts
5. **API keys本地**: Provider的API keys永不离开本机

## Day 1 数据格式 (未来零迁移)

```typescript
// ~/.veil/registry.json — 用Solana PDA layout
interface ProviderAccount {
  authority: string,        // Solana pubkey
  signing_pubkey: string,   // Ed25519 pubkey
  encryption_pubkey: string,// X25519 pubkey  
  models: string[],         // ["gpt-4o", "claude-sonnet"]
  capacity_remaining: number,
  stake_amount: number,     // Day 1 = 0
  reputation: number,       // Day 1 = 100
  registered_at: number,    // unix timestamp
  status: 'active' | 'suspended'
}
```

## Day 1 用户体验

### Consumer (对外开放)
```
$ npm install -g veil
$ veil init
  > Generated wallet (encrypted)
  > Testnet: 100 free credits
  > Gateway: http://localhost:9960/v1
  > Cursor: { apiBase: "http://localhost:9960/v1" }
```

### Provider (Kousan only)
```
$ veil provide init
  > Subscriptions: [ChatGPT Plus] [Claude Pro]
  > API keys: stored locally
$ veil provide start
  > Online. Models: gpt-4o, claude-sonnet
```

### Relay (Kousan only)
```
$ veil relay start
  > Listening: wss://relay-jp.runveil.io
```

## 演化路径 (事件驱动)

| Stage | 触发事件 | 新增能力 | 代码量变化 |
|-------|---------|---------|-----------|
| 0 能跑 | 自己用了能用 | 6模块骨架 | 1.5K行 |
| 1 能用 | 第2个用户 | 多账号+日志+钱包 | → 3K行 |
| 2 能信 | 第1个Community Relay | QUIC+链上Registry+Escrow | → 8K行 |
| 3 能赚 | 月收入>$1K | Points+Surge+TOKEN | → 15K行 |
| 4 能治 | DAO成立 | Staking+Governance+RBOB | → 25K行 |

## 何时引入Rust？

不预定时间。当以下任一条件满足：
1. 加密模块处理延迟>10ms (tweetnacl性能不足)
2. WebSocket连接数>1000/Relay (需要QUIC)
3. WASM沙箱需求出现 (Provider隔离)

重写范围：只替换瓶颈模块的内部实现，接口不变。

---

*v0.2 基于5人圆桌review。v0.1完整设计保留在00-architecture-overview.md作为终局参考。*
