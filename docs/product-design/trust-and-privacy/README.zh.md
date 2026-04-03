# 信任与隐私

## 目的

本节定义 Veil 在隐私、身份和运维者可见性方面承诺什么、不承诺什么。

## 适用场景

- 你需要 Veil 的公开隐私定位
- 你想理解 Consumer、Relay、Provider 之间的信任拆分
- 你需要一份不夸大匿名性的精确表述

## 核心定位

Veil 旨在提供无账户接入和隐私保护式路由，但并不承诺完美匿名。

它的核心设计思想是角色拆分：

- Consumer 侧拥有本地身份、本地提示词和本地策略
- Relay 侧拥有路由、准入和见证记录
- Provider 侧拥有明文执行边界

## Veil 能保护什么

- Relay 在路由请求时不需要提示词明文
- Provider 在执行时不需要获得完整的 Consumer 本地上下文
- 本地客户端可以通过一个网关集成，而不用内嵌很多上游账户流程
- 见证记录和账务记录可以与提示词内容分离

## Veil 不承诺什么

- 针对流量分析的完美匿名
- 针对 Relay 与 Provider 串谋的完美匿名
- 对上游模型提供方完全不可见
- 在 Consumer 或 Provider 端点被攻破时仍然提供保护

## 信任边界

| 角色 | 主要信任假设 |
|------|--------------|
| Consumer | 本地机器和钱包仍由用户控制 |
| Relay | 在不解密业务载荷的前提下进行路由和见证记录 |
| Provider | 执行明文请求，但不应接收不必要的 Consumer 上下文 |
| Bootstrap | 只处理 Relay 元数据 |

## 公开表述规则

公开文档可以把 Veil 描述为：

- 无账户接入
- 隐私保护式路由
- 通过角色拆分实现可见性分离

公开文档不应把 Veil 描述为：

- 保证匿名
- 无法追踪
- 不受运维者关联分析影响

如果需要看这套表述为什么这样收敛，请继续阅读 [无账户接入，不等于匿名](./accountless-not-anonymous.zh.md)。

## 隐私边界与结算证据

可见性拆分与结算证据并不冲突，而是互补关系：

- Relay 可以在不解密提示词明文的前提下记录带签名的见证元数据。
- 结算重放依赖见证记录与定价证据，不依赖扩大角色可见范围。
- 推理记录与治理记录保持账本分离，以同时维持隐私边界和可审计性。

## 下一步阅读

- [无账户接入，不等于匿名](./accountless-not-anonymous.zh.md)
- [系统模型](../../technical-design/system-model/README.zh.md)
- [协议设计](../../technical-design/protocol/README.zh.md)
- [治理与经济边界](../../product-design/governance-and-economics/README.zh.md)
