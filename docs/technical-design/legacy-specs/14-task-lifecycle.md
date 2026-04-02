# 14 — Task Lifecycle & Failover Design

> 复杂任务管理：多轮调用、心跳探针、中断恢复、Provider切换
> Date: 2026-04-01
> Status: Draft
> Depends on: 03-metering-billing, 05-consumer-gateway, 06-provider-engine, 07-relay-routing

## 1. 问题定义

简单请求（1 request → 1 response）现有设计能处理。但实际场景中：

1. **复杂任务**：一个Consumer请求触发Provider内部10-20次API调用（tool calls、multi-turn reasoning）
2. **长时间运行**：任务可能跑几分钟甚至更久
3. **中途断裂**：Provider的订阅额度mid-task耗尽、被限流、网络断开
4. **静默死亡**：Provider挂了但没发任何错误信号

## 2. 任务类型

```typescript
type TaskType = 'simple' | 'multi_turn';

// simple: 1个API调用，stream_start → chunks → stream_end
// multi_turn: N个API调用，Provider内部循环直到任务完成
```

### 2.1 Simple Task（现有）
```
Consumer ──request──> Relay ──> Provider ──> AI API (1次)
Consumer <──stream──< Relay <── Provider <── Response
```

### 2.2 Multi-Turn Task（新增）
```
Consumer ──request──> Relay ──> Provider ──> AI API #1 (思考)
                                         ──> AI API #2 (tool call)
                                         ──> AI API #3 (tool result)
                                         ──> ...
                                         ──> AI API #N (最终回答)
Consumer <──stream──< Relay <── Provider <── 最终Response
```

Consumer只看到1个请求和最终响应。Provider内部的N次调用对Consumer不可见。

## 3. 预授权机制

Consumer在发请求时声明愿意付的上限：

```typescript
interface TaskRequest {
  // 现有字段
  request_id: string;
  model: string;
  messages: Message[];
  
  // 新增：预授权
  budget: {
    max_cost_usdc: number;      // 最多花多少钱（如$0.50）
    max_api_calls?: number;     // 最多几次内部API调用（默认50）
    max_duration_ms?: number;   // 最长执行时间（默认300000 = 5分钟）
  };
}
```

**Provider行为：**
```
执行中累计cost → 接近budget.max_cost_usdc的80%
  → 发progress通知给Consumer（通过Relay）
  
累计cost → 达到budget.max_cost_usdc
  → 停止执行
  → 返回已有结果（partial response）
  → 标记 status: 'budget_exceeded'
  
累计api_calls → 达到budget.max_api_calls
  → 同上，停止并返回partial
```

## 4. 心跳探针（Probe）

### 4.1 触发条件

```
Provider正在处理任务
  → 连续silence_threshold_ms没有任何数据（chunk/progress/heartbeat）
  → Relay发起probe
```

### 4.2 Probe配置

```typescript
interface ProbeConfig {
  silenceThresholdMs: 30_000;     // 30秒无数据触发probe
  probeTimeoutMs: 10_000;         // probe 10秒内必须回
  maxProbeFailures: 2;            // 连续2次失败 = 判定死亡
  probeBillable: false;           // probe费用Provider自付
}
```

### 4.3 Probe消息格式

```typescript
// Relay → Provider
interface ProbeRequest {
  type: 'probe';
  request_id: string;             // 关联到正在执行的任务
  timestamp: number;
}

// Provider → Relay
interface ProbeResponse {
  type: 'probe_ack';
  request_id: string;
  status: 'alive' | 'busy' | 'rate_limited';
  progress?: {
    api_calls_completed: number;
    estimated_remaining: number;  // 预估剩余调用次数
    current_cost_usdc: number;    // 当前累计费用
  };
}
```

### 4.4 Probe流程

```
任务进行中，Relay监控数据流:

Case A: 正常（有数据流入）
  chunks流入 → 重置silence计时器 → 不probe

Case B: 安静但活着
  silence 30s → probe → Provider回ack(status:busy)
  → 重置silence计时器 → 继续等
  → Consumer收到进度通知

Case C: 被限流
  silence 30s → probe → Provider回ack(status:rate_limited)
  → 停止计费
  → 等待Provider报告恢复 / 触发failover

Case D: 死亡
  silence 30s → probe #1 → timeout 10s
  → probe #2 → timeout 10s
  → 判定死亡
  → 停止计费（按已收到的output算）
  → 触发failover
```

### 4.5 Probe时序图

```
Consumer          Relay              Provider          AI API
   │                │                    │                │
   │── request ────>│── request ────────>│── API #1 ─────>│
   │                │                    │<── response ───│
   │                │                    │── API #2 ─────>│
   │                │                    │  (processing...)│
   │                │                    │                │
   │                │  [30s silence]     │                │
   │                │── probe ──────────>│                │
   │                │<── probe_ack ──────│ (busy, 2/10)  │
   │<── progress ──│                    │                │
   │                │                    │<── response ───│
   │                │                    │── API #3 ─────>│
   │                │                    │  ...           │
   │                │                    │                │
   │                │  [30s silence]     │                │
   │                │── probe ──────────>│                │
   │                │    [10s timeout]   │    (dead)      │
   │                │── probe #2 ───────>│                │
   │                │    [10s timeout]   │                │
   │                │                    │                │
   │                │  [判定死亡]         │                │
   │<── error ─────│  (provider_dead)   │                │
   │                │── failover ────────────────────────>│ (new Provider)
```

## 5. 中断计费

### 5.1 正常完成
```
cost = sum(所有内部API调用的input_tokens) × price_input
     + sum(所有内部API调用的output_tokens) × price_output
```

### 5.2 Budget超限停止
```
cost = 实际累计cost（≤ max_cost_usdc）
状态: budget_exceeded
Consumer拿到partial result
```

### 5.3 Provider死亡中断
```
cost = input_tokens(已处理) × price_input
     + output_tokens(已收到的chunk) × price_output
     
注意: 
- probe的费用不算Consumer的
- Provider内部已调用但未返回的API，由Provider自己承担
```

### 5.4 Stream中断
```
stream_start → chunks → 断开（无stream_end）
  → Relay等30s + 2次probe → 判定中断
  → 计费按已收到的chunk累加
  → incomplete witness生成
```

## 6. Failover（Provider切换）

### 6.1 触发条件

```typescript
type FailoverReason = 
  | 'provider_dead'          // probe 2次失败
  | 'provider_rate_limited'  // Provider报告被限流
  | 'budget_exceeded'        // 预算超限但任务未完成
  | 'timeout'                // 超过max_duration_ms
  | 'provider_error';        // Provider返回error
```

### 6.2 Failover流程

```
原Provider判定不可用
  │
  ├── Consumer还有剩余budget吗？
  │     No  → 返回partial result + 原因
  │     Yes ↓
  │
  ├── 有其他在线Provider吗？
  │     No  → 返回partial result + "no provider available"
  │     Yes ↓
  │
  ├── 能带上之前的context吗？
  │     │
  │     ├── Simple task: 重发原始请求到新Provider
  │     │
  │     └── Multi-turn task: 
  │           带上partial result作为context
  │           "继续这个任务，之前做到了..."
  │           剩余budget = 原budget - 已花费
  │
  └── 新Provider处理 → 正常流程
```

### 6.3 Context传递

```typescript
interface FailoverContext {
  original_request: TaskRequest;
  partial_result?: string;          // 之前Provider的输出
  consumed_budget: number;          // 已花费
  remaining_budget: number;         // 剩余预算
  api_calls_completed: number;      // 之前的调用次数
  failover_reason: FailoverReason;
  previous_provider_id: string;
}
```

## 7. Multi-Turn Usage上报

### 7.1 Provider实时上报

Provider在每次内部API调用完成后，发progress消息给Relay：

```typescript
interface TaskProgress {
  type: 'task_progress';
  request_id: string;
  api_call_index: number;       // 第几次调用
  usage: NormalizedUsage;       // 本次调用的usage
  cumulative_cost: number;      // 累计费用
  status: 'processing' | 'completing';
}
```

Relay累加usage，Consumer收到进度通知。

### 7.2 最终Witness

```typescript
interface MultiTurnWitness {
  request_id: string;
  type: 'multi_turn';
  task_status: 'completed' | 'budget_exceeded' | 'interrupted' | 'failed';
  api_calls_count: number;
  usage: {
    total_input: number;
    total_output: number;
    total_cache_read: number;
    total_cache_write: number;
  };
  per_call_breakdown: Array<{
    index: number;
    input: number;
    output: number;
  }>;
  budget_authorized: number;
  actual_cost: number;
  probe_count: number;           // 发了几次probe
  failover_count: number;        // 切换了几次Provider
  duration_ms: number;
  relay_signature: string;
}
```

## 8. Provider可靠性评分

Probe和failover数据反馈到Provider评分：

```typescript
interface ProviderReliability {
  pubkey: string;
  total_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  avg_probe_response_ms: number;   // probe平均响应时间
  probe_failure_rate: number;      // probe失败率
  failover_rate: number;           // 被切走的比率
  avg_task_duration_ms: number;
  
  // 综合评分 0-100
  reliability_score: number;
}

// 评分影响:
// - Provider选择时优先选高分的
// - 低分Provider的任务被限制（不接multi-turn）
// - 连续3次failover → Provider暂停30分钟
```

## 9. 状态管理

### 9.1 Relay内存状态

```typescript
// 每个活跃任务一个entry
interface ActiveTask {
  request_id: string;
  consumer_ws: WebSocket;
  provider_ws: WebSocket;
  type: TaskType;
  budget: Budget;
  start_time: number;
  last_activity: number;          // 最后收到数据的时间
  probe_count: number;
  probe_failures: number;
  cumulative_usage: NormalizedUsage;
  cumulative_cost: number;
  api_calls_count: number;
  status: 'active' | 'probing' | 'failing_over' | 'completed';
}

// Relay维护一个Map<request_id, ActiveTask>
```

### 9.2 持久化（SQLite）

```sql
-- 扩展witness表
ALTER TABLE witnesses ADD COLUMN task_type TEXT DEFAULT 'simple';
ALTER TABLE witnesses ADD COLUMN api_calls_count INTEGER DEFAULT 1;
ALTER TABLE witnesses ADD COLUMN probe_count INTEGER DEFAULT 0;
ALTER TABLE witnesses ADD COLUMN failover_count INTEGER DEFAULT 0;
ALTER TABLE witnesses ADD COLUMN task_status TEXT DEFAULT 'completed';
ALTER TABLE witnesses ADD COLUMN budget_authorized REAL;
ALTER TABLE witnesses ADD COLUMN duration_ms INTEGER;

-- Provider可靠性表
CREATE TABLE provider_reliability (
  provider_pubkey TEXT PRIMARY KEY,
  total_tasks INTEGER DEFAULT 0,
  completed_tasks INTEGER DEFAULT 0,
  failed_tasks INTEGER DEFAULT 0,
  total_probe_response_ms INTEGER DEFAULT 0,
  probe_count INTEGER DEFAULT 0,
  probe_failures INTEGER DEFAULT 0,
  failover_count INTEGER DEFAULT 0,
  reliability_score REAL DEFAULT 100.0,
  updated_at TEXT
);
```

## 10. 错误处理

| 场景 | 处理 |
|------|------|
| Provider回probe_ack(rate_limited) | 停止计费，等恢复或failover |
| Provider回probe_ack(busy)但cost已超budget | 发budget_warning，等当前API调用完成后停止 |
| Failover时无可用Provider | 返回partial result + error |
| 新Provider也挂了 | 最多failover 3次，之后返回error |
| Consumer断开 | Relay通知Provider取消任务 |
| budget = 0（未设置） | 默认$1.00 上限 |
| multi-turn但Provider不支持progress上报 | 降级为simple模式，只有最终usage |

## 11. 安全约束

- Provider不能伪造api_calls_count（Relay可通过progress消息计数验证）
- budget_authorized由Consumer签名，Provider不能篡改
- probe消息有时间戳+签名，防重放
- failover时Consumer的原始请求内容不暴露给新Provider（仍然走信封加密）
- partial result通过加密通道传给新Provider（新Provider也看不到Consumer身份）

## 12. 实现优先级

| 阶段 | 实现 |
|------|------|
| Day 1 | simple task only + 基础超时（120s） |
| Stage 1 | + probe心跳 + 中断计费 |
| Stage 2 | + multi-turn support + budget预授权 |
| Stage 3 | + failover + Provider可靠性评分 |

## 13. 与现有模块的关系

```
14-task-lifecycle
  ├── 03-metering (中断计费、multi-turn usage累加)
  ├── 05-consumer (预授权、progress通知)
  ├── 06-provider (probe响应、progress上报、budget检查)
  ├── 07-relay (probe发送、failover路由、ActiveTask管理)
  ├── 08-network (probe消息、超时检测)
  └── 11-wire-protocol (新增消息类型: probe/probe_ack/task_progress/budget_warning)
```

## 14. 新增Wire Protocol消息

```typescript
// 追加到MessageType
type MessageType = 
  | ... // 现有14种
  | 'probe'           // Relay → Provider: 心跳探针
  | 'probe_ack'       // Provider → Relay: 探针响应
  | 'task_progress'   // Provider → Relay → Consumer: 进度
  | 'budget_warning'  // Relay → Consumer: 预算即将耗尽
  | 'task_cancel';    // Relay → Provider: Consumer断开/取消
```

---

*任务生命周期是Veil从"demo"到"production"的关键。简单请求谁都能处理，复杂任务的可靠性才是护城河。*
