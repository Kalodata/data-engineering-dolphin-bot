import { analyzeSqlAgainstFailure, resolveGithubRepo } from "./sql_repo_analysis.mjs";
import { verifyPartitionExists } from "./hive_probe.mjs";
import { recentPrsForFile } from "./github_extra.mjs";

/**
 * Enrich failure with code/git/GitHub PR + optional live partition probe.
 */
export async function enrichFailureContext({
  repoRoot,
  sqlFile,
  logText = "",
  category = "",
  varsMap = {},
  hiveProbe = null,
  enablePrLookup = true,
} = {}) {
  const repoAnalysis = analyzeSqlAgainstFailure({
    repoRoot,
    sqlFile,
    logText,
    category,
    varsMap,
  });

  const lines = [...(repoAnalysis.lines || [])];
  let partition = null;
  let prs = [];

  const wantPartition =
    Boolean(hiveProbe) &&
    hiveProbe.enabled !== false &&
    hiveProbe.onAlert === true &&
    (/分区\/路径/.test(String(category || "")) ||
      /InvalidInputException|Partition.+not found|Path does not exist|cannot find partition/i.test(
        String(logText || ""),
      ));

  if (wantPartition && repoAnalysis.struct) {
    partition = await verifyPartitionExists({
      struct: repoAnalysis.struct,
      varsMap,
      hiveOptions: {
        enabled: true,
        timeoutMs: hiveProbe?.timeoutMs || 90_000,
        jdbcUrl: hiveProbe?.jdbcUrl,
        jdbcJar: hiveProbe?.jdbcJar,
      },
    });
    if (partition?.lines?.length) lines.push(...partition.lines);
  }

  if (enablePrLookup && repoRoot && repoAnalysis.relativePath) {
    const github = resolveGithubRepo(repoRoot);
    prs = recentPrsForFile(github, repoAnalysis.relativePath, { limit: 2 });
    if (prs.length) {
      lines.push(`相关 PR：${prs.map((p) => p.label).join("；")}`);
      if (prs[0]?.url) lines.push(`PR：${prs[0].url}`);
    }
  }

  return {
    ...repoAnalysis,
    useful: lines.length > 0,
    lines: lines.slice(0, 8),
    partition,
    prs,
  };
}
