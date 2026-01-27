import type { IconName } from "./icons.js";
import { t } from "./i18n.js";

/** Stable id for nav group collapse state; labelKey for i18n. */
export const TAB_GROUPS = [
  { id: "chat", labelKey: "nav.groupChat", tabs: ["chat"] },
  {
    id: "control",
    labelKey: "nav.groupControl",
    tabs: ["overview", "channels", "instances", "sessions", "cron"],
  },
  { id: "agent", labelKey: "nav.groupAgent", tabs: ["skills", "nodes"] },
  { id: "settings", labelKey: "nav.groupSettings", tabs: ["config", "debug", "logs"] },
] as const;

export type Tab =
  | "overview"
  | "channels"
  | "instances"
  | "sessions"
  | "cron"
  | "skills"
  | "nodes"
  | "chat"
  | "config"
  | "debug"
  | "logs";

const TAB_PATHS: Record<Tab, string> = {
  overview: "/overview",
  channels: "/channels",
  instances: "/instances",
  sessions: "/sessions",
  cron: "/cron",
  skills: "/skills",
  nodes: "/nodes",
  chat: "/chat",
  config: "/config",
  debug: "/debug",
  logs: "/logs",
};

const PATH_TO_TAB = new Map(
  Object.entries(TAB_PATHS).map(([tab, path]) => [path, tab as Tab]),
);

export function normalizeBasePath(basePath: string): string {
  if (!basePath) return "";
  let base = basePath.trim();
  if (!base.startsWith("/")) base = `/${base}`;
  if (base === "/") return "";
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

export function normalizePath(path: string): string {
  if (!path) return "/";
  let normalized = path.trim();
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const path = TAB_PATHS[tab];
  return base ? `${base}${path}` : path;
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let path = pathname || "/";
  if (base) {
    if (path === base) {
      path = "/";
    } else if (path.startsWith(`${base}/`)) {
      path = path.slice(base.length);
    }
  }
  let normalized = normalizePath(path).toLowerCase();
  if (normalized.endsWith("/index.html")) normalized = "/";
  if (normalized === "/") return "chat";
  return PATH_TO_TAB.get(normalized) ?? null;
}

export function inferBasePathFromPathname(pathname: string): string {
  let normalized = normalizePath(pathname);
  if (normalized.endsWith("/index.html")) {
    normalized = normalizePath(normalized.slice(0, -"/index.html".length));
  }
  if (normalized === "/") return "";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return "";
  for (let i = 0; i < segments.length; i++) {
    const candidate = `/${segments.slice(i).join("/")}`.toLowerCase();
    if (PATH_TO_TAB.has(candidate)) {
      const prefix = segments.slice(0, i);
      return prefix.length ? `/${prefix.join("/")}` : "";
    }
  }
  return `/${segments.join("/")}`;
}

export function iconForTab(tab: Tab): IconName {
  switch (tab) {
    case "chat":
      return "messageSquare";
    case "overview":
      return "barChart";
    case "channels":
      return "link";
    case "instances":
      return "radio";
    case "sessions":
      return "fileText";
    case "cron":
      return "loader";
    case "skills":
      return "zap";
    case "nodes":
      return "monitor";
    case "config":
      return "settings";
    case "debug":
      return "bug";
    case "logs":
      return "scrollText";
    default:
      return "folder";
  }
}

const TITLE_KEYS: Record<Tab, string> = {
  overview: "nav.title.overview",
  channels: "nav.title.channels",
  instances: "nav.title.instances",
  sessions: "nav.title.sessions",
  cron: "nav.title.cron",
  skills: "nav.title.skills",
  nodes: "nav.title.nodes",
  chat: "nav.title.chat",
  config: "nav.title.config",
  debug: "nav.title.debug",
  logs: "nav.title.logs",
};

export function titleForTab(tab: Tab): string {
  return t(TITLE_KEYS[tab] ?? "nav.title.overview");
}


const SUBTITLE_KEYS: Record<Tab, string> = {
  overview: "nav.subtitle.overview",
  channels: "nav.subtitle.channels",
  instances: "nav.subtitle.instances",
  sessions: "nav.subtitle.sessions",
  cron: "nav.subtitle.cron",
  skills: "nav.subtitle.skills",
  nodes: "nav.subtitle.nodes",
  chat: "nav.subtitle.chat",
  config: "nav.subtitle.config",
  debug: "nav.subtitle.debug",
  logs: "nav.subtitle.logs",
};

export function subtitleForTab(tab: Tab): string {
  const key = SUBTITLE_KEYS[tab];
  return key ? t(key) : "";
}
