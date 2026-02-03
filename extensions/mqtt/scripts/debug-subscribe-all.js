#!/usr/bin/env node
/**
 * 调试用：订阅 MQTT 全量主题 "#"，打印所有收到的消息，便于查看收发情况。
 *
 * 用法（环境变量）：
 *   MQTT_BROKER_URL=mqtt://host:1883 MQTT_USERNAME=... MQTT_PASSWORD=... node scripts/debug-subscribe-all.js
 *
 * 用法（命令行参数）：
 *   node scripts/debug-subscribe-all.js --broker mqtt://host:1883 --username ... --password ...
 *
 * 注意：不要将真实密码提交到仓库；本地调试时用环境变量或临时传参即可。
 */

const mqtt = (await import("mqtt")).default;

const DEBUG_CLIENT_ID_PREFIX = "debug-subscribe-all-";
const QOS = 1;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** 仅做 UTF-8 校验：非 UTF-8 时显示占位说明，避免乱码；不做额外解析。 */
function payloadToDisplay(payload) {
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (buf.length === 0) return "(空)";
  let str;
  try {
    str = utf8Decoder.decode(buf);
  } catch {
    return `(非 UTF-8，${buf.length} 字节)`;
  }
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  let brokerUrl = process.env.MQTT_BROKER_URL || process.env.BROKER_URL;
  let username = process.env.MQTT_USERNAME;
  let password = process.env.MQTT_PASSWORD;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--broker" && args[i + 1]) brokerUrl = args[++i];
    else if (args[i] === "--username" && args[i + 1]) username = args[++i];
    else if (args[i] === "--password" && args[i + 1]) password = args[++i];
  }
  return { brokerUrl, username, password };
}

const { brokerUrl, username, password } = parseArgs();
if (!brokerUrl) {
  console.error("Usage: MQTT_BROKER_URL=... MQTT_USERNAME=... MQTT_PASSWORD=... node scripts/debug-subscribe-all.js");
  process.exit(1);
}

const clientId = DEBUG_CLIENT_ID_PREFIX + Math.random().toString(36).slice(2, 10);

const client = mqtt.connect(brokerUrl, {
  clientId,
  username: username || undefined,
  password: password || undefined,
  clean: true,
  keepalive: 60,
  protocolVersion: 4, // MQTT 3.1.1（百度 IoT 等要求）
});

client.on("connect", () => {
  console.log("[connect] 已连接 broker，clientId=%s，订阅 # ...", clientId);
  client.subscribe("#", { qos: QOS }, (err) => {
    if (err) {
      console.error("[subscribe] 订阅失败:", err);
      process.exitCode = 1;
      return;
    }
    console.log("[subscribe] 已订阅 #，等待消息（Ctrl+C 退出）\n");
  });
});

client.on("message", (topic, payload) => {
  const body = payloadToDisplay(payload);
  const ts = new Date().toISOString();
  console.log("[%s] topic: %s\n%s\n", ts, topic, body);
});

client.on("error", (err) => {
  console.error("[error]", err);
});

client.on("close", () => {
  console.log("[close] 连接已关闭");
});

client.on("offline", () => {
  console.log("[offline] 客户端离线");
});

process.on("SIGINT", () => {
  client.end();
});
