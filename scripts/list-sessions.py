#!/usr/bin/env python3
"""List the sessions this bridge has served, newest first.

Answers "which --session id do I pass?": the TUI's tabs show LLM-summarised
titles, not ids, so the id has to come from somewhere. The bridge writes every
session it serves into its one state file (the id map) together with the title
it was last known under — this script prints that table so the id is a copy
away.

    python3 scripts/list-sessions.py                 # newest 20
    python3 scripts/list-sessions.py -n 50            # more rows
    python3 scripts/list-sessions.py my-project       # filter by title/id/dir substring
    python3 scripts/list-sessions.py --all           # include sessions with no title

The ids printed are exactly what `--session <id>` (or `-s`) expects. For "the
newest one" use `-c`/`--continue` — opencode's own semantic, forwarded.
"""

from __future__ import annotations

import argparse
import datetime
import json
import os
import sys


def session_map_path() -> str:
    override = os.environ.get("OPENCODE_ACP_CLIENT_SESSION_MAP")
    if override and override.strip():
        return override
    return os.path.join(os.path.expanduser("~"), ".opencode-acp-client", "sessions.json")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("filter", nargs="?", help="substring to match against id, title, or directory")
    parser.add_argument("-n", "--limit", type=int, default=20, help="rows to show (default 20)")
    parser.add_argument("--all", action="store_true", help="also list sessions with no title")
    args = parser.parse_args()

    path = session_map_path()
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        print(f"no session map at {path}", file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as err:
        print(f"cannot read {path}: {err}", file=sys.stderr)
        return 1

    rows = []
    for visible_id, entry in data.items():
        if visible_id.startswith("__") or not isinstance(entry, dict):
            continue
        title = (entry.get("title") or "").strip()
        if not title and not args.all:
            continue
        directory = entry.get("directory") or ""
        if args.filter and args.filter.lower() not in (
            visible_id + " " + title + " " + directory
        ).lower():
            continue
        updated = entry.get("updatedAt") or 0
        rows.append((updated, visible_id, title, directory, entry.get("acpSessionId") or "?"))

    rows.sort(reverse=True)
    if not rows:
        print("no matching sessions")
        return 0

    now = datetime.datetime.now()
    shown = rows[: max(1, args.limit)]
    width = max(len(visible) for _, visible, *_ in shown)
    for updated, visible, title, directory, acp in shown:
        when = datetime.datetime.fromtimestamp(updated / 1000) if updated else None
        age = ""
        if when:
            delta = (now - when).total_seconds()
            if delta < 60:
                age = f"{int(delta)}s ago"
            elif delta < 3600:
                age = f"{int(delta / 60)}m ago"
            elif delta < 86400:
                age = f"{int(delta / 3600)}h ago"
            else:
                age = f"{int(delta / 86400)}d ago"
        print(f"{visible:<{width}}  {age:>7}  {title or '(untitled)'}")
        print(f"{'':<{width}}  dir: {directory or '?'}   agent-id: {acp}")
    more = len(rows) - len(shown)
    if more > 0:
        print(f"… {more} more (use -n {len(rows)} to show all)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
