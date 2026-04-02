# Veil 文档

本目录是 Veil 的规范化文档入口。

Veil 正在被构建成一个由 Agent 运营的 AI 容量市场。今天对外公开的规范运行时，仍然首先表现为一个 AI 推理路由系统，主要包含四类角色：

- `Consumer`：本地 OpenAI 兼容网关
- `Relay`：验签、路由、限流和见证记录
- `Provider`：上游执行节点
- `Bootstrap`：Relay 发现服务

目标市场形态会在这套运行时基线之上，再加入 Claw 自动化、卖方策略和结算流程。

## 按目标阅读

- 第一次进入项目：
  [项目概览](./product-design/overview/README.zh.md) -> [产品设计](./product-design/README.zh.md) -> [设计治理](./design-governance/README.zh.md) -> [技术设计](./technical-design/README.zh.md)
- 准备安装或运行：
  [安装](./installation/README.zh.md) -> [操作手册](./manual/README.zh.md) -> [运维与运行时](./operations/README.zh.md)
- 需要配置节点：
  [配置](./technical-design/configuration/README.zh.md)
- 需要接入客户端或工具：
  [客户端接入](./clients/README.zh.md)
- 需要理解信任与隐私边界：
  [信任与隐私](./product-design/trust-and-privacy/README.zh.md)
- 需要统一术语：
  [术语表](./glossary/README.zh.md)
- 需要实现或评审协议：
  [协议设计](./technical-design/protocol/README.zh.md)
- 需要理解贡献治理或经济边界：
  [治理与经济边界](./product-design/governance-and-economics/README.zh.md) -> [路线图](./product-design/roadmap/README.zh.md)
  若需要严格排序实施，请继续阅读 [execution-rules.zh.md](./product-design/roadmap/execution-rules.zh.md)。

## 系统一览

```text
客户端 -> Consumer 网关 -> Relay -> Provider -> 上游 AI
                       \-> 预算      \-> 见证记录
Bootstrap -> Relay 发现
RBOB -> 贡献记账
```

## 文档分区

- [product-design/](./product-design/README.zh.md)：产品范围、信任与隐私口径、治理经济与路线图
- [technical-design/](./technical-design/README.zh.md)：系统模型、架构、模块、协议与运行时配置
- [design-governance/](./design-governance/README.zh.md)：产品愿景与追踪治理
  另见 [documentation-governance-rules.zh.md](./design-governance/documentation-governance-rules.zh.md)，用于归类与维护标准。
- [clients/](./clients/README.zh.md)：本地网关接入说明
- [operations/](./operations/README.zh.md)：部署、持久化、限制和可观测性
- [manual/](./manual/README.zh.md)：按角色的运行方式
- [installation/](./installation/README.zh.md)：安装和首次环境准备
- [glossary/](./glossary/README.zh.md)：统一术语和公开写法

## 模块索引

模块文档按实现边界拆分：

- [wallet-identity](./technical-design/modules/wallet-identity/README.zh.md)
- [consumer-gateway](./technical-design/modules/consumer-gateway/README.zh.md)
- [network-transport](./technical-design/modules/network-transport/README.zh.md)
- [relay](./technical-design/modules/relay/README.zh.md)
- [provider-engine](./technical-design/modules/provider-engine/README.zh.md)
- [metering-witness](./technical-design/modules/metering-witness/README.zh.md)
- [bootstrap-discovery](./technical-design/modules/bootstrap-discovery/README.zh.md)
- [claw-autopilot](./technical-design/modules/claw-autopilot/README.zh.md)
- [pricing-risk-policy](./technical-design/modules/pricing-risk-policy/README.zh.md)
- [settlement-payout](./technical-design/modules/settlement-payout/README.zh.md)
- [cli](./technical-design/modules/cli/README.zh.md)
- [rbob-ledger](./technical-design/modules/rbob-ledger/README.zh.md)

## 命名规范

- 顶层设计分类统一使用 kebab-case：`product-design`、`technical-design`、`design-governance`
- 每个目录入口文件统一命名为 `README.md`（中文为 `README.zh.md`）
- 中英文配对文档统一使用相同基名，后缀分别为 `.md` 与 `.zh.md`

## 语言约定

- 英文入口：`README.md`
- 中文入口：`README.zh.md`

每个文档目录都遵循同样的命名方式。
