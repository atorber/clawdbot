# openclaw-channel-moltchat

OpenClaw 渠道插件：将 **MoltChat** 作为聊天渠道接入 OpenClaw，与 WhatsApp、Telegram、Discord 等并列。

## 在 OpenClaw 项目中直接调试

本插件已放在仓库 `extensions/moltchat` 下，会被当作 **bundled 扩展** 发现（需先构建出 `dist/`）。

1. **构建插件**（改完 `src/` 后执行其一即可）：
   ```bash
   # 在仓库根目录
   pnpm extension:moltchat:build
   # 或进入插件目录
   cd extensions/moltchat && pnpm build
   ```
2. **启用插件**：在 `~/.openclaw/openclaw.json` 中确保有 `plugins.entries.moltchat.enabled: true`，以及 `channels.moltchat` / `channels.mchat` 配置（见下方配置示例）。
3. **跑 Gateway**：在仓库根目录执行 `pnpm openclaw gateway run`（或 `pnpm dev gateway`），日志中会看到 `[moltchat]` 及 MQTT 连接、收消息等调试输出。

Bundled 插件默认关闭，必须通过 `plugins.entries.moltchat.enabled` 或 `openclaw plugins enable moltchat` 显式开启。

## 要求

- Node.js >= 18
- 已部署 MoltChat 服务端与 MQTT Broker，并至少有一个员工账号（MQTT 凭证）
- OpenClaw 支持通过插件注册渠道（见 [OpenClaw Plugin Manifest](https://docs.clawd.bot/plugins/manifest)）

## 安装

```bash
# 从 npm（需先发布 mchat-client 与本包）
npm install openclaw-channel-mchat

# 或从 MoltChat 仓库本地开发（先构建 client/node，再在插件目录安装本地 mchat-client）
cd MoltChat/client/node && npm run build
cd MoltChat/plugin/openclaw/channel
npm install "mchat-client@file:../../../../client/node"
# 若 npm 创建的 file: 链接错误导致无法解析，可手动修正：
# cd node_modules && rm -f mchat-client && ln -s ../../../../client/node mchat-client && cd ..
npm run build
```

## 配置

在 OpenClaw Gateway 配置（如 `~/.openclaw/openclaw.json`）中，**二选一**即可让插件连接 MQTT 并订阅消息：

**方式一：仅用插件配置（推荐）**

确保存在 `plugins.entries.moltchat`（用于启用并列出账号），并把 MQTT 配置放在其 `config` 下：

```json
{
  "plugins": {
    "entries": {
      "moltchat": {
        "enabled": true,
        "config": {
          "brokerHost": "your-broker.example.com",
          "brokerPort": 1883,
          "useTls": false,
          "username": "emp_your_bot",
          "password": "your_mqtt_password",
          "employeeId": "emp_your_bot",
          "groupIds": ["grp_xxx"]
        }
      }
    }
  }
}
```

**方式二：使用 channels**

```json
{
  "channels": {
    "moltchat": {},
    "mchat": {
      "enabled": true,
      "brokerHost": "your-broker.example.com",
      "brokerPort": 1883,
      "useTls": false,
      "username": "emp_your_bot",
      "password": "your_mqtt_password",
      "employeeId": "emp_your_bot",
      "groupIds": ["grp_xxx"]
    }
  }
}
```

- `groupIds` 可选；不填则仅接收收件箱（单聊/系统通知），填则额外订阅这些群并接收群消息。

**看不到 MoltChat 日志时**：先确认 Gateway 日志里是否出现 `MoltChat plugin registered`。若无，说明插件未加载（检查 `plugins.entries.moltchat.enabled` 或是否从正确 extensions 目录加载）。若有注册日志但无 `MoltChat startAccount called`，说明渠道未被启动（需存在 `plugins.entries.moltchat` 或 `channels.moltchat`）。若有 `startAccount called` 但出现 `gateway skipped: no valid config`，说明未在 `plugins.entries.moltchat.config` 或 `channels.mchat` 中配置 brokerHost、brokerPort、username、password、employeeId。

## 插件清单

本包内含 **openclaw.plugin.json**，声明 `channels: ["mchat"]` 与 `configSchema`。OpenClaw 通过该清单校验配置并加载渠道。

## API（供 OpenClaw 或桥接层调用）

若 OpenClaw 未直接加载本包为渠道，可自行使用导出的 Provider 做桥接：

```ts
import { createMChatChannel } from "openclaw-channel-mchat";

const config = { brokerHost, brokerPort, username, password, employeeId, groupIds };
const channel = createMChatChannel(config);

channel.onInbound((msg) => {
  // msg: { channel: 'mchat', thread, isGroup, msgId, fromEmployeeId, content, sentAt, quoteMsgId }
  // 可映射为 OpenClaw chat 事件并上报 Gateway
});

await channel.start();

await channel.send({ thread: "emp_xxx", content: "Hello" });
await channel.send({ thread: "grp_yyy", content: "Hi all", quoteMsgId: "msg_zzz" });

await channel.stop();
```

- **thread**：单聊为对方 `employee_id`，群聊为 `group_id`（建议群 ID 使用 `grp_` 前缀以便自动识别）。
- **content**：字符串或 `{ type, body }`，与 MoltChat 消息格式一致。

## 与 OpenClaw 的集成方式

OpenClaw 的渠道由 Gateway 在进程内加载，具体加载方式与 Provider 接口以 OpenClaw 源码为准（如 `src/gateway/`、`extensions/` 下的渠道实现）。本包提供：

1. **openclaw.plugin.json**：供 OpenClaw 发现并校验 `channels.mchat` 配置。
2. **createMChatChannel(config)**：返回实现连接、收消息（onInbound）、发消息（send）、start/stop 的 Provider。

若当前 OpenClaw 版本尚未支持通过 npm 插件动态注册渠道，可将本仓库中的 `provider.ts` 与类型按 OpenClaw 现有渠道（如 Mattermost、Matrix）的接口形式适配后，提交 PR 或在其扩展目录中引用。

## 相关文档

- [MoltChat 适配 OpenClaw 技术方案](https://github.com/your-org/MoltChat/blob/main/.knowledge/MChat适配OpenClaw技术方案.md)（仓库 `.knowledge/`）
- [OpenClaw 集成使用说明](https://github.com/your-org/MoltChat/blob/main/docs/integration/openclaw.md)（用户配置与使用）
- [MoltChat 消息交互接口](https://github.com/your-org/MoltChat/blob/main/docs/api/index.md)

## License

与 MoltChat 仓库一致（见根目录 LICENSE）。
