import {
  buildProcessInstanceUiUrl,
  formatCountryDailyBoard,
  formatProgressReport,
  formatTieredBoard,
  listCountryDailyBoard,
  listRunningProgress,
  listTieredBoard,
  loadDsEnv,
} from "./ds32_client.mjs";
import { boardCard, runningCard } from "./feishu_cards.mjs";

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
