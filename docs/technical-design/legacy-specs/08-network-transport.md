# 08 — Network Transport Design

> WebSocket连接管理、心跳保活、重连策略、服务端监听
> Date: 2026-04-01
> Status: Draft
> Depends on: 00-architecture-review-v0.2, types.ts (WsMessage)

## 1. 职责边界

Network Transport模块是Veil协议的传输基础层，职责明确：

**管（DO）：**
- WebSocket客户端连接建立与生命周期管理
- 自动重连（指数退避+上限）
- 心跳保活（ping/pong机制 + pong超时断连）
- WebSocket服务端创建与连接分发
- JSON消息序列化/反序列化（WsMessage）
- 连接状态抽象（屏蔽ws库底层readyState数字）

**不管（DON'T）：**
- 消息路由（Relay的事）
- 消息加密/解密（Crypto模块的事）
- 认证/鉴权（各角色模块自行处理）
- 业务逻辑（Consumer/Provider/Relay模块的事）
- 传输层切换（Day 1只有WebSocket，QUIC在Stage 2）

**边界原则：** 本模块只关心"字节怎么到达"，不关心"字节是什么意思"。

## 2. 接口定义

### 2.1 核心类型

```typescript
// 连接抽象 — 屏蔽ws库底层细节
export interface Connection {
  ws: WebSocket;                                      // 底层ws实例（重连时会被替换）
  send(msg: WsMessage): void;                         // 序列化+发送，非OPEN状态静默丢弃
  close(): void;                                       // 主动关闭，不触发重连
  readonly readyState: 'connecting' | 'open' | 'closing' | 'closed';
}

// 客户端连接选项
export interface ConnectionOptions {
  url: string;                                         // wss://relay-jp.runveil.io
  onMessage: (msg: WsMessage) => void;                 // 收到消息回调
  onClose: (code: number, reason: string) => void;     // 连接关闭回调
  onError: (err: Error) => void;                       // 错误回调
  reconnect?: boolean;                                 // 是否自动重连，默认true
  pingIntervalMs?: number;                             // 心跳间隔，默认30s
}

// [GAP] 缺少 onReconnect 回调 — 上层无法感知重连事件
// [GAP] 缺少 maxReconnectAttempts — 当前无限重试，无法设上限
// [GAP] 缺少 headers 选项 — 无法传递认证token/版本号
```

### 2.2 函数签名

```typescript
// 客户端连接（Promise在首次连接成功时resolve，失败时reject）
export function connect(options: ConnectionOptions): Promise<Connection>;

// 服务端创建
export function createServer(options: {
  port: number;
  onConnection: (conn: Connection, req: IncomingMessage) => void;
}): {
  close(): void;
  port: number;
  address(): { port: number };
};
```

### 2.3 [GAP] 缺失接口

```typescript
// [GAP] 连接指标收集 — 运维必需
export interface ConnectionMetrics {
  connectedAt: number;
  reconnectCount: number;
  messagesSent: number;
  messagesReceived: number;
  bytesSent: number;
  bytesReceived: number;
  lastPingRtt: number;          // ping-pong往返延迟
  avgPingRtt: number;
}

// [GAP] 服务端连接管理 — 当前无法遍历/踢出连接
export interface ServerHandle {
  close(): void;
  port: number;
  connections(): Iterable<Connection>;
  broadcast(msg: WsMessage): void;
  connectionCount(): number;
}

// [GAP] 背压控制 — 高吞吐场景必需
export interface BackpressureOptions {
  highWaterMark: number;        // bufferedAmount阈值
  onDrain: () => void;          // 缓冲区排空回调
}
```

## 3. 数据流

### 3.1 客户端连接+重连流程

```
connect(options)
    │
    ▼
┌──────────┐    成功     ┌──────────┐
│ new WS() │───────────▶│  OPEN    │◀──────────────────────┐
│ CONNECTING│            │          │                       │
└──────────┘            └────┬─────┘                       │
    │                        │                             │
    │ 失败                    │ 收到message                  │
    ▼                        ▼                             │
  reject()             JSON.parse(data)                    │
  (仅首次)                   │                             │
                             ▼                             │
                      onMessage(msg)                       │
                                                           │
                        连接断开                             │
                            │                              │
                            ▼                              │
                    ┌───────────────┐     intentionally     │
                    │   onClose()   │───── closed? ──▶ 结束  │
                    └───────┬───────┘      Yes              │
                            │ No                           │
                            ▼                              │
                    reconnect=true?                        │
                            │ Yes                          │
                            ▼                              │
                  ┌─────────────────┐                      │
                  │ delay = min(    │                      │
                  │  1s × 2^attempt,│                      │
                  │  60s)           │                      │
                  └────────┬────────┘                      │
                           │                               │
                           ▼                               │
                    setTimeout(delay)                      │
                           │                               │
                           ▼                               │
                    doConnect() ───────────────────────────┘
```

### 3.2 心跳保活

```
┌──────────────────────────────────────────┐
│              OPEN状态                     │
│                                          │
│   每30s:  ws.ping() ──▶ 对端             │
│                                          │
│   10s内收到pong ──▶ 清除超时timer         │
│   10s内没收到   ──▶ ws.terminate()       │
│                      触发close+重连       │
└──────────────────────────────────────────┘
```

### 3.3 消息收发

```
应用层                Network Transport              对端
  │                        │                          │
  │  conn.send(WsMessage)  │                          │
  │──────────────────────▶│                          │
  │                  JSON.stringify()                  │
  │                  ws.send(string)                   │
  │                        │─────────────────────────▶│
  │                        │                          │
  │                        │◀─────────────────────────│
  │                  JSON.parse(data)                  │
  │  onMessage(WsMessage)  │                          │
  │◀──────────────────────│                          │
```

## 4. 状态管理

### 4.1 连接状态机

```
              connect()
                 │
                 ▼
          ┌─────────────┐
          │ CONNECTING  │
          └──────┬──────┘
                 │
        ┌────────┴────────┐
        │ open            │ error
        ▼                 ▼
  ┌──────────┐     ┌──────────┐
  │   OPEN   │     │  CLOSED  │──▶ 重连(如启用)
  └────┬─────┘     └──────────┘
       │
       │ close/error
       ▼
  ┌──────────┐
  │ CLOSING  │
  └────┬─────┘
       │
       ▼
  ┌──────────┐
  │  CLOSED  │──▶ 重连(如启用且非主动关闭)
  └──────────┘
```

### 4.2 关键状态变量

| 变量 | 类型 | 作用 |
|------|------|------|
| `reconnectAttempt` | number | 当前重连次数，连接成功后重置为0 |
| `intentionallyClosed` | boolean | conn.close()时设true，阻止重连 |
| `isFirstConnect` | boolean | 区分首次连接失败(reject)和重连失败(静默) |
| `pingInterval` | timer | 心跳定时器，断连时清除 |
| `pongTimeout` | timer | pong超时定时器，收到pong时清除 |

### 4.3 [GAP] 状态缺失

- **无连接健康评分**：当前只有二值状态(connected/disconnected)，缺乏延迟/丢包等细粒度指标
- **重连状态不可观测**：上层无法知道"正在第N次重连"
- **conn对象ws字段直接暴露**：重连时替换ws实例，如果上层持有旧ws引用会出问题

## 5. 错误处理

### 5.1 当前实现

| 错误场景 | 处理方式 | 评价 |
|----------|---------|------|
| 首次连接失败 | Promise reject | ✅ 合理 |
| 重连失败 | 静默重试，onClose回调通知 | ✅ 合理 |
| JSON解析失败 | console.log error，丢弃消息 | ⚠️ 应通知上层 |
| pong超时 | ws.terminate()强制断连 | ✅ 合理 |
| 非OPEN状态send | 静默丢弃 | ⚠️ 应有可选回调或返回值 |

### 5.2 [GAP] 缺失的错误处理

```typescript
// [GAP] 消息发送失败反馈
// 当前: send()在非OPEN状态静默丢弃，调用方无感知
// 建议: send()返回boolean，或提供onSendFailed回调

// [GAP] 消息大小超限
// 当前: maxPayload由ws库层面处理，会直接断连
// 建议: send()前检查JSON.stringify().length，超限时抛明确错误

// [GAP] 无效消息格式
// 当前: JSON.parse失败只打log，上层完全无感知
// 建议: 增加 onInvalidMessage 回调

// [GAP] 重连耗尽
// 当前: 无限重连，无上限
// 建议: maxReconnectAttempts，耗尽后onReconnectExhausted回调
```

## 6. 安全约束

### 6.1 当前实现

| 约束 | 实现 | 状态 |
|------|------|------|
| WSS(TLS)传输加密 | url参数支持wss:// | ✅ 但未强制 |
| 消息大小限制 | MAX_MESSAGE_SIZE = 10MB | ✅ |
| 心跳超时断连 | PONG_TIMEOUT_MS = 10s | ✅ |

### 6.2 [GAP] 缺失的安全措施

| 缺失 | 风险 | 优先级 |
|------|------|--------|
| **未强制wss://**  | 明文传输prompt（虽有应用层加密，但metadata泄露） | P1 |
| **无TLS证书验证选项** | MITM攻击 | P1 |
| **无消息频率限制** | 单连接flood攻击拖垮Relay | P1 |
| **无连接数限制（Server端）** | 资源耗尽 | P1 |
| **无来源IP限制** | DDoS | P2 |
| **无协议版本协商** | 版本不兼容时静默失败 | P2 |
| **无认证握手** | 任何人可连接Relay | P1（Relay模块负责，但transport层应支持） |

### 6.3 建议增加

```typescript
// 连接选项增强
interface SecureConnectionOptions extends ConnectionOptions {
  rejectUnauthorized?: boolean;   // TLS证书验证，默认true
  ca?: Buffer;                     // 自签名CA（开发用）
  protocols?: string[];            // WebSocket子协议（版本协商）
}

// 服务端选项增强
interface SecureServerOptions {
  port: number;
  maxConnections: number;           // 最大连接数
  perIpLimit: number;               // 每IP最大连接数
  messageRateLimit: number;         // 每秒最大消息数/连接
  onConnection: (conn: Connection, req: IncomingMessage) => void;
}
```

## 7. 测试要求

### 7.1 单元测试

| 测试用例 | 覆盖点 |
|----------|--------|
| 正常连接+发消息+收消息 | connect() happy path |
| 连接失败reject | 首次连接错误处理 |
| 自动重连 | 断连后指数退避重连 |
| 重连退避时间 | 1s→2s→4s→...→60s(上限) |
| conn.close()不重连 | intentionallyClosed标志 |
| ping/pong正常 | 心跳保活 |
| pong超时断连 | 10s无pong→terminate |
| JSON解析失败 | 非法消息处理 |
| 非OPEN状态send | 静默丢弃不抛异常 |
| Server接受连接 | createServer基本功能 |
| 消息大小限制 | >10MB消息处理 |

### 7.2 集成测试

| 测试用例 | 覆盖点 |
|----------|--------|
| Client↔Server回声 | 端到端消息传递 |
| Server重启后Client自动重连 | 重连+消息恢复 |
| 多Client并发连接 | 连接隔离 |
| 长时间保活(>5min) | 心跳稳定性 |

### 7.3 [GAP] 缺失测试

- **网络抖动模拟**（随机延迟/丢包）
- **内存泄漏测试**（长期运行+大量重连是否泄漏timer/listener）
- **背压测试**（高速发送时bufferedAmount增长）
- **并发消息顺序保证**

## 8. 模块依赖

```
┌───────────────────┐
│ network/index.ts  │
└──────┬────────────┘
       │
       │ imports
       ▼
┌──────────────┐    ┌────────────────────┐
│ ws (npm)     │    │ config/bootstrap.ts│
│ WebSocket    │    │ PING_INTERVAL_MS   │
│ WebSocketSvr │    │ PONG_TIMEOUT_MS    │
└──────────────┘    │ WS_RECONNECT_*     │
                    │ MAX_MESSAGE_SIZE   │
                    └────────────────────┘
       │
       │ types
       ▼
┌──────────────┐
│ types.ts     │
│ WsMessage    │
│ MessageType  │
└──────────────┘

被依赖:
  consumer/  ── connect() 连接Relay
  provider/  ── connect() 连接Relay
  relay/     ── createServer() 监听
```

### 依赖风险

| 依赖 | 风险 | 缓解 |
|------|------|------|
| `ws` npm包 | 供应链攻击 | lockfile + 审计 |
| `node:http` IncomingMessage | Node版本变更 | Node 22 LTS，低风险 |
| bootstrap.ts常量 | 参数需要运行时可调 | [GAP] 应支持env/config覆盖 |

---

*Transport层是整个协议的管道。管道本身要极简可靠，复杂性留给上层。*
