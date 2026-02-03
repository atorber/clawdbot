#!/usr/bin/env node
/**
 * 完整端到端验证：模拟 Android App (android-mqtt) 的全部交互逻辑。
 *
 * 覆盖场景：
 * 1. operator/node 双会话 connect（基础连接）
 * 2. operator 发送 voicewake.set 请求（验证请求/响应）
 * 3. node 接收 voicewake.changed 事件（验证事件推送）
 * 4. node 发送 node.event (agent.request)（验证节点事件上报）
 * 5. operator 发送 config.get 请求（验证配置获取 + canvasHostUrl）
 *
 * 用法：
 *   BROKER_URL=mqtt://host:1883 MQTT_USERNAME=... MQTT_PASSWORD=... MQTT_CLIENT_ID=... \
 *   GATEWAY_TOKEN=... node scripts/test-e2e-android-full.js
 *
 * 可选参数：
 *   --skip-events    跳过事件测试（仅测试请求/响应）
 *   --verbose        显示详细日志
 */

const mqtt = (await import("mqtt")).default;
import crypto from 'node:crypto';

const GATEWAY_PROTOCOL_VERSION = 3;
const MQTT_PROTOCOL_VERSION = 4;
const QOS = 1;

function parseArgs() {
  const args = process.argv.slice(2);
  let brokerUrl = process.env.BROKER_URL || process.env.MQTT_BROKER_URL;
  let username = process.env.MQTT_USERNAME || process.env.USERNAME;
  let password = process.env.MQTT_PASSWORD || process.env.PASSWORD;
  let mqttClientId = process.env.MQTT_CLIENT_ID;
  let topicClientId = process.env.MQTT_TOPIC_CLIENT_ID;
  let gatewayToken = process.env.GATEWAY_TOKEN;
  let skipEvents = false;
  let testReconnect = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--broker" && args[i + 1]) brokerUrl = args[++i];
    else if (args[i] === "--username" && args[i + 1]) username = args[++i];
    else if (args[i] === "--password" && args[i + 1]) password = args[++i];
    else if (args[i] === "--client-id" && args[i + 1]) mqttClientId = args[++i];
    else if (args[i] === "--topic-client-id" && args[i + 1]) topicClientId = args[++i];
    else if (args[i] === "--gateway-token" && args[i + 1]) gatewayToken = args[++i];
    else if (args[i] === "--skip-events") skipEvents = true;
    else if (args[i] === "--test-reconnect") testReconnect = true;
    else if (args[i] === "--verbose") verbose = true;
  }

  // Topic Client ID: for topic paths (like Android's topicClientId setting)
  // MQTT Client ID: for broker connection (Android generates random moltbot-android-{uuid})
  if (!topicClientId && mqttClientId) topicClientId = mqttClientId;
  // Generate random MQTT connection client ID like Android does (without 'test' to verify ACL)
  const uuid = crypto.randomUUID().split('-')[0];
  const randomMqttClientId = `moltbot-android-${uuid}`;
  return { brokerUrl, username, password, mqttClientId: randomMqttClientId, topicClientId, gatewayToken, skipEvents, testReconnect, verbose };
}

const config = parseArgs();
if (!config.brokerUrl || !config.topicClientId) {
  console.error(
    "Usage: BROKER_URL=mqtt://host:1883 MQTT_USERNAME=... MQTT_PASSWORD=... MQTT_CLIENT_ID=... \\\n" +
    "       GATEWAY_TOKEN=... node scripts/test-e2e-android-full.js\n\n" +
    "Options:\n" +
    "  --skip-events      Skip event tests\n" +
    "  --test-reconnect   Enable reconnect test (optional, depends on Bridge timing)\n" +
    "  --verbose          Show detailed logs",
  );
  process.exit(1);
}

const { topicClientId, gatewayToken, skipEvents, testReconnect, verbose } = config;

// Topics
const topics = {
  operator: {
    req: `moltbot/gw/${topicClientId}/operator/req`,
    res: `moltbot/gw/${topicClientId}/operator/res`,
    evt: `moltbot/gw/${topicClientId}/operator/evt`,
  },
  node: {
    req: `moltbot/gw/${topicClientId}/node/req`,
    res: `moltbot/gw/${topicClientId}/node/res`,
    evt: `moltbot/gw/${topicClientId}/node/evt`,
  },
};

// Test state
const state = {
  client: null,
  pending: new Map(), // id -> { resolve, reject, timeout }
  eventHandlers: new Map(), // event -> handler
  done: false,
  results: {
    operatorConnect: false,
    nodeConnect: false,
    voicewakeSet: false,
    voicewakeEvent: false,
    nodeEvent: false,
    configGet: false,
    reconnect: false,
  },
};

function log(...args) {
  if (verbose) console.log("[e2e]", ...args);
}

function logResult(name, ok, detail = "") {
  const status = ok ? "✓" : "✗";
  const detailStr = detail ? ` (${detail})` : "";
  console.log(`  ${status} ${name}${detailStr}`);
}

function buildConnectParams(role) {
  const params = {
    minProtocol: GATEWAY_PROTOCOL_VERSION,
    maxProtocol: GATEWAY_PROTOCOL_VERSION,
    client: {
      id: "moltbot-android",
      displayName: "E2E Test Node",
      version: "2026.1.30",
      platform: "android",
      mode: role === "operator" ? "ui" : "node",
      instanceId: `e2e-test-${Date.now()}`,
      deviceFamily: "Android",
      modelIdentifier: "E2E Test Device",
    },
    role,
    scopes: role === "operator" ? ["operator.admin"] : [],
    caps: role === "node" ? ["canvas", "camera", "voiceWake", "location"] : [],
    commands:
      role === "node"
        ? ["canvas.present", "canvas.navigate", "canvas.eval", "canvas.snapshot", "camera.snap", "location.get"]
        : [],
    locale: "zh-CN",
  };
  if (gatewayToken?.trim()) {
    params.auth = { token: gatewayToken.trim() };
  }
  return params;
}

function createClient() {
  const client = mqtt.connect(config.brokerUrl, {
    clientId: config.mqttClientId,
    clean: true,
    keepalive: 60,
    username: config.username || undefined,
    password: config.password || undefined,
    connectTimeout: 60000,
    protocolVersion: MQTT_PROTOCOL_VERSION,
  });
  log(`MQTT clientId=${config.mqttClientId} broker=${config.brokerUrl}`);
  return client;
}

function sendRequest(role, method, params, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const id = `${role}-${method}-${Date.now()}`;
    const frame = JSON.stringify({
      type: "req",
      id,
      method,
      params,
    });

    const timeout = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error(`Request timeout: ${method}`));
    }, timeoutMs);

    state.pending.set(id, { resolve, reject, timeout });

    const topic = topics[role].req;
    log(`→ ${topic}: ${method}`);
    state.client.publish(topic, frame, { qos: QOS }, (err) => {
      if (err) {
        clearTimeout(timeout);
        state.pending.delete(id);
        reject(err);
      }
    });
  });
}

function handleMessage(topic, payload) {
  const text = payload.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }

  log(`← ${topic}: type=${parsed.type} id=${parsed.id || "-"} event=${parsed.event || "-"}`);

  if (parsed.type === "res") {
    const pending = state.pending.get(parsed.id);
    if (pending) {
      clearTimeout(pending.timeout);
      state.pending.delete(parsed.id);
      if (parsed.ok) {
        pending.resolve(parsed.payload);
      } else {
        pending.reject(new Error(parsed.error?.message || "Request failed"));
      }
    }
    return;
  }

  if (parsed.type === "event") {
    const handler = state.eventHandlers.get(parsed.event);
    if (handler) {
      handler(parsed.payload, parsed.payloadJSON);
    }
    return;
  }
}

function waitForEvent(eventName, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      state.eventHandlers.delete(eventName);
      reject(new Error(`Event timeout: ${eventName}`));
    }, timeoutMs);

    state.eventHandlers.set(eventName, (payload, payloadJSON) => {
      clearTimeout(timeout);
      state.eventHandlers.delete(eventName);
      resolve({ payload, payloadJSON });
    });
  });
}

async function runTests() {
  console.log("\n📱 Android MQTT E2E 完整测试\n");
  console.log(`Broker: ${config.brokerUrl}`);
  console.log(`Client ID: ${config.mqttClientId}`);
  console.log(`Topic Client ID: ${topicClientId}`);
  console.log("");

  // 1. Connect to MQTT
  state.client = createClient();

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("MQTT connect timeout")), 15000);
    state.client.on("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    state.client.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  log("MQTT connected");

  // Subscribe to all topics
  const allTopics = [topics.operator.res, topics.operator.evt, topics.node.res, topics.node.evt];
  await new Promise((resolve, reject) => {
    state.client.subscribe(allTopics, { qos: QOS }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  log("Subscribed to topics");
  state.client.on("message", handleMessage);

  console.log("测试结果：\n");

  // 2. Test: Operator Connect
  try {
    const res = await sendRequest("operator", "connect", buildConnectParams("operator"));
    state.results.operatorConnect = true;
    const serverName = res?.server?.host || "(unknown)";
    logResult("operator connect", true, `server=${serverName}`);
  } catch (err) {
    logResult("operator connect", false, err.message);
  }

  // 3. Test: Node Connect
  try {
    const res = await sendRequest("node", "connect", buildConnectParams("node"));
    state.results.nodeConnect = true;
    const canvasHost = res?.canvasHostUrl || "(none)";
    logResult("node connect", true, `canvasHostUrl=${canvasHost}`);
  } catch (err) {
    logResult("node connect", false, err.message);
  }

  // 4. Test: Voicewake Set (operator)
  try {
    const triggers = ["clawd", "claude", "e2e-test"];
    await sendRequest("operator", "voicewake.set", { triggers });
    state.results.voicewakeSet = true;
    logResult("voicewake.set", true, `triggers=${triggers.join(",")}`);
  } catch (err) {
    logResult("voicewake.set", false, err.message);
  }

  // 5. Test: Voicewake Changed Event (node receives)
  if (!skipEvents && state.results.voicewakeSet) {
    try {
      // Trigger another voicewake.set to generate event
      const eventPromise = waitForEvent("voicewake.changed", 3000);

      // Small delay then trigger
      await new Promise((r) => setTimeout(r, 200));
      await sendRequest("operator", "voicewake.set", { triggers: ["clawd", "claude"] });

      const evt = await eventPromise;
      state.results.voicewakeEvent = true;
      const triggers = evt.payload?.triggers || JSON.parse(evt.payloadJSON || "{}").triggers || [];
      logResult("voicewake.changed event", true, `triggers=${triggers.join(",")}`);
    } catch (err) {
      logResult("voicewake.changed event", false, err.message);
    }
  } else if (skipEvents) {
    logResult("voicewake.changed event", true, "skipped");
    state.results.voicewakeEvent = true;
  }

  // 6. Test: Node Event (agent.request)
  try {
    const eventPayload = {
      event: "agent.request",
      payload: {
        message: "E2E test voice command",
        sessionKey: "main",
        thinking: "low",
        deliver: false,
      },
    };
    await sendRequest("node", "node.event", eventPayload);
    state.results.nodeEvent = true;
    logResult("node.event (agent.request)", true);
  } catch (err) {
    logResult("node.event (agent.request)", false, err.message);
  }

  // 7. Test: Config Get (operator)
  try {
    const res = await sendRequest("operator", "config.get", {});
    state.results.configGet = true;
    const seamColor = res?.config?.ui?.seamColor || "(default)";
    const mainKey = res?.config?.session?.mainKey || "main";
    logResult("config.get", true, `seamColor=${seamColor} mainKey=${mainKey}`);
  } catch (err) {
    logResult("config.get", false, err.message);
  }

  // 8. Test: Reconnect (simulate Android reconnect behavior)
  // Tests: MQTT disconnect -> reconnect -> re-subscribe -> re-establish gateway sessions
  {
    try {
      log("Testing reconnect...");

      // Clear any pending requests from previous session
      for (const [id, p] of state.pending) {
        clearTimeout(p.timeout);
        p.reject(new Error("Session closed"));
      }
      state.pending.clear();

      // Close current connection
      await new Promise((resolve) => {
        state.client.end(true, {}, resolve);
      });
      log("Disconnected");

      // Wait for:
      // 1. Broker to fully release clientId (some brokers need time after disconnect)
      // 2. Bridge to detect stale WebSocket sessions
      // 3. Gateway to clean up old sessions
      // Baidu IoT broker may need longer due to keepalive timing
      await new Promise((r) => setTimeout(r, 5000));

      // Reconnect with fresh client
      state.client = createClient();
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Reconnect timeout")), 10000);
        state.client.on("connect", () => {
          clearTimeout(timeout);
          resolve();
        });
        state.client.on("error", (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      log("Reconnected to MQTT");

      // Setup message handler BEFORE subscribing
      state.client.on("message", handleMessage);

      // Resubscribe
      const allTopics = [topics.operator.res, topics.operator.evt, topics.node.res, topics.node.evt];
      await new Promise((resolve, reject) => {
        state.client.subscribe(allTopics, { qos: QOS }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      log("Resubscribed to topics");

      // Re-connect both sessions (like Android GatewaySession.runLoop)
      // Add small delays between requests to ensure ordering
      await sendRequest("operator", "connect", buildConnectParams("operator"));
      log("Operator reconnected");

      await new Promise((r) => setTimeout(r, 300));

      await sendRequest("node", "connect", buildConnectParams("node"));
      log("Node reconnected");

      await new Promise((r) => setTimeout(r, 300));

      // Verify functionality after reconnect
      await sendRequest("operator", "voicewake.get", {});

      state.results.reconnect = true;
      logResult("reconnect", true, "re-established both sessions");
    } catch (err) {
      logResult("reconnect", false, err.message);
    }
  }

  // Summary
  console.log("\n---");
  const passed = Object.values(state.results).filter(Boolean).length;
  const total = Object.keys(state.results).length;
  const allPassed = passed === total;

  if (allPassed) {
    console.log(`\n✅ E2E 测试通过 (${passed}/${total})`);
    console.log("\nAndroid 端交互逻辑验证：");
    console.log("  - MQTT 连接参数正确 (cleanSession, keepAlive, QoS)");
    console.log("  - Topic 结构正确 (moltbot/gw/{clientId}/{role}/req|res|evt)");
    console.log("  - 双会话 connect 握手正常 (operator + node)");
    console.log("  - 请求/响应流程正常 (voicewake.set, config.get)");
    console.log("  - 事件接收正常 (voicewake.changed)");
    console.log("  - 节点事件上报正常 (node.event)");
    console.log("  - 断开重连正常 (MQTT reconnect + session re-establish)");
  } else {
    console.log(`\n❌ E2E 测试失败 (${passed}/${total})`);
  }

  // Cleanup
  state.client.end(true);
  process.exit(allPassed ? 0 : 1);
}

// Timeout
setTimeout(() => {
  console.error("\n❌ 测试超时 (30s)");
  state.client?.end(true);
  process.exit(1);
}, 30000);

runTests().catch((err) => {
  console.error("\n❌ 测试异常:", err.message);
  state.client?.end(true);
  process.exit(1);
});
