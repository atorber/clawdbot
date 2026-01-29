# apps/android-mqtt 切换为 MQTT 连接 — 实现方案 v2.0

## 1. 目标与范围

- **目标**：将 `apps/android-mqtt` 与 Gateway 的连接从 **WebSocket** 改为 **MQTT**，**尽可能保持原有功能和界面交互不变**。
- **范围**：
  - 保留：双 session（operator + node）、聊天、Canvas、相机/录屏/短信/定位、语音唤醒、设置页、发现/手动连接等现有能力与 UI。
  - 变更：底层传输由「直连 Gateway 的 WebSocket」改为「经 MQTT Broker 的 MQTT 发布/订阅」。
- **实现范围**：**Android MQTT 客户端**与 **Gateway 侧 MQTT Bridge** 一并实现、一并交付，保证端到端可用。

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

## 4. 方案 B 详细设计（v2.0）

### 4.1 传输抽象

- 在 `gateway` 包内引入 **传输接口**，使 `GatewaySession` 只依赖该接口，不直接依赖 OkHttp/WebSocket：
  - 接口职责：建立连接、发送单条 JSON、接收单条 JSON（回调）、关闭连接。
- 现有 WebSocket 实现改为该接口的一个实现（**WsGatewayTransport** 或内联在现有 `Connection` 中）。
- 新增 **MqttGatewayTransport**：使用 MQTT 客户端连接 Broker，通过固定 topic 布局收发与当前 WebSocket 相同的 JSON 帧。

这样 `NodeRuntime`、`ChatController`、UI 无需改动，仅替换「连接/传输」实现。

### 4.2 MQTT Topic 与消息格式

- **ClientId**：每台设备唯一（可用 `instanceId` 或 `deviceId`），用于区分不同 Android 客户端，并用于 topic 命名。同一设备只使用**一个** MQTT 连接、一个 clientId。
- **Topic 约定（按 role 分 topic，不建议复用）**：  
  operator 与 node 必须使用**两套** topic，避免 res/evt 混流与路由歧义；同一设备一个 MQTT 连接、两个 `MqttGatewayTransport` 实例分别使用下列两套前缀。

  | Role    | 请求（Android → Gateway） | 响应（Gateway → Android） | 事件（Gateway → Android） |
  |---------|----------------------------|----------------------------|----------------------------|
  | operator | `moltbot/gw/{clientId}/operator/req` | `moltbot/gw/{clientId}/operator/res` | `moltbot/gw/{clientId}/operator/evt` |
  | node     | `moltbot/gw/{clientId}/node/req`     | `moltbot/gw/{clientId}/node/res`     | `moltbot/gw/{clientId}/node/evt`     |

  - Android 发布到对应 role 的 `req`；订阅对应 role 的 `res`、`evt`。Bridge 订阅 `moltbot/gw/+/operator/req` 与 `moltbot/gw/+/node/req`，按 topic 将 req 转交 Gateway，并将 res/evt 发布到对应 clientId+role 的 `res`/`evt`。
- **消息体**：与现有 WebSocket 完全一致。
  - 请求帧：`{ "type": "req", "id": "<uuid>", "method": "connect"|..., "params": {...} }`
  - 响应帧：`{ "type": "res", "id": "<uuid>", "ok": true|false, "payload": {...}, "error": {...}? }`
  - 事件帧：`{ "type": "event", "event": "connect.challenge"|..., "payload": {...}? }`
- **QoS**：建议请求/响应用 QoS 1；事件可用 0 或 1，视 Broker 与功耗权衡。
- **请求-响应关联与幂等**：不假设 req/res 严格有序；仅用 `id` 匹配。对同一 `id` 的多次 res 做**幂等**（仅第一次 complete 有效，后续忽略）。Bridge 对同一 req 只发一次 res（若重复发送，Android 幂等处理）。

### 4.3 Gateway 侧 MQTT Bridge 约定

- 当前 Gateway 暴露的是 WebSocket 服务，没有「Gateway 协议 over MQTT」的实现。为支持方案 B，需要 **Gateway 侧** 增加一层桥接（二选一或组合）：
  1. **扩展现有 `extensions/mqtt`**：增加「Gateway bridge」模式——连接同一 Broker，订阅 `moltbot/gw/+/operator/req` 与 `moltbot/gw/+/node/req`，将收到的 JSON 当作虚拟 WebSocket 客户端请求，转交给现有 Gateway 内部协议处理，并把 `res`/`evt` 发布到对应 clientId+role 的 `res`/`evt` topic。
  2. **独立进程/服务**：订阅上述 topic，与 Gateway 通过本地 WebSocket 或内部 API 通信，逻辑同上。

**connect.challenge 时序约定**：  
WebSocket 下 Gateway 在连接建立后**立即**发送 `connect.challenge`，客户端再带 nonce 发 `connect`。MQTT 无“连接建立”的服务器端事件，Bridge 只有在收到客户端发布时才知道客户端存在。采用以下策略之一：

1. **MQTT 视为 loopback（推荐、改动最小）**  
   - Bridge 与 Gateway 约定：来自 MQTT Bridge 的虚拟连接视为“本地/loopback”，**不要求 device nonce**。  
   - Android 流程：连上 Broker、订阅对应 role 的 res/evt 后**直接发** `connect`（device 可不带 nonce 或带空 nonce）；Bridge 转给 Gateway 时标记为 loopback 或由 Gateway 对 Bridge 来源豁免 nonce 校验。  
   - 需在 Gateway 或 Bridge 侧增加来源标记/豁免策略，文档中明确约定。

2. **增加 announce topic（可选）**  
   - 新增 topic：`moltbot/gw/{clientId}/announce`。  
   - 流程：Android 连 Broker → 订阅 res/evt → **仅向 announce 发布一条空或轻量 payload** → Bridge 收到后向对应 role 的 `evt` 发布 `connect.challenge` → Android 收到 challenge 后再向 `req` 发布 `connect`（带 nonce）。  
   - 与现有 WebSocket 语义一致，但多一个 topic、需实现“等 challenge 再 connect”的状态机。

**Bridge 状态与扩展性**：  
Bridge 为**有状态**：每 (clientId, role) 对应至少一条到 Gateway 的 WebSocket（或等效会话）。需考虑连接数上限、心跳与空闲断开、Android 重连后 session 恢复（复用或新建 WebSocket）。若需水平扩展，可约定同一 Broker 上多 Bridge 实例、按 topic 或 clientId 分片（后续迭代）。

### 4.4 Gateway Bridge 实现要点（与 Android 一并实现）

Bridge 与 Android MQTT 客户端**同周期实现**，部署于 Gateway 所在环境，连接同一 Broker 与本地 Gateway WebSocket。

- **放置位置**：在 **`extensions/mqtt`** 中增加「Gateway bridge」模式（新子模块或新入口），与现有 MQTT channel 共用 Broker 连接或独立连接均可；若配置隔离更清晰，可单独建 `extensions/mqtt-gateway-bridge` 包，依赖 `extensions/mqtt` 的 MQTT 客户端与配置能力。
- **配置**：
  - **Broker**：复用 MQTT 插件的 `brokerUrl`、`username`、`password`，或为 bridge 单独配置一段（如 `gatewayBridge.brokerUrl`）。
  - **Gateway WebSocket 地址**：Bridge 需连接本进程或本机 Gateway 的 WebSocket，例如 `ws://127.0.0.1:18789` 或从 Gateway 运行时获取 bind 地址与端口；可配置项如 `gatewayBridge.gatewayWsUrl`（默认 `ws://127.0.0.1:18789`）。
- **流程**：
  1. Bridge 连接 Broker，订阅 `moltbot/gw/+/operator/req`、`moltbot/gw/+/node/req`（MQTT `+` 单层通配）。
  2. 收到某条 req 时，从 topic 解析出 `clientId`、`role`（operator/node）。若该 (clientId, role) 尚无对应 WebSocket，则向 Gateway 发起 WebSocket 连接；**connect.challenge 策略**：采用「MQTT 视为 loopback」——Bridge 在建立 WebSocket 后收到 Gateway 下发的 `connect.challenge` 时**不转发到 MQTT**，在转发该客户端的首条 `connect` 请求时，在 Gateway 侧标记为 loopback 或由 Gateway 对来自 Bridge 的连接豁免 nonce 校验（需在 Gateway 或 Bridge 侧实现豁免逻辑）。
  3. 将 req 的 JSON 原样通过对应 WebSocket 发给 Gateway；收到该 WebSocket 的 `res` 或 `event` 时，按 `id` 或 `event` 原样发布到 `moltbot/gw/{clientId}/{role}/res` 或 `moltbot/gw/{clientId}/{role}/evt`。对同一 req 的 res 只发布一次（幂等由 Android 兜底）。
  4. WebSocket 断开（Gateway 关闭或网络断开）时，可清理该 (clientId, role) 的会话；Android 重连后再次发 req 时，Bridge 重新建立 WebSocket 即可。
- **消息大小**：在发布到 MQTT 前检查 payload 长度，超过约定上限（如 256KB）时向对应 res topic 发布错误响应 `{ type: "res", id, ok: false, error: { code: "PAYLOAD_TOO_LARGE", message: "..." } }`，不转发到 Gateway。
- **依赖与启动**：Bridge 随 Gateway 进程启动（例如在 Gateway 启动完成后拉起 bridge 子模块）；或通过配置开关启用（如 `gatewayBridge.enabled: true`）。需依赖现有 Gateway WebSocket 服务已监听，再建立出向 WebSocket 连接。

### 4.5 消息大小与错误处理

- **单条消息上限**：约定与现有 `extensions/mqtt` 的 `maxMessageSize` 对齐（如 256KB），或与目标 Broker 默认上限一致；在协议或配置中写明推荐值。
- **超出时行为**：Android/Bridge 在发送前检查 payload 大小；超出时**拒绝并返回明确错误**（如 `PAYLOAD_TOO_LARGE`），不假设分片。首版不定义分片协议；若后续需要，可再约定 topic 后缀或分片格式。

### 4.6 Android 端实现要点

- **依赖**：引入 Eclipse Paho Android MQTT 客户端（或 HiveMQ 等兼容 MQTT 3.1.1 的库）。**以实施时选定的稳定版本为准**，建议兼容 minSdk 31 与现有 ProGuard 规则；实施前确认与 AndroidX / minSdk 的兼容性。
- **配置**（可沿用/扩展现有 `SecurePrefs`）：
  - **连接模式**：`ws`（当前直连 WebSocket）| `mqtt`（经 Broker）。
  - **MQTT 模式**：Broker URL（`tcp://` / `ssl://` 或 `ws://`/`wss://`）、用户名、密码、ClientId（可选，默认用 instanceId）、topic 前缀（可选，默认 `moltbot/gw/{clientId}`）。
- **发现与连接**：
  - **MQTT 模式**下：不再使用「Gateway host:port」发现，改为「Broker 地址 + 认证」；发现列表可改为「已保存的 Broker 配置」或保留「手动 Broker URL」入口。
  - 若希望继续显示「网关名称」，可依赖 bridge 在 `connect` 响应里返回的 `server.name` 等信息，或由用户在设置里给当前 Broker 起别名。
- **双 session**：**一个 MQTT 连接 + 两套 topic 前缀（operator / node）**。两个 `MqttGatewayTransport` 实例共享同一 MQTT 连接，分别使用 operator 与 node 的 req/res/evt topic；`connect` 的 `role`/`options` 各不同。
- **生命周期**：MQTT 连接的生命周期与 **NodeForegroundService** 对齐（前台时建连/保活，断开时通知与重试策略一致）。若使用 Paho Android Service，需确认其与 Foreground Service 的配合方式，避免双通道保活或冲突。可选：在测试中增加「后台/Doze 下断线重连与通知」的验证项。
- **TLS**：Broker 使用 `ssl://` 或 `wss://` 时，沿用系统证书或可选证书 pinning（与现有 GatewayTls 思路一致，按需简化）。

### 4.7 界面与交互保持不变

- **设置页**：
  - 在「连接模式」为 MQTT 时，展示 Broker URL、用户名、密码、ClientId（可编辑或自动）、可选 topic 前缀；可保留「已保存的 Broker」列表或「当前 Broker」显示。
  - 发现列表在 MQTT 模式下可显示为「已配置的 Broker」或隐藏，仅保留手动输入 Broker。
- **聊天 / Canvas / 相机 / 语音 / 状态栏**：无逻辑变更，仍依赖 `NodeRuntime` 暴露的 `operatorSession`/`nodeSession`、状态与 Chat 接口。

## 5. 实施步骤建议

1. **抽象层**  
   - 定义 `GatewayTransport` 接口（connect/disconnect/sendRequest/sendJson、回调 onOpen/onMessage/onClose/onError）。  
   - 将现有 `GatewaySession` 内 WebSocket 逻辑抽成 `WsGatewayTransport`，`GatewaySession` 改为持有 `GatewayTransport` 并驱动重连/鉴权流程。

2. **MQTT 传输**  
   - 实现 `MqttGatewayTransport`：连接 Broker，按 role 订阅对应 `res`/`evt`、发布到对应 `req`；将收到的 payload 转成与 WebSocket 相同的 JSON 回调给 `GatewaySession`。  
   - 处理连接状态、重连、单条请求-响应关联（**仅用 id 匹配、res 幂等去重**），以及 **connect.challenge 采用 4.3 约定策略**（loopback 或 announce）。

3. **配置与连接入口**  
   - `SecurePrefs` 增加连接模式、Broker URL、MQTT 认证与 topic 前缀。  
   - `NodeRuntime` / 连接逻辑：根据模式选择 `WsGatewayTransport` 或 `MqttGatewayTransport`；MQTT 模式下用 Broker 配置而非 host:port 发起连接。

4. **发现与设置 UI**  
   - 设置页根据「连接模式」切换「Gateway 发现 + 手动 host/port」与「Broker URL + MQTT 认证」表单。  
   - 保持现有 Tab/布局风格，仅替换表单字段与保存键。

5. **Gateway Bridge（服务端，与 Android 一并实现）**  
   - 在 `extensions/mqtt`（或新包 `mqtt-gateway-bridge`）中实现 Bridge：连接 Broker，订阅 `moltbot/gw/+/operator/req`、`moltbot/gw/+/node/req`；为每个 (clientId, role) 建立/复用到本地 Gateway 的 WebSocket；将 req 转发给 Gateway，将收到的 res/event 发布到对应 `res`/`evt` topic。  
   - 实现 connect.challenge 的「loopback」策略：Bridge 侧收到 Gateway 的 challenge 不转发到 MQTT；转发首条 connect 时由 Gateway 或 Bridge 标记为 loopback 并豁免 nonce 校验。  
   - 配置：Broker 连接信息、Gateway WebSocket URL（默认 `ws://127.0.0.1:18789`）、可选开关启用 bridge。  
   - 随 Gateway 启动或通过配置启用；与 Android 端同周期交付。

6. **测试与兼容**  
   - 保留 WebSocket 模式，默认或通过配置切回，便于无 Broker 环境继续使用。  
   - **单元测试**：以 **mock GatewayTransport** 为主，对 `GatewaySession` 的 req/res/event 逻辑做单测；**MqttGatewayTransport** 可单独用 mock（或内存中模拟的对端）验证序列化与 id 匹配。**单元测试不依赖真实 MQTT Broker**。  
   - 集成/端到端测试：Android + Bridge + 真实 Broker（如 Docker 内 Mosquitto）+ 本机 Gateway，验证完整 MQTT 连接、connect、聊天、node.invoke 等流程。

## 6. 依赖与配置汇总

| 项目 | 内容 |
|------|------|
| 新依赖 | Paho Android MQTT（或等价 MQTT 3.1.1 客户端）；**以实施时选定的稳定版本为准**，建议兼容 minSdk 31 与 ProGuard |
| 配置项 | 连接模式(ws/mqtt)、brokerUrl、mqttUsername、mqttPassword、mqttClientId、topicPrefix（可选） |
| 兼容 | 保留 ws 模式；MQTT 模式下 discovery 改为「Broker 配置」或隐藏 |

## 7. 风险与备选

- **交付顺序**：Android 与 Bridge 同周期实现；若需分阶段验证，可先在本机用 Broker + Bridge + Android 做端到端联调，再对外发布。
- **降级**：若需先上线「仅聊天 over MQTT」，可再实现一版「仅聊天」的 MQTT 通道（与 miniprogram/Gateway MQTT 插件一致），界面仅保留聊天 + 简单设置，作为方案 A 的独立分支或后续迭代。
- **安全与可见性**：MQTT topic 名与 clientId 对能访问同一 Broker 的其它客户端可见。Broker 应配置 **ACL**，限制客户端仅能订阅/发布自身 `moltbot/gw/{clientId}/...` 的 topic；生产环境使用 TLS（ssl:///wss://）与强认证。

---

## 版本历史

- **v2.0**：按技术评审结论修订。主要变更：operator/node 按 role 分 topic（不建议复用）；connect.challenge 约定（loopback 或 announce）；请求-响应幂等与消息大小约定；Bridge 状态与扩展性；Android 与 NodeForegroundService 生命周期；依赖与测试策略澄清；安全/ACL 提醒。**Gateway Bridge 与 Android 一并实现、一并交付**；新增 4.4 Gateway Bridge 实现要点与实施步骤 5 的 Bridge 实现说明。
- **v1**：初版方案 + 技术评审建议。存档见 [MQTT-实现方案-v1-存档.md](./MQTT-实现方案-v1-存档.md)。
