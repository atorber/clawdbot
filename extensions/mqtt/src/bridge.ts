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
 * - Payload: UTF-8 JSON only. Req = { type:"req", id, method, params? }; res = { type:"res", id, ok, payload?, error? }; event = { type:"event", event, payload?, seq? }.
 * - Bridge and Android use the same format: all MQTT payloads are JSON strings (no binary). Bridge publishes via publishJson (object → stringify); Android sends/receives UTF-8 JSON.
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
/** WebSocket connect timeout (ms): reject if WS doesn't open within this time. */
const WS_CONNECT_TIMEOUT_MS = 10_000;
/** WebSocket ping interval (ms): send ping to detect zombie connections. */
const WS_PING_INTERVAL_MS = 30_000;
/** WebSocket pong timeout (ms): close connection if no pong received within this time after ping. */
const WS_PONG_TIMEOUT_MS = 10_000;

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
  /** Publish JSON object to MQTT; payload is stringified internally. */
  publishJson: (topic: string, payloadObj: object) => void;
  maxMessageSize: number;
  log: { info?: (msg: string) => void; warn?: (msg: string) => void };
  /** Timestamp of last pong received (for health check). */
  lastPongTime: number;
  /** Ping interval timer (cleared on close). */
  pingTimer?: ReturnType<typeof setInterval>;
};

/** Pending session with version for race condition prevention. */
type PendingSession = {
  promise: Promise<Session>;
  /** Version number to detect stale promises after reconnect. */
  version: number;
  /** Queued requests to send once session is established (non-connect only). */
  queuedRequests: string[];
};

/**
 * Creates a WebSocket session to the gateway. When WS opens, the gateway sends
 * connect.challenge; we ignore it. Then we send initialReq (the first MQTT req that
 * triggered this session). Resolves when WS is open and initialReq has been sent.
 *
 * Includes:
 * - Connect timeout (WS_CONNECT_TIMEOUT_MS)
 * - Ping/pong health check (WS_PING_INTERVAL_MS / WS_PONG_TIMEOUT_MS)
 * - Close reason logging
 */
function createSession(
  clientId: string,
  role: string,
  gatewayWsUrl: string,
  initialReq: string,
  publishJsonToMqtt: (topic: string, payloadObj: object) => void,
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
      publishJson: publishJsonToMqtt,
      maxMessageSize,
      log,
      lastPongTime: Date.now(),
    };

    // Connect timeout: reject if WS doesn't open within WS_CONNECT_TIMEOUT_MS
    const connectTimeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { ws.close(); } catch {}
        reject(new Error(`WebSocket connect timeout (${WS_CONNECT_TIMEOUT_MS}ms)`));
      }
    }, WS_CONNECT_TIMEOUT_MS);

    const clearConnectTimeout = () => {
      clearTimeout(connectTimeout);
    };

    // Start ping/pong health check
    const startPingTimer = () => {
      session.pingTimer = setInterval(() => {
        const timeSinceLastPong = Date.now() - session.lastPongTime;
        if (timeSinceLastPong > WS_PING_INTERVAL_MS + WS_PONG_TIMEOUT_MS) {
          log.warn?.(`[bridge] WS pong timeout ${clientId}/${role} (${timeSinceLastPong}ms since last pong), closing`);
          try { ws.close(); } catch {}
          return;
        }
        try {
          ws.ping();
        } catch (e) {
          log.warn?.(`[bridge] WS ping failed ${clientId}/${role}: ${String(e)}`);
        }
      }, WS_PING_INTERVAL_MS);
    };

    const stopPingTimer = () => {
      if (session.pingTimer) {
        clearInterval(session.pingTimer);
        session.pingTimer = undefined;
      }
    };

    ws.on("pong", () => {
      session.lastPongTime = Date.now();
    });

    ws.on("open", () => {
      clearConnectTimeout();
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
        startPingTimer();
        resolve(session);
      }
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const raw = typeof data === "string" ? data : data.toString("utf8");
      const text = raw.replace(/\0/g, "").trim();
      if (!text) return;
      let parsed: { type?: string; event?: string; id?: string; ok?: boolean; error?: { code?: string; message?: string } };
      try {
        parsed = JSON.parse(text) as { type?: string; event?: string; id?: string; ok?: boolean; error?: { code?: string; message?: string } };
      } catch {
        return;
      }
      if (parsed?.type === "event") {
        // Gateway sends challenge for remote connections; Bridge connects locally
        // (ws://127.0.0.1) which skips challenge verification, so we ignore it.
        if (parsed.event === "connect.challenge") return;
        if (JSON.stringify(parsed).length > maxMessageSize) {
          log.warn?.(`[bridge] evt too large for ${clientId}/${role}, dropping`);
          return;
        }
        session.publishJson(evtTopic(clientId, role), parsed);
        return;
      }
      if (parsed?.type === "res") {
        // If Gateway returns "invalid handshake" error, session state is stale on Gateway side.
        // Close this WS so next request creates fresh session with connect.
        if (parsed.ok === false && parsed.error?.message?.includes("invalid handshake")) {
          log.warn?.(`[bridge] Gateway session invalid for ${clientId}/${role}, closing WS`);
          try { ws.close(); } catch {}
        }
        if (JSON.stringify(parsed).length > maxMessageSize) {
          log.warn?.(`[bridge] res too large for ${clientId}/${role}, dropping`);
          return;
        }
        session.publishJson(resTopic(clientId, role), parsed);
      }
    });

    ws.on("error", (err) => {
      clearConnectTimeout();
      if (!resolved) {
        resolved = true;
        reject(err);
      }
      log.warn?.(`[bridge] WS error ${clientId}/${role}: ${String(err)}`);
    });

    ws.on("close", (code, reason) => {
      clearConnectTimeout();
      stopPingTimer();
      const reasonStr = reason?.toString() || "";
      log.info?.(`[bridge] WS closed ${clientId}/${role} code=${code} reason=${reasonStr}`);
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
  // 方案2: PendingSession with version for race condition prevention
  const pendingSessions = new Map<string, PendingSession>();
  const sessionKey = (clientId: string, role: string) => `${clientId}\0${role}`;
  // Session version counter: incremented on each new session creation to detect stale promises
  let sessionVersion = 0;

  const mqttClient: MqttClient = mqtt.connect(config.brokerUrl, {
    clientId: config.clientId,
    clean: true,
    keepalive: BRIDGE_KEEPALIVE_S,
    reconnectPeriod: BRIDGE_RECONNECT_PERIOD_MS,
    username: config.username,
    password: config.password,
    connectTimeout: 15000,
  });

  /** Strip NUL and trim so MQTT payload is safe for JSON.parse (some brokers/tools truncate at \\0). */
  const sanitizeMqttPayload = (raw: string): string => raw.replace(/\0/g, "").trim();

  /** Publish JSON object to MQTT (unified payload format: UTF-8 JSON string). */
  let handle: { publishJson: (topic: string, payloadObj: object) => void } | null = null;
  let lastDisconnectLogTime = 0;
  const DISCONNECT_LOG_INTERVAL_MS = 10_000;

  const payloadPreview = (x: string | object, maxLen: number = 120): string => {
    const s = typeof x === "string" ? x : JSON.stringify(x);
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen) + "...";
  };

  mqttClient.on("connect", () => {
    log.info?.("[bridge] MQTT connected");
    handle = {
      publishJson: (topic: string, payloadObj: object) => {
        const payload = sanitizeMqttPayload(JSON.stringify(payloadObj));
        if (!payload) return;
        log.info?.(`[bridge] MQTT send topic=${topic} payload=${payloadPreview(payloadObj)}`);
        mqttClient.publish(topic, payload, { qos: QOS });
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
    // 方案4: MQTT 重连后会话清理
    // Close all WebSocket sessions when MQTT disconnects. This ensures fresh
    // state when MQTT reconnects, avoiding stale sessions that can't receive
    // responses (MQTT subscription is lost on disconnect).
    if (sessions.size > 0 || pendingSessions.size > 0) {
      log.info?.(`[bridge] cleaning up ${sessions.size} sessions and ${pendingSessions.size} pending on MQTT close`);
      for (const s of sessions.values()) {
        if (s.pingTimer) clearInterval(s.pingTimer);
        try { s.ws.close(); } catch {}
      }
      sessions.clear();
      pendingSessions.clear();
    }
  });

  mqttClient.on("message", (topic: string, payload: Buffer) => {
    const parsed = parseReqTopic(topic);
    if (!parsed || !handle) return;
    const { clientId, role } = parsed;
    const reqJson = sanitizeMqttPayload(payload.toString("utf8"));
    if (!reqJson) {
      log.warn?.(`[bridge] MQTT recv empty payload for ${clientId}/${role}, rejecting`);
      handle.publishJson(resTopic(clientId, role), {
        type: "res",
        id: "",
        ok: false,
        error: { code: "INVALID_JSON", message: "Request payload must be non-empty UTF-8 JSON" },
      });
      return;
    }
    log.info?.(`[bridge] MQTT recv topic=${topic} clientId=${clientId} role=${role} payload=${payloadPreview(reqJson)}`);

    let reqObj: { id?: string; method?: string };
    try {
      reqObj = JSON.parse(reqJson) as { id?: string; method?: string };
    } catch {
      log.warn?.(`[bridge] MQTT recv invalid JSON for ${clientId}/${role}, rejecting`);
      handle.publishJson(resTopic(clientId, role), {
        type: "res",
        id: "",
        ok: false,
        error: { code: "INVALID_JSON", message: "Request payload must be UTF-8 JSON" },
      });
      return;
    }

    if (reqJson.length > config.maxMessageSize) {
      const errObj = {
        type: "res",
        id: typeof reqObj?.id === "string" ? reqObj.id : "",
        ok: false,
        error: { code: "PAYLOAD_TOO_LARGE", message: "Request payload exceeds max size" },
      };
      handle.publishJson(resTopic(clientId, role), errObj);
      return;
    }

    const isConnectRequest = reqObj?.method === "connect";

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

    // 方案7: Queue non-connect requests while session is being established
    if (pending && !isConnectRequest) {
      pending.queuedRequests.push(reqJson);
      log.info?.(`[bridge] queued request for ${clientId}/${role} (queue size: ${pending.queuedRequests.length})`);
      return;
    }

    if (!isConnectRequest && !pending) {
      log.warn?.(`[bridge] no session for ${clientId}/${role}, rejecting non-connect request`);
      handle.publishJson(resTopic(clientId, role), {
        type: "res",
        id: typeof reqObj?.id === "string" ? reqObj.id : "",
        ok: false,
        error: { code: "NO_SESSION", message: "No active session; send connect first" },
      });
      return;
    }

    // 方案2: Create new session with version tracking
    const thisVersion = ++sessionVersion;
    const sessionPromise = createSession(
      clientId,
      role,
      config.gatewayWsUrl,
      reqJson,
      (topic, payloadObj) => {
        if (handle) handle.publishJson(topic, payloadObj);
      },
      config.maxMessageSize,
      log,
      () => {
        // Only delete if this session is still the current one (avoid deleting newer sessions)
        const currentSession = sessions.get(key);
        const currentPending = pendingSessions.get(key);
        if (currentPending?.version === thisVersion) {
          pendingSessions.delete(key);
        }
        // For sessions map, we need to check if it's the same session object
        // Since we store the session after promise resolves, check by comparing
        // We mark the session with its version when storing it
        if (currentSession && (currentSession as Session & { _version?: number })._version === thisVersion) {
          sessions.delete(key);
        }
      },
    );

    const pendingSession: PendingSession = {
      promise: sessionPromise,
      version: thisVersion,
      queuedRequests: [],
    };
    pendingSessions.set(key, pendingSession);

    sessionPromise
      .then((s) => {
        // 方案2: Check version to avoid stale session race
        const currentPending = pendingSessions.get(key);
        if (!currentPending || currentPending.version !== thisVersion) {
          log.info?.(`[bridge] session ${clientId}/${role} v${thisVersion} superseded by v${currentPending?.version}, closing`);
          try { s.ws.close(); } catch {}
          return;
        }

        pendingSessions.delete(key);
        // Mark session with version for onClose check
        (s as Session & { _version?: number })._version = thisVersion;
        sessions.set(key, s);

        // 方案7: Send queued requests after session is established
        if (pendingSession.queuedRequests.length > 0) {
          log.info?.(`[bridge] sending ${pendingSession.queuedRequests.length} queued requests for ${clientId}/${role}`);
          for (const queued of pendingSession.queuedRequests) {
            if (s.ws.readyState === WebSocket.OPEN) {
              sendPayload(s, queued);
            }
          }
        }
      })
      .catch((err) => {
        // 方案2: Only clean up if version matches
        const currentPending = pendingSessions.get(key);
        if (currentPending?.version === thisVersion) {
          pendingSessions.delete(key);
        }

        log.warn?.(`[bridge] session failed ${clientId}/${role}: ${String(err)}`);

        let reqObjId: string | undefined;
        try {
          const obj = JSON.parse(reqJson) as { id?: string };
          reqObjId = typeof obj?.id === "string" ? obj.id : undefined;
        } catch {
          // ignore
        }
        if (handle) {
          handle.publishJson(resTopic(clientId, role), {
            type: "res",
            id: reqObjId ?? "",
            ok: false,
            error: { code: "BRIDGE_ERROR", message: String(err) },
          });
        }
        for (const queued of pendingSession.queuedRequests) {
          let queuedId: string | undefined;
          try {
            const obj = JSON.parse(queued) as { id?: string };
            queuedId = typeof obj?.id === "string" ? obj.id : undefined;
          } catch {
            // ignore
          }
          if (handle) {
            handle.publishJson(resTopic(clientId, role), {
              type: "res",
              id: queuedId ?? "",
              ok: false,
              error: { code: "BRIDGE_ERROR", message: String(err) },
            });
          }
        }
      });
  });

  mqttClient.on("error", (err) => {
    log.warn?.(`[bridge] MQTT error: ${String(err)} (connection may reconnect automatically)`);
  });

  abortSignal.addEventListener(
    "abort",
    () => {
      // Stop all ping timers and close WebSocket sessions
      for (const s of sessions.values()) {
        if (s.pingTimer) clearInterval(s.pingTimer);
        try {
          s.ws.close();
        } catch {
          // ignore
        }
      }
      sessions.clear();
      pendingSessions.clear();
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
