# @clawdbot/mqtt

MQTT channel plugin for Clawdbot. Connects to an arbitrary MQTT broker and treats topics as sessions.

## Overview

- **Inbound:** subscribe to configured topics; payload must be JSON with `messageId` and `text`.
- **Outbound:** replies are published to a topic that must **not** overlap with subscribe topics (topic separation is enforced).
- **Defaults:** retain messages ignored; messages older than 5 minutes after startup are filtered; QoS 1; `cleanSession: false`.

## Installation

```bash
clawdbot plugins install @clawdbot/mqtt
```

Or from a local checkout:

```bash
clawdbot plugins install --link /path/to/clawdbot/extensions/mqtt
```

## Minimal configuration

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

- **brokerUrl:** `mqtt://` or `mqtts://` (required).
- **topics.subscribe:** list of topics to subscribe to (required); MQTT wildcards `+` and `#` are supported.
- **topics.publishMode:** `"direct"` (default) or `"prefix"`.
- **topics.publishPrefix:** when `publishMode` is `"prefix"`, the template for reply topic; `{to}` is replaced by the single wildcard segment from the subscribed topic (e.g. `devices/+/in` + topic `devices/device-123/in` → `devices/device-123/out`).

**Important:** The reply topic must not be in `topics.subscribe`. Use different paths for in and out (e.g. `.../in` vs `.../out`).

## Inbound message format (JSON)

Payload must be JSON. Required fields:

- **messageId:** unique id (used for deduplication).
- **text:** message body.

Optional:

- **timestamp:** Unix ms or ISO8601 (used for age filtering).
- **replyTo:** messageId of the message being replied to.
- **clientId:** used when `fromExtractor` is `"payload"` or `"topic+payload"`.
- **replyToTopic:** MQTT topic to publish replies to (required when `publishMode` is `"direct"` and no `publishPrefix`).

Example:

```json
{
  "messageId": "unique-id-123",
  "text": "Hello",
  "timestamp": 1706342400000,
  "replyToTopic": "devices/device-123/out"
}
```

## Configuration reference (v2)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `brokerUrl` | string | required | `mqtt://` or `mqtts://` URL |
| `topics.subscribe` | string[] | required | Topics to subscribe to |
| `topics.publishPrefix` | string | - | Reply topic template (`{to}` placeholder) |
| `topics.publishMode` | `"direct"` \| `"prefix"` | `"direct"` | How reply topic is determined |
| `ignoreRetainedMessages` | boolean | `true` | Ignore retain flag |
| `ignoreMessagesOlderThanMs` | number | `300000` | Ignore messages older than this after startup |
| `cleanSession` | boolean | `false` | MQTT clean session |
| `keepalive` | number | `60` | Keepalive in seconds |
| `qos.subscribe` / `qos.publish` | 0 \| 1 \| 2 | `1` | QoS for subscribe and publish |
| `maxMessageSize` | number | `200000` | Max publish size (bytes) |
| `fromExtractor` | `"topic"` \| `"payload"` \| `"topic+payload"` | `"topic"` | How to derive sender id |
| `allowFrom` | (string \| number)[] | `[]` | Topic/sender allowlist |
| `dmPolicy` | string | - | `pairing`, `allowlist`, `open`, `disabled` |

## Security

- Prefer `mqtts://` and TLS in production.
- Use `allowFrom` and `dmPolicy` to restrict which topics/senders can trigger the agent.

## References

- Implementation scheme: `.wiki/MQTT-Channel-实现方案-v2.md`
- Channel docs: [docs.clawd.bot/channels/mqtt](https://docs.clawd.bot/channels/mqtt)
