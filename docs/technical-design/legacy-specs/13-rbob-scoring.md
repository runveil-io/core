# 13 — RBOB Scoring System Design

> 积分计算、追踪、发放、TOKEN转换
> Date: 2026-04-01
> Status: Draft
> Depends on: rbob-protocol-v1.md, clawd-build-marketplace.md

## 1. 职责边界

**做什么：**
- 计算每次PR合并的RBOB积分
- 追踪积分余额和变动历史
- 管理Genesis Bonus衰减
- 积分→TOKEN转换（TGE时）
- 积分回收（代码被删除时）

**不做什么：**
- 不判断代码质量（由CI测试+review决定）
- 不管理合并流程（GitHub/RBOB rules管）
- 不处理TOKEN发行（链上合约管）

## 2. 接口定义

### 2.1 积分计算

```typescript
interface PointsCalculation {
  basePoints: number;       // 任务基础积分（来自desired/*.yaml的points字段）
  genesisMultiplier: number; // Genesis Bonus倍率 (5x→1x衰减)
  difficultyBonus: number;  // 难度加成 (easy:1.0, medium:1.2, hard:1.5)
  finalPoints: number;      // basePoints × genesisMultiplier × difficultyBonus
}

function calculatePoints(params: {
  taskId: string;
  basePoints: number;
  difficulty: 'easy' | 'medium' | 'hard';
  mergedAt: Date;
}): PointsCalculation;
```

### 2.2 Genesis Bonus衰减

```typescript
// Genesis Bonus: 前30天5x，之后线性衰减到1x（90天）
function getGenesisMultiplier(daysSinceLaunch: number): number {
  if (daysSinceLaunch <= 30) return 5.0;
  if (daysSinceLaunch >= 120) return 1.0;
  // 线性衰减: 5x @ day30 → 1x @ day120
  return 5.0 - (daysSinceLaunch - 30) * (4.0 / 90);
}
```

### 2.3 积分账本

```typescript
interface ContributorAccount {
  pubkey: string;           // 贡献者的签名公钥
  totalPoints: number;      // 累计积分
  activePoints: number;     // 活跃积分（代码仍存活）
  reclaimedPoints: number;  // 被回收的积分（代码被删）
  contributions: Contribution[];
}

interface Contribution {
  id: string;               // PR merge的commit hash
  taskId: string | null;    // 对应的desired task id
  prUrl: string;
  mergedAt: Date;
  points: number;
  status: 'active' | 'reclaimed';
  reclaimedAt?: Date;
  files: string[];          // 修改的文件列表
}
```

## 3. 数据流

```
PR合并 (GitHub webhook / manual trigger)
       │
       ├── 解析PR: 哪些文件, 对应哪个task
       │
       ├── 计算积分: base × genesis × difficulty
       │
       ├── 写入DB: contributions + ledger
       │
       └── 通知: TG/GitHub comment "🎯 +500 points"

代码被删除 (后续PR删除了之前的代码)
       │
       ├── 检测: git diff找到被删的文件/函数
       │
       ├── 关联: 哪个contribution引入了被删的代码
       │
       ├── 回收: activePoints -= reclaimed
       │
       └── 通知: "⚠️ -200 points (code removed in PR#xx)"
```

## 4. 状态管理

### 4.1 contributions.db Schema

```sql
CREATE TABLE contributors (
  pubkey TEXT PRIMARY KEY,
  github_username TEXT,
  total_points INTEGER DEFAULT 0,
  active_points INTEGER DEFAULT 0,
  reclaimed_points INTEGER DEFAULT 0,
  first_contribution_at TEXT,
  last_contribution_at TEXT
);

CREATE TABLE contributions (
  id TEXT PRIMARY KEY,       -- commit hash
  contributor_pubkey TEXT NOT NULL,
  task_id TEXT,
  pr_url TEXT NOT NULL,
  merged_at TEXT NOT NULL,
  base_points INTEGER NOT NULL,
  genesis_multiplier REAL NOT NULL,
  difficulty_bonus REAL NOT NULL,
  final_points INTEGER NOT NULL,
  status TEXT DEFAULT 'active',  -- active | reclaimed
  reclaimed_at TEXT,
  reclaimed_by TEXT,              -- commit hash that removed code
  files_json TEXT NOT NULL,       -- JSON array of file paths
  FOREIGN KEY (contributor_pubkey) REFERENCES contributors(pubkey)
);

CREATE TABLE points_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contributor_pubkey TEXT NOT NULL,
  amount INTEGER NOT NULL,        -- positive=earn, negative=reclaim
  reason TEXT NOT NULL,            -- 'merge:xxx' | 'reclaim:xxx' | 'genesis_bonus'
  contribution_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (contributor_pubkey) REFERENCES contributors(pubkey)
);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
  -- 'launch_date', 'total_points_issued', etc.
);
```

### 4.2 Day 1存储

- SQLite文件：`contributions.db`（Relay维护）
- Git审计：每次积分变动对应一个git commit
- 无链上存储（Stage 3才上链）

## 5. 错误处理

| 场景 | 处理 |
|------|------|
| PR合并但不对应任何desired task | 给最小积分(100 base)，标记为`ad-hoc` |
| 同一PR多次webhook触发 | 幂等：按commit hash去重 |
| 贡献者公钥未注册 | 自动创建contributor记录 |
| 积分回收时原始contribution不存在 | 忽略，记warning日志 |
| Genesis Bonus计算时launch_date未设 | 默认multiplier=1.0（无bonus） |

## 6. 安全约束

- **积分不可转让**（pre-TGE）：积分绑定公钥，不能p2p转移
- **积分总量有上限**：不能超过Treasury预期收入（见v2.2 §6）
- **DB修改需要签名**：[GAP] 每次ledger写入附带Relay签名，防篡改
- **R3保护**：contributions.db的schema修改需要更高审批
- **防刷**：
  - 同一个公钥24h内最多5个PR合并
  - 单PR最高积分 = 任务定义的points × 2（防拆分刷量）
  - 空PR（0行有效代码变更）不计积分

## 7. 测试要求

- 基础积分计算：100 base × 5x genesis × 1.2 medium = 600
- Genesis衰减：day 0=5x, day 30=5x, day 75=3x, day 120=1x
- 积分回收：merge后删代码，active_points正确扣减
- 幂等性：同一commit hash重复提交不重复计分
- 防刷：24h内第6个PR被拒绝
- Ledger审计：所有积分变动可追溯到具体PR

## 8. 模块依赖

```
rbob-scoring
  ├── db (contributions.db读写)
  ├── crypto (签名验证——验证贡献者身份)
  ├── metering [弱依赖] (未来积分可能挂钩推理收入)
  └── external:
      ├── GitHub API (webhook接收, PR信息)
      └── Git (diff分析，代码存活检测)
```

## 9. TOKEN转换 (TGE)

```
阶段0 (pre-TGE):
  积分追踪在DB，不上链
  贡献者可查询: veil points --pubkey xxx

阶段1 (TGE):
  total_points_issued = SUM(all active_points)
  token_airdrop_pool = TOTAL_SUPPLY × 0.10  (10%)
  conversion_rate = token_airdrop_pool / total_points_issued
  
  每个贡献者获得:
  tokens = active_points × conversion_rate

阶段2 (post-TGE):
  新积分 → 直接发TOKEN（不再用积分）
  conversion_rate由DAO治理决定
```

## 10. [GAP] 缺失功能

1. **GitHub webhook接收** — 需要一个HTTP endpoint接收merge事件
2. **代码存活检测** — 需要定期git diff分析哪些代码被删了
3. **积分查询CLI** — `veil points` 命令
4. **积分Dashboard** — web界面展示排行榜
5. **DB签名** — 每条ledger记录的Relay签名
6. **链上迁移** — Stage 3把DB搬到Solana
