#!/usr/bin/env node
/**
 * 测试 Gateway Bridge 连通性：连接同一 Broker，向 moltbot/gw/{clientId}/operator/req
 * 发送一条最小 connect 请求，订阅 res，收到任意 res 即表示 bridge 已转发且网关已响应。
 *
 * Broker 若要求 clientId 为纯字母，脚本会使用随机纯字母（未设置 MQTT_CLIENT_ID 时）。
 * 若出现 "Identifier rejected"，可能是：同一 username 仅允许一个连接（先停 Gateway 再测）、
 * 或需在控制台预注册 clientId 格式。
 *
 * 用法：
 *   BROKER_URL=wss://... USERNAME=... PASSWORD=... node scripts/test-bridge.js
 *   MQTT_CLIENT_ID=自定义纯字母id  # 可选，Broker 有要求时指定
 */

const mqtt = (await import("mqtt")).default;

function randomAlpha(len = 12) {
  const a = "abcdefghijklmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < len; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
const topicClientId = "testbridge" + randomAlpha(10);
const reqTopic = `moltbot/gw/${topicClientId}/operator/req`;
const resTopic = `moltbot/gw/${topicClientId}/operator/res`;

function parseArgs() {
  const args = process.argv.slice(2);
  let brokerUrl = process.env.BROKER_URL || process.env.MQTT_BROKER_URL;
  let username = process.env.USERNAME || process.env.MQTT_USERNAME;
  let password = process.env.PASSWORD || process.env.MQTT_PASSWORD;
  let clientIdPrefix = process.env.MQTT_CLIENT_ID;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--broker" && args[i + 1]) {
      brokerUrl = args[++i];
    } else if (args[i] === "--username" && args[i + 1]) {
      username = args[++i];
    } else if (args[i] === "--password" && args[i + 1]) {
      password = args[++i];
    } else if (args[i] === "--client-id" && args[i + 1]) {
      clientIdPrefix = args[++i];
    }
  }
  return { brokerUrl, username, password, clientIdPrefix };
}

const { brokerUrl, username, password, clientIdPrefix } = parseArgs();
if (!brokerUrl) {
  console.error("Usage: BROKER_URL=wss://... USERNAME=... PASSWORD=... node scripts/test-bridge.js");
  process.exit(1);
}

const req = JSON.stringify({
  type: "req",
  id: "1",
  method: "connect",
  params: {
    minProtocol: 1,
    maxProtocol: 1,
    client: {
      id: topicClientId,
      version: "1.0",
      platform: "node",
      mode: "operator",
    },
  },
});

const runnerClientId = (clientIdPrefix && clientIdPrefix.trim())
  ? clientIdPrefix.trim()
  : randomAlpha(16);
if (process.env.DEBUG_BRIDGE) {
  console.error("[test-bridge] topic clientId:", topicClientId, "mqtt clientId:", runnerClientId);
}
const client = mqtt.connect(brokerUrl, {
  clientId: runnerClientId,
  clean: true,
  username: username || undefined,
  password: password || undefined,
  connectTimeout: 15000,
});

let resolved = false;
const done = (ok, msg) => {
  if (resolved) return;
  resolved = true;
  client.end(true);
  if (ok) {
    console.log("OK: bridge responded –", msg);
    process.exit(0);
  } else {
    console.error("FAIL:", msg);
    process.exit(1);
  }
};

client.on("connect", () => {
  client.subscribe(resTopic, { qos: 1 }, (err) => {
    if (err) {
      done(false, "subscribe failed: " + err.message);
      return;
    }
    client.publish(reqTopic, req, { qos: 1 }, (pubErr) => {
      if (pubErr) done(false, "publish failed: " + pubErr.message);
    });
  });
});

client.on("message", (topic, payload) => {
  if (topic !== resTopic) return;
  const text = payload.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    done(false, "invalid res JSON");
    return;
  }
  if (parsed?.type === "res") {
    if (parsed.ok) {
      done(true, "connect ok (unexpected for minimal params)");
    } else {
      done(true, "gateway returned error (bridge working): " + (parsed.error?.message || parsed.error?.code || "unknown"));
    }
  }
});

client.on("error", (err) => {
  done(false, "mqtt error: " + err.message);
});

setTimeout(() => {
  if (!resolved) {
    done(false, "timeout (no res in 10s). Is gateway running with gatewayBridge.enabled and same broker?");
  }
}, 10000);
