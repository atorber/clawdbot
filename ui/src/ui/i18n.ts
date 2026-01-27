/**
 * Lightweight i18n for Control UI. Supports en and zh.
 * Call setLocale() (or sync from settings) before rendering so t() uses the active locale.
 */

import messagesEn from "../locales/en.json";
import messagesZh from "../locales/zh.json";

export type Locale = "en" | "zh";

const messages: Record<Locale, Record<string, string>> = {
  en: messagesEn as Record<string, string>,
  zh: messagesZh as Record<string, string>,
};

let currentLocale: Locale = "en";

export function getLocale(): Locale {
  return currentLocale;
}

/** Set active locale. Call when loading settings or when user switches language. */
export function setLocale(locale: Locale): void {
  currentLocale = locale in messages ? locale : "en";
}

/** Translate key; fallback to en then key. */
export function t(key: string): string {
  const msg = messages[currentLocale]?.[key] ?? messages.en[key];
  return typeof msg === "string" ? msg : key;
}

/** Infer default locale from browser. */
export function inferLocale(): Locale {
  if (typeof navigator === "undefined" || !navigator.language) return "en";
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}
