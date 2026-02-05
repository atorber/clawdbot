/**
 * OpenClaw MoltChat 渠道配置与消息类型
 */

export const CHANNEL_ID = "moltchat";

/** 插件配置（与 openclaw.plugin.json configSchema 一致） */
export interface MChatChannelConfig {
  enabled?: boolean;
  brokerHost: string;
  brokerPort: number;
  useTls?: boolean;
  username: string;
  password: string;
  employeeId: string;
  clientId?: string;
  requestTimeoutMs?: number;
  /** 要订阅的群 ID 列表；不填则仅收件箱 */
  groupIds?: string[];
}

/** 归一化后的入站消息（供 OpenClaw 侧映射为 chat 事件） */
export interface MChatInboundMessage {
  channel: typeof CHANNEL_ID;
  /** 单聊时为对方 employee_id，群聊时为 group_id */
  thread: string;
  /** 是否群消息 */
  isGroup: boolean;
  msgId?: string;
  fromEmployeeId?: string;
  content?: unknown;
  sentAt?: string;
  quoteMsgId?: string;
}

/** 发送参数 */
export interface MChatSendParams {
  /** 单聊为 to_employee_id，群聊为 group_id */
  thread: string;
  /** 文本或 { type, body } */
  content: string | { type?: string; body?: unknown };
  quoteMsgId?: string;
}

export interface MChatChannelProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 注册入站消息回调（inbox/group -> 归一化消息） */
  onInbound(cb: (msg: MChatInboundMessage) => void): void;
  /** 发送消息 */
  send(params: MChatSendParams): Promise<void>;
  /** 是否已连接 */
  readonly connected: boolean;
}
