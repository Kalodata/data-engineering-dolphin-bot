/**
 * Cursor Agent runtime helpers: local cwd vs cloud.repos.
 * Chat/Alert can run on Cursor Cloud against GitHub; Planner stays local/no-repo.
 */

/** DS project codes → cloud_repos key (alert watcher has no /use session). */
export const DS_PROJECT_CODE_TO_CLOUD_KEY = {
  "9892432515424": "tiktok", // TikTok 天级 / daily
  "9892430281952": "tiktok", // hourly
  "9903013351008": "tiktok", // tiered
  "9895112718944": "tiktok", // test
  "15468494076768": "amazon",
  "16419399873888": "shopee",
};

export const DEFAULT_CLOUD_REPOS = {
  tiktok: {
    url: "https://github.com/Kalodata/data-analysis-tiktok",
    startingRef: "main",
  },
  daily: {
    url: "https://github.com/Kalodata/data-analysis-tiktok",
    startingRef: "main",
  },
  hourly: {
    url: "https://github.com/Kalodata/data-analysis-tiktok",
    startingRef: "main",
  },
  tiered: {
    url: "https://github.com/Kalodata/data-analysis-tiktok",
    startingRef: "main",
  },
  test: {
    url: "https://github.com/Kalodata/data-analysis-tiktok",
    startingRef: "main",
  },
  amazon: {
    url: "https://github.com/Kalodata/data-analysis-amazon",
    startingRef: "main",
  },
  amz: {
    url: "https://github.com/Kalodata/data-analysis-amazon",
    startingRef: "main",
  },
  shopee: {
    url: "https://github.com/Kalodata/data-analysis-shopee",
    startingRef: "main",
  },
};

/** Normalize /use key → cloud_repos map key. */
export function normalizeCloudRepoKey(key) {
  const k = String(key || "").toLowerCase().trim();
  if (!k) return "tiktok";
  if (k === "daily" || k === "hourly" || k === "tiered" || k === "test") return "tiktok";
  if (k === "amz") return "amazon";
  return k;
}

/** Map DS REST projectCode (or /use key) → cloud repo key. */
export function cloudRepoKeyFromProjectCode(projectCodeOrKey, fallback = "tiktok") {
  const raw = String(projectCodeOrKey || "").trim();
  if (!raw) return normalizeCloudRepoKey(fallback);
  if (/^\d+$/.test(raw)) {
    return DS_PROJECT_CODE_TO_CLOUD_KEY[raw] || normalizeCloudRepoKey(fallback);
  }
  return normalizeCloudRepoKey(raw);
}

/**
 * Merge config cloud_repos over defaults.
 * Pass `cloud_repos: false` or `null` to disable built-in defaults (empty map).
 * @returns {Record<string, { url: string, startingRef: string }>}
 */
export function loadCloudReposMap(rawCloudRepos) {
  if (rawCloudRepos === false || rawCloudRepos === null) return {};
  const out = { ...DEFAULT_CLOUD_REPOS };
  for (const [key, value] of Object.entries(rawCloudRepos || {})) {
    const k = String(key).toLowerCase();
    if (!value) continue;
    if (typeof value === "string") {
      out[k] = { url: value, startingRef: "main" };
      continue;
    }
    if (value.url) {
      out[k] = {
        url: String(value.url),
        startingRef: String(value.starting_ref || value.startingRef || "main"),
      };
    }
  }
  return out;
}

/**
 * Resolve which GitHub repo Cloud Agent should clone for this chat session.
 */
export function resolveCloudReposForSession({
  cloudRepos,
  sessionProjectKey = "",
  defaultKey = "tiktok",
  projectCode = "",
} = {}) {
  const key = projectCode
    ? cloudRepoKeyFromProjectCode(projectCode, sessionProjectKey || defaultKey)
    : normalizeCloudRepoKey(sessionProjectKey || defaultKey);
  const map = cloudRepos || DEFAULT_CLOUD_REPOS;
  const entry = map[key] || map.tiktok || map[normalizeCloudRepoKey(defaultKey)];
  if (!entry?.url) return [];
  return [{ url: entry.url, startingRef: entry.startingRef || "main" }];
}

/**
 * Build Agent.prompt options: either cloud.repos or local.cwd (never both).
 */
export function buildAgentPromptOptions({
  apiKey,
  model,
  runtime = "local",
  localCwd = null,
  cloudRepos = [],
  autoCreatePR = false,
} = {}) {
  const base = {
    apiKey,
    model: { id: model || "auto" },
  };
  if (runtime === "cloud") {
    return {
      ...base,
      cloud: {
        repos: Array.isArray(cloudRepos) ? cloudRepos : [],
        autoCreatePR: Boolean(autoCreatePR),
      },
    };
  }
  if (!localCwd) {
    throw new Error("local Agent runtime requires localCwd");
  }
  return {
    ...base,
    local: { cwd: localCwd },
  };
}
