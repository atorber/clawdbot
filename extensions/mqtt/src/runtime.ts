import type { PluginRuntime } from "clawdbot/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setMqttRuntime(next: PluginRuntime): void {
  runtime = next;
}

export function getMqttRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("MQTT runtime not initialized");
  }
  return runtime;
}
