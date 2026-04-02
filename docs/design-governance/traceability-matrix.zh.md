# 愿景追踪矩阵

## 目的

本矩阵把运行时模块映射到 [产品愿景](../design-governance/product-vision.zh.md) 的五个结果：
`Access`、`Privacy`、`Market`、`Automation`、`Settlement`。

在设计评审和文档更新时使用本页，可降低“因遗漏而偏离愿景”的风险。

## 模块映射


| 模块                    | Access  | Privacy | Market  | Automation | Settlement | 说明                          |
| --------------------- | ------- | ------- | ------- | ---------- | ---------- | --------------------------- |
| `consumer-gateway`    | Yes     | Partial | Partial | Partial    | Partial    | 核心 OpenAI 兼容接入面，包含预算与路由上下文。 |
| `provider-engine`     | Partial | Partial | Yes     | Partial    | Partial    | 兑现卖方可执行供给，并保持可进入结算链路的证据连续性。 |
| `relay`               | Partial | Yes     | Yes     | Partial    | Yes        | 承担路由、见证与市场中介角色，生成可签名使用记录。   |
| `bootstrap-discovery` | Partial | Partial | Yes     | Partial    | No         | 让 Relay 可用性与中介选择保持显式化。      |
| `network-transport`   | Yes     | Partial | Partial | Yes        | No         | 共享连通与重连能力支撑接入连续性和低人工运行。     |
| `wallet-identity`     | Partial | Yes     | No      | Partial    | No         | 维护密钥与身份边界，是无账户接入和隐私保护的基础。   |
| `metering-witness`    | No      | Partial | Partial | No         | Yes        | 产出可用于收益分发的使用证据。             |
| `pricing-risk-policy` | No      | No      | Yes     | Yes        | Yes        | 提供确定性定价与风险控制，并维持报价/结算语义分离。  |
| `settlement-payout`   | No      | No      | Yes     | Partial    | Yes        | 将见证与定价转换为可审计的收益分发输出。        |
| `claw-autopilot`      | Partial | Partial | Yes     | Yes        | Partial    | 自动化接入与市场运营，受策略和健康门槛约束。      |
| `cli`                 | Partial | Partial | Partial | Yes        | No         | 运维入口，逐步把手工操作迁移到受支持自动化路径。    |


## 文档层映射


| 文档分区                             | Access  | Privacy | Market  | Automation | Settlement | 说明                        |
| -------------------------------- | ------- | ------- | ------- | ---------- | ---------- | ------------------------- |
| `docs/product-design/overview/`                 | Yes     | Partial | Yes     | Partial    | Partial    | 定义产品范围与高层方向，覆盖运行时与市场主线。   |
| `docs/design-governance/`                   | Yes     | Yes     | Yes     | Yes        | Yes        | 愿景、结果、原则与架构/路线图约束的规范源。    |
| `docs/technical-design/system-model/`             | Yes     | Yes     | Yes     | Yes        | Yes        | 定义角色可见性、请求链路、运维路径与结算输入关系。 |
| `docs/technical-design/architecture/`             | Yes     | Yes     | Yes     | Yes        | Yes        | 定义有界上下文，并明确报价/结算语义分离。     |
| `docs/technical-design/modules/`                  | Yes     | Yes     | Yes     | Yes        | Yes        | 通过模块合同把实现职责映射到五条结果。       |
| `docs/technical-design/protocol/`                 | Partial | Yes     | Yes     | Partial    | Yes        | 线级契约、市场契约说明与见证证据链共同支撑市场运行和结算可重放性。 |
| `docs/product-design/trust-and-privacy/`        | Partial | Yes     | Partial | Partial    | Yes        | 定义公开隐私口径与信任边界，并补充可见性拆分与结算证据的互补关系。 |
| `docs/product-design/roadmap/`                  | Yes     | Yes     | Yes     | Yes        | Yes        | 分阶段落地与执行门槛让五条结果持续留在主路径。   |
| `docs/operations/`               | Partial | Partial | Yes     | Yes        | Yes        | 运行可观测性、发布门槛与经济运行就绪检查共同支撑市场与结算可靠性。 |
| `docs/technical-design/configuration/`            | Partial | Partial | Partial | Partial    | Partial    | 记录运行时控制项，并加入市场角色与报价/结算护栏。 |
| `docs/clients/`                  | Yes     | Partial | Yes     | Partial    | Partial    | 面向接入层，并显式说明其是市场网络入口及报价/结算边界。 |
| `docs/product-design/governance-and-economics/` | Partial | Partial | Yes     | Partial    | Yes        | 定义市场经济与结算连续性，并与贡献账务分离。    |


## 审核规则

- 每个模块 README 至少应显式说明它支撑的一个结果。
- 涉及定价、见证或收益分发的模块必须保持“报价语义”和“结算语义”分离。
- 面向 Relay 的模块应说明 Relay 同时是控制平面角色与市场角色，而非纯传输基础设施。
- 面向自动化的模块应说明如何降低人工运维，同时不绕过安全门槛。

