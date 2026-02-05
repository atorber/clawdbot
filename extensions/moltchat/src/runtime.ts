/**
 * 保存插件运行时（含 core），供 startAccount 内入站消息 dispatch 使用。
 * 类型为 unknown，运行时由 OpenClaw 注入，避免构建时依赖 openclaw/plugin-sdk 的 moduleResolution。
 */

let runtime: unknown = null;

export function setMoltChatRuntime(next: unknown): void {
  runtime = next;
}

export function getMoltChatRuntime(): unknown {
  return runtime;
}
