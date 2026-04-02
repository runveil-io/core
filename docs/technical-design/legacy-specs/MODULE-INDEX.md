# Veil Protocol — 模块详设索引

> 每个模块一份详设，从v0.2架构向下展开到可直接写代码的颗粒度
> 
> 状态: ✅ 已完成 | 🔨 进行中 | ❌ 缺失

## 核心模块 (src/)

| # | 模块 | 文件 | 详设文档 | 状态 |
|---|------|------|---------|------|
| 03 | metering/ | normalize.ts, pricing.ts, witness.ts, types.ts | 03-metering-billing.md | ✅ |
| 04 | crypto/ | index.ts (envelope.ts, keys.ts) | 04-crypto-envelope.md | ✅ |
| 05 | consumer/ | index.ts, anthropic-stream.ts, selector.ts | 05-consumer-gateway.md | ✅ |
| 06 | provider/ | index.ts, engine.ts, accounts.ts | 06-provider-engine.md | ✅ |
| 07 | relay/ | index.ts, auth.ts, witness.ts | 07-relay-routing.md | ✅ |
| 08 | network/ | index.ts (ws.ts) | 08-network-transport.md | ✅ |
| 09 | wallet/ | index.ts (store.ts) | 09-wallet-identity.md | ✅ |
| 10 | cli/ | cli.ts | 10-cli-ux.md | ✅ |

## 横切关注点

| # | 主题 | 详设文档 | 状态 |
|---|------|---------|------|
| 02 | 安全威胁模型 | 02-security-threat-model.md | ✅ (需扩充) |
| 11 | wire protocol | 11-wire-protocol.md | ✅ |
| 12 | 反检测与容灾 | 12-anti-detection.md | ✅ |
| 13 | RBOB积分系统 | 13-rbob-scoring.md | ✅ |

## 已有的上层文档

| 文档 | 定位 |
|------|------|
| 00-architecture-overview.md | 终局架构（12模块版，参考用） |
| 00-architecture-review-v0.2.md | Day 1架构（6模块极简版，**当前基准**） |
| 01-day1-implementation-spec.md | Day 1实现细节 |
| idle-compute-protocol-v2.2-complete-outline.md | 协议级大纲（最全） |
| rbob-protocol-v1.md | RBOB规则定义 |

## 每份详设应包含

1. **职责边界** — 这个模块做什么，不做什么
2. **接口定义** — TypeScript类型/函数签名
3. **数据流** — 输入什么，处理什么，输出什么
4. **状态管理** — 持久化什么，内存里存什么
5. **错误处理** — 可能出什么错，怎么处理
6. **安全约束** — 红线在哪
7. **测试要求** — 关键场景的测试用例描述
8. **与其他模块的依赖** — 调用谁，被谁调用
