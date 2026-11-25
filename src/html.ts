import { decodeHTML } from "entities";

/** Convert CP's rich-text HTML to readable plain text. */
export function htmlToText(html: unknown): string {
  if (typeof html !== "string" || !html) return "";
  const text = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*\/\s*(p|div|ul|ol|h[1-6]|tr|table)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeHTML(text)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
