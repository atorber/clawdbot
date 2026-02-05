/**
 * openclaw-channel-mchat
 * OpenClaw 渠道插件：将 MoltChat 作为聊天渠道接入 OpenClaw
 */

import type { PluginLogger } from "./provider";
import type {
  MChatChannelConfig,
  MChatChannelProvider,
  MChatInboundMessage,
  MChatSendParams,
} from "./types";
import { createMChatChannel } from "./provider";
import { getMoltChatRuntime, setMoltChatRuntime } from "./runtime";
import { CHANNEL_ID } from "./types";

export { createMChatChannel, CHANNEL_ID };
export type {
  MChatChannelConfig,
  MChatChannelProvider,
  MChatInboundMessage,
  MChatSendParams,
  PluginLogger,
};

/** 由 register(api) 注入，供 channel / provider 打日志 */
let pluginLogger: PluginLogger | null = null;

/** 当前运行中的渠道实例，由 gateway.start/startAccount 创建、gateway.stop/stopAccount 清除 */
let currentProvider: MChatChannelProvider | null = null;

/** 当前账号 ID（用于入站路由） */
let currentAccountId = "default";

/** 入站消息通过 core 派发到 agent（需已设置 runtime） */
async function dispatchMoltChatInbound(params: {
  msg: MChatInboundMessage;
  accountId: string;
}): Promise<void> {
  const core = getMoltChatRuntime() as {
    config: { loadConfig: () => unknown };
    channel: {
      routing: { resolveAgentRoute: (p: unknown) => { sessionKey: string; agentId: string } };
      reply: {
        formatAgentEnvelope: (p: unknown) => string;
        resolveEnvelopeFormatOptions: (cfg: unknown) => unknown;
        finalizeInboundContext: (p: unknown) => Record<string, unknown>;
        dispatchReplyWithBufferedBlockDispatcher: (p: unknown) => Promise<void>;
      };
      session: {
        resolveStorePath: (store: unknown, p: { agentId: string }) => string;
        recordInboundSession: (p: unknown) => Promise<void>;
      };
    };
  } | null;
  if (!core) return;
  const { msg, accountId } = params;
  const cfg = core.config.loadConfig();
  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: msg.isGroup ? "group" : "user", id: msg.thread },
  });
  const bodyStr =
    typeof msg.content === "string"
      ? msg.content
      : msg.content != null
        ? JSON.stringify(msg.content)
        : "";
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "MoltChat",
    from: msg.fromEmployeeId ?? msg.thread,
    timestamp: msg.sentAt ? new Date(msg.sentAt).getTime() : undefined,
    envelope: core.channel.reply.resolveEnvelopeFormatOptions(cfg),
    body: bodyStr,
  });
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: bodyStr,
    CommandBody: bodyStr,
    From: `moltchat:user:${msg.fromEmployeeId ?? msg.thread}`,
    To: msg.isGroup ? `moltchat:group:${msg.thread}` : `moltchat:user:${msg.thread}`,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: msg.isGroup ? "group" : "direct",
    ConversationLabel: msg.thread,
    SenderName: msg.fromEmployeeId,
    SenderId: msg.fromEmployeeId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    MessageSid: msg.msgId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: msg.isGroup ? `moltchat:group:${msg.thread}` : `moltchat:user:${msg.thread}`,
  });
  const storePath = core.channel.session.resolveStorePath(
    (cfg as { session?: { store?: unknown } })?.session?.store,
    {
      agentId: route.agentId,
    },
  );
  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err: unknown) => {
      pluginLogger?.warn?.("MoltChat recordInboundSession error: " + String(err));
    },
  });
  const thread = msg.thread;
  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: cfg as Record<string, unknown>,
    dispatcherOptions: {
      deliver: async (payload: { text?: string }) => {
        const provider = currentProvider;
        if (provider?.connected && payload.text) {
          await provider.send({ thread, content: payload.text });
        }
      },
      onError: (err: unknown, info: { kind: string }) => {
        pluginLogger?.warn?.(`MoltChat ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

/** 启动单个账号的通用逻辑（供 start 与 startAccount 复用）；config、accountId 与 emitChat 由调用方提供 */
async function startAccountWithConfig(
  config: MChatChannelConfig,
  accountId: string,
  emitChat: (ev: unknown) => void,
): Promise<void> {
  if (config.enabled === false) {
    pluginLogger?.debug?.("MoltChat gateway skipped (disabled)");
    return;
  }
  pluginLogger?.info?.("MoltChat gateway starting");
  pluginLogger?.debug?.(
    `MoltChat broker=${config.brokerHost}:${config.brokerPort} employeeId=${config.employeeId} groupIds=${config.groupIds?.length ?? 0}`,
  );
  currentAccountId = accountId;
  const provider = createMChatChannel(config, pluginLogger ?? undefined);
  provider.onInbound((msg) => {
    const contentLen =
      typeof msg.content === "string"
        ? msg.content.length
        : msg.content
          ? JSON.stringify(msg.content).length
          : 0;
    const contentPreview =
      typeof msg.content === "string"
        ? msg.content.slice(0, 80)
        : msg.content
          ? JSON.stringify(msg.content).slice(0, 80)
          : "";
    pluginLogger?.debug?.(
      `MoltChat inbound thread=${msg.thread} isGroup=${msg.isGroup} from=${msg.fromEmployeeId ?? ""} msgId=${msg.msgId ?? ""} contentLen=${contentLen} preview=${contentPreview}`,
    );
    const core = getMoltChatRuntime();
    if (core) {
      dispatchMoltChatInbound({ msg, accountId }).catch((e) => {
        pluginLogger?.warn?.("MoltChat dispatchInbound error: " + String(e));
      });
    } else {
      try {
        emitChat(msg);
      } catch (e) {
        pluginLogger?.warn?.("MoltChat emitChat error: " + String(e));
      }
    }
  });
  await provider.start();
  currentProvider = provider;
  pluginLogger?.info?.("MoltChat gateway started");
  pluginLogger?.debug?.(
    `MoltChat connected=${provider.connected} inbox subscribed for employeeId=${config.employeeId}`,
  );
}

/** 停止渠道的通用逻辑（供 stop 与 stopAccount 复用） */
async function stopAccountInternal(): Promise<void> {
  if (currentProvider) {
    pluginLogger?.info?.("MoltChat gateway stopping");
    await currentProvider.stop();
    currentProvider = null;
    pluginLogger?.info?.("MoltChat gateway stopped");
  }
}

/** 从 start/startAccount 的 ctx 中解析出 mchat 配置（核心传 cfg/account，兼容 config；account 来自 resolveAccount） */
function getConfigFromCtx(ctx: {
  cfg?: {
    channels?: { moltchat?: MChatChannelConfig; mchat?: MChatChannelConfig };
    plugins?: { entries?: { moltchat?: { config?: MChatChannelConfig } } };
  };
  config?: { channels?: { moltchat?: MChatChannelConfig; mchat?: MChatChannelConfig } };
  account?: MChatChannelConfig;
}): MChatChannelConfig | undefined {
  return (
    ctx.account ??
    ctx.config?.channels?.moltchat ??
    ctx.config?.channels?.mchat ??
    ctx.cfg?.channels?.moltchat ??
    ctx.cfg?.channels?.mchat ??
    ctx.cfg?.plugins?.entries?.moltchat?.config
  );
}

/** OpenClaw 渠道插件描述（config 在 channels.mchat 下） */
const mchatChannelPlugin = {
  id: CHANNEL_ID,
  meta: {
    id: CHANNEL_ID,
    label: "MoltChat",
    selectionLabel: "MoltChat (MQTT)",
    docsPath: "/channels/moltchat",
    blurb: "MoltChat 企业 IM 渠道，基于 MQTT，支持单聊与群聊",
    aliases: ["moltchat"],
  },
  capabilities: {
    chatTypes: ["direct", "group"] as const,
  },
  config: {
    listAccountIds: (cfg: {
      channels?: { moltchat?: unknown };
      plugins?: { entries?: { moltchat?: unknown } };
    }) =>
      cfg.channels?.moltchat != null || cfg.plugins?.entries?.moltchat != null ? ["default"] : [],
    resolveAccount: (
      cfg: {
        channels?: { moltchat?: MChatChannelConfig; mchat?: MChatChannelConfig };
        plugins?: { entries?: { moltchat?: { config?: MChatChannelConfig } } };
      },
      _accountId?: string,
    ) =>
      cfg.channels?.moltchat ?? cfg.channels?.mchat ?? cfg.plugins?.entries?.moltchat?.config ?? {},
  },
  outbound: {
    deliveryMode: "direct" as const,
    sendText: async (params: { text: string; thread?: string; channel?: string }) => {
      const provider = currentProvider;
      if (!provider?.connected) throw new Error("MoltChat channel not connected");
      const thread = params.thread ?? "";
      const len = params.text?.length ?? 0;
      pluginLogger?.info?.(`MoltChat sendText thread=${thread} len=${len}`);
      pluginLogger?.debug?.(`MoltChat sendText preview=${(params.text ?? "").slice(0, 60)}`);
      await provider.send({ thread, content: params.text });
      return { ok: true };
    },
  },
  gateway: {
    /** 兼容：核心若只调 start/stop，仍会执行并看到日志 */
    start: async (ctx: {
      config?: { channels?: { mchat?: MChatChannelConfig } };
      emitChat?: (ev: unknown) => void;
    }) => {
      const config = getConfigFromCtx(ctx);
      if (!config) {
        pluginLogger?.debug?.("MoltChat gateway skipped (no config or disabled)");
        return;
      }
      const emit = typeof ctx.emitChat === "function" ? ctx.emitChat : () => {};
      await startAccountWithConfig(config, "default", emit);
    },
    stop: async () => {
      await stopAccountInternal();
    },
    /** 核心实际调用：startAccount/stopAccount；传入 ctx（含 cfg、account，无 emitChat 时用 no-op） */
    startAccount: async (ctx: {
      accountId?: string;
      account?: MChatChannelConfig;
      cfg?: { channels?: { mchat?: MChatChannelConfig } };
      config?: { channels?: { mchat?: MChatChannelConfig } };
      emitChat?: (ev: unknown) => void;
    }) => {
      pluginLogger?.info?.("MoltChat startAccount called");
      const config = getConfigFromCtx(ctx);
      if (!config || typeof config.brokerHost !== "string") {
        pluginLogger?.warn?.(
          "MoltChat gateway skipped: no valid config. Set channels.moltchat or channels.mchat or plugins.entries.moltchat.config with brokerHost, brokerPort, username, password, employeeId. Ensure the channel is enabled so it is started.",
        );
        return;
      }
      const accountId = ctx.accountId ?? "default";
      const emit = typeof ctx.emitChat === "function" ? ctx.emitChat : () => {};
      await startAccountWithConfig(config, accountId, emit);
    },
    stopAccount: async (_ctx?: { accountId?: string }) => {
      await stopAccountInternal();
    },
  },
};

/** OpenClaw 插件入口：default 导出带 register 的对象（与 Matrix/Line 一致） */
const plugin = {
  id: CHANNEL_ID,
  name: "MoltChat",
  description: "MoltChat channel plugin (MQTT-based enterprise IM)",
  register(api: {
    registerChannel: (arg: { plugin: typeof mchatChannelPlugin }) => void;
    logger?: PluginLogger;
    runtime?: unknown;
  }): void {
    pluginLogger = api.logger ?? null;
    setMoltChatRuntime(api.runtime ?? null);
    pluginLogger?.info?.("MoltChat plugin registered");
    api.registerChannel({ plugin: mchatChannelPlugin });
  },
};

export default plugin;
