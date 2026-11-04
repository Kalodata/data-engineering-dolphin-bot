import {
  buildProcessInstanceUiUrl,
  formatCountryDailyBoard,
  formatProgressReport,
  formatStageTimesSummary,
  formatTieredBoard,
  listCountryDailyBoard,
  listRunningProgress,
  listTieredBoard,
  loadDsEnv,
  resolveInstanceByCountryDate,
} from "./ds32_client.mjs";
import { boardCard, runningCard, stageTimesSummaryCard } from "./feishu_cards.mjs";

export function getBeijingTime(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hour: get("hour"), minute: get("minute") };
}

export function startBoardPush({ config, getDs, sendText, log = console.error }) {
  const bp = config.boardPush;
  if (!bp?.enabled || !bp?.chatId) {
    log("[board-push] disabled or no chat_id configured");
    return { stop: () => {} };
  }
  const hours = bp.hours || [9, 11, 15, 19];
  const minute = bp.minute ?? 0;
  let lastPushedHour = -1;
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const { hour, minute: currentMinute } = getBeijingTime();
    if (lastPushedHour === hour) return;
    if (!hours.includes(hour) || currentMinute !== minute) return;
    lastPushedHour = hour;
    try {
      const ds = getDs();
      const env = loadDsEnv();
      const projectCode = ds.projectCode;
      const [board, progress] = await Promise.all([
        listCountryDailyBoard(ds, {}),
        listRunningProgress(ds, {}),
      ]);
      await sendText({ chatId: bp.chatId, card: boardCard(board), text: formatCountryDailyBoard(board) });
      await sendText({
        chatId: bp.chatId,
        card: runningCard({
          enrich: progress.enrich,
          total: progress.page?.total,
          uiUrlBuilder: (inst) =>
            buildProcessInstanceUiUrl({ apiUrl: env.apiUrl, projectCode, processInstanceId: inst.id }),
        }),
        text: formatProgressReport(progress),
      });
      log(`[board-push] sent board+progress to ${bp.chatId} at Beijing hour=${hour}`);
    } catch (err) {
      log(`[board-push] error at hour=${hour}: ${err.message}`);
    }
  }

  const timer = setInterval(tick, 60_000);
  log(`[board-push] started, hours=${hours.join(",")} chat=${bp.chatId}`);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

export function startTieredBoardPush({ config, getDs, sendText, log = console.error }) {
  const bp = config.tieredBoardPush;
  if (!bp?.enabled || !bp?.chatId) {
    log("[tiered-board-push] disabled or no chat_id configured");
    return { stop: () => {} };
  }
  const hour = bp.hour ?? 15;
  const minute = bp.minute ?? 0;
  let lastPushedDate = "";
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const now = new Date();
    const { hour: currentHour, minute: currentMinute } = getBeijingTime(now);
    const todayDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    if (lastPushedDate === todayDate) return;
    if (currentHour !== hour || currentMinute !== minute) return;
    lastPushedDate = todayDate;
    try {
      const ds = getDs();
      const board = await listTieredBoard(ds, { now });
      await sendText({
        chatId: bp.chatId,
        card: boardCard({ ...board, cardTitle: `📊 分级看板 · T-2 ${board.targetDate || "?"}`, overdueLabel: "超时未完成" }),
        text: formatTieredBoard(board),
      });
      log(`[tiered-board-push] sent to ${bp.chatId} at Beijing ${hour}:${String(minute).padStart(2, "0")}`);
    } catch (err) {
      log(`[tiered-board-push] error: ${err.message}`);
    }
  }

  const timer = setInterval(tick, 60_000);
  log(`[tiered-board-push] started, hour=${hour}:${String(minute).padStart(2, "0")} chat=${bp.chatId}`);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Daily per-country stage-times push. Pilot scope: config.stageTimesPush.countries
 * (default ["id"]) — add more two-letter codes there to extend, no code change needed.
 */
export function startStageTimesPush({ config, getDs, sendText, log = console.error }) {
  const sp = config.stageTimesPush;
  if (!sp?.enabled || !sp?.chatId) {
    log("[stage-times-push] disabled or no chat_id configured");
    return { stop: () => {} };
  }
  const hour = sp.hour ?? 18;
  const minute = sp.minute ?? 0;
  const countries = sp.countries?.length ? sp.countries : ["id"];
  let lastPushedDate = "";
  let stopped = false;

  async function tick() {
    if (stopped) return;
    const now = new Date();
    const { hour: currentHour, minute: currentMinute } = getBeijingTime(now);
    const todayDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
    if (lastPushedDate === todayDate) return;
    if (currentHour !== hour || currentMinute !== minute) return;
    lastPushedDate = todayDate;

    const ds = getDs();
    const env = loadDsEnv();
    const projectCode = ds.projectCode;
    for (const country of countries) {
      try {
        const matches = await resolveInstanceByCountryDate(ds, { country });
        if (!matches.length) {
          log(`[stage-times-push] no instance found for country=${country}`);
          continue;
        }
        const inst = matches
          .slice()
          .sort((a, b) => String(b.startTime || "").localeCompare(String(a.startTime || "")))[0];
        const stages = await ds.getStageTimesSummary(inst.id, projectCode);
        const uiUrl = buildProcessInstanceUiUrl({ apiUrl: env.apiUrl, projectCode, processInstanceId: inst.id });
        await sendText({
          chatId: sp.chatId,
          card: stageTimesSummaryCard({ processInstanceId: inst.id, stages, uiUrl }),
          text: `[${country.toUpperCase()}] ${formatStageTimesSummary(inst.id, stages)}`,
        });
        log(`[stage-times-push] sent stage-times for ${country} (#${inst.id}) to ${sp.chatId}`);
      } catch (err) {
        log(`[stage-times-push] error for country=${country}: ${err.message}`);
      }
    }
  }

  const timer = setInterval(tick, 60_000);
  log(`[stage-times-push] started, hour=${hour}:${String(minute).padStart(2, "0")} countries=${countries.join(",")} chat=${sp.chatId}`);
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
