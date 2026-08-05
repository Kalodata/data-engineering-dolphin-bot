import { execFileSync } from "node:child_process";

/**
 * Look up recent open/merged PRs touching a file via GitHub CLI.
 */
export function recentPrsForFile(github, relativePath, { limit = 3 } = {}) {
  if (!github?.owner || !github?.repo || !relativePath) return [];
  if (!hasGhAuth()) return [];
  const file = pathBasename(relativePath);
  try {
    const out = execFileSync(
      "gh",
      [
        "search",
        "prs",
        "--repo",
        `${github.owner}/${github.repo}`,
        file,
        "--limit",
        String(limit),
        "--json",
        "number,title,url,state",
      ],
      { encoding: "utf8", timeout: 15_000 },
    ).trim();
    const items = JSON.parse(out || "[]");
    return (items || []).slice(0, limit).map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      url: p.url,
      label: `#${p.number} ${p.title}`.slice(0, 100),
    }));
  } catch {
    return [];
  }
}

function hasGhAuth() {
  try {
    execFileSync("gh", ["auth", "status"], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function pathBasename(p) {
  const s = String(p || "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}
