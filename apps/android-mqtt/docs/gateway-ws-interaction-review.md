# apps/android-mqtt 与 Gateway 数据交互规范 Review

参考 **apps/android**（WebSocket 直连 Gateway）的交互逻辑，对 **apps/android-mqtt**（经 MQTT + Bridge 转 WS）的协议实现做对照检查。

---

## 1. 协议与帧格式（与 apps/android 一致）

| 项目 | apps/android (WS) | apps/android-mqtt (MQTT→Bridge→WS) | 结论 |
|------|-------------------|-----------------------------------|------|
| 协议版本 | `GATEWAY_PROTOCOL_VERSION = 3` | `GatewayProtocol.kt` 同 | ✅ |
| 请求帧 req | `{ type: "req", id, method, params? }` | `Connection.request()` 同 | ✅ |
| 响应帧 res | `{ type: "res", id, ok, payload?, error? }` | `handleResponse()` 解析一致 | ✅ |
| 事件帧 event | `{ type: "event", event, payload?, payloadJSON?, seq? }` | `handleEvent()` 解析一致 | ✅ |

---

## 2. connect 握手

### 2.1 connect 请求 params（buildConnectParams）

两边字段一致：

- `minProtocol` / `maxProtocol` = 3  
- `client`: id, displayName, version, platform, mode, instanceId, deviceFamily, modelIdentifier  
- `caps`, `commands`, `permissions`, `role`, `scopes`  
- `auth`: token 或 password  
- `device`: id, publicKey, signature, signedAt, nonce?（与 buildDeviceAuthPayload 一致）  
- `locale`, `userAgent`  

✅ **android-mqtt 符合**

### 2.2 connect.challenge（nonce）

- **apps/android**：非 loopback 时 `awaitConnectNonce()` 等 Gateway 发 `connect.challenge`，取 `nonce` 再发 connect。  
- **android-mqtt**：`GatewayTransport.skipConnectChallenge = true`（MqttGatewayConnection），不等待 challenge，nonce 传 null；Bridge 连的是 `ws://127.0.0.1`，Gateway 对本地连接不要求 challenge。  

✅ **符合预期**（MQTT 场景下由 Bridge 连本地 WS，无需设备端 challenge）

### 2.3 connect 响应解析（sendConnect 内）

两边均从 connect res 的 payload 中取：

- `server.host` → serverName  
- `auth.deviceToken` / `auth.role` → 存 DeviceAuthStore  
- `canvasHostUrl` → normalize 后存  
- `snapshot.sessionDefaults.mainSessionKey` → mainSessionKey  
- 然后 `onConnected(serverName, remoteAddress, mainSessionKey)`  

✅ **android-mqtt 符合**

### 2.4 设备认证 payload（buildDeviceAuthPayload）

格式一致：`version|deviceId|clientId|clientMode|role|scopeString|signedAtMs|authToken`，若有 nonce 则追加 `|nonce`；v1/v2 与 nonce 是否为空一致。

✅ **android-mqtt 符合**

---

## 3. 消息处理

### 3.1 handleResponse（res）

- 从 `frame["id"]`, `frame["ok"]`, `frame["payload"]`（toString 作 payloadJson）, `frame["error"]`（code, message）解析。  
- `pending.remove(id)?.complete(RpcResponse(...))`。  

✅ **android-mqtt 与 apps/android 一致**

### 3.2 handleEvent（event）

- `payloadJson` = `frame["payload"]?.toString() ?: frame["payloadJSON"].asStringOrNull()`。  
- `connect.challenge`：提取 nonce，complete `connectNonceDeferred`（android-mqtt 因 skipConnectChallenge 可不依赖）。  
- `node.invoke.request`：调用 `handleInvokeEvent(payloadJson)`，再 `sendInvokeResult`。  
- 其余事件：`onEvent(event, payloadJson)`。  

✅ **android-mqtt 符合**

### 3.3 node.invoke 与 node.event

- **InvokeRequest**：id, nodeId, command, paramsJSON/params, timeoutMs。  
- **InvokeResult**：request `node.invoke.result`，params 含 id, nodeId, ok, payload/payloadJSON, error。  
- **node.event**：params 含 event, payload/payloadJSON。  

✅ **android-mqtt 与 apps/android 一致**

---

## 4. NodeRuntime 层：connect options 与双会话

### 4.1 buildNodeConnectOptions / buildOperatorConnectOptions

- **node**：role=`"node"`, caps=buildCapabilities(), commands=buildInvokeCommands(), client id=`"moltbot-android"`, mode=`"node"`。  
- **operator**：role=`"operator"`, caps/commands 空, client id=`"moltbot-control-ui"`, mode=`"ui"`。  
- 两边均有 userAgent、buildClientInfo（displayName, version, platform, instanceId, deviceFamily, modelIdentifier）。  

✅ **android-mqtt 与 apps/android 一致**

### 4.2 双会话（operator + node）

- apps/android：`operatorSession.connect(endpoint, ...)`, `nodeSession.connect(endpoint, ...)`，各持一个 WS Connection。  
- android-mqtt：`operatorSession.connect(targetOp, ...)`, `nodeSession.connect(targetNode, ...)`，共用同一 MqttGatewayConnection，target 区分 role（operator/node），对应 Bridge 上两条 WS（clientId+operator / clientId+node）。  

✅ **语义一致**（双 role、双会话，仅传输层由 WS 改为 MQTT 双 topic）

---

## 5. 差异与建议

### 5.1 normalizeCanvasHostUrl

- **apps/android**：可根据 endpoint 的 `tailnetDns`、`lanHost`、`canvasPort` 做 fallback，便于远程/复杂网络。  
- **android-mqtt**：仅做 trim 与 loopback 判断，无 endpoint 信息（无 GatewayEndpoint，只有 MQTT brokerUrl/topicClientId）。  

**结论**：当前 Bridge 连 `ws://127.0.0.1`，Gateway 返回的 `canvasHostUrl` 多为 `http://127.0.0.1:18793` 或 null，android-mqtt 的简单 normalize 足够。若日后支持“远程 Gateway + MQTT”，可考虑在 android-mqtt 中增加基于 broker host 或配置的 fallback。**当前无必须修改。**

### 5.2 DeviceIdentityStore / DeviceAuthStore

两边实现一致（Ed25519 签名、device payload、token 存取）。✅

### 5.3 GatewaySession 入参

- apps/android 多 `onTlsFingerprint`、Connection 多 `GatewayTlsParams`/endpoint；android-mqtt 无 TLS（走 MQTT+Bridge），无 endpoint，仅 `GatewayConnectionTarget.Mqtt`。  

✅ **符合 MQTT 使用场景**

---

## 6. 总结

| 类别 | 结论 |
|------|------|
| 协议版本与帧格式（req/res/event） | ✅ 一致 |
| connect params / device 认证 / connect 响应解析 | ✅ 一致 |
| connect.challenge | ✅ 通过 skipConnectChallenge 合理跳过 |
| handleResponse / handleEvent / node.invoke / node.event | ✅ 一致 |
| NodeRuntime 双会话与 connect options | ✅ 一致 |
| normalizeCanvasHostUrl | ✅ 当前场景够用，可选后续增强 |
| DeviceIdentity / DeviceAuth | ✅ 一致 |

**结论：apps/android-mqtt 与 Gateway 的 WS 数据交互规范与 apps/android 对齐，符合当前 MQTT+Bridge 的交互要求；无需为“符合规范”做代码修改，仅可根据日后需求考虑 canvas URL fallback 等增强。**
