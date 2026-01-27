---
summary: "MQTT channel for arbitrary MQTT broker access"
read_when:
  - You want Clawdbot to receive and send messages via MQTT
  - You are connecting to EMQ X, Mosquitto, HiveMQ, or another MQTT broker
---
# MQTT

**Status:** Optional plugin (disabled by default).

This channel connects Clawdbot to an arbitrary MQTT broker. Topics are used as sessions; inbound payloads must be JSON with `messageId` and `text`. Reply topics must be separate from subscribe topics (topic separation is enforced to avoid loops).

## Install

### Onboarding

- `clawdbot onboard` and `clawdbot channels add` can install the MQTT plugin on demand.

### Manual install

```bash
clawdbot plugins install @clawdbot/mqtt
```

Local checkout (dev):

```bash
clawdbot plugins install --link <path-to-clawdbot>/extensions/mqtt
```

Restart the Gateway after installing or enabling the plugin.

## Quick setup

1. Add config under `channels.mqtt.accounts.<id>`:

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
          "password": "your-password",
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

2. Ensure **inbound** and **reply** topics do not overlap (e.g. subscribe `devices/+/in`, reply `devices/{to}/out`).

3. Send JSON payloads on subscribe topics with at least `messageId` and `text` (see [Inbound format](#inbound-message-format)).

4. Restart the Gateway.

## Inbound message format

Payload must be valid JSON. Required fields:

| Field | Type | Description |
|-------|------|-------------|
| `messageId` | string | Unique id (used for deduplication) |
| `text` | string | Message body |

Optional:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | number or string | Unix ms or ISO8601; used for age filtering |
| `replyTo` | string | messageId of the message being replied to |
| `clientId` | string | Used when `fromExtractor` is `"payload"` or `"topic+payload"` |
| `replyToTopic` | string | MQTT topic to publish replies to (needed when `publishMode` is `"direct"` and no `publishPrefix`) |

Example:

```json
{
  "messageId": "uuid-123",
  "text": "Hello",
  "timestamp": 1706342400000,
  "replyToTopic": "devices/device-123/out"
}
```

Messages that are not valid JSON or lack `messageId`/`text` are skipped (with a warning in logs). Retain messages are ignored by default. Messages older than 5 minutes at startup are ignored by default.

## Topic separation (no loops)

**Inbound** topics (in `topics.subscribe`) and **reply** topics must not overlap. The plugin checks at runtime and will not publish to a topic that is in the subscribe set.

- Prefer different path segments: e.g. subscribe `devices/+/in`, reply `devices/+/out`.
- With `publishMode: "prefix"` and `publishPrefix: "devices/{to}/out"`, the `{to}` is replaced by the wildcard segment (e.g. topic `devices/device-123/in` → reply topic `devices/device-123/out`).
- With `publishMode: "direct"`, the client must send `replyToTopic` in each message.

## Configuration reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `brokerUrl` | string | required | `mqtt://` or `mqtts://` URL |
| `clientId` | string | auto | Client ID; default `clawdbot-<accountId>-<random>` |
| `username` / `password` | string | - | Broker auth |
| `tls` | boolean or object | - | TLS options; use TLS for `mqtts://` |
| `topics.subscribe` | string[] | required | Topics to subscribe to (`+`, `#` allowed) |
| `topics.publishPrefix` | string | - | Reply topic template when `publishMode` is `"prefix"` |
| `topics.publishMode` | `"direct"` \| `"prefix"` | `"direct"` | How reply topic is determined |
| `ignoreRetainedMessages` | boolean | `true` | Ignore retain messages |
| `ignoreMessagesOlderThanMs` | number | `300000` | Ignore messages older than this (ms) after startup |
| `cleanSession` | boolean | `false` | MQTT clean session |
| `keepalive` | number | `60` | Keepalive (seconds) |
| `qos.subscribe` / `qos.publish` | 0 \| 1 \| 2 | `1` | QoS |
| `maxMessageSize` | number | `200000` | Max publish size (bytes) |
| `fromExtractor` | `"topic"` \| `"payload"` \| `"topic+payload"` | `"topic"` | Sender id source |
| `allowFrom` | (string \| number)[] | `[]` | Allowed topics/senders |
| `dmPolicy` | string | - | `pairing`, `allowlist`, `open`, `disabled` |

## Security

- Use `mqtts://` and TLS in production.
- Configure broker ACLs so clients can only subscribe/publish to allowed topics.
- Use `allowFrom` and `dmPolicy` to limit which senders can trigger the agent.

## Troubleshooting

- **No replies:** Check that the reply topic is not in `topics.subscribe` and that the client subscribes to the reply topic.
- **Duplicate handling:** Ensure every inbound payload has a unique `messageId`.
- **Old messages on startup:** Increase `ignoreMessagesOlderThanMs` or rely on `messageId` deduplication.
- **Connection drops:** The client uses a 1s reconnect period by default; check broker and network.

## See also

- [Channels overview](/channels)
- [Plugin install](/plugin#install)
- Repo: `.wiki/MQTT-Channel-实现方案-v2.md` (implementation scheme)
