# 架构设计

## 目的

本节说明 Veil 的运行时拓扑，以及各主要运行平面的职责归属边界。

任何架构简化都应对照 [产品愿景](../../design-governance/product-vision.zh.md) 审核，避免在简化过程中把市场、结算或自动化目标一并删掉。
模块到愿景的映射请参考 [traceability-matrix.zh.md](../../design-governance/traceability-matrix.zh.md)。

## 适用场景

- 需要判断某个能力应该落在哪个运行边界
- 需要评审信任、持久化或所有权划分
- 想从产品行为快速定位到实现结构

## 运行时拓扑

当前运行时已经实现 Consumer Gateway、Relay、Provider、Bootstrap、Wallet 和 RBOB。Claw Autopilot 是目标运行模型中已文档化的自动化层。

- `Consumer Gateway`：本地 OpenAI 兼容接入层
- `Relay`：路由与见证记录中介节点
- `Provider`：上游执行节点
- `Bootstrap`：Relay 发现服务
- `Claw Autopilot`：节点接入与运行自动化层
- `Wallet`：本地密钥与秘密存储
- `RBOB Ledger`：贡献积分账本

## 有界上下文

### Access Plane

由 Consumer Gateway 负责。处理客户端兼容、请求封装、响应格式化和预算控制。

### Control Plane

由 Relay 与 Bootstrap 负责。处理发现、准入、路由、限制和见证记录。

### Autopilot Plane

由 Claw 负责。处理节点接入流程、运行编排、策略应用、故障恢复，以及低人工干预的自动化运营。

### Execution Plane

由 Provider 负责。处理解密、上游请求和本地账号治理。

### Market Plane

由 Provider 策略、Relay 准入和 `pricing-risk-policy` 共同负责。处理容量发布、价格策略、报价语义、结算资产提示和卖方运行限制。

### Identity Plane

由 Wallet 与本地配置负责。处理密钥材料和加密后的凭证。

### Governance Plane

由 RBOB 账本与评审流程负责。处理与推理流量分离的贡献治理。

### Settlement Plane

由见证记录、定价接口和 `settlement-payout` 负责。处理从用量证据到可计费、可支付结果的转换，同时不把治理账本和推理账本混成一本账。

这里必须把报价单位和最终结算资产严格分离，避免预算、定价和支付轨被写成一回事。

## 持久化对象

- `wallet.json`
- `config.json`
- `provider.json`
- `relay.db`
- `witness.db`
- `relay_registry`
- `rbob_ledger`

## 规划中的控制扩展

- 用于自动定价和风险包络的策略状态
- 由 Claw 管理的运维者意图状态
- 从见证记录和定价记录推导出的结算状态

## 愿景约束检查清单

- 保持本地 OpenAI 兼容接入作为默认集成面
- 在 Consumer、Relay、Provider 边界上持续降低身份耦合并维持隐私保护式路由
- 保持 Relay 作为显式的市场与见证角色
- 持续区分报价单位与最终结算资产
- 保持 Claw 或等价自动化能力位于运维主路径
