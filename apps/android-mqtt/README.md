## Clawdbot Node (Android MQTT) (internal)

Android node app that connects to the gateway via **MQTT** (with optional WebSocket fallback). Exposes **Canvas + Chat + Camera**. Requires the MQTT extension with **Gateway Bridge** enabled so the broker bridges to the gateway WebSocket.

Notes:
- The node keeps the connection alive via a **foreground service** (persistent notification with a Disconnect action).
- Chat uses the shared session key **`main`** (same session across iOS/macOS/WebChat/Android).
- Supports modern Android only (`minSdk 31`, Kotlin + Jetpack Compose).

## Open in Android Studio
- Open the folder `apps/android-mqtt`.

## Build / Run

```bash
cd apps/android-mqtt
./gradlew :app:assembleDebug
./gradlew :app:installDebug
./gradlew :app:testDebugUnitTest
```

`gradlew` auto-detects the Android SDK at `~/Library/Android/sdk` (macOS default) if `ANDROID_SDK_ROOT` / `ANDROID_HOME` are unset.

## Connect / Pair

1) Start the gateway and enable the MQTT extension with **Gateway Bridge** (see `extensions/mqtt/README.md`). Ensure the bridge connects to your MQTT broker and the gateway WebSocket.

2) In the Android app:
- Open **Settings**
- Configure **MQTT broker** (host, port, optional auth). Optionally use **Manual Gateway** for WebSocket (host + port) instead of MQTT.

3) Approve pairing (on the gateway machine):
```bash
clawdbot nodes pending
clawdbot nodes approve <requestId>
```

More details: `docs/platforms/android.md`, `extensions/mqtt/README.md`.

## Permissions

- Discovery (when using WebSocket / manual gateway):
  - Android 13+ (`API 33+`): `NEARBY_WIFI_DEVICES`
  - Android 12 and below: `ACCESS_FINE_LOCATION` (required for NSD scanning)
- Foreground service notification (Android 13+): `POST_NOTIFICATIONS`
- Camera:
  - `CAMERA` for `camera.snap` and `camera.clip`
  - `RECORD_AUDIO` for `camera.clip` when `includeAudio=true`
