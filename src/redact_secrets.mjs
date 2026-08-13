/**
 * Redact secrets before sending logs/params to Cursor Cloud.
 */

const REDACT = "[REDACTED]";

const SECRET_KEY =
  "password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret";

/**
 * Scrub common credential patterns from free text (DS logs, JDBC URLs, headers).
 */
export function redactSecrets(text) {
  let s = String(text ?? "");
  if (!s) return s;

  // jdbc:hive2://user:password@host
  s = s.replace(
    /\bjdbc:([a-z0-9.+-]+):\/\/([^/@\s]+):([^@/\s]+)@/gi,
    `jdbc:$1://$2:${REDACT}@`,
  );

  // JSON / quoted keys: "password":"secret" or 'token':'abc'
  s = s.replace(
    new RegExp(
      `(["'])(${SECRET_KEY})\\1\\s*:\\s*(["'])(?:\\\\.|(?!\\3).)*\\3`,
      "gi",
    ),
    (_, q1, key, q2) => `${q1}${key}${q1}:${q2}${REDACT}${q2}`,
  );

  // Unquoted JSON-ish: password: "secret" / password: 'secret'
  s = s.replace(
    new RegExp(`\\b(${SECRET_KEY})\\b\\s*:\\s*(["'])(?:\\\\.|(?!\\2).)*\\2`, "gi"),
    (_, key, q) => `${key}:${q}${REDACT}${q}`,
  );

  // Shell / props: password='secret' password="secret" password=secret
  s = s.replace(
    new RegExp(
      `\\b(${SECRET_KEY})\\b(\\s*[=:]\\s*)(["']?)([^\\s&;,'"}]+)\\3`,
      "gi",
    ),
    (_, key, sep, q) => `${key}${sep}${q}${REDACT}${q}`,
  );

  // URL query variants: ?Password=xxx&Token=yyy (case-insensitive keys)
  s = s.replace(
    new RegExp(`([?&])(${SECRET_KEY})=([^&#\\s]*)`, "gi"),
    (_, prefix, key) => `${prefix}${key}=${REDACT}`,
  );

  // Authorization: Bearer xxx / Basic xxx
  s = s.replace(
    /\b(Authorization)\s*:\s*(Bearer|Basic)\s+\S+/gi,
    `$1: $2 ${REDACT}`,
  );

  // AWS SigV4 query / header fragments
  s = s.replace(/\b(X-Amz-Credential)=([^&\s]+)/gi, `$1=${REDACT}`);
  s = s.replace(/\b(X-Amz-Signature)=([^&\s]+)/gi, `$1=${REDACT}`);
  s = s.replace(/\b(X-Amz-Security-Token)=([^&\s]+)/gi, `$1=${REDACT}`);
  s = s.replace(
    /\b(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID)\s*[=:]\s*\S+/gi,
    `$1=${REDACT}`,
  );

  // Common env dumps
  s = s.replace(
    /\b(DS_API_TOKEN|CURSOR_API_KEY|HIVE_JDBC_URL)\s*[=:]\s*\S+/gi,
    `$1=${REDACT}`,
  );

  return s;
}
