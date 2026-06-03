import { cookies } from "next/headers";
import { messages, defaultLocale, locales, type Locale, type MessageKey } from "./config";

export async function getLocale(): Promise<Locale> {
  const c = await cookies();
  const v = c.get("lang")?.value as Locale | undefined;
  return v && (locales as readonly string[]).includes(v) ? v : defaultLocale;
}

/** Returns a translator bound to the current cookie locale (falls back to English). */
export async function getT() {
  const locale = await getLocale();
  return (key: MessageKey): string => messages[locale][key] ?? messages.en[key];
}
