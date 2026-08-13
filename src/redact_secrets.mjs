/**
 * Redact secrets before sending logs/params to Cursor Cloud.
 */

const REDACT = "[REDACTED]";

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

  // password/passwd/pwd/secret/token/api_key/access_key = value
  s = s.replace(
    /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret)\b\s*[=:]\s*([^\s&;,'"]+)/gi,
    `$1=${REDACT}`,
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
