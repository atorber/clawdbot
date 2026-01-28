import type { MqttClient } from "mqtt";
import mqtt from "mqtt";

import type { ResolvedMqttAccount } from "./types.js";

const RECONNECT_PERIOD_MS = 1000;

export type MqttClientHandle = {
  publish: (topic: string, payload: string | Buffer, opts?: { qos?: 0 | 1 | 2 }) => void;
  stop: () => void;
};

export type CreateMqttClientOptions = {
  account: ResolvedMqttAccount;
  onMessage: (topic: string, payload: Buffer, retain: boolean) => void;
  onReady?: (handle: MqttClientHandle) => void;
  abortSignal: AbortSignal;
  log?: { info?: (msg: string) => void; error?: (msg: string) => void; debug?: (msg: string) => void };
};

export function createMqttClient(opts: CreateMqttClientOptions): Promise<MqttClientHandle> {
  const { account, onMessage, onReady, abortSignal, log } = opts;

  return new Promise((resolve, reject) => {
    const client: MqttClient = mqtt.connect(account.brokerUrl, {
      clientId: account.clientId,
      clean: account.cleanSession,
      keepalive: account.keepalive,
      connectTimeout: account.connectTimeoutMs ?? 60_000,
      reconnectPeriod: RECONNECT_PERIOD_MS,
      username: account.username,
      password: account.password,
      ...(typeof account.tls === "object" && account.tls !== null
        ? {
            ca: account.tls.ca,
            cert: account.tls.cert,
            key: account.tls.key,
          }
        : account.tls === true
          ? { rejectUnauthorized: true }
          : {}),
    });

    let subscribed = false;

    const stop = () => {
      try {
        client.end(true);
      } catch {
        // ignore
      }
    };

    abortSignal.addEventListener(
      "abort",
      () => {
        stop();
      },
      { once: true },
    );

    client.on("connect", () => {
      log?.debug?.(`[${account.accountId}] MQTT connected`);
      const qos = account.qos.subscribe as 0 | 1 | 2;
      client.subscribe(account.topics.subscribe, { qos }, (err) => {
        if (err) {
          log?.error?.(`[${account.accountId}] MQTT subscribe error: ${String(err)}`);
          reject(err);
          return;
        }
        subscribed = true;
        log?.info?.(`[${account.accountId}] MQTT subscribed to ${account.topics.subscribe.length} topic(s)`);
        const handle: MqttClientHandle = {
          publish: (topic: string, payload: string | Buffer, publishOpts?: { qos?: 0 | 1 | 2 }) => {
            client.publish(topic, payload, { qos: publishOpts?.qos ?? account.qos.publish });
          },
          stop,
        };
        onReady?.(handle);
        resolve(handle);
      });
    });

    client.on("message", (topic: string, payload: Buffer, packet: { retain?: boolean }) => {
      onMessage(topic, payload, packet.retain === true);
    });

    client.on("error", (err) => {
      log?.error?.(`[${account.accountId}] MQTT error: ${String(err)}`);
      if (!subscribed) reject(err);
    });

    client.on("reconnect", () => {
      log?.debug?.(`[${account.accountId}] MQTT reconnecting`);
    });
  });
}
