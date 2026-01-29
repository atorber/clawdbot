## Clawdbot Node (Android MQTT)（内部）

通过 **MQTT** 连接网关的 Android 节点应用（可选 WebSocket 回退）。提供 **Canvas + 聊天 + 相机**。需在 MQTT 扩展中启用 **Gateway Bridge**，由 Broker 桥接到网关 WebSocket。

说明：
- 节点通过**前台服务**保持连接（常驻通知栏，带「断开」操作）。
- 聊天使用共享会话键 **`main`**（与 iOS/macOS/WebChat/Android 共用同一会话）。
- 仅支持较新 Android（`minSdk 31`，Kotlin + Jetpack Compose）。

## 在 Android Studio 中打开

- 打开目录 `apps/android-mqtt`。

## 构建 / 运行

```bash
cd apps/android-mqtt
./gradlew :app:assembleDebug
./gradlew :app:installDebug
./gradlew :app:testDebugUnitTest
```

若未设置 `ANDROID_SDK_ROOT` / `ANDROID_HOME`，`gradlew` 会使用 macOS 默认路径 `~/Library/Android/sdk` 自动检测 Android SDK。

## 连接 / 配对

1) 启动网关并启用带 **Gateway Bridge** 的 MQTT 扩展（见 `extensions/mqtt/README.md`）。确保 Bridge 已连上你的 MQTT Broker 与网关 WebSocket。

2) 在 Android 应用中：
- 打开 **设置**
- 配置 **MQTT Broker**（地址、端口、可选认证）。也可使用 **手动网关** 以 WebSocket（主机 + 端口）代替 MQTT。

3) 在网关机器上批准配对：
```bash
clawdbot nodes pending
clawdbot nodes approve <requestId>
```

更多说明：`docs/platforms/android.md`、`extensions/mqtt/README.md`。

## 在线调试（MQTT 连接失败时）

按下面顺序排查，可快速定位问题。

### 1. Android 端日志（logcat）

连接设备或模拟器后：

```bash
adb logcat -s MoltbotGateway:* MoltbotWebView:E
```

- **MoltbotGateway**：Gateway 会话、MQTT 连接/订阅失败、JSON-RPC 错误会在这里；`Gateway error: ...` 会同步到应用内状态栏文案。
- 若 MQTT 连接/订阅抛异常，会看到 `MqttException` 或 "connect failed" / "subscribe failed" 相关堆栈。

应用内「设置」下方或状态栏若显示 `Failed: MQTT broker URL required`，说明未填 Broker 地址；`Gateway error: ...` 多为 Broker 连不上、认证失败或网络不可达。

### 2. Gateway Bridge 日志

确保本机已启动 Gateway，且 MQTT 插件里 **Gateway Bridge** 已开启（`channels.mqtt.gatewayBridge.enabled: true`）。在运行 Gateway 的终端或日志中搜索 **`[bridge]`**：

- `[bridge] starting broker=... gatewayWs=...`：Bridge 已读取配置并尝试连接 Broker。
- `[bridge] subscribed to req topics`：已订阅 `moltbot/gw/+/operator/req` 与 `moltbot/gw/+/node/req`。
- `[bridge] subscribe error: ...`：订阅失败，多为 Broker 地址/认证错误。
- `[bridge] WS error ...` / `[bridge] session failed ...`：Bridge 连上 Broker 后，与网关 WebSocket（默认 `ws://127.0.0.1:18789`）通信失败，检查 Gateway 是否在本机监听 18789。

### 3. MQTT Broker 与网络

- Broker 是否已启动；Android 设备与运行 Gateway/Bridge 的机器能否访问同一 Broker（若 Broker 在电脑上，手机需与电脑同网或使用可访问的地址）。
- Broker 地址格式：`tcp://host:1883` 或 `ssl://host:8883`（或 `mqtt://` / `mqtts://`，视客户端库而定）；端口、用户名、密码、Client ID 与 Broker 实际配置一致。**常见错误**：端口写成 `188` 会连不上，标准非加密端口为 `1883`。

### 4. 配置核对

- **Android 应用**：设置页里「连接模式」选 MQTT 后，Broker URL、用户名、密码、Client ID 是否与 Broker 及 Bridge 端一致。
- **Gateway 配置**（如 `~/.clawdbot/config.json` 或环境对应配置）：`channels.mqtt.gatewayBridge` 中 `enabled: true`，`brokerUrl`、`username`、`password`、`gatewayWsUrl`（默认 `ws://127.0.0.1:18789`）是否正确。

按 1→2→3→4 排查后，多数「MQTT 连接失败」可定位到是 Android 连 Broker、Bridge 连 Broker、Bridge 连 Gateway 或配置不一致中的某一环。

## 权限

- 发现（使用 WebSocket / 手动网关时）：
  - Android 13+（`API 33+`）：`NEARBY_WIFI_DEVICES`
  - Android 12 及以下：`ACCESS_FINE_LOCATION`（NSD 扫描所需）
- 前台服务通知（Android 13+）：`POST_NOTIFICATIONS`
- 相机：
  - `CAMERA`：用于 `camera.snap` 与 `camera.clip`
  - `RECORD_AUDIO`：`camera.clip` 在 `includeAudio=true` 时需录音
