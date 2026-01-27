import type { ResolvedMqttAccount } from "./types.js";

export type ParsedMqttInbound = {
  messageId: string;
  text: string;
  from: string;
  to: string;
  chatId: string;
  rawBody: string;
  timestamp?: number;
  /** MQTT topic to publish replies to (must not be in subscribe set). */
  replyTopic: string;
};

function simpleHash(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).slice(0, 8);
}

/**
 * Parse MQTT inbound message: apply retain/age filters, parse JSON, derive From/To/MessageSid.
 * Returns null if the message should be skipped.
 */
export function parseMqttInbound(
  account: ResolvedMqttAccount,
  topic: string,
  payload: Buffer,
  retain: boolean,
  startTimeMs: number,
): ParsedMqttInbound | null {
  if (account.ignoreRetainedMessages && retain) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(payload.toString("utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;

  const obj = raw as Record<string, unknown>;
  const text = typeof obj.text === "string" ? obj.text : "";
  if (!text.trim()) return null;

  const messageId =
    typeof obj.messageId === "string" && obj.messageId
      ? obj.messageId
      : null;

  const ts =
    typeof obj.timestamp === "number"
      ? obj.timestamp
      : typeof obj.timestamp === "string"
        ? Date.parse(obj.timestamp)
        : undefined;
  const tsMs = ts !== undefined && !Number.isNaN(ts) ? (ts < 1e12 ? ts * 1000 : ts) : undefined;

  if (
    account.ignoreMessagesOlderThanMs > 0 &&
    startTimeMs > 0 &&
    tsMs !== undefined &&
    tsMs < startTimeMs - account.ignoreMessagesOlderThanMs
  ) {
    return null;
  }

  const fallbackId = messageId ?? `mqtt:${topic}:${tsMs ?? 0}:${simpleHash(payload.toString("utf8"))}`;

  const clientId = typeof obj.clientId === "string" ? obj.clientId : undefined;
  const from =
    account.fromExtractor === "payload" && clientId
      ? `${topic}/${clientId}`
      : account.fromExtractor === "topic+payload" && clientId
        ? `${topic}/${clientId}`
        : topic;

  const chatId = from;
  const to = topic;

  const replyTopic = resolveReplyTopic(account, topic, obj);
  if (!replyTopic) return null;

  return {
    messageId: fallbackId,
    text: text.trim(),
    rawBody: text.trim(),
    from: `mqtt:${from}`,
    to: `mqtt:${to}`,
    chatId: `mqtt:${chatId}`,
    timestamp: tsMs,
    replyTopic,
  };
}

function resolveReplyTopic(
  account: ResolvedMqttAccount,
  topic: string,
  obj: Record<string, unknown>,
): string | null {
  const fromPayload = typeof obj.replyToTopic === "string" ? obj.replyToTopic.trim() : null;
  if (fromPayload) return fromPayload;

  if (account.topics.publishMode !== "prefix" || !account.topics.publishPrefix) return null;

  const prefix = account.topics.publishPrefix;
  const id = extractSingleWildcard(account.topics.subscribe, topic);
  if (id !== null) return prefix.replace(/{to}/g, id);
  return prefix.replace(/{to}/g, topic);
}

function extractSingleWildcard(patterns: string[], topic: string): string | null {
  const top = topic.split("/");
  for (const pat of patterns) {
    const parts = pat.split("/");
    if (parts.length !== top.length) continue;
    let out: string[] = [];
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === "+") out.push(top[i] ?? "");
      else if (parts[i] === "#") {
        out.push(top.slice(i).join("/"));
        break;
      } else if (parts[i] !== top[i]) {
        ok = false;
        break;
      }
    }
    if (ok && out.length === 1) return out[0]!;
  }
  return null;
}
