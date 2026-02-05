/**
 * Minimal i18n for Control UI. No runtime deps; messages in locales/*.ts.
 * Use t(key) in views; fallback: current locale → en → key.
 */
import en from "./locales/en.js";
import zhCN from "./locales/zh-CN.js";

const STORAGE_KEY = "openclaw.control.locale";
const BUNDLES: Record<string, Record<string, string>> = {
  en,
  "zh-CN": zhCN,
};

/** Supported locales for the UI dropdown. Default (first) is English. */
export const LOCALE_OPTIONS = [
  { value: "en" as const, labelKey: "i18n.en" },
  { value: "zh-CN" as const, labelKey: "i18n.zhCN" },
];

function normalizeLocale(lang: string): "en" | "zh-CN" {
  const lower = lang.trim().toLowerCase();
  if (lower.startsWith("zh")) {
    return "zh-CN";
  }
  return "en";
}

function resolveStored(): "en" | "zh-CN" {
  if (typeof localStorage === "undefined") {
    return "en";
  }
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    return normalizeLocale(raw);
  }
  return "en";
}

let currentLocale: "en" | "zh-CN" = resolveStored();

export function getLocale(): "en" | "zh-CN" {
  return currentLocale;
}

export function setLocale(locale: string): void {
  const next = normalizeLocale(locale);
  if (next === currentLocale) {
    return;
  }
  currentLocale = next;
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, next);
  }
}

/**
 * Translate by key. Fallback: current locale → en → key.
 */
export function t(key: string): string {
  const bundle = BUNDLES[currentLocale];
  const enBundle = BUNDLES.en;
  return bundle?.[key] ?? enBundle?.[key] ?? key;
}

/**
 * Call t() with a given locale (for server or tests). Does not change getLocale().
 */
export function tWithLocale(key: string, locale: "en" | "zh-CN"): string {
  const bundle = BUNDLES[locale];
  const enBundle = BUNDLES.en;
  return bundle?.[key] ?? enBundle?.[key] ?? key;
}
