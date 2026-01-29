/**
 * Gateway Bridge: bridges MQTT topics (moltbot/gw/{clientId}/{role}/req|res|evt) to the
 * gateway WebSocket. Android (and other) MQTT clients publish req and subscribe to res/evt;
 * the bridge subscribes to req, opens a WebSocket to the gateway per (clientId, role),
 * forwards req to WS and publishes WS res/event to MQTT. Connections to ws://127.0.0.1
 * are treated as local by the gateway, so device nonce is not required.
 */

import type { MqttClient } from "mqtt";
import mqtt from "mqtt";
import WebSocket from "ws";

import type { PluginRuntime } from "moltbot/plugin-sdk";

const TOPIC_PREFIX = "moltbot/gw";
const REQ_OPERATOR = `${TOPIC_PREFIX}/+/operator/req`;
const REQ_NODE = `${TOPIC_PREFIX}/+/node/req`;
const QOS = 1;
const DEFAULT_MAX_MESSAGE_SIZE = 256 * 1024;
const DEFAULT_GATEWAY_WS_URL = "ws://127.0.0.1:18789";

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
  const clientId =
    String(bridge.clientId ?? "").trim() || `moltbot-gw-bridge-${Math.random().toString(36).slice(2, 10)}`;
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

export function startGatewayBridge(runtime: PluginRuntime, abortSignal: AbortSignal): void {
  const config = getBridgeConfig(runtime);
  if (!config) return;

  const log = runtime.log?.subsystem?.("mqtt-bridge") ?? {};
  log.info?.(`[bridge] starting broker=${config.brokerUrl} gatewayWs=${config.gatewayWsUrl}`);

  const sessions = new Map<string, Session>();
  const sessionKey = (clientId: string, role: string) => `${clientId}\0${role}`;

  const mqttClient: MqttClient = mqtt.connect(config.brokerUrl, {
    clientId: config.clientId,
    clean: true,
    keepalive: 60,
    username: config.username,
    password: config.password,
  });

  let handle: { publish: (topic: string, payload: string | Buffer, opts?: { qos?: 0 | 1 | 2 }) => void } | null = null;

  mqttClient.on("connect", () => {
    mqttClient.subscribe([REQ_OPERATOR, REQ_NODE], { qos: QOS }, (err) => {
      if (err) {
        log.warn?.(`[bridge] subscribe error: ${String(err)}`);
        return;
      }
      handle = {
        publish: (topic: string, payload: string | Buffer, opts?: { qos?: 0 | 1 | 2 }) => {
          mqttClient.publish(topic, payload, { qos: opts?.qos ?? QOS });
        },
      };
      log.info?.("[bridge] subscribed to req topics");
    });
  });

  mqttClient.on("message", (topic: string, payload: Buffer) => {
    const parsed = parseReqTopic(topic);
    if (!parsed || !handle) return;
    const { clientId, role } = parsed;
    const reqJson = payload.toString("utf8");
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

    const key = sessionKey(clientId, role);
    let session = sessions.get(key);

    const ensureSession = (): Promise<{ session: Session; created: boolean }> => {
      if (session && session.ws.readyState === WebSocket.OPEN) {
        return Promise.resolve({ session, created: false });
      }
      if (session) {
        try {
          session.ws.close();
        } catch {
          // ignore
        }
        sessions.delete(key);
      }
      return createSession(
        clientId,
        role,
        config.gatewayWsUrl,
        reqJson,
        (t, p, opts) => handle!.publish(t, p, opts),
        config.maxMessageSize,
        log,
        () => sessions.delete(key),
      ).then((s) => {
        session = s;
        sessions.set(key, s);
        return { session: s, created: true };
      });
    };

    ensureSession()
      .then(({ session: s, created }) => {
        if (!created && s.ws.readyState === WebSocket.OPEN) sendPayload(s, reqJson);
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
    log.warn?.(`[bridge] MQTT error: ${String(err)}`);
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
      log.info?.("[bridge] stopped");
    },
    { once: true },
  );
}
