# 协议设计

## 目的

本节描述 Veil 各运行角色之间的线级协议契约。

## 适用场景

- 你在实现 Consumer、Relay 或 Provider 的消息处理
- 你在评审签名、信封或消息类型
- 你想在改代码前先明确请求与响应契约

## 传输

- Consumer、Relay、Provider 之间使用 WebSocket
- Bootstrap API 使用 HTTP
- 消息载荷使用 JSON

## 顶层消息

```ts
interface WsMessage {
  type: MessageType;
  request_id?: string;
  payload?: unknown;
  timestamp: number;
}
```

## 主要消息类型

- `provider_hello`
- `provider_ack`
- `request`
- `response`
- `stream_start`
- `stream_chunk`
- `stream_end`
- `error`
- `ping`
- `pong`
- `list_providers`
- `provider_list`

## 请求信封

Consumer 请求包含：

- `outer`：Relay 可见的元数据
- `inner`：发给 Provider 的 base64 编码密封字节

`outer` 携带：

- Consumer 公钥
- Provider id
- model
- 在需要确定性结算时，携带 pricing version 或报价引用
- signature

`inner` 携带：

- messages
- 模型参数
- stream 标志

## 签名

Consumer 对以下字段签名：

- request id
- consumer public key
- provider id
- model
- timestamp
- 内层载荷哈希（inner payload hash）

Relay 在转发前校验签名。

## 密封载荷

密封请求格式为：

```text
[sender_public_key(32)] [nonce(24)] [ciphertext(...)]
```

Relay 只转发密封载荷，不进行解密。

## 响应路径

- 非流式响应返回 `encrypted_body`
- 流式响应依次发送 `stream_start`、`stream_chunk`、`stream_end`
- `stream_end` 携带生成见证记录所需的用量和完成元数据

## 目录消息

Relay 通过以下消息发布 Provider 可用性：

- `list_providers`
- `provider_list`

## 市场契约说明

- `provider_list` 让卖方供给与中介可见性保持显式化，而不是隐含基础设施行为。
- 请求元数据中的定价版本或报价引用，把路由阶段报价绑定到可重放的结算证据链。
- 见证记录结合 `dedupe_key` 在保证可审计性的同时，降低重放入账风险。

关于 Relay 的市场角色边界，请参考 [Relay 模块](../modules/relay/README.zh.md)。

## 错误语义

错误使用以下结构返回：

```ts
interface ErrorPayload {
  code: string;
  message: string;
}
```

## Witness 语义

请求完成时，Relay 记录带签名的见证记录。见证记录必须能够与确定性的定价快照关联，以便后续重放结算。

## 结算证据链

```ts
interface WitnessRecord {
  request_id: string;
  provider_id: string;
  relay_id: string;
  model: string;
  usage: NormalizedUsage;
  pricing_version: string;
  quote_unit: 'usd_estimate';
  completion_status: 'success' | 'error' | 'aborted';
  completed_at: number;
  evidence_hash: string;
  dedupe_key: string;
  provider_usage_hash?: string;
  relay_signature: string;
}
```

- `pricing_version` 用来把见证记录绑定到确定性的报价条款
- `quote_unit` 只表示预算与比较用的计价语言，不代表最终结算资产
- `evidence_hash` 和 `dedupe_key` 让结算系统能拒绝重放或重复入账的记录
- 当上游用量回执可用时，可以把其哈希写入 `provider_usage_hash`，补强证据链
