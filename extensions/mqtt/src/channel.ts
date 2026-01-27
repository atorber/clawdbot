import type { ClawdbotConfig } from "moltbot/plugin-sdk";
import {
  buildChannelConfigSchema,
  type ChannelPlugin,
} from "moltbot/plugin-sdk";

import { MqttConfigSchema } from "./config-schema.js";
import { createMqttClient, type MqttClientHandle } from "./client.js";
import { parseMqttInbound } from "./mapping.js";
import { getMqttRuntime } from "./runtime.js";
import {
  listMqttAccountIds,
  resolveDefaultMqttAccountId,
  resolveMqttAccount,
  isTopicInSubscribe,
  type ResolvedMqttAccount,
} from "./types.js";

const CHANNEL_ID = "mqtt" as const;

const activeClients = new Map<
  string,
  { handle: MqttClientHandle; startTimeMs: number }
>();

export const mqttPlugin: ChannelPlugin<ResolvedMqttAccount> = {
  id: "mqtt",
  meta: {
    id: "mqtt",
    label: "MQTT",
    selectionLabel: "MQTT",
    docsPath: "/channels/mqtt",
    docsLabel: "mqtt",
    blurb: "Arbitrary MQTT broker; JSON payload + topic-based sessions",
    order: 60,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  reload: { configPrefixes: ["channels.mqtt"] },
  configSchema: buildChannelConfigSchema(MqttConfigSchema),

  config: {
    listAccountIds: (cfg) => listMqttAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveMqttAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMqttAccountId(cfg),
    isConfigured: (account) => account.configured,
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveMqttAccount({ cfg, accountId }).config.allowFrom ?? []).map((e) => String(e)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((e) => String(e).trim())
        .filter(Boolean),
  },

  outbound: {
    deliveryMode: "direct",
    sendText: async ({ to, text, accountId }) => {
      const account = resolveMqttAccount({
        cfg: getMqttRuntime().config.loadConfig() as ClawdbotConfig,
        accountId,
      });
      const topic = to.startsWith("mqtt:") ? to.slice(5) : to;
      if (isTopicInSubscribe(topic, account)) {
        throw new Error(`Cannot publish to subscribed topic "${topic}"; 入站/出站 topic 不得重叠`);
      }
      const entry = activeClients.get(account.accountId);
      if (!entry) throw new Error(`MQTT client not running for account ${account.accountId}`);
      entry.handle.publish(topic, text ?? "", { qos: account.qos.publish });
      return { channel: CHANNEL_ID, to: topic };
    },
  },

  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((a) => {
        const err = typeof a.lastError === "string" ? a.lastError.trim() : "";
        if (!err) return [];
        return [
          { channel: CHANNEL_ID, accountId: a.accountId, kind: "runtime" as const, message: err },
        ];
      }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account as ResolvedMqttAccount;
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        lastStartAt: Date.now(),
        lastError: null,
      });
      ctx.log?.info?.(`[${account.accountId}] starting MQTT (${account.brokerUrl})`);

      if (!account.configured) {
        throw new Error("MQTT brokerUrl and topics.subscribe are required");
      }

      const startTimeMs = Date.now();
      const cfg = ctx.cfg as ClawdbotConfig;
      const core = getMqttRuntime();

      const handle = await createMqttClient({
        account,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
        onReady: (h) => {
          activeClients.set(account.accountId, { handle: h, startTimeMs });
        },
        onMessage: (topic, payload, retain) => {
          const parsed = parseMqttInbound(
            account,
            topic,
            payload,
            retain,
            startTimeMs,
          );
          if (!parsed) return;

          const route = core.channel.routing.resolveAgentRoute({
            cfg,
            channel: CHANNEL_ID,
            accountId: account.accountId,
            peer: { kind: "dm", id: parsed.chatId },
          });

          const storePath = core.channel.session.resolveStorePath(cfg.session?.store as string | undefined, {
            agentId: route.agentId,
          });
          const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
          const previousTimestamp = core.channel.session.readSessionUpdatedAt({
            storePath,
            sessionKey: route.sessionKey,
          });
          const body = core.channel.reply.formatAgentEnvelope({
            channel: "MQTT",
            from: parsed.from,
            timestamp: parsed.timestamp,
            previousTimestamp,
            envelope: envelopeOptions,
            body: parsed.rawBody,
          });

          const ctxPayload = core.channel.reply.finalizeInboundContext({
            Body: body,
            RawBody: parsed.rawBody,
            CommandBody: parsed.rawBody,
            From: parsed.from,
            To: parsed.to,
            SessionKey: route.sessionKey,
            AccountId: route.accountId,
            ChatType: "direct",
            ConversationLabel: parsed.from,
            Provider: CHANNEL_ID,
            Surface: CHANNEL_ID,
            MessageSid: parsed.messageId,
            Timestamp: parsed.timestamp,
            OriginatingChannel: CHANNEL_ID,
            OriginatingTo: parsed.to,
          });

          void core.channel.session.recordInboundSession({
            storePath,
            sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
            ctx: ctxPayload,
            onRecordError: (err) => {
              ctx.log?.error?.(`mqtt: session meta: ${String(err)}`);
            },
          });

          const replyTopic = parsed.replyTopic;
          const clientHandle = activeClients.get(account.accountId)?.handle;

          void core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: ctxPayload,
            cfg,
            dispatcherOptions: {
              deliver: async (payload) => {
                const t = (payload as { text?: string }).text ?? "";
                if (!clientHandle) return;
                clientHandle.publish(replyTopic, t, { qos: account.qos.publish });
              },
              onError: (err, info) => {
                ctx.log?.error?.(`mqtt ${info.kind} reply failed: ${String(err)}`);
              },
            },
          });
        },
      });

      if (!activeClients.has(account.accountId)) {
        activeClients.set(account.accountId, { handle, startTimeMs });
      }
      ctx.log?.info?.(`[${account.accountId}] MQTT started`);

      return {
        stop: () => {
          handle.stop();
          activeClients.delete(account.accountId);
          ctx.log?.info?.(`[${account.accountId}] MQTT stopped`);
        },
      };
    },
  },
};
