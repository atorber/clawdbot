# apps/android-mqtt 切换为 MQTT 连接 — 实现方案（v1 存档）

> 本文档为 v1 方案存档。当前生效方案见 [MQTT-实现方案.md](./MQTT-实现方案.md)（v2.0）。

---

## 1. 目标与范围

- **目标**：将 `apps/android-mqtt` 与 Gateway 的连接从 **WebSocket** 改为 **MQTT**，**尽可能保持原有功能和界面交互不变**。
- **范围**：
  - 保留：双 session（operator + node）、聊天、Canvas、相机/录屏/短信/定位、语音唤醒、设置页、发现/手动连接等现有能力与 UI。
  - 变更：底层传输由「直连 Gateway 的 WebSocket」改为「经 MQTT Broker 的 MQTT 发布/订阅」。

## 2. 当前架构简要

- **连接方式**：OkHttp WebSocket 直连 `ws://host:port` 或 `wss://host:port`（Gateway 的 WebSocket 端口，默认 18789）。
- **发现**：mDNS/DNS-SD（`_moltbot-gw._tcp`） + 手动填写 host/port。
- **协议**：单路双向 JSON 帧：
  - 请求：`{ type: "req", id, method, params }` → 响应：`{ type: "res", id, ok, payload?, error? }`
  - 服务端推送：`{ type: "event", event, payload? }`
  - 关键方法：`connect`（鉴权/握手）、`node.event`、`node.invoke.result` 等；事件：`connect.challenge`、`node.invoke.request` 等。
- **使用方**：`NodeRuntime` 持有两个 `GatewaySession`（operator 与 node），`ChatController` / `TalkModeManager` 等只依赖 `GatewaySession` 的 `request` / `sendNodeEvent` / 回调，不关心传输。

## 3. 方案选型

| 方案 | 描述 | 功能保持 | 服务端改动 |
|------|------|----------|------------|
| **A. 仅聊天走 MQTT** | 与现有 `extensions/mqtt` 一致：Android 连 Broker，发 `messageId`+`text`，收回复 | 仅聊天；无 Node/Canvas/发现等 | 无（沿用现有 MQTT 插件） |
| **B. 完整协议 over MQTT** | 同一套 Gateway JSON 协议（req/res/event）经 MQTT topic 传输 | 全部保留 | 需要 Gateway 侧 MQTT↔内部协议桥接 |

为满足「尽可能保持原有功能和界面交互不变」，采用 **方案 B**。

## 4. 方案 B 详细设计

### 4.1 传输抽象

- 在 `gateway` 包内引入 **传输接口**，使 `GatewaySession` 只依赖该接口，不直接依赖 OkHttp/WebSocket：
  - 接口职责：建立连接、发送单条 JSON、接收单条 JSON（回调）、关闭连接。
- 现有 WebSocket 实现改为该接口的一个实现（**WsGatewayTransport** 或内联在现有 `Connection` 中）。
- 新增 **MqttGatewayTransport**：使用 MQTT 客户端连接 Broker，通过固定 topic 布局收发与当前 WebSocket 相同的 JSON 帧。

这样 `NodeRuntime`、`ChatController`、UI 无需改动，仅替换「连接/传输」实现。

### 4.2 MQTT Topic 与消息格式

- **ClientId**：每台设备唯一（可用 `instanceId` 或 `deviceId`），用于区分不同 Android 客户端，并用于 topic 命名。
- **Topic 建议**（Broker 上）：
  - **请求（Android → Gateway）**：`moltbot/gw/{clientId}/req`  
    - Android 发布；Gateway 端 bridge 订阅。
  - **响应（Gateway → Android）**：`moltbot/gw/{clientId}/res`  
    - Android 订阅；bridge 发布对 `req` 的响应。
  - **事件（Gateway → Android）**：`moltbot/gw/{clientId}/evt`  
    - Android 订阅；bridge 发布服务端事件。
- **消息体**：与现有 WebSocket 完全一致。
  - 请求帧：`{ "type": "req", "id": "<uuid>", "method": "connect"|..., "params": {...} }`
  - 响应帧：`{ "type": "res", "id": "<uuid>", "ok": true|false, "payload": {...}, "error": {...}? }`
  - 事件帧：`{ "type": "event", "event": "connect.challenge"|..., "payload": {...}? }`
- **QoS**：建议请求/响应用 QoS 1，保证至少一次；事件可用 0 或 1，视 Broker 与功耗权衡。

同一 `clientId` 下，operator 与 node 可复用同一套 topic（通过 `connect` 的 `role` 区分），或拆分为 `moltbot/gw/{clientId}/operator/req|res|evt` 与 `moltbot/gw/{clientId}/node/req|res|evt`，由 bridge 与 Android 约定即可。

### 4.3 Gateway 侧 MQTT Bridge 约定

- 当前 Gateway 暴露的是 WebSocket 服务，没有「Gateway 协议 over MQTT」的实现。为支持方案 B，需要 **Gateway 侧** 增加一层桥接（二选一或组合）：
  1. **扩展现有 `extensions/mqtt`**：增加「Gateway bridge」模式——连接同一 Broker，订阅 `moltbot/gw/+/req`，将收到的 JSON 当作虚拟 WebSocket 客户端请求，转交给现有 Gateway 内部协议处理，并把 `res`/`evt` 发布到对应 `res`/`evt` topic。
  2. **独立进程/服务**：订阅上述 topic，与 Gateway 通过本地 WebSocket 或内部 API 通信，逻辑同上。

Android 端不实现 bridge，只按上述 topic 与 JSON 格式收发；bridge 的实现与部署单独进行（可后续迭代）。

### 4.4 Android 端实现要点

- **依赖**：引入 Eclipse Paho Android MQTT 客户端（如 `org.eclipse.paho:org.eclipse.paho.android.service:1.1.1` + `org.eclipse.paho:org.eclipse.paho.client.mqttv3`），或 HiveMQ 等兼容 MQTT 3.1.1 的库。
- **配置**（可沿用/扩展现有 `SecurePrefs`）：
  - **连接模式**：`ws`（当前直连 WebSocket）| `mqtt`（经 Broker）。
  - **MQTT 模式**：Broker URL（`tcp://` / `ssl://` 或 `ws://`/`wss://` 若用 Paho over WebSocket）、用户名、密码、ClientId（可选，默认用 instanceId）、topic 前缀（可选，默认 `moltbot/gw/{clientId}`）。
- **发现与连接**：
  - **MQTT 模式**下：不再使用「Gateway host:port」发现，改为使用「Broker 地址 + 认证」；发现列表可改为「已保存的 Broker 配置」或保留一个「手动 Broker URL」入口。
  - 若希望继续显示「网关名称」，可依赖 bridge 在 `connect` 响应里返回的 `server.name` 等信息，或由用户在设置里给当前 Broker 起别名。
- **双 session**：operator 与 node 各建一条「逻辑连接」：每条对应同一 Broker、同一 clientId 下的一组 topic，但 `connect` 的 `role`/`options` 不同；实现上可以是两个 `MqttGatewayTransport` 实例，或一个 MQTT 连接 + 两套 topic 前缀（见上）。
- **TLS**：Broker 使用 `ssl://` 或 `wss://` 时，沿用系统证书或可选证书 pinning（与现有 GatewayTls 思路一致，按需简化）。

### 4.5 界面与交互保持不变

- **设置页**：
  - 在「连接模式」为 MQTT 时，展示 Broker URL、用户名、密码、ClientId（可编辑或自动）、可选 topic 前缀；可保留「已保存的 Broker」列表或「当前 Broker」显示。
  - 发现列表在 MQTT 模式下可显示为「已配置的 Broker」或隐藏，仅保留手动输入 Broker。
- **聊天 / Canvas / 相机 / 语音 / 状态栏**：无逻辑变更，仍依赖 `NodeRuntime` 暴露的 `operatorSession`/`nodeSession`、状态与 Chat 接口。

## 5. 实施步骤建议

1. **抽象层**  
   - 定义 `GatewayTransport` 接口（connect/disconnect/sendRequest/sendJson、回调 onOpen/onMessage/onClose/onError）。  
   - 将现有 `GatewaySession` 内 WebSocket 逻辑抽成 `WsGatewayTransport`，`GatewaySession` 改为持有 `GatewayTransport` 并驱动重连/鉴权流程。

2. **MQTT 传输**  
   - 实现 `MqttGatewayTransport`：连接 Broker，订阅 `res`/`evt`，发布 `req`；将收到的 payload 转成与 WebSocket 相同的 JSON 回调给 `GatewaySession`。  
   - 处理连接状态、重连、单条请求-响应关联（通过 `id` 匹配），以及 `connect.challenge` 等事件顺序。

3. **配置与连接入口**  
   - `SecurePrefs` 增加连接模式、Broker URL、MQTT 认证与 topic 前缀。  
   - `NodeRuntime` / 连接逻辑：根据模式选择 `WsGatewayTransport` 或 `MqttGatewayTransport`；MQTT 模式下用 Broker 配置而非 host:port 发起连接。

4. **发现与设置 UI**  
   - 设置页根据「连接模式」切换「Gateway 发现 + 手动 host/port」与「Broker URL + MQTT 认证」表单。  
   - 保持现有 Tab/布局风格，仅替换表单字段与保存键。

5. **Gateway Bridge（服务端）**  
   - 单独排期：在 `extensions/mqtt` 或新模块中实现订阅 `moltbot/gw/+/req`、调用现有 Gateway 协议、回写 `res`/`evt` 的 bridge；文档约定 topic 与 JSON 格式，与 Android 对齐。

6. **测试与兼容**  
   - 保留 WebSocket 模式，默认或通过配置切回，便于无 Broker 环境继续使用。  
   - 单元测试：对 `GatewaySession` 使用 mock transport；MQTT 传输可做基于内存 broker 或 mock 的测试。

## 6. 依赖与配置汇总

| 项目 | 内容 |
|------|------|
| 新依赖 | Paho Android MQTT（或等价 MQTT 3.1.1 客户端） |
| 配置项 | 连接模式(ws/mqtt)、brokerUrl、mqttUsername、mqttPassword、mqttClientId、topicPrefix（可选） |
| 兼容 | 保留 ws 模式；MQTT 模式下 discovery 改为「Broker 配置」或隐藏 |

## 7. 风险与备选

- **Bridge 未就绪**：Android 先实现 MQTT 传输与配置，连接时若收不到 `res`/`evt` 会表现为「连接超时」；可先交付 Android 侧，Gateway bridge 后续补齐。
- **降级**：若需先上线「仅聊天 over MQTT」，可再实现一版「仅聊天」的 MQTT 通道（与 miniprogram/Gateway MQTT 插件一致），界面仅保留聊天 + 简单设置，作为方案 A 的独立分支或后续迭代。

---

## 8. 技术评审与改进建议（v1 评审原文）

以下为方案 review 中发现的可能问题与改进建议，实施时建议一并考虑。

### 8.1 connect.challenge 时序（高优先级）

**问题**：当前 WebSocket 下，Gateway 在 **连接建立后立即** 向客户端发送 `connect.challenge`（见 `src/gateway/server/ws-connection.ts`），客户端再带 nonce 发 `connect`。MQTT 无“连接建立”的服务器端事件：Bridge 只有在收到客户端 **发布** 的消息时才知道有客户端存在，因此无法“先发 challenge、再等 connect”。

**改进建议**（三选一或组合）：略（见 v2.0 正文 4.3）。

### 8.2 双 session 与 topic 隔离（高优先级）

**问题**：operator 与 node 复用同一套 topic 会导致 res/evt 混流、无法区分归属。

**改进建议**：明确采用按 role 分 topic（见 v2.0 正文 4.2）。

### 8.3～8.10

其余评审项已并入 v2.0 正文，此处不再重复。
