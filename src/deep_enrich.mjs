import { analyzeSqlAgainstFailure, resolveGithubRepo } from "./sql_repo_analysis.mjs";
import {
  verifyPartitionExists,
  probeQualityTable,
} from "./hive_probe.mjs";
import { recentPrsForFile } from "./github_extra.mjs";

/**
 * Enrich failure with code/git/GitHub PR + optional live partition / quality probe.
 */
export async function enrichFailureContext({
  repoRoot,
  sqlFile,
  logText = "",
  category = "",
  varsMap = {},
  hiveProbe = null,
  enablePrLookup = true,
  quality = null,
} = {}) {
  const repoAnalysis = sqlFile
    ? analyzeSqlAgainstFailure({
        repoRoot,
        sqlFile,
        logText,
        category,
        varsMap,
      })
    : { lines: [], relativePath: null, struct: null, useful: false };

  const lines = [...(repoAnalysis.lines || [])];
  let partition = null;
  let qualityHive = null;
  let prs = [];

  const hiveOn =
    Boolean(hiveProbe) &&
    hiveProbe.enabled !== false &&
    hiveProbe.onAlert === true;
  const hiveOptions = {
    enabled: true,
    timeoutMs: hiveProbe?.timeoutMs || 90_000,
    jdbcUrl: hiveProbe?.jdbcUrl,
    jdbcJar: hiveProbe?.jdbcJar,
  };

  const wantPartition =
    hiveOn &&
    (/分区\/路径/.test(String(category || "")) ||
      /InvalidInputException|Partition.+not found|Path does not exist|cannot find partition/i.test(
        String(logText || ""),
      ));

  if (wantPartition && repoAnalysis.struct) {
    partition = await verifyPartitionExists({
      struct: repoAnalysis.struct,
      varsMap,
      hiveOptions,
    });
    if (partition?.lines?.length) lines.push(...partition.lines);
  }

  const wantQualityHive =
    hiveOn &&
    (/数据质量/.test(String(category || "")) || Boolean(quality?.table));
  if (wantQualityHive && quality?.table) {
    qualityHive = await probeQualityTable({
      quality,
      varsMap,
      logText,
      hiveOptions,
    });
    if (qualityHive?.lines?.length) lines.push(...qualityHive.lines);
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
    qualityHive,
    prs,
  };
}
