#!/usr/bin/env node
/**
 * 端到端验证：MQTT 客户端模拟 Android App (MqttGatewayTransport) 行为。
 *
 * Android 行为：
 * - 每个 role (operator/node) 创建独立的 MQTT 连接
 * - MQTT clientId = `${clientId}_${role}`（如 ai_aihcmentor_operator）
 * - Topics = `moltbot/gw/${clientId}/${role}/req|res|evt`
 * - isCleanSession = true, keepAlive = 60, QoS = 1
 * - Gateway 协议版本 = 3
 *
 * 简化模式（默认）：
 * - 使用单个 MQTT 连接发送 operator + node 请求（避免需要注册多个设备）
 * - MQTT clientId = MQTT_CLIENT_ID 环境变量
 *
 * 完整模式（--full-simulation）：
 * - 创建两个独立连接，MQTT clientId 分别为 ${clientId}_operator 和 ${clientId}_node
 * - 需要在 Broker 控制台注册这两个设备
 *
 * 用法：
 *   BROKER_URL=mqtt://host:1883 MQTT_USERNAME=... MQTT_PASSWORD=... MQTT_CLIENT_ID=... node scripts/test-e2e-mqtt-client.js
 *   可选：GATEWAY_TOKEN=... 用于 gateway auth.mode=token 鉴权
 *   可选：MQTT_TOPIC_CLIENT_ID=... 用于 topic 路径中的 clientId（默认与 MQTT_CLIENT_ID 相同）
 *   可选：--full-simulation  完全模拟 Android 双连接行为
 *
 * 注意：不要用 USERNAME/PASSWORD，会被系统环境变量覆盖
 */

const mqtt = (await import("mqtt")).default;

const GATEWAY_PROTOCOL_VERSION = 3;
const MQTT_PROTOCOL_VERSION = 4; // MQTT 3.1.1（百度 IoT 等 broker 要求）
const QOS = 1;

function parseArgs() {
  const args = process.argv.slice(2);
  let brokerUrl = process.env.BROKER_URL || process.env.MQTT_BROKER_URL;
  // 注意：USERNAME 在 Unix/macOS 是系统环境变量（当前用户），优先用 MQTT_USERNAME
  let username = process.env.MQTT_USERNAME || process.env.USERNAME;
  let password = process.env.MQTT_PASSWORD || process.env.PASSWORD;
  let mqttClientId = process.env.MQTT_CLIENT_ID;
  let topicClientId = process.env.MQTT_TOPIC_CLIENT_ID;
  let gatewayToken = process.env.GATEWAY_TOKEN;
  let fullSimulation = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--broker" && args[i + 1]) brokerUrl = args[++i];
    else if (args[i] === "--username" && args[i + 1]) username = args[++i];
    else if (args[i] === "--password" && args[i + 1]) password = args[++i];
    else if (args[i] === "--client-id" && args[i + 1]) mqttClientId = args[++i];
    else if (args[i] === "--topic-client-id" && args[i + 1]) topicClientId = args[++i];
    else if (args[i] === "--gateway-token" && args[i + 1]) gatewayToken = args[++i];
    else if (args[i] === "--full-simulation") fullSimulation = true;
  }
  // 默认 topicClientId 与 mqttClientId 相同
  if (!topicClientId && mqttClientId) topicClientId = mqttClientId;
  return { brokerUrl, username, password, mqttClientId, topicClientId, gatewayToken, fullSimulation };
}

const { brokerUrl, username, password, mqttClientId, topicClientId, gatewayToken, fullSimulation } = parseArgs();
if (!brokerUrl || !mqttClientId) {
  console.error(
    "Usage: BROKER_URL=mqtt://host:1883 MQTT_USERNAME=... MQTT_PASSWORD=... MQTT_CLIENT_ID=... node scripts/test-e2e-mqtt-client.js\n" +
      "  MQTT_CLIENT_ID: Broker 接受的 clientId（百度 IoT 等需用控制台创建设备的 clientId）\n" +
      "  --full-simulation: 完全模拟 Android 双连接行为（需注册 ${clientId}_operator 和 ${clientId}_node 设备）",
  );
  process.exit(1);
}

// Topic 路径使用 topicClientId
const reqTopicOperator = `moltbot/gw/${topicClientId}/operator/req`;
const resTopicOperator = `moltbot/gw/${topicClientId}/operator/res`;
const evtTopicOperator = `moltbot/gw/${topicClientId}/operator/evt`;
const reqTopicNode = `moltbot/gw/${topicClientId}/node/req`;
const resTopicNode = `moltbot/gw/${topicClientId}/node/res`;
const evtTopicNode = `moltbot/gw/${topicClientId}/node/evt`;

function buildConnectParams(role) {
  const params = {
    minProtocol: GATEWAY_PROTOCOL_VERSION,
    maxProtocol: GATEWAY_PROTOCOL_VERSION,
    client: {
      id: "moltbot-android",
      version: "2026.1.29",
      platform: "android",
      mode: "node",
    },
    role,
    scopes: role === "operator" ? ["operator.admin"] : [],
    locale: "zh-CN",
  };
  if (gatewayToken && gatewayToken.trim()) {
    params.auth = { token: gatewayToken.trim() };
  }
  return params;
}

const reqOperator = JSON.stringify({
  type: "req",
  id: "op-1",
  method: "connect",
  params: buildConnectParams("operator"),
});

const reqNode = JSON.stringify({
  type: "req",
  id: "node-1",
  method: "connect",
  params: buildConnectParams("node"),
});

let operatorOk = false;
let nodeOk = false;
let done = false;

function checkDone(clients) {
  if (done) return;
  if (operatorOk && nodeOk) {
    done = true;
    console.log("E2E OK: operator and node both received res via MQTT → Bridge → Gateway");
    clients.forEach((c) => c.end(true));
    process.exit(0);
  }
}

function fail(msg, clients) {
  if (done) return;
  done = true;
  console.error("FAIL:", msg);
  clients.forEach((c) => c.end(true));
  process.exit(1);
}

/**
 * 创建 MQTT 连接，与 Android MqttGatewayTransport 对齐：
 * - isCleanSession = true
 * - keepAliveInterval = 60
 * - protocolVersion = 4 (MQTT 3.1.1)
 */
function createClient(clientIdSuffix) {
  const finalClientId = clientIdSuffix ? `${mqttClientId}_${clientIdSuffix}` : mqttClientId;
  const client = mqtt.connect(brokerUrl, {
    clientId: finalClientId,
    clean: true, // Android: isCleanSession = true
    keepalive: 60, // Android: keepAliveInterval = 60
    username: username || undefined,
    password: password || undefined,
    connectTimeout: 60000,
    protocolVersion: MQTT_PROTOCOL_VERSION,
  });
  console.error(`[e2e] MQTT clientId=${finalClientId} broker=${brokerUrl}`);
  return client;
}

if (fullSimulation) {
  // 完整模式：模拟 Android 为每个 role 创建独立连接
  console.error("[e2e] Full simulation mode: creating separate connections for operator and node");

  const operatorClient = createClient("operator");
  const nodeClient = createClient("node");
  const clients = [operatorClient, nodeClient];

  operatorClient.on("connect", () => {
    operatorClient.subscribe([resTopicOperator, evtTopicOperator], { qos: QOS }, (err) => {
      if (err) {
        fail("operator subscribe failed: " + err.message, clients);
        return;
      }
      operatorClient.publish(reqTopicOperator, reqOperator, { qos: QOS }, (pubErr) => {
        if (pubErr) fail("publish operator req failed: " + pubErr.message, clients);
      });
    });
  });

  nodeClient.on("connect", () => {
    nodeClient.subscribe([resTopicNode, evtTopicNode], { qos: QOS }, (err) => {
      if (err) {
        fail("node subscribe failed: " + err.message, clients);
        return;
      }
      // 等 operator 连接成功后再发 node connect
    });
  });

  operatorClient.on("message", (topic, payload) => {
    const text = payload.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed?.type !== "res") return;
    if (operatorOk) return;
    operatorOk = true;
    const ok = parsed.ok === true;
    const errMsg = parsed.error?.message || parsed.error?.code || "";
    console.log(ok ? "operator: connected" : `operator: res (error) – ${errMsg}`);
    // 发送 node connect
    nodeClient.publish(reqTopicNode, reqNode, { qos: QOS }, (pubErr) => {
      if (pubErr) fail("publish node req failed: " + pubErr.message, clients);
    });
    checkDone(clients);
  });

  nodeClient.on("message", (topic, payload) => {
    const text = payload.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed?.type !== "res") return;
    if (nodeOk) return;
    nodeOk = true;
    const ok = parsed.ok === true;
    const errMsg = parsed.error?.message || parsed.error?.code || "";
    console.log(ok ? "node: connected" : `node: res (error) – ${errMsg}`);
    checkDone(clients);
  });

  operatorClient.on("error", (err) => fail("operator mqtt error: " + err.message, clients));
  nodeClient.on("error", (err) => fail("node mqtt error: " + err.message, clients));

  setTimeout(() => {
    if (!done) {
      fail(
        `timeout (15s). operatorOk=${operatorOk} nodeOk=${nodeOk}. Is Gateway running with gatewayBridge?`,
        clients,
      );
    }
  }, 15000);
} else {
  // 简化模式：单个连接发送 operator + node 请求
  console.error("[e2e] Simplified mode: single connection for both roles");

  const client = createClient(null);
  const clients = [client];

  client.on("connect", () => {
    client.subscribe([resTopicOperator, resTopicNode, evtTopicOperator, evtTopicNode], { qos: QOS }, (err) => {
      if (err) {
        fail("subscribe failed: " + err.message, clients);
        return;
      }
      client.publish(reqTopicOperator, reqOperator, { qos: QOS }, (pubErr) => {
        if (pubErr) fail("publish operator req failed: " + pubErr.message, clients);
      });
    });
  });

  client.on("message", (topic, payload) => {
    const text = payload.toString("utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    if (parsed?.type !== "res") return;
    const ok = parsed.ok === true;
    const errMsg = parsed.error?.message || parsed.error?.code || "";

    if (topic === resTopicOperator) {
      if (operatorOk) return;
      operatorOk = true;
      console.log(ok ? "operator: connected" : `operator: res (error) – ${errMsg}`);
      client.publish(reqTopicNode, reqNode, { qos: QOS }, (pubErr) => {
        if (pubErr) fail("publish node req failed: " + pubErr.message, clients);
      });
      checkDone(clients);
      return;
    }
    if (topic === resTopicNode) {
      if (nodeOk) return;
      nodeOk = true;
      console.log(ok ? "node: connected" : `node: res (error) – ${errMsg}`);
      checkDone(clients);
    }
  });

  client.on("error", (err) => fail("mqtt error: " + err.message, clients));

  setTimeout(() => {
    if (!done) {
      fail(
        `timeout (15s). operatorOk=${operatorOk} nodeOk=${nodeOk}. Is Gateway running with gatewayBridge?`,
        clients,
      );
    }
  }, 15000);
}
