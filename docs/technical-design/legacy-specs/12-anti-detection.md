# 12 — 反检测与容灾 详细设计

> 模块: miner/anti-detection
> 版本: v0.1.0
> 状态: Draft
> 依赖: idle-compute-protocol-v2.2 §8, 红队审计 §20.1

---

## 1. 职责边界

### 范围内
- Provider 使用 AI 订阅服务时避免被厂商封号的技术措施
- 5层防封架构（节奏调度、多账号池、流量伪装、封号检测、自动恢复）
- 月成本经济模型（含封号率）

### 范围外
- 上游 API 调用的具体实现 — 见 provider/index.ts
- 订阅账号的获取/付费方式 — 用户自行管理
- 法律合规分析 — 见内部文档（不公开）
- Provider 选择/负载均衡 — 见 relay 模块

### 设计原则
1. **不保证不被检测** — 只提高检测成本和降低封号概率
2. **砍掉会话复用**（红队审计 §20.1.4）— 数据泄露风险不可接受
3. **对外不提"反检测"** — 公开文档用 "Multi-account redundancy"
4. **接受封号作为成本** — 经济模型已包含封号率

---

## 2. 详细规范：5层防封架构

### 架构总览

```
Layer 5: 封号检测与自动恢复    ← 最后防线
Layer 4: 多账号切换状态机       ← 容灾核心
Layer 3: 流量特征伪装           ← 降低机器特征
Layer 2: 自然节奏调度           ← 模拟人类模式
Layer 1: 独立对话（无复用）      ← 隔离基线
```

### Layer 1: 独立对话（隔离基线）

**红队修正:** 砍掉会话复用，每个请求开新对话。

```typescript
interface ConversationPolicy {
  reuse: false;                    // 永不复用会话
  system_prompt_reset: true;       // 每次请求重置system prompt
  max_context_length: 0;           // 不累积上下文
  cleanup_after_response: true;    // 响应后立即清理
}
```

**理由:** 会话复用意味着 Provider B 的请求可能看到 Provider A 请求的上下文残留。哪怕只是 system prompt 级别的泄露都不可接受。

**厂商视角:** 每个对话都是独立的短对话。这比"一个超长对话"更像正常 API 使用模式。

### Layer 2: 自然节奏调度算法

模拟人类使用 AI 的时间模式，避免 7×24 匀速请求。

```typescript
interface RhythmScheduler {
  timezone: string;                // Provider所在时区
  active_hours: [number, number];  // 活跃时段，如 [8, 23]（8AM-11PM）
  peak_hours: [number, number];    // 高峰时段，如 [10, 12], [14, 18]
  
  // 请求间隔参数
  min_interval_ms: 3000;           // 最小间隔3秒
  max_interval_ms: 15000;          // 最大间隔15秒
  burst_probability: 0.15;         // 15%概率连续快速请求（模拟灵感爆发）
  burst_count: [2, 5];             // burst时连续2-5个请求，间隔500-1500ms
  
  // 并发控制
  max_concurrent: 3;               // 最大同时3个请求（模拟多tab）
  typical_concurrent: 1;           // 通常1个
}
```

**调度算法:**

```typescript
function nextRequestDelay(scheduler: RhythmScheduler, hour: number): number {
  // 非活跃时段：大幅降低频率
  if (hour < scheduler.active_hours[0] || hour > scheduler.active_hours[1]) {
    return randomBetween(60_000, 300_000); // 1-5分钟间隔
  }
  
  // 判断是否进入burst模式
  if (Math.random() < scheduler.burst_probability) {
    return randomBetween(500, 1500); // burst间隔
  }
  
  // 正常模式：高峰期间隔短，低谷期间隔长
  const isPeak = isInPeakHours(hour, scheduler.peak_hours);
  const base = isPeak
    ? randomBetween(scheduler.min_interval_ms, 8000)
    : randomBetween(5000, scheduler.max_interval_ms);
  
  // 添加泊松抖动（更自然）
  return Math.max(1000, poissonJitter(base, 0.3));
}

function poissonJitter(base: number, factor: number): number {
  // 泊松分布抖动，避免均匀分布的人工痕迹
  const u = Math.random();
  return base * (1 + factor * Math.log(1 / u) * (Math.random() > 0.5 ? 1 : -1));
}
```

**日活跃量曲线（示例，UTC+9）:**

```
请求量
  ▲
  │         ┌──┐     ┌────────┐
  │        ╱    ╲   ╱          ╲
  │       ╱      ╲ ╱            ╲
  │      ╱        V              ╲
  │     ╱    午休                  ╲
  │────╱                            ╲────
  └──────────────────────────────────────► 时间
  0  4  8  10 12 14    18  20  23  24
       ↑活跃开始    ↑高峰        ↑活跃结束
```

### Layer 3: 流量特征伪装

```typescript
interface TrafficDisguise {
  // User-Agent 模拟
  user_agent_pool: string[];     // 多个真实浏览器/CLI UA轮换
  
  // 请求头仿真
  headers: {
    // OAuth token模式下模拟Claude Code CLI
    'user-agent': 'claude-cli/2.1.75';
    'x-app': 'cli';
    'anthropic-beta': 'claude-code-20250219,...';
    'anthropic-dangerous-direct-browser-access': 'true';
  };
  
  // [GAP] 请求特征
  // - prompt长度分布应模拟真实用户（不全是超长prompt）
  // - 模型选择应有偏好（不是均匀分布）
  // - 语言应混合（不全是英文API请求）
}
```

**当前代码已实现的伪装（provider/index.ts）:**
- OAuth token检测 (`sk-ant-oat`)
- Claude Code请求头仿真
- system prompt注入（模拟Claude Code环境）

[GAP: 更多流量特征伪装尚未实现]

### Layer 4: 多账号切换状态机

核心容灾机制。协议身份（钱包公钥）与模型账号（邮箱+订阅）解耦。

```typescript
interface AccountPool {
  accounts: AccountEntry[];
  active_index: number;
  rotation_policy: RotationPolicy;
}

interface AccountEntry {
  id: string;                        // 内部标识
  provider: 'anthropic';             // [GAP: 未来支持多厂商]
  credential: string;                // API key 或 OAuth token
  credential_type: 'api_key' | 'oauth_token';
  status: AccountStatus;
  stats: AccountStats;
}

type AccountStatus =
  | 'active'           // 正常使用中
  | 'cooling'          // 主动冷却（降低风险）
  | 'rate_limited'     // 触发速率限制，等待重置
  | 'suspended'        // 被封，需要人工处理
  | 'retired';         // 已弃用

interface AccountStats {
  total_requests: number;
  requests_today: number;
  last_used_at: number;
  last_rate_limit_at: number | null;
  consecutive_errors: number;
  ban_count: number;
  created_at: number;
}

interface RotationPolicy {
  max_requests_per_day: number;       // 单账号日上限（如2000）
  cool_down_after_rate_limit_ms: number; // 触发限速后冷却时间
  max_consecutive_errors: number;     // 连续错误N次→切换
  rotation_interval_hours: number;    // 定期轮换间隔（如8小时）
}
```

**状态机:**

```
                    ┌─────────┐
       添加账号 ──→ │ active  │
                    └────┬────┘
                         │
            ┌────────────┼────────────┐
            │            │            │
    日上限/定期      连续错误≥N    HTTP 429
            │            │            │
            ▼            ▼            ▼
      ┌──────────┐ ┌──────────┐ ┌────────────┐
      │ cooling  │ │ cooling  │ │rate_limited│
      │ (8h轮换) │ │ (检查中)  │ │(等待重置)   │
      └────┬─────┘ └────┬─────┘ └─────┬──────┘
           │            │              │
      冷却期满      错误恢复       窗口重置
           │            │              │
           └────────────┼──────────────┘
                        │
                        ▼
                  ┌──────────┐
                  │  active  │
                  └──────────┘
                  
      HTTP 401/403 ──→ ┌───────────┐
                       │ suspended │ ──→ 通知用户补充
                       └───────────┘
                       
      手动退役 ──→ ┌──────────┐
                  │ retired  │
                  └──────────┘
```

**切换算法:**

```typescript
function selectAccount(pool: AccountPool): AccountEntry | null {
  const available = pool.accounts.filter(a => a.status === 'active');
  
  if (available.length === 0) {
    // 尝试从cooling中找可用的
    const cooling = pool.accounts.filter(a => 
      a.status === 'cooling' && 
      Date.now() - a.stats.last_used_at > pool.rotation_policy.cool_down_after_rate_limit_ms
    );
    if (cooling.length > 0) {
      cooling[0].status = 'active';
      return cooling[0];
    }
    return null; // 所有账号不可用
  }
  
  // 选择今日使用最少的（均匀分摊）
  available.sort((a, b) => a.stats.requests_today - b.stats.requests_today);
  return available[0];
}
```

### Layer 5: 封号检测与自动恢复

```typescript
interface BanDetector {
  // 检测信号
  signals: {
    http_401: true;           // 认证失败 → 确认被封
    http_403: true;           // 禁止访问 → 确认被封
    http_429_persistent: true; // 持续限速超过N次 → 疑似风控
    response_quality_drop: true; // [GAP] 响应质量下降可能是被降级
  };
  
  // 响应动作
  on_ban_detected(account: AccountEntry): void {
    account.status = 'suspended';
    account.stats.ban_count++;
    
    // 立即切换到下一个可用账号
    const next = selectAccount(pool);
    if (next) {
      // 无缝切换，不中断服务
      pool.active_index = pool.accounts.indexOf(next);
    } else {
      // 所有账号不可用 → 暂停接单
      pauseProviding();
    }
    
    // 通知用户
    notifyOperator({
      type: 'account_suspended',
      account_id: account.id,
      remaining_accounts: countAvailable(pool),
      action_needed: countAvailable(pool) < 2
        ? 'URGENT: 添加新账号 clawd provide accounts add'
        : '当前仍有可用账号'
    });
  }
}
```

**自动恢复流程:**

```
检测到封号
    │
    ├──→ 标记账号 suspended
    ├──→ 切换到下一账号
    ├──→ 通知用户
    │
    ├──→ [可用账号≥2] → 继续服务
    ├──→ [可用账号=1] → 告警: 请补充账号
    └──→ [可用账号=0] → 暂停provide + CRITICAL告警

恢复路径:
    a) 用户添加新账号: clawd provide accounts add
    b) 封号申诉成功 → 手动恢复: clawd provide accounts activate <id>
    c) [GAP] 自动检测账号是否恢复（定期低频试探）
```

---

## 3. 数据流

### 请求处理（含反检测）

```
Relay推送请求
    │
    ▼
┌──────────────────┐
│ 节奏调度器检查     │
│ (是否在活跃时段    │
│  间隔是否足够)     │
└────────┬─────────┘
         │ OK
         ▼
┌──────────────────┐
│ 选择账号          │
│ (selectAccount)   │
│ 最少使用的active  │
└────────┬─────────┘
         │ 选到账号
         ▼
┌──────────────────┐
│ 构造伪装请求      │
│ (headers/UA)      │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐     429/529
│ 调用上游API       │────────────┐
│ (含重试逻辑)      │            │
└────────┬─────────┘            ▼
         │              ┌───────────────┐
         │ 200          │ 退避+切换账号   │
         ▼              │ (getRetryDelay) │
┌──────────────────┐    └───────────────┘
│ 更新账号统计      │
│ requests_today++  │    401/403
│ last_used_at=now  │────────────┐
└────────┬─────────┘            ▼
         │              ┌───────────────┐
         ▼              │ 封号检测触发    │
    返回加密响应         │ on_ban_detected │
                        └───────────────┘
```

---

## 4. 状态管理

### 4.1 持久化状态（SQLite）

```sql
CREATE TABLE account_pool (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'anthropic',
  credential_encrypted TEXT NOT NULL,    -- 加密存储
  credential_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  total_requests INTEGER DEFAULT 0,
  requests_today INTEGER DEFAULT 0,
  last_used_at INTEGER,
  last_rate_limit_at INTEGER,
  consecutive_errors INTEGER DEFAULT 0,
  ban_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 每日重置计数器
-- [GAP: cron job 或 应用层在日期变更时重置 requests_today]
```

### 4.2 内存状态

```typescript
interface AntiDetectionState {
  scheduler: RhythmScheduler;
  pool: AccountPool;
  last_request_at: number;
  requests_in_current_burst: number;
  is_paused: boolean;        // 所有账号不可用时暂停
  daily_stats: {
    date: string;            // YYYY-MM-DD
    total_requests: number;
    by_account: Map<string, number>;
    rate_limits_hit: number;
    bans_detected: number;
  };
}
```

---

## 5. 错误处理与边界情况

| 场景 | 处理 |
|------|------|
| 唯一账号被封 | 暂停provide + CRITICAL通知 |
| 所有账号同时被封 | 暂停provide + 建议等待/添加API key |
| 节奏调度器拒绝（非活跃时段） | 请求排队或拒绝（返回rate_limit给Relay） |
| credential加密存储损坏 | 要求重新添加账号 |
| 时区检测失败 | fallback到UTC，全天活跃 |
| 上游API格式变更 | [GAP] 需要版本适配层 |
| 订阅到期 | 同401处理路径 |

---

## 6. 安全约束

### 6.1 凭证存储
- 所有 credential 使用设备级密钥加密后存储
- 内存中仅保留当前 active 账号的 credential
- [GAP: 与 wallet/keystore 的集成方式]

### 6.2 不可外泄的信息
- credential 绝不出现在日志中
- 封号通知中不包含具体 credential
- 账号统计不包含请求内容

### 6.3 公开文档规范（红队审计 §20.3.12）
- 对外文档不提"反检测"、"避免封号"
- 使用 "Multi-account redundancy" / "high availability"
- 封号容灾不进白皮书

### 6.4 单厂商流量上限
- 单一 AI 厂商不超过 40% 总流量（spec §8.2）
- [GAP: 当前代码仅支持 Anthropic，多厂商支持未实现]

---

## 7. 经济模型

### 7.1 月成本公式

```
月成本 = Σ(订阅费_i) × (1 + 封号率)
```

| 变量 | 保守估计 | 乐观估计 |
|------|---------|---------|
| 单账号订阅费 | $20/月 | $20/月 |
| 账号数量 | 3 | 2 |
| 月封号率 | 15% | 5% |
| 月成本 | $69 | $42 |
| API key 后备 | $50/月 | $0 |
| **总月成本** | **$119** | **$42** |

### 7.2 收入与ROI

```
假设:
  - Provider 分成 = 80% (spec §6.2)
  - 月处理量 = $100-200 等值token
  - 协议费 = 10%
  
月毛收入 = $100 × 80% = $80
月净收入 = $80 - $69 = $11 (保守)
月净收入 = $160 × 80% - $42 = $86 (乐观)

+ TOKEN 挖矿奖励 (不确定性大，不算入基础ROI)
+ Genesis Bonus 5x 积分 (前30天)
```

### 7.3 Surge 定价应反映真实成本

```
surge base_price 应 ≥ Provider平均成本
  → base_price_ratio = 0.50 (spec §5.4.5)
  → 含义: 协议价格 = 厂商价格 × 50% × surge_multiplier
  → Provider成本 ≈ 订阅费 / 可处理token量
  → 当 surge_multiplier > 1.5 时 Provider才有利润
  → [GAP: 需要实际数据验证这个比例]
```

---

## 8. 测试要求

### 8.1 单元测试
- [ ] `nextRequestDelay()`: 活跃时段间隔合理、非活跃时段间隔增大、burst模式触发
- [ ] `selectAccount()`: 选择最少使用的、跳过suspended、cooling恢复逻辑
- [ ] `BanDetector`: 401→suspended、429→cooling、切换逻辑
- [ ] `poissonJitter()`: 分布合理性（直方图检查）

### 8.2 集成测试
- [ ] 模拟封号→自动切换→继续服务
- [ ] 所有账号被封→暂停provide→添加新账号→恢复
- [ ] 24小时模拟：请求分布符合时区模式
- [ ] 日上限触发→自动轮换

### 8.3 统计测试
- [ ] 1000次 `nextRequestDelay()` 调用：间隔分布非均匀（Kolmogorov-Smirnov检验）
- [ ] 请求时间序列：不含周期性模式（自相关分析）

---

## 9. 与其他模块的依赖

```
┌──────────────┐     ┌──────────────┐
│ config/      │     │ wallet/      │
│ 时区/参数     │     │ 凭证加密      │
└──────┬───────┘     └──────┬───────┘
       │                    │
       └────────┬───────────┘
                │
        ┌───────▼────────┐
        │ anti-detection │ ← 本模块
        │  Layer 1-5     │
        └───────┬────────┘
                │
       ┌────────┼────────┐
       │        │        │
┌──────▼──┐  ┌──▼──┐  ┌──▼──────────┐
│provider/ │  │ db  │  │ notification│
│请求处理   │  │账号池│  │ 封号告警     │
└─────────┘  └─────┘  └─────────────┘
```

| 模块 | 关系 | 说明 |
|------|------|------|
| `provider/index.ts` | 调用方 | handleRequest() 前经过反检测层 |
| `wallet/` | 上游 | 凭证加密存储 |
| `config/` | 上游 | 时区、调度参数、轮换策略 |
| `db.ts` | 下游 | 账号池持久化 |
| 通知系统 | 下游 | 封号/告警推送 [GAP: 通知渠道未定义] |

---

## 附录 A: 已知GAP

| GAP | 优先级 | 说明 |
|-----|--------|------|
| 多厂商支持 | P1 | 当前仅Anthropic，需支持OpenAI/Google等 |
| 响应质量监控 | P2 | 被降级（如被切到低质量模型）的检测 |
| 自动账号恢复检测 | P3 | 定期试探被封账号是否已恢复 |
| API格式适配层 | P2 | 上游API版本变更时的兼容处理 |
| 通知渠道 | P2 | 封号告警推送到哪里（Telegram/Discord/clawd UI） |
| 凭证与keystore集成 | P1 | 与wallet/keystore进程的加密委托 |
| Proxy模式反检测 | P2 | proxyUrl模式下是否需要不同的反检测策略 |
| requests_today重置 | P3 | 日期变更时重置每日计数器的触发机制 |

---

*v0.1.0 — 基于spec §8 + 红队审计修正。实现优先级: Layer 4 (多账号) > Layer 2 (节奏) > Layer 5 (检测) > Layer 3 (伪装) > Layer 1 (已实现)。*
