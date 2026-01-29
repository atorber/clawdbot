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

### Bridge 配置

在 `channels.mqtt` 下增加 `gatewayBridge` 配置块：

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `false` | 是否启用 Gateway Bridge |
| `gatewayWsUrl` | string | `ws://127.0.0.1:18789` | Bridge 连接的网关 WebSocket 地址 |
| `brokerUrl` | string | 可选 | Bridge 使用的 MQTT Broker 地址；不填则使用第一个 MQTT 账户的 Broker |
| `username` | string | - | Broker 用户名（未填则可用第一个账户的） |
| `password` | string | - | Broker 密码（未填则可用第一个账户的） |
| `clientId` | string | 自动 | Bridge 使用的 MQTT 客户端 id |
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
