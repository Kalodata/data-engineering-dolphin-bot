from __future__ import annotations

import argparse
import json
import os
import queue
import shlex
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any


EVENT_KEY = "im.message.receive_v1"


@dataclass(frozen=True)
class Config:
    allowed_users: set[str]
    allowed_chats: set[str]
    projects: dict[str, Path]
    model: str
    max_reply_chars: int

    @classmethod
    def load(cls, path: Path) -> "Config":
        raw = json.loads(path.read_text(encoding="utf-8"))
        projects = {
            name: Path(project_path).expanduser().resolve()
            for name, project_path in raw.get("projects", {}).items()
        }
        return cls(
            allowed_users=set(raw.get("allowed_users", [])),
            allowed_chats=set(raw.get("allowed_chats", [])),
            projects=projects,
            model=raw.get("model", "auto"),
            max_reply_chars=int(raw.get("max_reply_chars", 3500)),
        )


@dataclass(frozen=True)
class FeishuMessage:
    message_id: str
    chat_id: str
    chat_type: str
    sender_id: str
    text: str


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Feishu to Cursor bridge.")
    parser.add_argument(
        "--config",
        default="config.json",
        help="Path to config JSON. Copy config.example.json to start.",
    )
    args = parser.parse_args()

    config = Config.load(Path(args.config))
    if "CURSOR_API_KEY" not in os.environ:
        raise SystemExit("CURSOR_API_KEY is required.")

    bridge = Bridge(config)
    bridge.run()


class Bridge:
    def __init__(self, config: Config) -> None:
        self.config = config

    def run(self) -> None:
        proc = subprocess.Popen(
            ["lark-cli", "event", "consume", EVENT_KEY, "--as", "bot"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        assert proc.stdout is not None
        assert proc.stderr is not None

        wait_for_ready(proc)
        print(f"Listening for {EVENT_KEY}. Press Ctrl+C to stop.", file=sys.stderr)

        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = parse_message(json.loads(line))
                if message is None:
                    continue
                self.handle_message(message)
            except Exception as exc:  # Keep the bridge alive after one bad event.
                print(f"Error while handling event: {exc}", file=sys.stderr)

    def handle_message(self, message: FeishuMessage) -> None:
        if message.chat_type != "p2p":
            print(f"Ignored non-p2p chat {message.chat_id} ({message.chat_type})", file=sys.stderr)
            return
        if self.config.allowed_users and message.sender_id not in self.config.allowed_users:
            print(f"Ignored sender {message.sender_id}", file=sys.stderr)
            return
        if self.config.allowed_chats and message.chat_id not in self.config.allowed_chats:
            print(f"Ignored chat {message.chat_id}", file=sys.stderr)
            return

        command = parse_command(message.text)
        if command is None:
            return

        try:
            reply = self.run_command(command)
        except Exception as exc:
            reply = f"Error: {exc}"
        self.reply(message.message_id, trim_reply(reply, self.config.max_reply_chars))

    def run_command(self, command: list[str]) -> str:
        name = command[0].lstrip("/")
        if name == "status":
            project_names = ", ".join(sorted(self.config.projects)) or "(none)"
            return f"online\nprojects: {project_names}"
        if name == "help":
            return HELP_TEXT
        if name == "ask":
            return self.ask(command)
        if name == "review":
            return self.review(command)
        return "Unknown command. Try /help."

    def ask(self, command: list[str]) -> str:
        if len(command) < 3:
            return "Usage: /ask <project> <question>"
        project_name = command[1]
        question = " ".join(command[2:]).strip()
        project_path = self.project_path(project_name)
        prompt = (
            "You are running from a Feishu mobile bridge. Answer the user's question "
            "about this local project. Do not modify files, install dependencies, "
            "commit, push, or run destructive commands.\n\n"
            f"Question: {question}"
        )
        return run_cursor(project_path, self.config.model, prompt)

    def review(self, command: list[str]) -> str:
        if len(command) != 2:
            return "Usage: /review <project>"
        project_name = command[1]
        project_path = self.project_path(project_name)
        prompt = (
            "Review the current git changes in this project. Prioritize bugs, "
            "regressions, security risks, and missing tests. Do not modify files, "
            "install dependencies, commit, push, or run destructive commands. "
            "Return concise findings first. If there are no findings, say so."
        )
        return run_cursor(project_path, self.config.model, prompt)

    def project_path(self, project_name: str) -> Path:
        try:
            project_path = self.config.projects[project_name]
        except KeyError as exc:
            known = ", ".join(sorted(self.config.projects)) or "(none)"
            raise ValueError(f"Unknown project '{project_name}'. Known projects: {known}") from exc
        if not project_path.exists():
            raise ValueError(f"Configured project path does not exist: {project_path}")
        return project_path

    def reply(self, message_id: str, text: str) -> None:
        subprocess.run(
            [
                "lark-cli",
                "im",
                "+messages-reply",
                "--message-id",
                message_id,
                "--text",
                text,
                "--as",
                "bot",
            ],
            check=True,
        )


def wait_for_ready(proc: subprocess.Popen[str]) -> None:
    assert proc.stderr is not None
    ready = queue.Queue[str]()

    def read_stderr() -> None:
        for line in proc.stderr:
            print(line, end="", file=sys.stderr)
            if f"[event] ready event_key={EVENT_KEY}" in line:
                ready.put("ready")

    threading.Thread(target=read_stderr, daemon=True).start()
    try:
        ready.get(timeout=30)
    except queue.Empty as exc:
        proc.terminate()
        raise RuntimeError("Timed out waiting for lark-cli event consumer to become ready.") from exc


def parse_message(payload: dict[str, Any]) -> FeishuMessage | None:
    event = payload.get("event", payload)
    message = event.get("message", {}) if isinstance(event.get("message"), dict) else {}

    message_id = first_string(
        event.get("message_id"),
        message.get("message_id"),
        event.get("open_message_id"),
    )
    chat_id = first_string(
        event.get("chat_id"),
        message.get("chat_id"),
        nested(event, "chat", "chat_id"),
    )
    chat_type = first_string(
        event.get("chat_type"),
        message.get("chat_type"),
        nested(event, "chat", "chat_type"),
    )
    sender_id = first_string(
        event.get("sender_id"),
        nested(event, "sender", "sender_id", "open_id"),
        nested(event, "sender", "sender_id", "user_id"),
    )
    text = parse_content(first_string(event.get("content"), message.get("content")))

    if not message_id or not chat_id or not chat_type or not sender_id:
        print(f"Skipped event with missing IDs: {payload}", file=sys.stderr)
        return None
    return FeishuMessage(
        message_id=message_id,
        chat_id=chat_id,
        chat_type=chat_type,
        sender_id=sender_id,
        text=text,
    )


def parse_content(content: str | None) -> str:
    if not content:
        return ""
    try:
        decoded = json.loads(content)
    except json.JSONDecodeError:
        return content.strip()
    if isinstance(decoded, dict):
        text = decoded.get("text")
        if isinstance(text, str):
            return text.strip()
    return content.strip()


def parse_command(text: str) -> list[str] | None:
    stripped = text.strip()
    if not stripped.startswith("/"):
        return None
    try:
        return shlex.split(stripped)
    except ValueError as exc:
        return ["/help", f"Invalid command: {exc}"]


def run_cursor(cwd: Path, model: str, prompt: str) -> str:
    from cursor_sdk import Agent, LocalAgentOptions

    with Agent.create(
        model=model,
        api_key=os.environ["CURSOR_API_KEY"],
        local=LocalAgentOptions(cwd=str(cwd)),
    ) as agent:
        run = agent.send(prompt)
        if hasattr(run, "text"):
            return str(run.text()).strip()
        result = run.wait()
        return str(getattr(result, "result", result)).strip()


def trim_reply(text: str, max_chars: int) -> str:
    clean = text.strip() or "(empty response)"
    if len(clean) <= max_chars:
        return clean
    return clean[: max_chars - 80].rstrip() + "\n\n[truncated locally; see computer logs for full output]"


def first_string(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value:
            return value
    return None


def nested(value: dict[str, Any], *keys: str) -> Any:
    current: Any = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


HELP_TEXT = """Commands:
/status
/ask <project> <question>
/review <project>

Only configured users, chats, and project names are accepted."""


if __name__ == "__main__":
    main()

