import region from "./regions/TW.json";
import deployment from "./deployment.json";
import regions from "./regions/index.json";
import profiles from "./profiles.json";

export const locales = ["ko-KR", "zh-TW", "en-US"] as const;
export type Locale = (typeof locales)[number];
export type Dictionary = { [key: string]: string | Dictionary };
export const localeNames: Record<Locale, string> = {
  "ko-KR": "한국어",
  "zh-TW": "繁體中文",
  "en-US": "English",
};
export function regionConfig(
  code = deployment.region,
  profile = deployment.profile,
) {
  if (
    !regions.regions.includes(code) ||
    code !== region.code ||
    !region.enabled
  )
    throw new Error(`Unsupported region: ${code}`);
  if (!Object.hasOwn(profiles, profile))
    throw new Error(`Unknown profile: ${profile}`);
  const overlay = profiles[profile as keyof typeof profiles];
  return { ...region, ...overlay };
}
export const regionCode = regionConfig().code;
/** Adult content entry: rating mark (empty for none) and the warning text key. */
export const ageConfig = regionConfig().age;
/** Consent items in display order; `document_url` may be empty until the document exists. */
export const consentItems = regionConfig().consent.items;
export const languageConfig = regionConfig().locale;
export const supportedLocales = languageConfig.supported as Locale[];
export const defaultLocale = languageConfig.default as Locale;
export function resolveLocale(
  requested: string | null | undefined,
  config = languageConfig,
): Locale {
  const exact = config.supported.find((locale) => locale === requested);
  const sameLanguage = config.supported.find(
    (locale) => locale.split("-")[0] === requested?.split("-")[0],
  );
  return (exact ?? sameLanguage ?? config.default) as Locale;
}
export function text(
  bundle: Dictionary,
  key: string,
  params: Record<string, string | number> = {},
): string {
  let result: string | Dictionary = bundle;
  for (const part of key.split(".")) {
    if (typeof result === "string" || !(part in result)) return key;
    result = result[part];
  }
  if (typeof result !== "string") return key;
  return result.replace(/\{([a-z_]+)\}/g, (_, name: string) =>
    String(params[name] ?? `{${name}}`),
  );
}
export function resolveText(
  value: { source_locale: Locale; texts: Partial<Record<Locale, string>> },
  locale: Locale,
): string {
  return (
    value.texts[locale] ||
    Object.entries(value.texts).find(
      ([key, item]) => item && key.split("-")[0] === locale.split("-")[0],
    )?.[1] ||
    value.texts[value.source_locale] ||
    ""
  );
}
