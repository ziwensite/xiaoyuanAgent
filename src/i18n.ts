import zh from "./locales/zh.json";
import en from "./locales/en.json";

const locales: Record<string, Record<string, string>> = { zh, en };
let locale = "zh";

export function initLocale(): void {
  try {
    const lang = (window.localStorage?.getItem("language") as string) || navigator.language || "zh";
    locale = lang.startsWith("zh") ? "zh" : "en";
  } catch {
    locale = "zh";
  }
}

export function t(key: string, ...args: string[]): string {
  const dict = locales[locale] || locales.zh;
  let text = dict[key];
  if (text === undefined) {
    const fallback = locales.zh[key];
    text = fallback !== undefined ? fallback : key;
  }
  // 用 split/join 而不是 replace：后者传字符串只替换第一处，且会把 arg 里的
  // `$&` / `$'` 当成替换模式，导致带这些字符的消息（如含 $ 的代码）被改坏。
  args.forEach((arg, i) => {
    text = text.split(`{${i}}`).join(arg);
  });
  return text;
}
