#!/usr/bin/env python3
"""Read-only delivery audit. Native user records, not sampled turn transitions, prove ingestion.

Usage: python3 scripts/audit-codex-delivery.py --since 2026-10-22T21:00:00Z --until 2026-10-29T21:00:00Z
Outputs JSON. A missing native input is an investigation candidate, NOT proof of loss:
history may be unavailable, and a native queue can defer ingestion until an ongoing turn ends.
"""
import argparse
import collections
import datetime as dt
import json
import os
from pathlib import Path
import re
import shlex
from zoneinfo import ZoneInfo


def instant(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def iso(value):
    return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat()


def log_rows(path):
    for p in sorted(path.parent.glob(path.name + "*")):
        if not p.is_file():
            continue
        for line in p.open(errors="replace"):
            try:
                yield dict(word.split("=", 1) for word in shlex.split(line) if "=" in word)
            except ValueError:
                continue


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True)
    parser.add_argument("--until", required=True)
    parser.add_argument("--root", default=str(Path.home() / ".iapeer"))
    parser.add_argument("--codex-home", default=os.getenv("CODEX_HOME", str(Path.home() / ".codex")))
    parser.add_argument("--timezone", default="Europe/Moscow")
    args = parser.parse_args()
    since, until = instant(args.since), instant(args.until)
    zone = ZoneInfo(args.timezone)
    root, home = Path(args.root), Path(args.codex_home)
    peers = json.loads((root / "peers-profiles.json").read_text())["peers"]
    cwd_by_peer = {p["personality"]: os.path.realpath(p["cwd"]) for p in peers}
    deliveries, failures = [], []
    for r in log_rows(root / "logs/iapeer/delivery.log"):
        try:
            at = instant(r["ts"])
        except (KeyError, ValueError):
            continue
        if not since <= at < until or r.get("ev") != "delivery":
            continue
        if r.get("ok") != "true":
            if "Codex" in r.get("err", "") or r.get("rt") == "codex":
                failures.append(r)
            continue
        if not r.get("via", "").startswith("codex-"):
            continue
        dispatch = at - float(r.get("ms", 0)) / 1000
        caller = r.get("caller", "").split("-", 1)
        if len(caller) != 2:
            continue
        deliveries.append({**r, "dispatch_estimate": iso(dispatch), "_dispatch": dispatch,
                           "_caller_runtime": caller[0], "_caller_peer": caller[1],
                           "_cwd": cwd_by_peer.get(r["to"]), "_matches": []})
    wanted = {r["_cwd"] for r in deliveries if r["_cwd"]}
    turns = collections.defaultdict(list)
    for r in log_rows(root / "logs/iapeer/turns.log"):
        if r.get("runtime") != "codex" or r.get("ev") not in ("turn-started", "turn-ended"):
            continue
        try:
            turns[r["personality"]].append((instant(r.get("at_iso", r["ts"])), r["ev"]))
        except (ValueError, KeyError):
            continue
    for events in turns.values():
        events.sort()
    by_key = collections.defaultdict(list)
    for r in deliveries:
        by_key[(r["_cwd"], r["_caller_peer"], r["_caller_runtime"], r.get("topic", ""))].append(r)
    files_read = 0
    for folder in (home / "sessions", home / "archived_sessions"):
        for path in folder.rglob("*.jsonl"):
            if path.stat().st_mtime < since:
                continue
            with path.open(errors="replace") as f:
                try:
                    meta = json.loads(next(f))
                    cwd = os.path.realpath(meta["payload"]["cwd"])
                except (ValueError, KeyError, StopIteration):
                    continue
                if cwd not in wanted:
                    continue
                files_read += 1
                for line in f:
                    try:
                        native = json.loads(line)
                        payload = native.get("payload", {})
                        if native.get("type") != "response_item" or payload.get("type") != "message" or payload.get("role") != "user":
                            continue
                        at = instant(native["timestamp"])
                        # A recurring timer with a time-only stamp on the NEXT day must not be
                        # borrowed as proof for an earlier failed dispatch. Allow only a short drain.
                        if at < since - 120 or at >= until + 120:
                            continue
                    except (ValueError, KeyError):
                        continue
                    for part in payload.get("content", []):
                        if not isinstance(part, dict) or part.get("type") != "input_text":
                            continue
                        for tag in re.finditer(r"<iap\s+([^>]+)>", part.get("text", "")):
                            attrs = dict(re.findall(r'([\w-]+)="([^"]*)"', tag[1]))
                            sender = attrs.get("from", attrs.get("from-personality"))
                            runtime = attrs.get("runtime", attrs.get("from-runtime"))
                            stamp = attrs.get("ts", "")
                            for r in by_key.get((cwd, sender, runtime, attrs.get("topic", "")), []):
                                dispatch = r["_dispatch"]
                                if at < dispatch - 2:
                                    continue
                                local = dt.datetime.fromtimestamp(dispatch, zone)
                                try:
                                    if re.fullmatch(r"\d\d:\d\d:\d\d", stamp):
                                        clock = dt.time.fromisoformat(stamp)
                                        # Delivery elapsed time is rounded; consider midnight ±1 day.
                                        stamps = [dt.datetime.combine(local.date() + dt.timedelta(days=d), clock, zone).timestamp() for d in (-1, 0, 1)]
                                    elif re.fullmatch(r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d", stamp):
                                        stamps = [dt.datetime.fromisoformat(stamp).replace(tzinfo=zone).timestamp()]
                                    else:
                                        stamps = [instant(stamp)]
                                except ValueError:
                                    continue
                                if min(abs(s - dispatch) for s in stamps) <= 2:
                                    r["_matches"].append({"at": at, "path": str(path), "envelope_ts": stamp})
    summary = collections.defaultdict(collections.Counter)
    for r in deliveries:
        events = turns[r["to"]]
        before = [e for e in events if e[0] <= r["_dispatch"]]
        after = [e for e in events if e[0] > r["_dispatch"] and e[1] == "turn-started"]
        r["previous_turn_event"] = {"at": iso(before[-1][0]), "event": before[-1][1]} if before else None
        r["next_turn_start"] = iso(after[0][0]) if after else None
        r["next_turn_start_delay_s"] = round(after[0][0] - r["_dispatch"], 3) if after else None
        matches = sorted(r.pop("_matches"), key=lambda m: m["at"])
        if matches:
            m = matches[0]
            r["native_input_at"] = iso(m["at"])
            r["native_input_delay_s"] = round(m["at"] - r["_dispatch"], 3)
            r["native_rollout"] = m["path"]
            # A compact time-only stamp may name an older delayed message with the same schedule.
            # Late matches are candidates, never a definitive assertion that THIS delivery landed.
            r["status"] = "native_input" if r["native_input_delay_s"] <= 120 else "late_native_input_candidate"
        else:
            r["status"] = "missing_native_input" if r["_cwd"] else "unknown_recipient_cwd"
        summary[r["to"]][r["status"]] += 1
        for k in list(r):
            if k.startswith("_"):
                del r[k]
    print(json.dumps({"since": args.since, "until": args.until, "scanned_rollouts": files_read,
                      "method": "Match new native USER IAP header by recipient cwd, caller, topic, and dispatch timestamp (delivery end minus ms, ±2s). Late/missing inputs require investigation; turn sampling alone is not proof. Current registry maps recipient cwd; no message bodies emitted.",
                      "summary": summary, "deliveries": deliveries, "failures": failures}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
