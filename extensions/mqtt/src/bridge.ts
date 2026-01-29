/**
 * Gateway Bridge: bridges MQTT topics (moltbot/gw/{clientId}/{role}/req|res|evt) to the
 * gateway WebSocket. Android (and other) MQTT clients publish req and subscribe to res/evt;
 * the bridge subscribes to req, opens a WebSocket to the gateway per (clientId, role),
 * forwards req to WS and publishes WS res/event to MQTT. Connections to ws://127.0.0.1
 * are treated as local by the gateway, so device nonce is not required.
 *
 * clientId design (why topic cannot share the same clientId as Bridge):
 * - Broker allows only one connection per clientId; if Bridge and a client used the same
 *   connection clientId, they would kick each other. So Bridge connection clientId uses
 *   reserved prefix "moltbot-bridge-" and never equals a client's.
 * - Topic path {clientId} is always the *client's* identity (who sent req / who gets res|evt).
 *   Bridge subscribes to moltbot/gw/+/role/req, parses clientId from the received topic, and
 *   publishes res/evt to moltbot/gw/{thatClientId}/role/res|evt. Bridge does not appear as
 *   clientId in any topic; clients are isolated by their own clientId in the path.
 *
 * Protocol alignment with Android (MqttGatewayConnection.kt):
 * - Topics: moltbot/gw/{clientId}/{operator|node}/req (pub from client), res/evt (sub).
 * - Payload: UTF-8 JSON. Req = { type:"req", id, method, params? }; res = { type:"res", id, ok, payload?, error? }; event = { type:"event", event, payload?, seq? }.
 * - Bridge forwards req as-is; publishes full WS frame for res/evt. Android parses type and handles res/event in GatewaySession.handleMessage.
 */

import type { MqttClient } from "mqtt";
import mqtt from "mqtt";
import WebSocket from "ws";

import type { PluginRuntime } from "moltbot/plugin-sdk";

const TOPIC_PREFIX = "moltbot/gw";
/** Reserved prefix for Bridge MQTT clientId so it never equals Android/app clientId (one clientId = one connection on broker). */
const BRIDGE_CLIENT_ID_PREFIX = "moltbot-bridge-";
const REQ_OPERATOR = `${TOPIC_PREFIX}/+/operator/req`;
const REQ_NODE = `${TOPIC_PREFIX}/+/node/req`;
const QOS = 1;
const DEFAULT_MAX_MESSAGE_SIZE = 256 * 1024;
const DEFAULT_GATEWAY_WS_URL = "ws://127.0.0.1:18789";
/** Delay after stopping previous bridge before starting new one (allow broker to release clientId). */
const BRIDGE_RESTART_DELAY_MS = 3000;
/** Reconnect interval when MQTT disconnects; longer to reduce clientId conflict with broker. */
const BRIDGE_RECONNECT_PERIOD_MS = 5000;
/** Keepalive (seconds): send PINGREQ this often so broker does not close for idle; use < broker idle timeout. */
const BRIDGE_KEEPALIVE_S = 30;

let currentBridgeAbortController: AbortController | null = null;
let scheduledBridgeStartTimeout: ReturnType<typeof setTimeout> | null = null;
/** Ignore repeated startGatewayBridge calls within this window to avoid restart storms. */
const BRIDGE_START_COOLDOWN_MS = 30_000;
let lastBridgeStartTime = 0;

type BridgeConfig = {
  enabled: boolean;
  gatewayWsUrl: string;
  brokerUrl: string;
  username?: string;
  password?: string;
  clientId: string;
  maxMessageSize: number;
};

function getBridgeConfig(runtime: PluginRuntime): BridgeConfig | null {
  const cfg = runtime.config.loadConfig() as {
    channels?: { mqtt?: { gatewayBridge?: Record<string, unknown>; accounts?: Record<string, { brokerUrl?: string; username?: string; password?: string }> } };
  };
  const mqtt = cfg?.channels?.mqtt;
  const bridge = mqtt?.gatewayBridge;
  if (!bridge || typeof bridge !== "object") return null;
  const enabled = bridge.enabled === true;
  if (!enabled) return null;
  let brokerUrl = String(bridge.brokerUrl ?? "").trim();
  let username: string | undefined = typeof bridge.username === "string" ? bridge.username : undefined;
  let password: string | undefined = typeof bridge.password === "string" ? bridge.password : undefined;
  if (!brokerUrl && mqtt?.accounts && typeof mqtt.accounts === "object") {
    const first = Object.values(mqtt.accounts)[0] as { brokerUrl?: string; username?: string; password?: string } | undefined;
    if (first?.brokerUrl) {
      brokerUrl = String(first.brokerUrl).trim();
      if (username === undefined) username = typeof first.username === "string" ? first.username : undefined;
      if (password === undefined) password = typeof first.password === "string" ? first.password : undefined;
    }
  }
  if (!brokerUrl) return null;
  const gatewayWsUrl = String(bridge.gatewayWsUrl ?? DEFAULT_GATEWAY_WS_URL).trim() || DEFAULT_GATEWAY_WS_URL;
  const raw = String(bridge.clientId ?? "").trim();
  const suffix = raw || Array.from({ length: 12 }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
  const clientId =
    suffix.startsWith(BRIDGE_CLIENT_ID_PREFIX) ? suffix : `${BRIDGE_CLIENT_ID_PREFIX}${suffix}`;
  const maxMessageSize =
    typeof bridge.maxMessageSize === "number" && bridge.maxMessageSize > 0
      ? bridge.maxMessageSize
      : DEFAULT_MAX_MESSAGE_SIZE;
  return {
    enabled: true,
    gatewayWsUrl,
    brokerUrl,
    username,
    password,
    clientId,
    maxMessageSize,
  };
}

function parseReqTopic(topic: string): { clientId: string; role: string } | null {
  const parts = topic.split("/");
  if (
    parts.length !== 5 ||
    parts[0] !== "moltbot" ||
    parts[1] !== "gw" ||
    (parts[3] !== "operator" && parts[3] !== "node") ||
    parts[4] !== "req"
  )
    return null;
  const clientId = parts[2];
  const role = parts[3];
  return { clientId, role };
}

function resTopic(clientId: string, role: string): string {
  return `${TOPIC_PREFIX}/${clientId}/${role}/res`;
}

function evtTopic(clientId: string, role: string): string {
  return `${TOPIC_PREFIX}/${clientId}/${role}/evt`;
}

type Session = {
  ws: WebSocket;
  clientId: string;
  role: string;
  publish: (topic: string, payload: string | Buffer, opts?: { qos?: 0 | 1 | 2 }) => void;
  maxMessageSize: number;
  log: { info?: (msg: string) => void; warn?: (msg: string) => void };
};

/**
 * Creates a WebSocket session to the gateway. When WS opens, the gateway sends
 * connect.challenge; we ignore it. Then we send initialReq (the first MQTT req that
 * triggered this session). Resolves when WS is open and initialReq has been sent.
 */
function createSession(
  clientId: string,
  role: string,
  gatewayWsUrl: string,
  initialReq: string,
  publish: (topic: string, payload: string | Buffer, opts?: { qos?: 0 | 1 | 2 }) => void,
  maxMessageSize: number,
  log: { info?: (msg: string) => void; warn?: (msg: string) => void },
  onClose: () => void,
): Promise<Session> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(gatewayWsUrl);
    let resolved = false;

    const session: Session = {
      ws,
      clientId,
      role,
      publish,
      maxMessageSize,
      log,
    };

    ws.on("open", () => {
      try {
        ws.send(initialReq);
      } catch (e) {
        if (!resolved) {
          resolved = true;
          reject(e);
        }
        return;
      }
      if (!resolved) {
        resolved = true;
        resolve(session);
      }
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const text = typeof data === "string" ? data : data.toString("utf8");
      let parsed: { type?: string; event?: string; id?: string };
      try {
        parsed = JSON.parse(text) as { type?: string; event?: string; id?: string };
      } catch {
        return;
      }
      if (parsed?.type === "event") {
        if (parsed.event === "connect.challenge") return;
        const payload = JSON.stringify(parsed);
        if (payload.length > maxMessageSize) {
          log.warn?.(`[bridge] evt too large for ${clientId}/${role}, dropping`);
          return;
        }
        publish(evtTopic(clientId, role), payload, { qos: QOS });
        return;
      }
      if (parsed?.type === "res") {
        const payload = JSON.stringify(parsed);
        if (payload.length > maxMessageSize) {
          log.warn?.(`[bridge] res too large for ${clientId}/${role}, dropping`);
          return;
        }
        publish(resTopic(clientId, role), payload, { qos: QOS });
      }
    });

    ws.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
      log.warn?.(`[bridge] WS error ${clientId}/${role}: ${String(err)}`);
    });

    ws.on("close", () => {
      onClose();
    });
  });
}

function sendPayload(session: Session, reqJson: string): void {
  try {
    session.ws.send(reqJson);
  } catch (e) {
    session.log.warn?.(`[bridge] WS send failed ${session.clientId}/${session.role}: ${String(e)}`);
  }
}

export function startGatewayBridge(runtime: PluginRuntime): void {
  const log =
    (runtime as { logging?: { getChildLogger?: (bindings: object, opts?: object) => { info?: (m: string) => void; warn?: (m: string) => void } } }).logging?.getChildLogger?.(
      { subsystem: "mqtt-bridge" },
      {},
    ) ?? {};
  const now = Date.now();
  if (
    currentBridgeAbortController !== null &&
    now - lastBridgeStartTime < BRIDGE_START_COOLDOWN_MS
  ) {
    log.info?.(
      "[bridge] start ignored (bridge already running, cooldown " +
        `${Math.ceil((BRIDGE_START_COOLDOWN_MS - (now - lastBridgeStartTime)) / 1000)}s)`,
    );
    return;
  }
  if (scheduledBridgeStartTimeout !== null) {
    clearTimeout(scheduledBridgeStartTimeout);
    scheduledBridgeStartTimeout = null;
  }
  const hadPrevious = currentBridgeAbortController !== null;
  if (currentBridgeAbortController !== null) {
    currentBridgeAbortController.abort();
    currentBridgeAbortController = null;
  }
  const config = getBridgeConfig(runtime);
  if (!config) {
    log.info?.(
      "[bridge] not started: channels.mqtt.gatewayBridge missing or disabled, or brokerUrl empty",
    );
    return;
  }
  if (hadPrevious) {
    log.info?.(`[bridge] restarting in ${BRIDGE_RESTART_DELAY_MS / 1000}s (allow broker to release clientId)`);
    scheduledBridgeStartTimeout = setTimeout(() => {
      scheduledBridgeStartTimeout = null;
      runBridge(runtime);
    }, BRIDGE_RESTART_DELAY_MS);
    return;
  }
  runBridge(runtime);
}

function runBridge(runtime: PluginRuntime): void {
  const log =
    (runtime as { logging?: { getChildLogger?: (bindings: object, opts?: object) => { info?: (m: string) => void; warn?: (m: string) => void } } }).logging?.getChildLogger?.(
      { subsystem: "mqtt-bridge" },
      {},
    ) ?? {};
  const config = getBridgeConfig(runtime);
  if (!config) return;
  lastBridgeStartTime = Date.now();
  const controller = new AbortController();
  currentBridgeAbortController = controller;
  const abortSignal = controller.signal;

  log.info?.(`[bridge] starting broker=${config.brokerUrl} gatewayWs=${config.gatewayWsUrl} clientId=${config.clientId}`);

  const sessions = new Map<string, Session>();
  const pendingSessions = new Map<string, Promise<Session>>();
  const sessionKey = (clientId: string, role: string) => `${clientId}\0${role}`;

  const mqttClient: MqttClient = mqtt.connect(config.brokerUrl, {
    clientId: config.clientId,
    clean: true,
    keepalive: BRIDGE_KEEPALIVE_S,
    reconnectPeriod: BRIDGE_RECONNECT_PERIOD_MS,
    username: config.username,
    password: config.password,
    connectTimeout: 15000,
  });

  let handle: { publish: (topic: string, payload: string | Buffer, opts?: { qos?: 0 | 1 | 2 }) => void } | null = null;
  let lastDisconnectLogTime = 0;
  const DISCONNECT_LOG_INTERVAL_MS = 10_000;

  const payloadPreview = (p: string | Buffer, maxLen: number = 120): string => {
    const s = typeof p === "string" ? p : p.toString("utf8");
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + "...";
  };

  mqttClient.on("connect", () => {
    log.info?.("[bridge] MQTT connected");
    // Set handle immediately so we can publish error responses as soon as we receive any message.
    handle = {
      publish: (topic: string, payload: string | Buffer, opts?: { qos?: 0 | 1 | 2 }) => {
        log.info?.(`[bridge] MQTT send topic=${topic} payload=${payloadPreview(payload)}`);
        mqttClient.publish(topic, payload, { qos: opts?.qos ?? QOS });
      },
    };
    mqttClient.subscribe([REQ_OPERATOR, REQ_NODE], { qos: QOS }, (err) => {
      if (err) {
        log.warn?.(`[bridge] subscribe error: ${String(err)}`);
        return;
      }
      log.info?.("[bridge] subscribed to req topics");
    });
  });

  mqttClient.on("close", () => {
    handle = null;
    const now = Date.now();
    if (now - lastDisconnectLogTime >= DISCONNECT_LOG_INTERVAL_MS) {
      lastDisconnectLogTime = now;
      log.info?.(
        "[bridge] MQTT disconnected (keepalive=" +
          BRIDGE_KEEPALIVE_S +
          "s; will auto-reconnect; typical causes: broker idle timeout, duplicate clientId, or network)",
      );
    }
  });

  mqttClient.on("message", (topic: string, payload: Buffer) => {
    const parsed = parseReqTopic(topic);
    if (!parsed || !handle) return;
    const { clientId, role } = parsed;
    const reqJson = payload.toString("utf8");
    log.info?.(`[bridge] MQTT recv topic=${topic} clientId=${clientId} role=${role} payload=${payloadPreview(reqJson)}`);
    if (reqJson.length > config.maxMessageSize) {
      let id: string | undefined;
      try {
        const obj = JSON.parse(reqJson) as { id?: string };
        id = typeof obj?.id === "string" ? obj.id : undefined;
      } catch {
        // ignore
      }
      const errRes = JSON.stringify({
        type: "res",
        id: id ?? "",
        ok: false,
        error: { code: "PAYLOAD_TOO_LARGE", message: "Request payload exceeds max size" },
      });
      handle.publish(resTopic(clientId, role), errRes, { qos: QOS });
      return;
    }

    // Check if this is a connect request - if so, we need a fresh WebSocket session
    let isConnectRequest = false;
    try {
      const obj = JSON.parse(reqJson) as { method?: string };
      isConnectRequest = obj?.method === "connect";
    } catch {
      // ignore parse errors
    }

    const key = sessionKey(clientId, role);
    const existing = sessions.get(key);

    // For connect requests, always create a new session (gateway requires connect as first message)
    if (isConnectRequest && existing) {
      log.info?.(`[bridge] closing existing session for connect request ${clientId}/${role}`);
      try {
        existing.ws.close();
      } catch {
        // ignore
      }
      sessions.delete(key);
    } else if (existing && existing.ws.readyState === WebSocket.OPEN) {
      // For non-connect requests, reuse existing session
      sendPayload(existing, reqJson);
      return;
    } else if (existing) {
      // Stale session, remove it
      try {
        existing.ws.close();
      } catch {
        // ignore
      }
      sessions.delete(key);
    }

    // For connect requests, also clear any pending sessions
    if (isConnectRequest && pendingSessions.has(key)) {
      pendingSessions.delete(key);
    }

    let pending = pendingSessions.get(key);
    const weCreatedPending = !pending;
    if (!pending) {
      pending = createSession(
        clientId,
        role,
        config.gatewayWsUrl,
        reqJson,
        (t, p, opts) => {
          if (handle) handle.publish(t, p, opts);
        },
        config.maxMessageSize,
        log,
        () => {
          sessions.delete(key);
          pendingSessions.delete(key);
        },
      )
        .then((s) => {
          pendingSessions.delete(key);
          sessions.set(key, s);
          return s;
        })
        .catch((err) => {
          pendingSessions.delete(key);
          throw err;
        });
      pendingSessions.set(key, pending);
    }

    pending
      .then((s) => {
        if (!weCreatedPending && s.ws.readyState === WebSocket.OPEN) sendPayload(s, reqJson);
      })
      .catch((err) => {
        log.warn?.(`[bridge] session failed ${clientId}/${role}: ${String(err)}`);
        let id: string | undefined;
        try {
          const obj = JSON.parse(reqJson) as { id?: string };
          id = typeof obj?.id === "string" ? obj.id : undefined;
        } catch {
          // ignore
        }
        const errRes = JSON.stringify({
          type: "res",
          id: id ?? "",
          ok: false,
          error: { code: "BRIDGE_ERROR", message: String(err) },
        });
        if (handle) handle.publish(resTopic(clientId, role), errRes, { qos: QOS });
      });
  });

  mqttClient.on("error", (err) => {
    log.warn?.(`[bridge] MQTT error: ${String(err)} (connection may reconnect automatically)`);
  });

  abortSignal.addEventListener(
    "abort",
    () => {
      for (const s of sessions.values()) {
        try {
          s.ws.close();
        } catch {
          // ignore
        }
      }
      sessions.clear();
      try {
        mqttClient.end(true);
      } catch {
        // ignore
      }
      if (currentBridgeAbortController === controller) {
        currentBridgeAbortController = null;
      }
      log.info?.("[bridge] stopped");
    },
    { once: true },
  );
}
