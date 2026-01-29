import type { ClawdbotPluginApi } from "moltbot/plugin-sdk";

import { startGatewayBridge } from "./src/bridge.js";
import { mqttPlugin } from "./src/channel.js";
import { setMqttRuntime } from "./src/runtime.js";

const plugin = {
  id: "mqtt",
  name: "MQTT",
  description: "MQTT channel plugin for arbitrary broker access",
  register(api: ClawdbotPluginApi) {
    setMqttRuntime(api.runtime);
    api.registerChannel({ plugin: mqttPlugin });
    startGatewayBridge(api.runtime);
  },
};

export default plugin;
