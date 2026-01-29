# @clawdbot/mqtt

Clawdbot 的 MQTT 通道插件，可连接任意 MQTT Broker，支持两种模式：

1. **通道（聊天）模式**：订阅配置的 topic；消息体须为带 `messageId` 和 `text` 的 JSON；回复发布到单独的出站 topic。
2. **Gateway Bridge 模式**：在 MQTT topic（`moltbot/gw/{clientId}/{role}/req|res|evt`）上桥接完整网关 JSON-RPC 协议，使 Android 等 MQTT 客户端具备与 WebSocket 客户端相同能力（operator + node 双会话、聊天、Canvas 等）。

## 概述（通道模式）

- **入站**：订阅配置的 topic；消息体须为带 `messageId` 和 `text` 的 JSON。
- **出站**：回复发布到**不得**与订阅 topic 重叠的 topic（入站/出站 topic 分离）。
- **默认**：忽略保留消息；启动后超过 5 分钟的消息被过滤；QoS 1；`cleanSession: false`。

## 安装

```bash
clawdbot plugins install @clawdbot/mqtt
```

或从本地目录安装：

```bash
clawdbot plugins install --link /path/to/clawdbot/extensions/mqtt
```

## 最小配置

```json
{
  "channels": {
    "mqtt": {
      "enabled": true,
      "accounts": {
        "default": {
          "enabled": true,
          "brokerUrl": "mqtts://broker.example.com:8883",
          "topics": {
            "subscribe": ["devices/+/in"],
            "publishPrefix": "devices/{to}/out",
            "publishMode": "prefix"
          }
        }
      }
    }
  }
}
```

### 用户名 / 密码鉴权

在 account 下增加 `username`、`password` 即可走用户名密码鉴权：

```json
{
  "channels": {
    "mqtt": {
      "enabled": true,
      "accounts": {
        "default": {
          "enabled": true,
          "brokerUrl": "mqtts://broker.example.com:8883",
          "username": "clawdbot",
          "password": "your-secret-password",
          "topics": {
            "subscribe": ["devices/+/in"],
            "publishPrefix": "devices/{to}/out",
            "publishMode": "prefix"
          }
        }
      }
    }
  }
}
```

密码也可用环境变量占位，由 Gateway 启动前展开，例如：`"password": "${MQTT_PASSWORD}"`，并设置 `export MQTT_PASSWORD=...`。

- **brokerUrl**：`mqtt://` 或 `mqtts://`（必填）。
- **topics.subscribe**：要订阅的 topic 列表（必填）；支持 MQTT 通配符 `+` 和 `#`。
- **topics.publishMode**：`"direct"`（默认）或 `"prefix"`。
- **topics.publishPrefix**：当 `publishMode` 为 `"prefix"` 时，回复 topic 的模板；`{to}` 会被入站 topic 中匹配到的那一段替换（例如 `devices/+/in` + 实际 topic `devices/device-123/in` → `devices/device-123/out`）。

**注意**：回复 topic 不能出现在 `topics.subscribe` 中，入站与出站请使用不同路径（例如 `.../in` 与 `.../out`）。

## 如何用 MQTT 客户端发消息给 Gateway

Gateway 订阅的是你在配置里写的 `topics.subscribe`（例如 `devices/+/in`）。你要做的只有两步：

1. **往“入站 topic”发一条消息**  
   使用一个会被 Gateway 订阅到的 topic。例如 Gateway 配了 `subscribe: ["devices/+/in"]`，你就往 `devices/<你的标识>/in` 发，例如 `devices/my-client/in`。

2. **消息体必须是 JSON**，且包含 `messageId` 和 `text`，例如：
   ```json
   {"messageId": "uuid-1", "text": "你好，请回复"}
   ```

Gateway 收到后会走 Agent 逻辑，并把回复发到**出站 topic**（不会发回你发的那个 topic）。要收到回复，你的 MQTT 客户端需要**订阅出站 topic**。

### 出站 topic 怎么定？

- **`publishMode: "prefix"` 且配了 `publishPrefix`**  
  回复 topic 由“入站 topic 里匹配到的那一段”和模板算出来。例如：
  - Gateway 订阅 `devices/+/in`，`publishPrefix`: `devices/{to}/out`
  - 你发到 `devices/my-client/in`
  - 回复会发到 `devices/my-client/out`
  - 所以你这边要**订阅** `devices/my-client/out` 才能收到回复。

- **`publishMode: "direct"` 或你想自己指定**  
  在每条消息的 JSON 里加 `replyToTopic`，例如：
  ```json
  {"messageId": "uuid-1", "text": "你好", "replyToTopic": "devices/my-client/out"}
  ```
  然后你的客户端订阅 `devices/my-client/out` 即可。

### 命令行示例（mosquitto_pub / mosquitto_sub）

假设 Broker 为 `mqtt://broker.example.com:1883`，Gateway 已按上面的“最小配置”订阅 `devices/+/in`，回复发到 `devices/{to}/out`。

**终端 1：先订阅你的出站 topic，等回复**
```bash
mosquitto_sub -h broker.example.com -t "devices/my-client/out" -v
```

**终端 2：向入站 topic 发一条消息**
```bash
mosquitto_pub -h broker.example.com -t "devices/my-client/in" \
  -m '{"messageId":"req-001","text":"今天天气怎么样？"}'
```

Gateway 处理完后会把 Agent 的回复发到 `devices/my-client/out`，终端 1 会看到那条回复。

### 用脚本发（Node 示例）

```js
const mqtt = require("mqtt");
const client = mqtt.connect("mqtt://broker.example.com");

const myId = "my-client";
const topicIn = `devices/${myId}/in`;
const topicOut = `devices/${myId}/out`;

client.on("connect", () => {
  client.subscribe(topicOut, (err) => {
    if (err) return;
    client.publish(topicIn, JSON.stringify({
      messageId: `req-${Date.now()}`,
      text: "你好，请简短回复",
    }));
  });
});

client.on("message", (topic, payload) => {
  if (topic === topicOut) {
    console.log("Gateway 回复:", payload.toString());
  }
});
```

要点：**发到入站 topic、订阅出站 topic**；每条消息带唯一 `messageId`，payload 为 JSON 且含 `text`。

## 如何调试 MQTT 消息交互

按下面顺序做，便于定位「连上了但没回复」或「收不到消息」等问题。

### 1. 确认前置条件

- **Gateway 已启动**，且已加载 MQTT 插件（`clawdbot plugins enable mqtt` 或配置里启用）。
- **MQTT 账户配置正确**：`brokerUrl`、`username`/`password`、`topics.subscribe` / `publishPrefix` / `publishMode` 与你的 Broker 和 topic 规划一致。
- **连接正常**：在 Gateway 日志里应能看到类似 `[default] MQTT subscribed to N topic(s)`，而不是反复 `connack timeout` 或 `MQTT error`。

### 2. 看 Gateway 日志

日志里 MQTT 相关一般会打 `gateway/channels/mqtt` 或 `[default] MQTT ...`：

- **连接与订阅**：`MQTT connected`、`MQTT subscribed to ...` 表示已连上并订阅好。
- **出错**：`MQTT error`、`connack timeout` 等表示连接或鉴权有问题，先按 [故障排除](#故障排除) 处理。

若使用 Control 或 CLI 的日志流，可过滤 `mqtt` 或 `channels/mqtt` 便于只看 MQTT 相关日志。

### 3. 用「一发一收」验证链路

用两个终端（或一个脚本先订阅再发），严格按「入站 topic 发、出站 topic 收」走一遍。

**终端 A：订阅出站 topic（先启动）**

```bash
# 把 my-client 换成你在入站 topic 里用的那段，Broker 换成实际地址与端口
mosquitto_sub -h <Broker 主机> -p <端口> -t "devices/my-client/out" -v
```

**终端 B：往入站 topic 发一条**

```bash
mosquitto_pub -h <Broker 主机> -p <端口> -t "devices/my-client/in" \
  -m '{"messageId":"debug-001","text":"你好"}'
```

若配置正确，终端 A 应在几秒到几十秒内看到 Gateway 发出的那条回复（纯文本或 JSON，取决于 Gateway 实现）。

- **终端 A 一直没输出**：要么出站 topic 不对、要么 Gateway 没往该 topic 发（查 Gateway 日志里是否有对该会话的回复下发）。
- **Gateway 日志里完全没 MQTT 收到消息**：检查入站 topic 是否和 `topics.subscribe` 匹配、payload 是否为合法 JSON 且带 `messageId` 和 `text`。

### 4. 检查 payload 格式

入站消息必须是 **JSON**，且至少包含：

- `messageId`：唯一字符串，用于去重。
- `text`：正文。

少字段、非 JSON、或 `text` 为空，都可能被忽略并在日志里出现格式相关提示。发之前可用 `echo '...' | jq .` 自检是否为合法 JSON。

### 5. 检查 topic 是否匹配

- **入站**：你发布的 topic 必须落在 Gateway 配置的 `topics.subscribe` 里。例如配置了 `["devices/+/in"]`，则你要发到 `devices/<任意一段>/in`，如 `devices/my-client/in`。
- **出站**：你订阅的 topic 必须和 Gateway 实际发布的 topic 一致。`publishMode: "prefix"` 且 `publishPrefix: "devices/{to}/out"` 时，入站 topic 为 `devices/my-client/in` 则出站为 `devices/my-client/out`，你要订阅的也是 `devices/my-client/out`。

可用 `mosquitto_sub -t "devices/#" -v` 临时订阅整个前缀，看 Gateway 实际往哪些 topic 发消息。

### 6. 使用自带的连接测试脚本（仅测连接）

仅验证「能否连上 Broker」，不验证收发：

```bash
cd extensions/mqtt
# 按需改 BROKER_URL / USERNAME / PASSWORD，或用环境变量
MQTT_BROKER_URL="mqtt://your-broker:1883" pnpm exec node scripts/test-connect.js
```

输出 `OK: connected` 表示连接与鉴权正常，可再按上面步骤排查「入站 → Agent → 出站」整条链。

### 7. 常见现象速查

| 现象 | 可能原因 | 建议 |
|------|----------|------|
| 一直 connack timeout | 端口/协议不对（如 8883 超时可试 1883/1884）、网络或 Broker 限连 | 换端口或协议、加大 `connectTimeout`、查 Broker 与网络 |
| 连接成功但收不到回复 | 没订阅出站 topic，或出站 topic 与 Gateway 不一致 | 用 `devices/#` 看实际出站 topic，再对准订阅 |
| Gateway 像没收到消息 | 入站 topic 不匹配 subscribe、或 payload 非 JSON/缺 messageId/text | 核对 subscribe 与发布 topic，检查 payload |
| 同一条消息被处理多次 | messageId 重复或未带 | 每条消息用唯一 messageId |

按「连接 → 入站格式与 topic → 出站 topic 与订阅」逐项对照，一般能较快定位问题。

## 入站消息格式（JSON）

消息体须为 JSON。必填字段：

- **messageId**：唯一 id，用于去重。
- **text**：消息正文。

可选字段：

- **timestamp**：Unix 毫秒或 ISO8601，用于按时间过滤。
- **replyTo**：被回复消息的 messageId。
- **clientId**：当 `fromExtractor` 为 `"payload"` 或 `"topic+payload"` 时使用。
- **replyToTopic**：回复要发往的 MQTT topic（当 `publishMode` 为 `"direct"` 且未配置 `publishPrefix` 时必填）。

示例：

```json
{
  "messageId": "unique-id-123",
  "text": "你好",
  "timestamp": 1706342400000,
  "replyToTopic": "devices/device-123/out"
}
```

## Gateway Bridge（网关桥）

启用 **Gateway Bridge** 后，插件会订阅客户端（如 Android 应用）发布网关**请求**的 MQTT topic，并将请求转发到本地网关 WebSocket；响应和事件再发布回 MQTT。这样无法使用 WebSocket 发现的设备可通过共享 MQTT Broker 连接，同时保持完整网关协议（operator + node 双会话、聊天、Canvas 等）。

### Topic 约定

| 角色     | 客户端发布（req）                      | Gateway → 客户端（res / evt）                  |
|----------|----------------------------------------|------------------------------------------------|
| operator | `moltbot/gw/{clientId}/operator/req`   | `moltbot/gw/{clientId}/operator/res` \| `evt`  |
| node     | `moltbot/gw/{clientId}/node/req`        | `moltbot/gw/{clientId}/node/res` \| `evt`      |

消息格式与 WebSocket 一致： `{ type: "req", id, method, params }` → `{ type: "res", id, ok, payload?, error? }`，以及 `{ type: "event", event, payload? }`。

### clientId 与 topic 设计（为何不能共用同一 clientId）

- **Topic 中的 clientId**：表示「请求方/接收方」身份，用于路由。每个客户端用**自己的** clientId 发 req（`moltbot/gw/{自己的clientId}/.../req`）并订阅 res/evt（`moltbot/gw/{自己的clientId}/.../res|evt`），因此**只收到自己的响应**，多客户端彼此隔离。
- **Broker 约束**：同一 clientId 在 Broker 上**只能有一个连接**。若 Bridge 与某客户端使用**相同的连接 clientId**，会互相踢线，故 **topic 中/连接上共用同一 clientId 不可行**。
- **若 clientId 不同且 topic 按 clientId 区分**：各客户端订阅的 res/evt 只含自己的 clientId，自然「订阅不到彼此的 topic 消息」，这是预期隔离，不是缺陷。
- **当前设计**：Bridge 的 **MQTT 连接** clientId 使用保留前缀 `moltbot-bridge-`，与所有客户端连接 clientId 区分；**topic 路径中的 clientId 始终是「客户端」的**（Bridge 订阅 `moltbot/gw/+/.../req`，收到后从 topic 解析出客户端 clientId，再往 `moltbot/gw/{该clientId}/.../res|evt` 回写）。Bridge 不作为 clientId 出现在 topic 中，从而避免连接冲突且路由正确。

### Bridge 配置

在 `channels.mqtt` 下增加 `gatewayBridge` 配置块：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `false` | 是否启用 Gateway Bridge |
| `gatewayWsUrl` | string | `ws://127.0.0.1:18789` | Bridge 连接的网关 WebSocket 地址 |
| `brokerUrl` | string | 可选 | Bridge 使用的 MQTT Broker 地址；不填则使用第一个 MQTT 账户的 Broker |
| `username` | string | - | Broker 用户名（未填则可用第一个账户的） |
| `password` | string | - | Broker 密码（未填则可用第一个账户的） |
| `clientId` | string | 不填则随机 | Bridge 的 MQTT 连接 clientId 始终带保留前缀 `moltbot-bridge-`（不填时为 `moltbot-bridge-` + 12 位随机字母，填写时为 `moltbot-bridge-` + 配置值），与 Android/其他客户端连接用 clientId 隔离，避免同一 clientId 只能一个连接冲突；Broker 要求预注册时在控制台注册该完整 clientId（如 `moltbot-bridge-mybridge`） |
| `maxMessageSize` | number | `262144`（256KB） | 单条消息最大长度；超出会返回 `PAYLOAD_TOO_LARGE` |

示例（Bridge 使用独立 Broker）：

```json
{
  "channels": {
    "mqtt": {
      "gatewayBridge": {
        "enabled": true,
        "gatewayWsUrl": "ws://127.0.0.1:18789",
        "brokerUrl": "tcp://broker.example.com:1883",
        "username": "bridge",
        "password": "secret"
      }
    }
  }
}
```

示例（Bridge 复用第一个 MQTT 账户的 Broker，不填 `brokerUrl`）：

```json
{
  "channels": {
    "mqtt": {
      "accounts": {
        "default": {
          "brokerUrl": "tcp://broker.example.com:1883",
          "topics": { "subscribe": ["devices/+/in"], "publishPrefix": "devices/{to}/out", "publishMode": "prefix" }
        }
      },
      "gatewayBridge": {
        "enabled": true
      }
    }
  }
}
```

Bridge 从本机连接网关，网关会将其视为本地客户端，connect 时不需要 device nonce。日志使用子系统 `mqtt-bridge`（例如 `[bridge] subscribed to req topics`）。

### Gateway 侧 MQTT 连接（Bridge）位置

- **插件入口**：`extensions/mqtt/index.ts`  
  `register()` 里会调用 `startGatewayBridge(api.runtime, ...)`，在 Gateway 启动并加载 MQTT 插件时启动 Bridge。
- **Bridge 实现**：`extensions/mqtt/src/bridge.ts`  
  - 读取配置：`channels.mqtt.gatewayBridge`（`enabled`、`brokerUrl`、`gatewayWsUrl`、`username`、`password`、`clientId` 等）。
  - 若 `getBridgeConfig()` 返回 `null`（未启用或未配 `brokerUrl`），Bridge 不启动。
  - 否则用 **`mqtt.connect(config.brokerUrl, ...)`** 连 Broker（与通道模式同一套 mqtt 库，无协议转换）。**`brokerUrl` 必须与通道模式下能正常收发的地址一致**：若通道用 `mqtt://host:1883` 能通，Bridge 也填 `mqtt://host:1883`；部分 Broker（如百度 IoT）对 `wss://...443` 不支持或鉴权不同，用 wss 会导致连接被拒。
  - 连接成功后订阅 `moltbot/gw/+/operator/req` 与 `moltbot/gw/+/node/req`，收到请求后建 WebSocket 到 `gatewayWsUrl`（默认 `ws://127.0.0.1:18789`）并转发。

### 如何确认 Gateway 中 MQTT Bridge 已连接成功

1. **看 Gateway 日志**  
   Bridge 的日志都带子系统 **`mqtt-bridge`** 或前缀 **`[bridge]`**。  
   - **连接成功**：应看到两条信息（顺序可能相邻或隔几行）：
     - `[bridge] starting broker=<你的 brokerUrl> gatewayWs=<gatewayWsUrl>`
     - `[bridge] subscribed to req topics`
   - **连接失败**：会看到例如 `[bridge] subscribe error: ...` 或 `[bridge] MQTT error: ...`。

2. **如何查看 Gateway 日志**  
   - **CLI 启动**：`moltbot gateway run` 或 `clawdbot gateway run` 时，日志在**当前终端 stdout**，直接看输出或重定向到文件。
   - **macOS 应用**：日志在系统统一日志里，可用项目里的 `./scripts/clawlog.sh` 查询（如 `./scripts/clawlog.sh -s com.moltbot.mac 2>&1 | grep -E 'bridge|mqtt'`），或在「帮助 / 日志」等入口查看（若应用提供）。
   - **筛选 Bridge**：在日志里搜 **`[bridge]`** 或 **`mqtt-bridge`** 即可只看 Bridge 相关行。

3. **未看到任何 `[bridge]` 日志**  
   - 确认配置里 `channels.mqtt.gatewayBridge.enabled` 为 `true` 且 `brokerUrl` 已填（或存在可用的第一个 MQTT 账户）。
   - 确认 MQTT 插件已加载（Gateway 启动日志里应有插件加载信息）。
   - Bridge 使用 `runtime.logging.getChildLogger({ subsystem: "mqtt-bridge" })` 输出；若仍无日志，请用最新代码重启 Gateway。

4. **只有 `[bridge] starting` 和 `[bridge] MQTT disconnected`，从未出现 `[bridge] MQTT connected`**
   - **协议/端口**：若通道模式用 **`mqtt://host:1883`** 能正常收发，请把 `gatewayBridge.brokerUrl` 也设为 **`mqtt://host:1883`**，不要用 `wss://...443`；百度 IoT 等对 wss 可能不支持或鉴权不同，会导致连接被拒。
   - **clientId**：不填则 Bridge 使用随机 clientId；若 Broker 要求预注册（如百度 IoT），需在配置中填写控制台创建设备的 clientId。
   - 启动日志里会打印 `broker=... clientId=xxx`，便于核对。

5. **出现 `[bridge] MQTT error: ... read ECONNRESET` 或频繁 `[bridge] MQTT disconnected`**  
   - 表示 Broker 侧关闭了连接。Bridge 会**自动重连**（reconnectPeriod 5s）；连接后应**尽量保持不断**。
   - **常见原因**：① **Broker 空闲超时**：Bridge 使用 keepalive 30s 发送 PINGREQ，若 Broker 的空闲超时 ≤30s 仍可能断；可在 Broker 控制台调大空闲超时，或改 Bridge 配置（若支持）减小 keepalive。② **同一 clientId 被多处使用**：只保留一个 Gateway 进程、避免重复启动 Bridge（已有 30s 冷却）。③ **网络波动**：本机/机房网络不稳会断线，重连即可。
   - **跑 E2E 或 Android 前**，请确认日志里刚出现过 `[bridge] MQTT connected` 和 `[bridge] subscribed to req topics`。

6. **clientId 与连接冲突**  
   - Broker 规定同一 clientId 只能有一个连接。Bridge 的 MQTT 连接 clientId 始终带保留前缀 `moltbot-bridge-`，与 Android/E2E 等客户端隔离。**Android 端（及 E2E 脚本）填写的 clientId 请勿以 `moltbot-bridge-` 开头**，否则会与 Bridge 抢占同一连接导致被踢线；通常使用设备 ID、实例 ID 或用户自填 ID 即可。

### 端到端验证（MQTT 客户端模拟 Android）

用脚本模拟 Android App 行为（operator + node 双会话 connect），经 Broker → Bridge → Gateway 做整链验证：

```bash
cd extensions/mqtt
BROKER_URL="wss://your-broker:443" USERNAME="..." PASSWORD="..." \
  MQTT_CLIENT_ID="my_abcd01" \
  GATEWAY_TOKEN="<gateway.auth.token 可选，鉴权用>" \
  node scripts/test-e2e-mqtt-client.js
```

成功时会打印：`E2E OK: operator and node both received res via MQTT → Bridge → Gateway`。需先确保 Gateway 已用带 `gatewayBridge` 的配置重启，且 Bridge 日志有 `[bridge] subscribed to req topics`。

### 测试 Bridge 连通性（单条 connect）

1. 在 Gateway 配置中启用 `gatewayBridge`（见上方示例或 `extensions/mqtt/sample-gateway-bridge-config.json`），重启 Gateway。
2. 在 Gateway 日志中确认出现 `[bridge] starting broker=...` 和 `[bridge] subscribed to req topics`。
3. 可选：用脚本验证「Broker → Bridge → Gateway」单条请求：
   ```bash
   cd extensions/mqtt
   BROKER_URL="wss://your-broker/mqtt" USERNAME="..." PASSWORD="..." node scripts/test-bridge.js
   ```
   Broker 要求纯字母 clientId 时，脚本会随机生成纯字母；也可加 `MQTT_CLIENT_ID="自定义纯字母id"`。若出现 "Identifier rejected"，可能是同一 username 仅允许一个连接（可先停 Gateway 再跑脚本验证本机连 Broker 是否正常），或需在 Broker 控制台预注册 clientId。脚本收到任意 res（含网关返回的 error）即表示 Bridge 工作正常。

## 配置参考（v2）

**账户**（通道模式）：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `brokerUrl` | string | 必填 | `mqtt://` 或 `mqtts://` 地址 |
| `username` | string | - | Broker 用户名（鉴权用） |
| `password` | string | - | Broker 密码（鉴权用，支持 `${ENV_VAR}` 占位） |
| `topics.subscribe` | string[] | 必填 | 要订阅的 topic 列表 |
| `topics.publishPrefix` | string | - | 回复 topic 模板（`{to}` 占位符） |
| `topics.publishMode` | `"direct"` \| `"prefix"` | `"direct"` | 回复 topic 的确定方式 |
| `ignoreRetainedMessages` | boolean | `true` | 是否忽略保留消息 |
| `ignoreMessagesOlderThanMs` | number | `300000` | 启动后忽略早于该时间的消息（毫秒） |
| `cleanSession` | boolean | `false` | MQTT clean session |
| `keepalive` | number | `60` | 保活间隔（秒） |
| `connectTimeout` | number | `60000` | 等待 CONNACK 的超时（毫秒）；网络慢或 broker 压力大时可调大 |
| `qos.subscribe` / `qos.publish` | 0 \| 1 \| 2 | `1` | 订阅与发布的 QoS |
| `maxMessageSize` | number | `200000` | 单条消息最大长度（字节） |
| `fromExtractor` | `"topic"` \| `"payload"` \| `"topic+payload"` | `"topic"` | 如何解析发送方 id |
| `allowFrom` | (string \| number)[] | `[]` | topic/发送方白名单 |
| `dmPolicy` | string | - | `pairing`、`allowlist`、`open`、`disabled` |

## 安全

- 生产环境建议使用 `mqtts://` 与 TLS。
- 使用 `allowFrom` 和 `dmPolicy` 限制哪些 topic/发送方能触发 Agent。

## 故障排除

### `Error: connack timeout`

表示 TCP 已连上，但在默认时间内没收到 broker 的 CONNACK，可能原因：

- **网络延迟或 broker 慢**：在对应 account 下加 `connectTimeout`（毫秒），例如 `60000`（60 秒）、`90000`：
  ```json
  "accounts": {
    "default": {
      "brokerUrl": "mqtts://...",
      "connectTimeout": 90000,
      ...
    }
  }
  ```
  默认已为 60 秒；若仍超时，可再调大或检查 broker/网络。
- **地址或端口不对**：确认 `brokerUrl`（`mqtt://` / `mqtts://`、端口 1883/8883）与 broker 实际一致。
- **鉴权失败或 broker 限制**：检查 `username` / `password`、broker 日志与连接/限流策略。

## 参考

- 通道实现方案：`.wiki/MQTT-Channel-实现方案-v2.md`
- Gateway Bridge + Android MQTT 方案：`apps/android-mqtt/docs/MQTT-实现方案.md`
- 通道文档：[docs.clawd.bot/channels/mqtt](https://docs.clawd.bot/channels/mqtt)
