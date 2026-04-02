# 03 — Metering & Billing Design

> Token计量、成本计算、结算流程
> Date: 2026-04-01
> Status: Draft
> Depends on: 00-architecture-review-v0.2, idle-compute-protocol-v2.2 (Section 5.3-5.4)

## 1. 问题定义

Consumer发了一个请求，Provider处理完返回了响应。需要回答：

1. 这次调用用了多少token？（计量）
2. Consumer应该付多少钱？（定价）
3. 钱怎么分？（结算）
4. 谁来验证这些数字？（防欺诈）

## 2. Token计量

### 2.1 计量点

```
Consumer ──> Relay ──> Provider ──> AI API
                                      │
                                      ├── API响应包含 usage 字段
                                      │   input_tokens: N
                                      │   output_tokens: M
                                      │   cache_creation_input_tokens: C1
                                      │   cache_read_input_tokens: C2
                                      │
                               Provider提取 usage
                                      │
                               Relay见证 usage
                                      │
                               链上结算 usage
```

**计量由Provider完成，Relay见证，链上可挑战。**

### 2.2 Provider端计量

Provider从AI API响应中提取usage。不同API的字段名不同，需要归一化：

```typescript
interface NormalizedUsage {
  input: number;      // prompt tokens (含system prompt)
  output: number;     // completion tokens
  cacheRead: number;  // 命中缓存的input tokens
  cacheWrite: number; // 写入缓存的input tokens
  total: number;      // input + output (不含cache)
}
```

**归一化映射表：**

| Provider | input | output | cacheRead | cacheWrite |
|----------|-------|--------|-----------|------------|
| Anthropic | input_tokens | output_tokens | cache_read_input_tokens | cache_creation_input_tokens |
| OpenAI | prompt_tokens | completion_tokens | prompt_tokens_details.cached_tokens | — |
| Google | promptTokenCount | candidatesTokenCount | cachedContentTokenCount | — |

参考实现：OpenClaw `normalizeUsage()` — 已处理所有主流API的字段差异。

### 2.3 流式(Streaming)计量

SSE流式响应中，token count通常在最后一个chunk或stream结束事件中：

- Anthropic: `message_delta` event 包含 `usage.output_tokens`
- OpenAI: 最后一个chunk的 `usage` 字段（需开启 `stream_options.include_usage`）

**规则：Provider必须等到stream结束后才提交usage给Relay。**

### 2.4 计量不可用时

某些情况API不返回usage（私有部署、旧版API等）：

- 使用tokenizer估算：tiktoken (OpenAI), claude-tokenizer (Anthropic)
- 估算标记为 `estimated: true`
- 估算结果允许±10%误差，超出可被挑战

## 3. 定价

### 3.1 Day 1 定价 (简单版)

```
consumer_cost = (input_tokens × model_input_price 
              + output_tokens × model_output_price) / 1,000,000
```

模型价格表（Day 1硬编码，后续链上DAO治理）：

| Model | Input ($/1M) | Output ($/1M) |
|-------|-------------|---------------|
| claude-sonnet-4 | $3.00 | $15.00 |
| claude-opus-4 | $15.00 | $75.00 |
| gpt-4o | $2.50 | $10.00 |
| gpt-4.1 | $2.00 | $8.00 |

**Veil定价 = 官方API价格 × discount_ratio**

Day 1: discount_ratio = 0.50（半价，吸引Consumer）
长期: Surge引擎动态调（0.30 - 0.80，见v2.2 §5.4.5）

### 3.2 Cache Token定价

Provider用缓存降低了自己的API成本，这个优势应该部分传递给Consumer：

```
cache_read_price = model_input_price × 0.10  (缓存命中按input价格的10%)
cache_write_price = model_input_price × 1.25 (首次写缓存比普通input贵25%)
```

激励Provider维护缓存（降低成本），同时Consumer也受益。

### 3.3 Subscription模式 vs API模式

Provider有两种成本结构：

- **Subscription Provider**: 月费固定（$20/月），边际成本≈0，直到达到Usage Limit
- **API Provider**: 按token付费，成本线性

Surge引擎不区分——定价统一按token，Provider的成本结构是它自己的问题。
Subscription Provider利润率更高（边际成本低），但有封号风险。
API Provider利润率低但稳定。市场自然平衡。

## 4. 结算流程

### 4.1 Day 1 结算 (链下)

```
1. Consumer发请求 → Relay转发 → Provider处理
2. Provider返回响应 + usage数据
3. Relay生成见证(witness):
   {
     request_id,
     consumer_pubkey_hash,  // 不存明文
     provider_pubkey,
     model,
     usage: { input, output, cacheRead, cacheWrite },
     cost_usdc,
     timestamp,
     relay_signature
   }
4. 见证写入Relay本地DB (better-sqlite3)
5. 累计到$1时 → 批量结算到Provider
```

**Day 1没有链上Escrow。USDC直接转账。信任Relay（Kousan运营）。**

### 4.2 Stage 2+ 结算 (链上)

见v2.2 §5.4.2 Escrow Program。补充计量相关细节：

```
SettlementRecord {
  ...
  metering: {
    input_tokens: u32,
    output_tokens: u32,
    cache_read_tokens: u32,
    cache_write_tokens: u32,
    estimated: bool,        // 是否为估算值
    model_price_snapshot: {  // 结算时的价格快照
      input_per_1m: u64,
      output_per_1m: u64,
    }
  }
}
```

### 4.3 防欺诈

**Provider虚报usage（多报）：**
- Consumer可以用本地tokenizer重算，差>10%即可challenge
- 罚没Provider质押50%

**Provider少报usage（讨好Consumer）：**
- Relay见证的usage与Provider报告的不符→Relay拒绝签witness
- 没有witness就没有结算

**Relay篡改usage：**
- Provider签名了原始usage，Consumer可验证
- 链上challenge：提交Provider签名的原始usage vs Relay提交的usage

## 5. 数据流总结

```
                    Provider
                       │
                 ┌─────┴─────┐
                 │ AI API    │
                 │ Response  │
                 │ + usage   │
                 └─────┬─────┘
                       │
              Provider签名usage
                       │
              ┌────────┴────────┐
              │                 │
         发给Consumer      发给Relay
         (加密响应+usage)  (usage+签名)
              │                 │
              │           Relay验证签名
              │           生成witness
              │           写入本地DB
              │                 │
              │           累计>=$1
              │                 │
              │           批量结算
              │           (Day1: 直接转账)
              │           (Stage2: 链上Escrow)
              │                 │
              └────────┬────────┘
                       │
                  Consumer本地
                  记录usage+cost
                  (余额扣减)
```

## 6. 实现优先级

| 阶段 | 实现 | 信任模型 |
|------|------|---------|
| Day 1 | Provider提取usage → Relay记录 → 直接USDC转账 | 信任Relay(Kousan) |
| Stage 1 | + Consumer本地验证 + 价格表链上化 | 信任Relay + Consumer可审计 |
| Stage 2 | + 链上Escrow + fraud proof | Trustless |
| Stage 3 | + Surge动态定价 + DAO调参 | Fully decentralized |

## 7. 与现有代码的对应

```
src/
  metering/           ← 新模块
    normalize.ts      ← usage归一化 (参考OpenClaw normalizeUsage)
    pricing.ts        ← 定价计算
    witness.ts        ← Relay见证生成+验证
    types.ts          ← NormalizedUsage, PriceConfig, Witness类型
  relay/
    index.ts          ← 调用metering模块生成witness
  provider/
    index.ts          ← 调用metering模块提取usage
  consumer/
    index.ts          ← 调用metering模块计算本地cost
```

## 8. Open Questions

1. **多轮对话的缓存归属**：Consumer A的对话产生了缓存，Consumer B命中了。缓存收益归谁？→ 建议归Provider（是它维护的缓存）
2. **Tokenizer精度**：不同tokenizer对同一文本估算差异可达5-8%。10%的挑战阈值是否合理？
3. **流式中断的计费**：stream到一半断了，已发送的output token要不要收费？→ 建议收（已消耗了API配额）
4. **系统prompt的计费**：Provider注入的system prompt（如安全提示）算谁的input？→ 建议不算Consumer的，Provider自付

---

*This module is the economic foundation of Veil. Get metering wrong = the whole marketplace breaks.*
