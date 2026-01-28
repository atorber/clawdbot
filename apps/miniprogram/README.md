# MQTT 微信小程序客户端

作为 [MQTT channel](https://github.com/moltbot/moltbot/tree/main/extensions/mqtt) 的配套客户端，支持配置 MQTT 信息并通过聊天界面与 Gateway 进行消息交互。

## 功能

- **配置页**：填写 Broker 地址（WebSocket）、用户名/密码、客户端 ID、入站/出站 Topic 模板
- **聊天页**：连接 MQTT、发送文本消息到 Gateway 入站 topic、订阅出站 topic 接收 Agent 回复

## 协议说明

与 Gateway MQTT channel 一致：

1. **入站**：向配置的入站 topic（如 `devices/{clientId}/in`）发布 JSON：`{"messageId":"唯一ID","text":"消息内容"}`
2. **出站**：订阅出站 topic（如 `devices/{clientId}/out`）接收 Gateway 下发的回复（纯文本或 JSON）

详见 [extensions/mqtt/README.md](../../extensions/mqtt/README.md)。

## 开发与运行

1. 使用 [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) 打开本目录（`apps/miniprogram`）
2. 若使用自己的 AppID，在「详情 - 本地设置」中勾选「不校验合法域名」便于本地调试
3. 正式发布前需在微信公众平台「开发 - 开发管理 - 开发设置 - 服务器域名」中配置 **socket 合法域名**（如 `wss://your-broker.com`），且域名需已备案

## 配置项

| 配置 | 说明 |
|------|------|
| Broker 地址 | MQTT over WebSocket 的完整 URL，如 `wss://broker.example.com:443/mqtt` |
| 用户名/密码 | 可选，与 Gateway 端 MQTT 账户一致 |
| 客户端 ID | 用于替换 topic 中的占位符，如 `devices/+/in` → `devices/my-client/in` |
| 入站 Topic 模板 | 发往 Gateway 的 topic，`+` 或 `{id}` 会替换为客户端 ID |
| 出站 Topic 模板 | 订阅以接收回复的 topic，占位符同上 |

## 目录结构

```
apps/miniprogram/
├── app.js / app.json / app.wxss
├── project.config.json
├── pages/
│   ├── config/     # MQTT 配置页
│   └── chat/        # 聊天页
├── utils/
│   ├── wx-websocket.js   # 微信 WebSocket 适配
│   ├── mqtt-client.js    # 最小 MQTT over WebSocket 客户端
│   └── storage.js       # 配置持久化
└── README.md
```

本小程序不依赖 npm 的 mqtt 包，使用内置的 MQTT 3.1.1 over WebSocket 实现，便于在微信环境中直接运行。
