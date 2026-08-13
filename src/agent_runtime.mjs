/**
 * Cursor Agent runtime helpers: local cwd vs cloud.repos.
 * Chat/Alert can run on Cursor Cloud against GitHub; Planner stays local/no-repo.
 */

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

/**
 * Merge config cloud_repos over defaults.
 * @returns {Record<string, { url: string, startingRef: string }>}
 */
export function loadCloudReposMap(rawCloudRepos = {}) {
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
} = {}) {
  const key = normalizeCloudRepoKey(sessionProjectKey || defaultKey);
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
