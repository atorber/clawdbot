import { buildChannelConfigSchema } from "moltbot/plugin-sdk";
import { z } from "zod";

const allowFromEntry = z.union([z.string(), z.number()]);

const mqttTopicsSchema = z.object({
  subscribe: z.array(z.string()).min(1),
  publishPrefix: z.string().optional(),
  publishMode: z.enum(["direct", "prefix"]).optional(),
});

const mqttQosSchema = z.object({
  subscribe: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
  publish: z.union([z.literal(0), z.literal(1), z.literal(2)]).optional(),
});

export const MqttAccountSchema = z.object({
  enabled: z.boolean().optional(),
  brokerUrl: z.string().min(1),
  clientId: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  tls: z.union([z.boolean(), z.object({
    ca: z.string().optional(),
    cert: z.string().optional(),
    key: z.string().optional(),
  })]).optional(),
  topics: mqttTopicsSchema,
  ignoreRetainedMessages: z.boolean().optional(),
  ignoreMessagesOlderThanMs: z.number().optional(),
  cleanSession: z.boolean().optional(),
  keepalive: z.number().optional(),
  connectTimeout: z.number().optional(),
  qos: mqttQosSchema.optional(),
  maxMessageSize: z.number().optional(),
  fromExtractor: z.enum(["topic", "payload", "topic+payload"]).optional(),
  allowFrom: z.array(allowFromEntry).optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
});

export type MqttAccountConfig = z.infer<typeof MqttAccountSchema>;

const GatewayBridgeSchema = z.object({
  enabled: z.boolean().optional(),
  gatewayWsUrl: z.string().optional(),
  brokerUrl: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  clientId: z.string().optional(),
  maxMessageSize: z.number().optional(),
});

export type GatewayBridgeConfig = z.infer<typeof GatewayBridgeSchema>;

export const MqttConfigSchema = z.object({
  enabled: z.boolean().optional(),
  accounts: z.record(z.string(), MqttAccountSchema).optional(),
  gatewayBridge: GatewayBridgeSchema.optional(),
});

export type MqttConfig = z.infer<typeof MqttConfigSchema>;

export const mqttChannelConfigSchema = buildChannelConfigSchema(MqttConfigSchema);
