# Board Push 定时推送设计

## 需求

飞书 bot 每天在北京时间 9:00、11:00、15:00、19:00 自动向指定群推送 TikTok 天级的 `/board`（各国看板）和 `/progress`（运行进度）内容。

## 架构

新增独立模块 `src/board_push.mjs`，在 `main()` 启动时与 `startFailureWatcher` 并列启动。

```
main.mjs
  ├─ startFailureWatcher(...)     ← 已有
  └─ startBoardPush(config, sendFn)  ← 新增

src/board_push.mjs
  └─ setInterval 每 60s 检查北京时间
       命中触发点 → 调 DS API → 发卡片到群
```

## 配置

`config.json` / `config.example.json` 新增 `board_push` 段：

```json
"board_push": {
  "enabled": true,
  "chat_id": "oc_xxx",
  "hours": [9, 11, 15, 19]
}
```

- `enabled`：false 时模块直接退出，不启动定时器
- `chat_id`：目标群 ID
- `hours`：触发小时列表（北京时间），默认 [9, 11, 15, 19]

时区固定 Asia/Shanghai，不做配置项。

## board_push.mjs 逻辑

```
startBoardPush(config, sendFn)
  ├─ 解析 config.board_push
  ├─ enabled=false → 直接返回
  └─ setInterval(tick, 60_000)

tick():
  1. 取北京时间当前 hour（Intl.DateTimeFormat，不引入三方库）
  2. lastPushedHour === hour → 已推，跳过
  3. hours.includes(hour) 为 false → 不在时间点，跳过
  4. 命中：
     a. lastPushedHour = hour（立即标记，防重入）
     b. listCountryDailyBoard(ds) → boardCard
     c. listRunningProgress(ds, {}) → progressText
     d. sendFn({ chatId, card: boardCard, text: progressText })
     e. 失败：console.error，不抛异常
```

## 发送方式

复用 `main.mjs` 中现有的 `sendText`/`sendCard` 函数，通过 `sendFn` 参数注入，避免模块间循环依赖。

推送格式：
- 先发 boardCard（飞书交互卡片，复用现有 `boardCard()`）
- 再发 progressText（文字，复用现有 `formatProgressReport()`）

## 防重入

`lastPushedHour` 为模块内变量（初始值 -1）。命中后立即置为当前 hour，同一小时内后续 tick 均跳过。bot 重启后重置为 -1，重启当分钟不会重复推送（因为重启后第一个 tick 距上次推送已过去至少若干秒，不影响正确性）。

## 文件改动清单

- `src/board_push.mjs`：新建
- `src/main.mjs`：import startBoardPush，在 main() 里调用
- `config.example.json`：新增 board_push 示例段
- `config.json`：新增 board_push 配置（本地，不提交）
