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

## 权限

- 发现（使用 WebSocket / 手动网关时）：
  - Android 13+（`API 33+`）：`NEARBY_WIFI_DEVICES`
  - Android 12 及以下：`ACCESS_FINE_LOCATION`（NSD 扫描所需）
- 前台服务通知（Android 13+）：`POST_NOTIFICATIONS`
- 相机：
  - `CAMERA`：用于 `camera.snap` 与 `camera.clip`
  - `RECORD_AUDIO`：`camera.clip` 在 `includeAudio=true` 时需录音
