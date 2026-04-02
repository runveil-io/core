# 10 — CLI UX Design

> 命令行入口：veil init / provide / relay / status / build
> Date: 2026-04-01
> Status: Draft

## 1. 职责边界

**做什么：**
- 解析命令和参数
- 调用对应模块的启动函数
- 展示状态和反馈（spinner, colors, table）
- 管理config和wallet的初始化

**不做什么：**
- 不包含业务逻辑（调用consumer/provider/relay模块）
- 不直接操作网络或加密
- 不持久化数据（委托给wallet和db模块）

## 2. 接口定义

### 2.1 命令结构

```typescript
// 现有命令 (src/cli.ts, 289行)
interface CLI {
  // 初始化
  'init': () => Promise<void>;           // 创建钱包+config
  
  // Provider
  'provide init': () => Promise<void>;   // 配置AI订阅
  'provide start': () => Promise<void>;  // 启动Provider
  'provide stop': () => Promise<void>;   // [GAP] 停止Provider
  
  // Relay
  'relay start': () => Promise<void>;    // 启动Relay
  'relay stop': () => Promise<void>;     // [GAP] 停止Relay
  
  // Consumer
  'start': () => Promise<void>;          // [GAP] 启动Consumer网关
  
  // 状态
  'status': () => Promise<void>;         // 显示运行状态
  'balance': () => Promise<void>;        // [GAP] 显示余额
  
  // Build
  'build': (repo?: string) => Promise<void>; // [GAP] clawd build
}
```

### 2.2 输出格式

```typescript
interface CLIOutput {
  spinner(text: string): { stop(finalText?: string): void };
  success(text: string): void;
  error(text: string): void;
  warn(text: string): void;
  table(headers: string[], rows: string[][]): void;
  json(data: unknown): void;  // --json flag时输出纯JSON
}
```

## 3. 数据流

```
用户输入
   │
   ├── veil init
   │     └── wallet/createWallet() → 生成密钥对
   │         → config/写config.json
   │         → 显示公钥+网关地址
   │
   ├── veil provide start
   │     └── 读config → 验证API key
   │         → provider/startProvider()
   │         → network/connect(relay)
   │         → 显示"Online. Models: ..."
   │
   ├── veil relay start
   │     └── 读config → db/initSchema()
   │         → relay/startRelay()
   │         → 显示"Listening on wss://..."
   │
   ├── veil status
   │     └── 读config → 检查进程
   │         → 显示表格(角色/状态/连接数/收益)
   │
   └── veil build [repo]
         └── [GAP] clawd-build skill调用
```

## 4. 状态管理

- **不持久化**：CLI自身不存数据
- **读取**：~/.veil/config.json, ~/.veil/wallet.json
- **进程管理**：[GAP] 需要PID文件或进程锁来支持stop命令

## 5. 错误处理

| 错误 | 处理 |
|------|------|
| config不存在 | 提示运行 `veil init` |
| wallet密码错误 | 最多3次重试，然后退出 |
| API key无效 | 提示重新配置 `veil provide init` |
| Relay连不上 | 显示错误+重试倒计时 |
| 端口被占 | 显示占用进程，建议换端口 |

## 6. 安全约束

- API key只在`provide init`时输入，存入config后不再显示
- wallet密码不回显
- `--json`输出不包含敏感字段（私钥、API key）
- 不支持通过命令行参数传密码（防止进程列表泄露）

## 7. 测试要求

- init创建wallet.json和config.json
- provide start在无config时报错并提示init
- status在无进程时显示"offline"
- --json输出可被JSON.parse
- --help输出包含所有命令

## 8. 模块依赖

```
cli.ts
  ├── wallet/    (init, 密码输入)
  ├── consumer/  (start网关)
  ├── provider/  (provide start)
  ├── relay/     (relay start)
  ├── config/    (读写配置)
  └── db/        (relay的DB初始化)
```

## 9. [GAP] 缺失功能

1. **stop命令** — 无法优雅停止provider/relay
2. **balance命令** — 无法查看Escrow余额
3. **build命令** — 未实现
4. **进程管理** — 无PID文件，无法检测是否已运行
5. **美化输出** — 纯console.log，无spinner/color/table
6. **--json flag** — 不支持机器可读输出
7. **自动更新检查** — 无版本检查
