#!/usr/bin/env python3
"""Local read-only proxy: dsctl 3.4.1 paths → Kalodata classic DS REST.

Rewrites:
  /v2/projects              → /projects
  /workflow-instances       → /process-instances
  /workflow-definition(s)   → /process-definition(s)

Also renames classic process* JSON fields to workflow* and injects projectCode
so dsctl 3.4.1 pydantic/service layer accepts the payload.

Readonly by default (blocks POST/PUT/PATCH/DELETE).
"""

from __future__ import annotations

import json
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen

LISTEN_HOST = os.environ.get("DS_PROXY_HOST", "127.0.0.1")
LISTEN_PORT = int(os.environ.get("DS_PROXY_PORT", "18765"))
UPSTREAM = os.environ.get(
    "DS_UPSTREAM_URL",
    "https://ds-offline.kalowave.com/dolphinscheduler",
).rstrip("/")
PREFIX = "/dolphinscheduler"
READONLY = os.environ.get("DS_PROXY_READONLY", "1") not in {"0", "false", "False"}
WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

PROJECT_RE = re.compile(r"/projects/(\d+)(?:/|$)")
INSTANCE_ID_RE = re.compile(r"/process-instances/(\d+)(?:/|$)")
DEFAULT_PROJECT_CODE = os.environ.get("DS_DEFAULT_PROJECT_CODE", "9892432515424")

# id -> projectCode learned from list/get under /projects/{code}/...
INSTANCE_PROJECT_CACHE: dict[int, int] = {}

INSTANCE_FIELD_MAP = {
    "processDefinitionCode": "workflowDefinitionCode",
    "processDefinitionVersion": "workflowDefinitionVersion",
    "processDefinition": "workflowDefinition",
    "isSubProcess": "isSubWorkflow",
    "processInstancePriority": "workflowInstancePriority",
    "nextProcessInstanceId": "nextWorkflowInstanceId",
}

TASK_FIELD_MAP = {
    "processInstanceId": "workflowInstanceId",
    "processInstanceName": "workflowInstanceName",
    "processDefinitionName": "workflowDefinitionName",
    "processInstancePriority": "workflowInstancePriority",
    "subProcess": "subWorkflow",
    "processDefine": "workflowDefine",
    "processInstance": "workflowInstance",
}


def rewrite_query(query: str) -> str:
    if not query:
        return query
    q = parse_qs(query, keep_blank_values=True)
    mapping = {
        "workflowInstanceId": "processInstanceId",
        "workflowDefinitionCode": "processDefineCode",
        "processDefineCode": "processDefineCode",
    }
    out: dict[str, list[str]] = {}
    for k, vals in q.items():
        out[mapping.get(k, k)] = vals
    return urlencode({k: v[0] for k, v in out.items()})


def rewrite_path(path: str) -> str:
    p = path
    if p.startswith(PREFIX + PREFIX):
        p = p[len(PREFIX) :]
    if p.startswith(PREFIX + "/v2/"):
        p = PREFIX + "/" + p[len(PREFIX + "/v2/") :]
    elif p.startswith("/v2/"):
        p = "/" + p[len("/v2/") :]

    for old, new in (
        ("/workflow-instances", "/process-instances"),
        ("/workflow-definitions", "/process-definitions"),
        ("/workflow-definition", "/process-definition"),
    ):
        if old in p:
            p = p.replace(old, new)

    # Classic API requires project scope for instance get:
    #   /process-instances/{id} → /projects/{code}/process-instances/{id}
    if "/projects/" not in p:
        m = INSTANCE_ID_RE.search(p)
        if m:
            inst_id = int(m.group(1))
            code = INSTANCE_PROJECT_CACHE.get(inst_id) or int(DEFAULT_PROJECT_CODE)
            rest = p.split(f"/process-instances/{inst_id}", 1)[1]
            p = f"{PREFIX}/projects/{code}/process-instances/{inst_id}{rest}"

    if not p.startswith(PREFIX) and not p.startswith("/actuator"):
        if p.startswith("/actuator"):
            p = PREFIX + p
        elif not p.startswith("/"):
            p = PREFIX + "/" + p
        else:
            p = PREFIX + p
    return p


def remember_instances(project_code: int | None, body: Any) -> None:
    if project_code is None:
        return
    rows: list[Any] = []
    if isinstance(body, dict) and isinstance(body.get("totalList"), list):
        rows = body["totalList"]
    elif isinstance(body, dict) and body.get("id") is not None:
        rows = [body]
    for row in rows:
        if isinstance(row, dict) and row.get("id") is not None:
            INSTANCE_PROJECT_CACHE[int(row["id"])] = int(project_code)


def _map_obj(obj: dict[str, Any], field_map: dict[str, str]) -> dict[str, Any]:
    out = dict(obj)
    for src, dst in field_map.items():
        if src in out and dst not in out:
            out[dst] = out[src]
    return out


def normalize_payload(path: str, data: bytes, project_code: int | None) -> bytes:
    """Best-effort JSON reshape for dsctl 3.4.1 validators."""
    try:
        payload = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return data
    if not isinstance(payload, dict):
        return data

    body = payload.get("data")
    if "process-instances" in path:
        remember_instances(project_code, body)
        if isinstance(body, dict) and isinstance(body.get("totalList"), list):
            body["totalList"] = [
                _enrich_instance(row, project_code) for row in body["totalList"]
            ]
        elif isinstance(body, dict) and body.get("id") is not None:
            payload["data"] = _enrich_instance(body, project_code)
    elif "task-instances" in path:
        if isinstance(body, dict) and isinstance(body.get("totalList"), list):
            body["totalList"] = [
                _enrich_task(row, project_code) for row in body["totalList"]
            ]
        elif isinstance(body, dict):
            payload["data"] = _enrich_task(body, project_code)

    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


def _enrich_task(row: Any, project_code: int | None) -> Any:
    if not isinstance(row, dict):
        return row
    out = _map_obj(row, TASK_FIELD_MAP)
    if project_code is not None and out.get("projectCode") in (None, 0, ""):
        out["projectCode"] = project_code
    return out


def _enrich_instance(row: Any, project_code: int | None) -> Any:
    if not isinstance(row, dict):
        return row
    out = _map_obj(row, INSTANCE_FIELD_MAP)
    if project_code is not None and out.get("projectCode") in (None, 0, ""):
        out["projectCode"] = project_code
    # Flag enums: classic may return "YES"/"NO" strings — leave as-is
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        sys.stderr.write("[ds-classic-proxy] " + (fmt % args) + "\n")

    def _handle(self) -> None:
        method = self.command.upper()
        parsed = urlsplit(self.path)
        raw_path = parsed.path
        query = parsed.query

        if READONLY and method in WRITE_METHODS:
            body = json.dumps(
                {
                    "code": 403,
                    "msg": (
                        "ds-classic-proxy readonly: refusing "
                        f"{method} {raw_path}"
                    ),
                    "data": None,
                }
            ).encode()
            self._write(403, body, "application/json")
            return

        if not (
            raw_path.startswith(PREFIX)
            or raw_path.startswith("/actuator")
            or raw_path.startswith("/v2/")
        ):
            self.send_error(404, "not a DS API path")
            return

        new_path = rewrite_path(raw_path)
        m = PROJECT_RE.search(new_path)
        project_code = int(m.group(1)) if m else None

        if new_path.startswith(PREFIX):
            upstream_url = UPSTREAM + new_path[len(PREFIX) :]
        elif new_path.startswith("/actuator"):
            upstream_url = UPSTREAM + new_path
        else:
            upstream_url = UPSTREAM + "/" + new_path.lstrip("/")

        length = int(self.headers.get("Content-Length") or 0)
        req_body = self.rfile.read(length) if length else None

        # v2 list sometimes puts filters in JSON body on GET
        if (
            method == "GET"
            and new_path.rstrip("/").endswith("process-instances")
            and req_body
        ):
            try:
                payload = json.loads(req_body.decode() or "{}")
            except json.JSONDecodeError:
                payload = {}
            if isinstance(payload, dict):
                q = parse_qs(query, keep_blank_values=True)
                for k, v in payload.items():
                    if v is None:
                        continue
                    key = {
                        "pageNo": "pageNo",
                        "pageSize": "pageSize",
                        "state": "stateType",
                        "searchVal": "searchVal",
                        "workflowName": "searchVal",
                    }.get(k, k)
                    q[key] = [str(v)]
                query = urlencode({k: vals[0] for k, vals in q.items()})
                req_body = None

        if query:
            query = rewrite_query(query)
            upstream_url = upstream_url + "?" + query

        headers: dict[str, str] = {"Accept": "application/json"}
        token = self.headers.get("token") or self.headers.get("Token")
        if token:
            headers["token"] = token
        ctype = self.headers.get("Content-Type")
        if ctype and req_body is not None:
            headers["Content-Type"] = ctype

        self.log_message("%s %s -> %s", method, raw_path, upstream_url)

        try:
            upstream_req = Request(
                upstream_url, data=req_body, headers=headers, method=method
            )
            with urlopen(upstream_req, timeout=120) as resp:
                data = resp.read()
                if data.lstrip()[:1] in (b"<", b"!") or b"<html" in data[:200].lower():
                    data = json.dumps(
                        {
                            "code": 502,
                            "msg": "upstream returned HTML after rewrite",
                            "data": {"upstream": upstream_url, "original": raw_path},
                        }
                    ).encode()
                    self._write(502, data, "application/json")
                    return
                data = normalize_payload(new_path, data, project_code)
                self._write(resp.status, data, "application/json")
        except HTTPError as e:
            data = e.read()
            try:
                data = normalize_payload(new_path, data, project_code)
            except Exception:
                pass
            self._write(e.code, data, e.headers.get("Content-Type", "application/json"))
        except URLError as e:
            data = json.dumps(
                {"code": 502, "msg": f"upstream error: {e}", "data": None}
            ).encode()
            self._write(502, data, "application/json")

    def _write(self, status: int, data: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        self._handle()

    def do_POST(self) -> None:  # noqa: N802
        self._handle()

    def do_PUT(self) -> None:  # noqa: N802
        self._handle()

    def do_PATCH(self) -> None:  # noqa: N802
        self._handle()

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle()

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle()


def main() -> int:
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), Handler)
    print(
        f"ds-classic-proxy on http://{LISTEN_HOST}:{LISTEN_PORT}{PREFIX}\n"
        f"upstream={UPSTREAM} readonly={READONLY}\n"
        f"DS_API_URL=http://{LISTEN_HOST}:{LISTEN_PORT}{PREFIX}",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
