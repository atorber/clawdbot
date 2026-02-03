# 查看 Android 端调试日志

用于排查 MQTT 发送/接收、Gateway 会话等问题（如 payload 不合法导致发送失败）。

## 1. 用 adb logcat（推荐）

手机通过 USB 连接电脑并开启「开发者选项 → USB 调试」后，在电脑终端执行：

```bash
# 只看 MQTT 与 Gateway 相关（tag 过滤）
adb logcat -s MqttGateway:D MoltbotGateway:D

# 或按 tag 包含关键字
adb logcat | grep -E "MqttGateway|MoltbotGateway"
```

**常用 tag：**

| Tag | 说明 |
|-----|------|
| `MqttGateway` | MQTT 连接状态变化（Disconnected/Connecting/Connected/Error）、发送/接收、publish 失败、payload 被忽略等 |
| `MoltbotGateway` | 网关状态文案（gateway status）、GatewaySession：node.event 失败、node.invoke.result 失败等 |

**看最近一段并持续输出：**

```bash
adb logcat -s MqttGateway:D MoltbotGateway:D -v time
```

**清空后只看新一轮：**

```bash
adb logcat -c && adb logcat -s MqttGateway:D MoltbotGateway:D -v time
```

**仅打印错误级别（zsh 下需用引号，否则 `*` 会被展开）：**

```bash
adb logcat -v time '*:E'
```

`*:E` 会包含大量系统错误（如 minksocket、HeatmapThread 等）。若只想看本应用的错误，用 tag 过滤：

```bash
adb logcat -v time MqttGateway:E MoltbotGateway:E
```

## 2. Debug 构建下的 MQTT 发送日志

在 **Debug 构建** 下，每次通过 MQTT 发送消息时会打：

- `MqttGateway` **D** 级：`MQTT send topic=... len=... payload=...`（payload 前 200 字符）
- 若 payload 经 sanitize 后为空：`MqttGateway` **W** 级：`MQTT send skipped: payload empty after sanitize`
- 若 publish 抛异常：`MqttGateway` **E** 级：`MQTT publish failed topic=... role=...` + 原因码与堆栈

据此可确认：

- 是否真的调用了 `send`、topic 和 payload 长度
- payload 内容是否合法（前 200 字符是否完整 JSON）
- 是否因空 payload 被跳过
- Paho 报错与 reasonCode（便于查 MqttException）

## 3. 无 USB 时（无线 adb 或日志文件）

```bash
# 无线 adb（手机与电脑同网）
adb tcpip 5555
adb connect <手机IP>:5555

# 将 logcat 写入文件（便于分享）
adb logcat -s MqttGateway:D MoltbotGateway:D -v time > android-mqtt.log
```

## 4. 排查「发送失败 / payload 不合法」时建议看什么

1. 执行：`adb logcat -c && adb logcat -s MqttGateway:D MoltbotGateway:D -v time`
2. 在 App 里触发一次连接（或发送消息）。
3. 看是否有：
   - `MQTT send topic=... len=... payload=...` → 有则说明发的是哪条、长度和前 200 字符。
   - `MQTT send skipped: payload empty after sanitize` → 说明内容被清空，可能含大量 `\0` 或仅空白。
   - `MQTT publish failed ... reasonCode=...` → 用 reasonCode 查 Paho 文档，确认是 broker 拒绝、长度限制等。
   - `MQTT message ignored: payload not JSON` → 接收到的不是合法 JSON（或不是 `{`/`[` 开头）。

结合上述 tag 的日志即可判断是安卓端 payload 不合法，还是 broker/网络问题。
