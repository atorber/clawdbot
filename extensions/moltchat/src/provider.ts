/**
 * MoltChat 渠道 Provider：使用 mchat-client 连接 MChat，归一化收/发消息
 */

import type { InboxMessage, GroupMessage } from "@atorber/mchat-client";
import { MChatClient, sendPrivateMessage, sendGroupMessage } from "@atorber/mchat-client";
import type { MChatChannelConfig, MChatInboundMessage, MChatSendParams } from "./types";
import { CHANNEL_ID } from "./types";

export type PluginLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

const GROUP_ID_PREFIX = "grp_";

function isGroupThread(thread: string, config: MChatChannelConfig): boolean {
  if (thread.startsWith(GROUP_ID_PREFIX)) return true;
  if (config.groupIds?.length && config.groupIds.includes(thread)) return true;
  return false;
}

export function createMChatChannel(
  config: MChatChannelConfig,
  logger?: PluginLogger | null,
): import("./types").MChatChannelProvider {
  if (config.enabled === false) {
    throw new Error("MoltChat channel is disabled in config");
  }

  logger?.info?.(
    "MoltChat provider creating client " + config.brokerHost + ":" + config.brokerPort,
  );

  const client = new MChatClient({
    brokerHost: config.brokerHost,
    brokerPort: config.brokerPort,
    useTls: config.useTls ?? false,
    username: config.username,
    password: config.password,
    employeeId: config.employeeId,
    clientId: config.clientId,
    requestTimeoutMs: config.requestTimeoutMs ?? 30000,
  });

  (client as { on?: (ev: string, fn: () => void) => void }).on?.("connect", () => {
    const clientId =
      typeof (client as { getClientId?: () => string }).getClientId === "function"
        ? (client as { getClientId: () => string }).getClientId()
        : "";
    logger?.info?.("MoltChat MQTT connect" + (clientId ? ` clientId=${clientId}` : ""));
    logger?.debug?.("MoltChat MQTT connected state=" + String(client.connected));
  });
  (client as { on?: (ev: string, fn: () => void) => void }).on?.("offline", () => {
    logger?.info?.("MoltChat MQTT offline");
  });
  (client as { on?: (ev: string, fn: (err: Error) => void) => void }).on?.(
    "error",
    (err: Error) => {
      logger?.error?.("MoltChat MQTT error: " + String(err?.message ?? err));
    },
  );

  const inboundListeners: ((msg: MChatInboundMessage) => void)[] = [];

  function emitInbound(msg: MChatInboundMessage): void {
    inboundListeners.forEach((cb) => {
      try {
        cb(msg);
      } catch (e) {
        logger?.warn?.("MoltChat inbound callback error: " + String(e));
      }
    });
  }

  client.on("inbox", (payload: InboxMessage) => {
    const from = payload.from_employee_id;
    const thread = from ?? "";
    const contentStr =
      typeof payload.content === "string" ? payload.content : JSON.stringify(payload.content ?? "");
    logger?.info?.(
      `MoltChat inbox received from=${from} msgId=${payload.msg_id ?? ""} content=${contentStr.slice(0, 80)}`,
    );
    logger?.debug?.(
      `MoltChat inbox from=${from} msgId=${payload.msg_id ?? ""} content=${contentStr.slice(0, 80)}`,
    );
    emitInbound({
      channel: CHANNEL_ID,
      thread,
      isGroup: false,
      msgId: payload.msg_id,
      fromEmployeeId: from,
      content: payload.content,
      sentAt: payload.sent_at,
      quoteMsgId: payload.quote_msg_id,
    });
  });

  client.on("group", (groupId: string, payload: GroupMessage) => {
    const contentStr =
      typeof payload.content === "string" ? payload.content : JSON.stringify(payload.content ?? "");
    logger?.debug?.(
      `MoltChat group groupId=${groupId} from=${payload.from_employee_id ?? ""} msgId=${payload.msg_id ?? ""} content=${contentStr.slice(0, 80)}`,
    );
    emitInbound({
      channel: CHANNEL_ID,
      thread: groupId,
      isGroup: true,
      msgId: payload.msg_id,
      fromEmployeeId: payload.from_employee_id,
      content: payload.content,
      sentAt: payload.sent_at,
      quoteMsgId: payload.quote_msg_id,
    });
  });

  return {
    get connected(): boolean {
      return client.connected;
    },

    onInbound(cb: (msg: MChatInboundMessage) => void): void {
      inboundListeners.push(cb);
    },

    async start(): Promise<void> {
      logger?.info?.(
        "MoltChat provider connecting to " + config.brokerHost + ":" + config.brokerPort,
      );
      await client.connect();
      logger?.debug?.("MoltChat provider connect() done state=" + String(client.connected));
      const groupIds = config.groupIds ?? [];
      for (const gid of groupIds) {
        await client.subscribeGroup(gid);
        logger?.info?.("MoltChat subscribed group " + gid);
      }
      if (groupIds.length === 0) {
        logger?.debug?.("MoltChat no groups to subscribe (inbox only)");
      }
      logger?.info?.("MoltChat provider connected");
    },

    async stop(): Promise<void> {
      logger?.info?.("MoltChat provider disconnecting");
      await client.disconnect();
      logger?.debug?.("MoltChat provider disconnected");
    },

    async send(params: MChatSendParams): Promise<void> {
      if (!client.connected) {
        throw new Error("MoltChat channel not connected");
      }
      const content = typeof params.content === "string" ? params.content : params.content;
      const len = typeof content === "string" ? content.length : 0;
      const isGroup = isGroupThread(params.thread, config);
      logger?.info?.(`MoltChat send thread=${params.thread} isGroup=${isGroup} len=${len}`);
      logger?.debug?.(
        `MoltChat send preview=${(typeof content === "string" ? content : JSON.stringify(content)).slice(0, 60)}`,
      );
      const quoteMsgId = params.quoteMsgId;
      if (isGroupThread(params.thread, config)) {
        await sendGroupMessage(client, params.thread, content, quoteMsgId);
      } else {
        await sendPrivateMessage(client, params.thread, content, quoteMsgId);
      }
    },
  };
}
