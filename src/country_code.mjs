/**
 * Resolve Kalodata/DS country_code from free text.
 * Structural extraction — not sentence templates.
 */

/** Display / spoken names → ISO-like codes used in DS globalParams.country_code */
const NAME_TO_CODE = [
  [/印度尼西亚|印尼|indonesia/i, "id"],
  [/越南|vietnam/i, "vn"],
  [/泰国|thailand/i, "th"],
  [/马来西亚|马来|malaysia/i, "my"],
  [/菲律宾|philippines/i, "ph"],
  [/新加坡|singapore/i, "sg"],
  [/墨西哥|mexico/i, "mx"],
  [/美国|united\s*states|\busa\b/i, "us"],
  [/英国|united\s*kingdom|england/i, "gb"],
  [/德国|germany/i, "de"],
  [/日本|japan/i, "jp"],
  [/韩国|korea/i, "kr"],
  [/巴西|brazil/i, "br"],
  [/法国|france/i, "fr"],
  [/西班牙|spain/i, "es"],
  [/意大利|italy/i, "it"],
];

/** Codes that appear often as English words — need stronger context. */
const AMBIGUOUS_CODES = new Set(["id", "us", "my", "de", "in", "me", "to", "or", "no"]);

/** Known DS country_code values (extend as needed). */
export const KNOWN_COUNTRY_CODES = new Set([
  "id",
  "vn",
  "th",
  "my",
  "ph",
  "sg",
  "mx",
  "us",
  "gb",
  "de",
  "jp",
  "kr",
  "br",
  "fr",
  "es",
  "it",
]);

/**
 * @returns {string|null} lower-case country_code
 */
export function resolveCountryCode(text) {
  const t = String(text || "").trim();
  if (!t) return null;

  // Explicit param: country_code=id / country: vn
  const explicit = t.match(
    /country[_\s-]?code\s*[=:]\s*([a-z]{2})\b|country\s*[=:]\s*([a-z]{2})\b/i,
  );
  if (explicit) {
    const code = (explicit[1] || explicit[2] || "").toLowerCase();
    if (KNOWN_COUNTRY_CODES.has(code)) return code;
  }

  for (const [re, code] of NAME_TO_CODE) {
    if (re.test(t)) return code;
  }

  // "vn分区" / "分区 vn" / "id 天级"
  const beside = t.match(
    /\b([a-z]{2})\b\s*(?:分区|天级|国家|站点)|(?:分区|国家|站点|country)\s*[=:]?\s*\b([a-z]{2})\b/i,
  );
  if (beside) {
    const code = (beside[1] || beside[2] || "").toLowerCase();
    if (KNOWN_COUNTRY_CODES.has(code)) return code;
  }

  // Bare ISO2 from known set
  const bare = t.match(/\b([a-z]{2})\b/gi) || [];
  for (const raw of bare) {
    const code = raw.toLowerCase();
    if (!KNOWN_COUNTRY_CODES.has(code)) continue;
    if (AMBIGUOUS_CODES.has(code)) {
      // ambiguous: only if DS-ish neighbor words in the same utterance
      if (
        /(分区|天级|国家|站点|country|任务|工作流|实例|调度|dolphin|stage|ads|dwd|dws|dwm)/i.test(
          t,
        )
      ) {
        return code;
      }
      continue;
    }
    return code;
  }

  return null;
}
