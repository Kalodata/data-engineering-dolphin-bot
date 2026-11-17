import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runLarkCli(args) {
  const { stdout } = await execFileAsync("lark-cli", args, {
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1", LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1" },
  });
  return JSON.parse(stdout);
}

/** Separate app urgency from normal card pushes; every operation uses the sender bot. */
export function createFeishuUrgentClient({
  profile = process.env.LARK_PROFILE || process.env.FEISHU_PROFILE,
  runCli = runLarkCli,
} = {}) {
  async function call(args) {
    const result = await runCli([...(profile ? ["--profile", profile] : []), ...args, "--as", "bot"]);
    if (result?.ok !== true) throw new Error(result?.error?.message || "Feishu command failed");
    return result.data || {};
  }

  return {
    async listMemberIds(chatId) {
      const ids = new Set();
      const tokens = new Set();
      let token = "";
      let total = 0;
      do {
        const data = await call([
          "im", "chat.members", "get", "--chat-id", chatId,
          "--member-id-type", "open_id", "--page-size", "100",
          ...(token ? ["--page-token", token] : []),
        ]);
        if (data.trigger_security_conf_limit) throw new Error("Feishu member list is truncated by security settings");
        // chat.members.get excludes bots; open_id ensures the IDs can be used by urgent_app.
        for (const member of data.items || []) {
          if (typeof member.member_id !== "string" || !member.member_id.startsWith("ou_")) {
            throw new Error("Feishu member list did not return user open_id");
          }
          ids.add(member.member_id);
        }
        total = Math.max(total, Number(data.member_total) || 0);
        if (!data.has_more) break;
        token = data.page_token;
        if (!token || tokens.has(token)) throw new Error("Feishu member pagination is incomplete");
        tokens.add(token);
      } while (true);
      if (!ids.size || ids.size < total) throw new Error("Feishu member list is empty or incomplete");
      return [...ids];
    },

    async sendMessage({ chatId, text, idempotencyKey }) {
      const data = await call([
        "im", "+messages-send", "--chat-id", chatId, "--text", text,
        "--idempotency-key", idempotencyKey,
      ]);
      if (!data.message_id) throw new Error("Feishu send response has no message_id");
      return data.message_id;
    },

    async urgentMessage(messageId, userIds) {
      if (!userIds.length || userIds.length > 200) throw new Error("Feishu urgency requires 1–200 users per batch");
      const data = await call([
        "im", "messages", "urgent_app", "--message-id", messageId,
        "--user-id-type", "open_id", "--data", JSON.stringify({ user_id_list: userIds }),
      ]);
      return { invalidUserIds: data.invalid_user_id_list || [] };
    },
  };
}
