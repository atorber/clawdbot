import type { ClawdbotConfig } from "moltbot/plugin-sdk";
import { normalizeAccountId } from "moltbot/plugin-sdk";

import type { MqttAccountConfig } from "./config-schema.js";

const DEFAULT_ACCOUNT_ID = "default";

const MQTT_DEFAULTS = {
  ignoreRetainedMessages: true,
  ignoreMessagesOlderThanMs: 300_000,
  cleanSession: false,
  keepalive: 60,
  connectTimeoutMs: 60_000,
  qosSubscribe: 1 as 0 | 1 | 2,
  qosPublish: 1 as 0 | 1 | 2,
  maxMessageSize: 200_000,
  fromExtractor: "topic" as const,
  publishMode: "direct" as const,
};

export type ResolvedMqttAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  brokerUrl: string;
  clientId: string;
  username?: string;
  password?: string;
  tls?: boolean | { ca?: string; cert?: string; key?: string };
  topics: {
    subscribe: string[];
    publishPrefix?: string;
    publishMode: "direct" | "prefix";
  };
  ignoreRetainedMessages: boolean;
  ignoreMessagesOlderThanMs: number;
  cleanSession: boolean;
  keepalive: number;
  connectTimeoutMs: number;
  qos: { subscribe: 0 | 1 | 2; publish: 0 | 1 | 2 };
  maxMessageSize: number;
  fromExtractor: "topic" | "payload" | "topic+payload";
  allowFrom?: Array<string | number>;
  dmPolicy?: "pairing" | "allowlist" | "open" | "disabled";
  config: MqttAccountConfig;
};

function getMqttChannelConfig(cfg: ClawdbotConfig): Record<string, unknown> | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.mqtt as
    | Record<string, unknown>
    | undefined;
}

function getAccountConfig(cfg: ClawdbotConfig, accountId: string): MqttAccountConfig | undefined {
  const mqtt = getMqttChannelConfig(cfg);
  const accounts = mqtt?.accounts as Record<string, MqttAccountConfig> | undefined;
  if (!accounts || typeof accounts !== "object") return undefined;
  return accounts[accountId] as MqttAccountConfig | undefined;
}

/**
 * Check if a topic matches any of the subscribe patterns.
 * For phase 1 we do simple string inclusion / exact match; MQTT wildcards +,#
 * would need a proper match function (e.g. mqtt-pattern or manual).
 */
function topicMatchesSubscribe(topic: string, subscribe: string[]): boolean {
  for (const s of subscribe) {
    if (s === topic) return true;
    if (s.includes("+") || s.includes("#")) {
      if (mqttTopicMatch(s, topic)) return true;
    }
  }
  return false;
}

function mqttTopicMatch(pattern: string, topic: string): boolean {
  const pat = pattern.split("/");
  const top = topic.split("/");
  let pi = 0;
  let ti = 0;
  while (pi < pat.length && ti < top.length) {
    if (pat[pi] === "#") return true;
    if (pat[pi] !== "+" && pat[pi] !== top[ti]) return false;
    pi++;
    ti++;
  }
  if (pi < pat.length && pat[pi] === "#") return true;
  return pi === pat.length && ti === top.length;
}

/**
 * Validate that publish topic does not overlap with subscribe set.
 * Used in resolveAccount and in outbound.sendText.
 */
export function validatePublishTopicNotSubscribed(
  publishTopic: string,
  subscribe: string[],
): { valid: boolean; message?: string } {
  if (topicMatchesSubscribe(publishTopic, subscribe)) {
    return {
      valid: false,
      message: `Publish topic "${publishTopic}" overlaps with subscribe set;入站/出站 topic 不得重叠`,
    };
  }
  return { valid: true };
}

export function listMqttAccountIds(cfg: ClawdbotConfig): string[] {
  const mqtt = getMqttChannelConfig(cfg);
  const accounts = mqtt?.accounts as Record<string, MqttAccountConfig> | undefined;
  if (!accounts || typeof accounts !== "object") return [];
  return Object.keys(accounts).filter((id) => {
    const ac = accounts[id];
    return ac && typeof ac === "object" && typeof ac.brokerUrl === "string" && Array.isArray(ac.topics?.subscribe) && ac.topics.subscribe.length > 0;
  });
}

export function resolveDefaultMqttAccountId(cfg: ClawdbotConfig): string {
  const ids = listMqttAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function mergeAccountConfig(cfg: ClawdbotConfig, accountId: string): MqttAccountConfig {
  const base = (getMqttChannelConfig(cfg) ?? {}) as MqttAccountConfig;
  const account = getAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account } as MqttAccountConfig;
}

export function resolveMqttAccount(opts: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedMqttAccount {
  const accountId = normalizeAccountId(opts.accountId ?? DEFAULT_ACCOUNT_ID);
  const mqtt = getMqttChannelConfig(opts.cfg);
  const baseEnabled = (mqtt?.enabled as boolean | undefined) !== false;
  const raw = mergeAccountConfig(opts.cfg, accountId);

  const enabled = baseEnabled && (raw.enabled !== false);
  const brokerUrl = (raw.brokerUrl ?? "").trim();
  const subscribe = Array.isArray(raw.topics?.subscribe) ? raw.topics.subscribe : [];
  const configured = brokerUrl.length > 0 && subscribe.length > 0;

  const clientId =
    raw.clientId?.trim() ||
    `clawdbot-${accountId}-${Math.random().toString(36).slice(2, 10)}`;

  const topics = {
    subscribe,
    publishPrefix: raw.topics?.publishPrefix,
    publishMode: (raw.topics?.publishMode ?? MQTT_DEFAULTS.publishMode) as "direct" | "prefix",
  };

  return {
    accountId,
    enabled,
    configured,
    brokerUrl,
    clientId,
    username: raw.username,
    password: raw.password,
    tls: raw.tls,
    topics,
    ignoreRetainedMessages: raw.ignoreRetainedMessages ?? MQTT_DEFAULTS.ignoreRetainedMessages,
    ignoreMessagesOlderThanMs:
      raw.ignoreMessagesOlderThanMs ?? MQTT_DEFAULTS.ignoreMessagesOlderThanMs,
    cleanSession: raw.cleanSession ?? MQTT_DEFAULTS.cleanSession,
    keepalive: raw.keepalive ?? MQTT_DEFAULTS.keepalive,
    connectTimeoutMs:
      (raw as MqttAccountConfig & { connectTimeout?: number }).connectTimeout ?? MQTT_DEFAULTS.connectTimeoutMs,
    qos: {
      subscribe: (raw.qos?.subscribe ?? MQTT_DEFAULTS.qosSubscribe) as 0 | 1 | 2,
      publish: (raw.qos?.publish ?? MQTT_DEFAULTS.qosPublish) as 0 | 1 | 2,
    },
    maxMessageSize: raw.maxMessageSize ?? MQTT_DEFAULTS.maxMessageSize,
    fromExtractor: (raw.fromExtractor ?? MQTT_DEFAULTS.fromExtractor) as
      | "topic"
      | "payload"
      | "topic+payload",
    allowFrom: raw.allowFrom,
    dmPolicy: raw.dmPolicy,
    config: raw,
  };
}

export function isTopicInSubscribe(topic: string, account: ResolvedMqttAccount): boolean {
  return topicMatchesSubscribe(topic, account.topics.subscribe);
}
