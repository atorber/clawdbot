#!/usr/bin/env node
/**
 * 按 MQTT Bridge 的逻辑直连 Gateway WebSocket：
 * - WS 打开后立即发送首条请求（不等待 connect.challenge，Bridge 会忽略 challenge）
 * - 使用 Gateway 允许的 client.id / client.mode（与 protocol 一致）
 *
 * 用法：node scripts/test-gateway-ws.js [ws://127.0.0.1:18789]
 */

const wsUrl = process.argv[2] || "ws://127.0.0.1:18789";
const WebSocket = (await import("ws")).default;

// Gateway 只接受规定的 client.id / client.mode（见 src/gateway/protocol/client-info.ts）
const req = JSON.stringify({
  type: "req",
  id: "1",
  method: "connect",
  params: {
    minProtocol: 3,
    maxProtocol: 3,
    client: {
      id: "test",
      version: "1.0",
      platform: "node",
      mode: "test",
    },
  },
});

const ws = new WebSocket(wsUrl);

ws.on("open", () => {
  // Bridge 逻辑：open 后立即发送 initialReq，不等待 connect.challenge
  ws.send(req);
});

ws.on("message", (data) => {
  const text = data.toString("utf8");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error("invalid JSON:", text.slice(0, 200));
    return;
  }
  if (parsed?.type === "event" && parsed?.event === "connect.challenge") {
    return;
  }
  if (parsed?.type === "res") {
    if (parsed.ok) {
      console.log("OK: gateway responded (connect ok)");
    } else {
      console.log("OK: gateway responded (error):", parsed.error?.message || parsed.error?.code);
    }
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (err) => {
  console.error("FAIL: ws error –", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("FAIL: timeout (no res in 8s). Is gateway listening on", wsUrl, "?");
  ws.close();
  process.exit(1);
}, 8000);
