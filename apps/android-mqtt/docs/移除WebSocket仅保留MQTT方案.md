# android-mqtt：移除 WebSocket 发现，仅保留 MQTT 连接方案

## 1. 目标与原则

- **目标**：从 `apps/android-mqtt` 中移除所有 **WebSocket 发现与直连** 相关功能，**仅保留 MQTT** 作为与 Gateway 的连接方式。
- **原则**：MQTT 仅作为「传输层替换」——与 Gateway 的交互逻辑（协议、会话、鉴权、事件、invoke）保持不变，仅底层由 WebSocket 换成 MQTT（经 Broker + Bridge）。

## 2. 当前实现概览

### 2.1 架构关系

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  UI (SettingsSheet, RootScreen)                                              │
│  - 连接模式: ws / mqtt (Radio)                                               │
│  - ws: 已发现网关列表 + 手动 host:port + TLS                                  │
│  - mqtt: Broker URL + 用户名/密码/ClientId + 连接按钮                         │
└─────────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  NodeRuntime / MainViewModel                                                 │
│  - connectionMode (ws|mqtt), gateways (发现列表), manualHost/Port, mqtt*      │
│  - connect(endpoint?) : endpoint==null 且 mqtt → MQTT 连接；否则 WS 连接     │
│  - 自动连接: mqtt 时用 brokerUrl；ws 时用 lastDiscoveredStableId 或 manual    │
└─────────────────────────────────────────────────────────────────────────────┘
         │                                              │
         │ (ws)                                         │ (mqtt)
         ▼                                              ▼
┌──────────────────────────┐              ┌────────────────────────────────────┐
│  GatewayDiscovery        │              │  MqttGatewayConnection              │
│  - NSD (mDNS) 本地发现   │              │  - 单连接，双 role (operator/node)  │
│  - DNS-SD 广域网发现     │              │  - topic: moltbot/gw/{clientId}/    │
│  - 输出: List<Endpoint>  │              │    {role}/req|res|evt              │
└──────────────────────────┘              └────────────────────────────────────┘
         │                                              │
         ▼                                              ▼
┌──────────────────────────┐              ┌────────────────────────────────────┐
│  GatewayConnectionTarget │              │  GatewayConnectionTarget           │
│  .Ws(endpoint, tls)      │              │  .Mqtt(connection, role)          │
└──────────────────────────┘              └────────────────────────────────────┘
         │                                              │
         ▼                                              ▼
┌──────────────────────────┐              ┌────────────────────────────────────┐
│  WsGatewayTransport     │              │  MqttGatewayConnection.RoleTransport │
│  - OkHttp WebSocket      │              │  - 实现 GatewayTransport            │
│  - ws(s)://host:port     │              │  - skipConnectChallenge=true      │
└──────────────────────────┘              └────────────────────────────────────┘
         │                                              │
         └──────────────────────┬───────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  GatewaySession（最小改动：仅删 Ws 分支，见 5.2）                              │
│  - 只依赖 GatewayTransport 接口                                               │
│  - connect(target) → Connection(transport) → open/send/onMessage              │
│  - 协议: req/res/event，connect 握手、device auth、node.invoke 等              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 与 Gateway 的交互逻辑（保持不变）

- **协议**：同一套 JSON 帧（req/res/event），版本 `GATEWAY_PROTOCOL_VERSION = 3`。
- **双会话**：operator（聊天、配置、voicewake 等）+ node（node.invoke、canvas、camera、location、sms 等），两路 `GatewaySession`，共享同一 MQTT 连接（两个 role 的 topic）。
- **鉴权**：token/password + device 签名（connect 参数），与传输无关。
- **connect.challenge**：WS 时由 Gateway 先发 challenge；MQTT 时 `skipConnectChallenge=true`，Bridge 侧按「loopback」处理，不向 App 转发 challenge。
- **Canvas / A2UI**：`currentCanvasHostUrl()` 来自 connect 响应；MQTT 时 `endpointForCanvas == null`，仍用响应里的 URL，无发现列表的 fallback。

## 3. 需移除的内容（WebSocket 发现相关）

| 类别 | 项 | 说明 |
|------|---|------|
| **发现** | `GatewayDiscovery` | 整个类：NSD + 广域 DNS-SD，输出 `gateways: StateFlow<List<GatewayEndpoint>>` |
| **发现** | `BonjourEscapes` | 仅被 GatewayDiscovery 使用，可删 |
| **传输** | `WsGatewayTransport` | WebSocket 传输实现 |
| **传输** | `GatewayConnectionTarget.Ws` | 仅保留 `GatewayConnectionTarget.Mqtt`（或简化为仅 MQTT 一种 target） |
| **端点/TLS** | `GatewayEndpoint` | 发现/手动 host:port 用；仅 MQTT 后不再需要（canvas URL 来自 connect 响应） |
| **TLS** | `GatewayTls` / `GatewayTlsParams` | WS 直连时的证书 pinning；MQTT 不需要 |
| **配置** | `connectionMode` (ws/mqtt) | 仅 MQTT 后固定为 MQTT，可移除该选项 |
| **配置** | `manualEnabled` / `manualHost` / `manualPort` / `manualTls` | 手动 WebSocket 网关，仅 MQTT 后删除 |
| **配置** | `lastDiscoveredStableId` | 用于 ws 模式自动连接上次发现的网关，仅 MQTT 后删除 |
| **配置** | TLS 指纹存储 | `loadGatewayTlsFingerprint` / `saveGatewayTlsFingerprint` 仅 WS 用，删除即可；旧 prefs 中 `gateway.tls.*` 不读不写，不导致崩溃（可选后续按需清理） |
| **UI** | 连接模式单选 | 「WebSocket（发现）」/「MQTT」→ 只保留 MQTT 配置区 |
| **UI** | 「已发现网关」/「其他网关」列表 | 发现列表及「连接」按钮 |
| **UI** | 发现状态文案 | `discoveryStatusText`、`gatewayDiscoveryFooterText` |
| **UI** | 高级 - 手动网关 | host/port/TLS 开关（WS 用） |
| **运行时** | `NodeRuntime` 中 discovery、gateways、ws 分支 | 创建/持有 `GatewayDiscovery`、按 `connectionMode` 分支、`connect(endpoint)` 的 WS 路径、`resolveTlsParams`、`connectedEndpoint` |
| **依赖** | OkHttp | 仅被 `WsGatewayTransport` 使用 |
| **依赖** | dnsjava | 仅被 `GatewayDiscovery` 用于广域 DNS-SD |
| **测试** | `BonjourEscapesTest` | 对应 `BonjourEscapes`，可删 |

## 4. 需保留/调整的内容（仅 MQTT）

| 类别 | 项 | 调整说明 |
|------|---|----------|
| **传输接口** | `GatewayTransport` | 保留，`MqttGatewayConnection.RoleTransport` 已实现 |
| **传输** | `MqttGatewayConnection` | 保留，逻辑不变 |
| **目标** | `GatewayConnectionTarget` | 可保留密封类仅含 `Mqtt(connection, role)`，或改为直接传 `MqttGatewayConnection`+role，不再需要 `Ws` |
| **会话** | `GatewaySession` | **最小改动**：仅删除 Ws 分支、移除对 `GatewayEndpoint` 的引用；可选移除 `endpointForCanvas` 并简化 `normalizeCanvasHostUrl(raw)`（见 5.2）。其余逻辑不变，只依赖 `GatewayTransport`。 |
| **协议** | `GatewayProtocol` (GATEWAY_PROTOCOL_VERSION) | 保留 |
| **鉴权/身份** | `DeviceIdentityStore` / `DeviceAuthStore` | 保留，connect 时仍需要 |
| **配置** | `mqttBrokerUrl` / `mqttUsername` / `mqttPassword` / `mqttClientId` | 保留，默认连接模式即 MQTT |
| **自动连接** | 仅当 `mqttBrokerUrl` 非空时自动 `connect(null)` | 保留；移除对 `lastDiscoveredStableId`、manual、gateways 的自动连接 |
| **UI** | 网关区域 | 仅保留：状态、服务器/地址（连接后）、断开、**高级** 里仅 MQTT 配置（Broker、用户名、密码、ClientId、连接按钮） |
| **ViewModel** | `gateways` / `discoveryStatusText` / `manual*` / `connectionMode` | 移除；`mqttConnectionState`、`mqtt*` 保留 |

## 5. 实现步骤建议

1. **删除发现与 WS 传输**
   - 删除 `GatewayDiscovery.kt`、`BonjourEscapes.kt`、`WsGatewayTransport.kt`、`GatewayTls.kt`。
   - 删除 `GatewayEndpoint.kt`（或仅保留若别处仍有引用；当前仅 WS/发现用）。
   - 删除测试 `BonjourEscapesTest.kt`。

2. **简化连接目标与 GatewaySession 最小改动**
   - `GatewaySession.connectOnce`：仅处理 `GatewayConnectionTarget.Mqtt`（或去掉密封类，直接传 MQTT connection + role）；删除 `GatewayConnectionTarget.Ws` 分支及对 `WsGatewayTransport`、`GatewayEndpoint` 的引用。
   - 若彻底删除 `GatewayEndpoint`：移除 `Connection` 的 `endpointForCanvas` 参数，将 `normalizeCanvasHostUrl(raw, endpoint)` 简化为 `normalizeCanvasHostUrl(raw)`，仅按 `raw` 与 loopback 处理（详见 9.3（1））。
   - 删除 `GatewayConnectionTarget.Ws` 及所有 `GatewayConnectionTarget.Ws` 的构造与分支。

3. **NodeRuntime**
   - 移除 `GatewayDiscovery` 实例及 `gateways`、`discoveryStatusText` 的暴露。
   - 移除 `connectionMode`、`manualEnabled`、`manualHost`、`manualPort`、`manualTls`、`lastDiscoveredStableId` 的读取与分支。
   - `connect(endpoint: GatewayEndpoint?)` 改为无参或仅 `connect()`：只建 MQTT 连接（Broker URL 等从 prefs 读）；删除 `connectedEndpoint`、`resolveTlsParams`、所有 `GatewayConnectionTarget.Ws` 与 `GatewayEndpoint` 相关逻辑。
   - 自动连接：仅当 `mqttBrokerUrl` 非空时执行一次自动 `connect()`，不再依赖 gateways/manual/lastDiscoveredStableId。
   - `refreshGatewayConnection`：仅调用 `connect()`（MQTT）并 `reconnect()` 两个 session。
   - `connectManual`：仅校验 `mqttBrokerUrl` 非空后调用 `connect()`。

4. **SecurePrefs**
   - 移除 `connectionMode`、`manualEnabled`、`manualHost`、`manualPort`、`manualTls`、`lastDiscoveredStableId` 的存储与 StateFlow。
   - 删除 `loadGatewayTlsFingerprint`/`saveGatewayTlsFingerprint`。旧 prefs 中已存在的 `gateway.tls.*` 键不读不写即可，无需主动迁移或删除，不会导致崩溃；若希望清理，可在后续版本用 `prefs.remove(key)` 按需清理。
   - 移除 `setConnectionMode`、`setManualEnabled`、`setManualHost`、`setManualPort`、`setManualTls`、`setLastDiscoveredStableId`。

5. **MainViewModel**
   - 移除 `gateways`、`discoveryStatusText`、`manualEnabled`、`manualHost`、`manualPort`、`manualTls`、`connectionMode` 的暴露。
   - 移除 `setConnectionMode`、`setManualEnabled`、`setManualHost`、`setManualPort`、`setManualTls`。
   - 保留 `setMqttBrokerUrl` 等 MQTT 配置与 `connect`/`connectManual`/`disconnect`（签名可简化）。

6. **UI（SettingsSheet）**
   - 网关区块：删除「连接模式」单选、发现列表、「已发现网关」/「其他网关」、发现 footer。
   - 高级：删除「使用手动网关」及 host/port/TLS；仅保留 MQTT 状态与 Broker/用户名/密码/ClientId/「连接 (MQTT)」。
   - 不再根据 `connectionMode` 切换 UI，仅展示 MQTT 相关项。

7. **RootScreen / StatusPill**
   - 移除对 `connectionMode` 的依赖；MQTT 状态可直接用 `mqttConnectionState`（或保留现有 `mqttStatus` 逻辑，因为仅 MQTT 时始终显示 MQTT 状态）。

8. **依赖**
   - `build.gradle.kts`：移除 `okhttp`、`dnsjava` 依赖。
   - 移除后需验证 `./gradlew :app:assembleDebug` 通过；若有其他模块间接依赖 OkHttp，需一并处理。

9. **调用点与 API 变更**
   - 实施后下列调用点必须与新区 API 一致：

   | 位置 | 当前 | 变更后 |
   |------|------|--------|
   | `NodeRuntime.connect(endpoint?)` | 有参，内部按 mqtt/ws 分支 | 无参 `connect()`，仅从 prefs 读 MQTT 配置并建 MQTT 连接。 |
   | `NodeRuntime.refreshGatewayConnection()` | 若 mqtt 则 `connect(null)`，否则 `connect(connectedEndpoint)` | 仅调用 `connect()` 与两 session 的 `reconnect()`。 |
   | `NodeRuntime.connectManual()` | mqtt 时 `connect(null)`，ws 时 `connect(GatewayEndpoint.manual(...))` | 仅校验 `mqttBrokerUrl` 非空后调用 `connect()`。 |
   | `MainViewModel.connect(endpoint)` | 转发 `runtime.connect(endpoint)` | 删除；或改为无参 `connect()` 转发 `runtime.connect()`。 |
   | `SettingsSheet` 发现列表「连接」按钮 | `viewModel.connect(gateway)` | 整块删除（发现列表移除）。 |
   | `SettingsSheet` 高级「连接 (MQTT)」/ 手动「连接」 | `viewModel.connectManual()` | 保留 `connectManual()`，其内部仅调用 `connect()`。 |
   | `RootScreen` / `StatusPill` | 依赖 `connectionMode` 决定是否显示 MQTT 状态 | 移除对 `connectionMode` 的依赖，始终按 `mqttConnectionState` 显示。 |

10. **README / 文档**
   - 更新 README、README-CN：仅描述 MQTT 连接方式，删除 WebSocket/发现/手动网关说明。

## 6. 当前实现中已满足「仅替换传输」的点

- **GatewaySession** 已完全基于 `GatewayTransport` 接口，无 WebSocket 专有逻辑；删除 WS 后需做最小改动（见 5.2），其余逻辑不变。
- **MqttGatewayConnection.RoleTransport** 正确实现 `open/send/onMessage/onClose`，且 `skipConnectChallenge=true`，与 Bridge 的 loopback 策略一致。
- **协议与鉴权**：connect 参数、device 签名、token 存储与传输无关，保留即可。
- **双 session（operator + node）**：同一 `MqttGatewayConnection`、不同 role topic，行为与方案文档一致。

## 7. 存在的问题与风险

| 问题 | 说明 | 建议 |
|------|------|------|
| **旧用户迁移** | 此前使用 ws 或 manual 的用户，升级后无「连接模式」选择，必须配置 MQTT Broker。 | 在设置或首次启动提示「请配置 MQTT Broker 地址」；可选：若检测到旧有 manual/ws 配置，在 UI 提示一次迁移说明。 |
| **默认连接行为** | 当前默认 `connectionMode = "ws"`，移除后仅 MQTT，未配置 Broker 时不会自动连接。 | 保持「仅当 Broker URL 非空时自动连接」即可。 |
| **GatewayEndpoint 的其它引用** | 除发现/WS 外，`GatewayEndpoint` 是否被 GatewaySession 的 canvas URL 等使用？ | 已确认：`endpointForCanvas` 仅 WS 路径传入 endpoint；MQTT 时为 null，canvas URL 完全来自 connect 响应。删除 WS 后可直接删除 `GatewayEndpoint`。 |
| **MainViewModel.connect(gateway)** | 当前 `connect(GatewayEndpoint?)` 既用于「选网关连接」又用于「MQTT 连接(null)」。 | 改为无参 `connect()`，内部仅从 prefs 取 MQTT 配置并建 MQTT 连接；删除所有 `connect(gateway)` 的网关参数。 |
| **依赖 OkHttp 的其它模块** | 仅 grep 显示只有 WsGatewayTransport 使用 OkHttp。 | 移除 WS 后删除 OkHttp 依赖；移除后验证 `./gradlew :app:assembleDebug` 通过；若未来有 HTTP 需求再单独加。 |
| **BonjourEscapes 测试** | 仅测试 BonjourEscapes。 | 随 BonjourEscapes 删除而删除该测试类。 |
| **单元测试** | 除删除 `BonjourEscapesTest` 外，GatewaySession、NodeRuntime 的改动可能影响现有逻辑。 | 实施后跑全量 `./gradlew :app:testDebugUnitTest`，确认无因删除类型/方法导致的编译或运行时错误；若有基于 mock transport 的 Session 单测，需适配仅 MQTT 的 target 类型。 |
| **Gateway 依赖** | 仅 MQTT 时，必须依赖 Gateway 侧 MQTT Bridge 与 Broker。 | 在 README/文档 中明确「需先启动 Gateway 并启用 MQTT 扩展的 Gateway Bridge」，与现有 `docs/MQTT-实现方案.md` 一致。 |

## 8. 验收要点

- 仅存在 MQTT 一种连接方式；设置中无「WebSocket（发现）」、无发现列表、无手动 host/port/TLS。
- 配置 Broker URL（及可选用户名/密码/ClientId）后，连接、断开、重连行为与当前 MQTT 模式一致。
- 与 Gateway 的交互不变：聊天、node.invoke（canvas/camera/location/sms 等）、voicewake、A2UI、会话与鉴权均通过现有 GatewaySession + MQTT 传输完成。
- 依赖中无 `okhttp`、`dnsjava`；无 `GatewayDiscovery`、`WsGatewayTransport`、`GatewayEndpoint`、`GatewayTls` 的代码引用。
- 文档与 README 已更新为「仅 MQTT」说明。
- **E2E 回归**：执行一次完整 E2E（Broker + Bridge + Gateway），覆盖 operator 与 node 双会话、connect、聊天、至少一种 node.invoke（如 canvas.snapshot）、断开与重连。

完成以上修改后，android-mqtt 将只通过 MQTT 连接 Gateway，且与 Gateway 的交互逻辑保持不变，仅传输层由 WebSocket 改为 MQTT。

---

## 9. 技术评审

### 9.1 结论与建议

**结论**：方案目标清晰、移除/保留边界正确，与当前代码结构一致；实现步骤可执行。评审中的修正与补充已并入正文（§4 GatewaySession 最小改动、§5.2/5.4/5.8/5.9、§7 风险与测试、§8 E2E 验收）。

**建议**：按正文 §5 步骤实施；旧配置迁移与文档更新按 §7、§5.9（调用点与 API 变更）执行；实施前将 9.3（1）的 GatewaySession 改动方式（A 或 B）定稿。

---

### 9.2 方案完整性

| 评审项 | 结论 | 说明 |
|--------|------|------|
| 移除清单与代码一致 | 通过 | grep 验证：GatewayDiscovery、BonjourEscapes、WsGatewayTransport、GatewayTls、GatewayEndpoint、connectionMode、manual*、lastDiscoveredStableId、gateways、discoveryStatusText 的引用均已在方案 3/5 中覆盖。 |
| 保留/调整与依赖关系 | 通过 | GatewayTransport、MqttGatewayConnection、GatewaySession、DeviceIdentityStore/DeviceAuthStore、MQTT 配置与自动连接逻辑的保留描述正确。 |
| 调用点无遗漏 | 通过 | 已并入 5.9（调用点与 API 变更）。 |

---

### 9.3 修正与补充

**（1）GatewaySession 并非「完全不改」**

- 文档 4、5、6 多处写「GatewaySession 不改」。实际删除 WS 后，`GatewaySession` 仍需**最小改动**：
  - `connectOnce`：删除 `is GatewayConnectionTarget.Ws` 分支及对 `WsGatewayTransport`、`t.endpoint` 的引用；仅保留 `is GatewayConnectionTarget.Mqtt` 分支。
  - `Connection(endpointForCanvas: GatewayEndpoint?)`：MQTT 时 `endpointForCanvas` 恒为 `null`。可选两种做法：  
    **A)** 保留参数，仅在 `connectOnce` 中恒传 `null`（实现量小，但保留对 `GatewayEndpoint` 类型的依赖，若删除 `GatewayEndpoint` 则需改签名）；  
    **B)** 移除 `endpointForCanvas` 参数，并简化 `normalizeCanvasHostUrl(raw: String?, endpoint: GatewayEndpoint?)` 为 `normalizeCanvasHostUrl(raw: String?)`，仅根据 `raw` 与 loopback 判断，不再使用 endpoint 的 tailnetDns/lanHost/canvasPort 回退（推荐，便于彻底删除 `GatewayEndpoint`）。
  - `awaitConnectNonce()` 仅在 `endpointForCanvas != null` 时等待 challenge；MQTT 时恒为 null，行为已符合预期，无需改逻辑。
- **建议**：在 5.2 中明确「GatewaySession 最小改动」——删除 Ws 分支；若采用 B，则移除 `endpointForCanvas` 并简化 `normalizeCanvasHostUrl`，以便删除 `GatewayEndpoint`。

**（2）SecurePrefs 中旧 key 的兼容**

- 方案 3 建议 TLS 指纹存储「可删或保留键兼容」。移除 `loadGatewayTlsFingerprint`/`saveGatewayTlsFingerprint` 后，旧 prefs 里已存在的 `gateway.tls.*` 键不会被读取或写入，不会导致崩溃；仅遗留无用数据。
- **建议**：在 5.4 或 7 中注明：不读不写即可，无需主动迁移或删除旧 key；若希望清理，可在后续版本用 `prefs.remove(key)` 按需清理。

**（3）依赖 OkHttp 的最终确认**

- 当前仅 `WsGatewayTransport` 使用 `okhttp`（WebSocket + TLS）。chat/voice 等未直接使用 OkHttp。
- **建议**：维持「移除 WS 后删除 OkHttp 依赖」；若 CI/构建中有其他模块间接依赖 OkHttp，移除后需验证 `./gradlew :app:assembleDebug` 通过。

---

### 9.4 调用点与 API 变更（已并入 5.9）

实施后下列调用点必须与新区 API 一致；正文 5.9 已列出完整表格。

| 位置 | 当前 | 变更后 |
|------|------|--------|
| `NodeRuntime.connect(endpoint: GatewayEndpoint?)` | 有参，内部按 mqtt/ws 分支 | 改为无参 `connect()`，仅从 prefs 读 MQTT 配置并建 MQTT 连接。 |
| `NodeRuntime.refreshGatewayConnection()` | 若 mqtt 则 `connect(null)`，否则 `connect(connectedEndpoint)` | 仅调用 `connect()` 与两 session 的 `reconnect()`。 |
| `NodeRuntime.connectManual()` | mqtt 时 `connect(null)`，ws 时 `connect(GatewayEndpoint.manual(...))` | 仅校验 `mqttBrokerUrl` 非空后调用 `connect()`。 |
| `MainViewModel.connect(endpoint: GatewayEndpoint)` | 转发 `runtime.connect(endpoint)` | 删除；或改为无参 `connect()` 转发 `runtime.connect()`。 |
| `SettingsSheet` 发现列表「连接」按钮 | `viewModel.connect(gateway)` | 整块删除（发现列表移除）。 |
| `SettingsSheet` 高级「连接 (MQTT)」/ 手动「连接」 | `viewModel.connectManual()` | 保留 `connectManual()`，其内部仅调用 `connect()`（见上）。 |
| `RootScreen` / `StatusPill` | 依赖 `connectionMode` 决定是否显示 MQTT 状态 | 移除对 `connectionMode` 的依赖，始终按 `mqttConnectionState` 显示（仅 MQTT 一种方式）。 |

---

### 9.5 风险与测试补充（已并入第 7、8 节）

| 风险/测试项 | 说明 | 建议 |
|-------------|------|------|
| **单元测试** | 除删除 `BonjourEscapesTest` 外，无其他直接依赖 Discovery/WS 的单元测试；`GatewaySession`、`NodeRuntime` 的改动可能影响现有逻辑。 | 实施后跑全量 `./gradlew :app:testDebugUnitTest`，重点确认无因删除类型/方法导致的编译或运行时错误；若有基于 mock transport 的 Session 单测，需适配仅 MQTT 的 target 类型。 |
| **回归场景** | 仅 MQTT 路径：配置 Broker → 连接 → 聊天 / node.invoke / canvas / voicewake / 断开 / 重连。 | 在 8. 验收要点 中增加：执行一次完整 E2E（Broker + Bridge + Gateway），覆盖 operator 与 node 双会话、connect、聊天、至少一种 node.invoke（如 canvas.snapshot）、断开与重连。 |
| **旧配置迁移** | 已存 `gateway.connectionMode` 为 `"ws"` 或存在 manual 配置的用户，升级后无 UI 入口。 | 与 7 一致：首次进入设置时若检测到 `connectionMode == "ws"` 或 manual 曾启用，可弹一次说明「请配置 MQTT Broker 地址」；不在方案中强制清空旧 key，避免破坏未升级的备份恢复。 |
| **Gateway 依赖** | 仅 MQTT 时，必须依赖 Gateway 侧 MQTT Bridge 与 Broker。 | 在 README/文档 中明确「需先启动 Gateway 并启用 MQTT 扩展的 Gateway Bridge」，与现有 `docs/MQTT-实现方案.md` 一致。 |

---

### 9.6 与仓库规范的一致性

- **命名与文档**：方案中 Moltbot/Android/网关/MQTT 等命名与 AGENTS.md、现有 MQTT 方案文档一致；未引入新品牌词。
- **文档链接**：若 README 中保留或引用 `docs.molt.bot`，应继续使用完整 URL；本方案主要影响 `apps/android-mqtt` 的 README/README-CN，未强制要求改主站文档。
- **测试**：符合「colocated `*.test.ts`」思路在 Android 上为 `*Test.kt`；删除 BonjourEscapes 同时删除对应测试，合理。

---

### 9.7 评审小结

- **可实施性**：高。按 §5 的步骤执行即可，5.2（GatewaySession 最小改动）、5.9（调用点与 API 变更）、7（风险与测试）、8（E2E 验收）已并入正文。
- **风险**：低。主要风险为旧用户迁移体验与 E2E 回归，已通过 §7、§8 覆盖。
- **建议**：实施前将 9.3（1）的 GatewaySession 改动方式（A 或 B）定稿，并确认 5.9 中所有调用点在分支/PR 中均有对应修改与自测。
