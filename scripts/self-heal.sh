#!/usr/bin/env bash
# scripts/self-heal.sh
#
# Failure logger / classifier stub.
# Called by scripts/runner.sh when a scrape run exits non-zero:
#
#     scripts/self-heal.sh <TS> <exit_code> <log_path>
#
# What this script ACTUALLY does (today):
#   1. Copies the last 50 lines of the run log to logs/heal-<TS>.txt
#   2. Classifies the failure by regex into one of:
#        tor-boot | imperva-block | chrome-crash | docker-down | unknown
#   3. Appends a JSON event to data/heal-log.json
#   4. Overwrites data/heal-status.json with the latest event
#   5. Prints a suggested next action for a human operator
#   6. Exits 0 — it is a logger, not a healer.
#
# What this script DOES NOT do (aspirational, left as comments only):
#   - Open a GitHub issue
#   - Page / iMessage / email the maintainer
#   - Attempt any code-level patch
#   - Restart docker, rotate Tor circuits, rebuild images, etc.
#
# If/when those get implemented, they belong in separate scripts
# wired in from here, behind explicit feature flags.

set -u
# NOTE: we deliberately do NOT `set -e`. This script must never fail the
# parent runner — its whole job is to record what already went wrong.

# ---------- args ----------
TS="${1:-}"
EXIT_CODE="${2:-}"
LOG_PATH="${3:-}"

if [ -z "$TS" ] || [ -z "$EXIT_CODE" ] || [ -z "$LOG_PATH" ]; then
  echo "self-heal: usage: $0 <TS> <exit_code> <log_path>" >&2
  # Still exit 0 — don't let bad invocation cascade-fail the runner.
  exit 0
fi

# ---------- paths ----------
# Resolve repo root from this script's location so it works no matter
# what cwd the runner invoked us from.
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
REPO_ROOT="$( cd -- "$SCRIPT_DIR/.." &> /dev/null && pwd )"

LOGS_DIR="$REPO_ROOT/logs"
DATA_DIR="$REPO_ROOT/data"
HEAL_SNIPPET="$LOGS_DIR/heal-${TS}.txt"
HEAL_LOG="$DATA_DIR/heal-log.json"
HEAL_STATUS="$DATA_DIR/heal-status.json"

mkdir -p "$LOGS_DIR" "$DATA_DIR"

# ---------- 1. capture last 50 lines of log ----------
if [ -f "$LOG_PATH" ]; then
  tail -n 50 "$LOG_PATH" > "$HEAL_SNIPPET" 2>/dev/null || true
else
  printf '(self-heal) log path not found: %s\n' "$LOG_PATH" > "$HEAL_SNIPPET"
fi

# ---------- 2. classify ----------
# Read what we just captured for matching. If the snippet is empty
# (missing log), category will fall through to "unknown".
SNIPPET_CONTENT=""
if [ -s "$HEAL_SNIPPET" ]; then
  SNIPPET_CONTENT="$(cat "$HEAL_SNIPPET")"
fi

category="unknown"
if   printf '%s' "$SNIPPET_CONTENT" | grep -Eiq 'tor failed to bootstrap'; then
  category="tor-boot"
elif printf '%s' "$SNIPPET_CONTENT" | grep -Eiq 'Access Denied|Incapsula'; then
  category="imperva-block"
elif printf '%s' "$SNIPPET_CONTENT" | grep -Eiq 'Target closed|crashed'; then
  category="chrome-crash"
elif printf '%s' "$SNIPPET_CONTENT" | grep -Eiq 'docker: command not found|Cannot connect to the Docker'; then
  category="docker-down"
fi

# ---------- suggested next action (human-facing) ----------
case "$category" in
  tor-boot)
    suggestion="restart docker desktop; pull fresh smyths-scraper:test"
    ;;
  imperva-block)
    suggestion="force Tor NEWNYM (docker exec ... ); skip + wait next tick"
    ;;
  chrome-crash)
    suggestion="rebuild image: docker buildx build --platform linux/amd64 --no-cache"
    ;;
  docker-down)
    suggestion="open Docker Desktop"
    ;;
  *)
    suggestion="inspect logs/heal-${TS}.txt manually"
    ;;
esac

# ---------- 3 & 4. build JSON event ----------
# We intentionally avoid a hard dependency on `jq`. Instead we build the
# JSON by hand with a small Python helper if available, falling back to
# manual string escaping. Python ships with macOS, so this is safe in
# this project's environment.

# First 500 chars of the snippet, for the event payload.
LOG_SNIPPET_500="$(printf '%s' "$SNIPPET_CONTENT" | cut -c 1-500)"

json_event=""
if command -v python3 >/dev/null 2>&1; then
  json_event="$(
    TS="$TS" \
    CATEGORY="$category" \
    EXIT_CODE="$EXIT_CODE" \
    LOG_SNIPPET_500="$LOG_SNIPPET_500" \
    python3 - <<'PY'
import json, os
event = {
    "ts": os.environ.get("TS", ""),
    "category": os.environ.get("CATEGORY", "unknown"),
    "exitCode": int(os.environ.get("EXIT_CODE", "0") or 0),
    "logSnippet": os.environ.get("LOG_SNIPPET_500", ""),
}
print(json.dumps(event))
PY
  )"
fi

if [ -z "$json_event" ]; then
  # Fallback: crude manual escape. Replace backslashes, double quotes,
  # newlines, carriage returns, and tabs. Good enough for a status file.
  esc_snippet="$LOG_SNIPPET_500"
  esc_snippet="${esc_snippet//\\/\\\\}"
  esc_snippet="${esc_snippet//\"/\\\"}"
  esc_snippet="${esc_snippet//$'\n'/\\n}"
  esc_snippet="${esc_snippet//$'\r'/\\r}"
  esc_snippet="${esc_snippet//$'\t'/\\t}"
  json_event="{\"ts\":\"${TS}\",\"category\":\"${category}\",\"exitCode\":${EXIT_CODE},\"logSnippet\":\"${esc_snippet}\"}"
fi

# 4. latest-event status file (single object, overwritten each call).
printf '%s\n' "$json_event" > "$HEAL_STATUS"

# 3. append to heal-log.json (a JSON array of events).
# Strategy: if the file doesn't exist or isn't valid JSON, start fresh
# with [event]. Otherwise append in-place via python3.
if command -v python3 >/dev/null 2>&1; then
  HEAL_LOG="$HEAL_LOG" EVENT_JSON="$json_event" python3 - <<'PY'
import json, os, sys

path = os.environ["HEAL_LOG"]
event = json.loads(os.environ["EVENT_JSON"])

data = []
if os.path.exists(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        if isinstance(loaded, list):
            data = loaded
    except Exception:
        data = []

data.append(event)

tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
PY
else
  # No python3 available — degrade to NDJSON-ish append. Not strictly
  # the same format, but better than losing the event entirely.
  printf '%s\n' "$json_event" >> "$HEAL_LOG"
fi

# ---------- 5. aspirational hooks (NOT implemented) ----------
# The following are intentionally NOT done here. They are logged as
# reminders for the human operator. When implemented, each should live
# behind an explicit env flag (e.g. SELF_HEAL_OPEN_ISSUE=1) so this
# script remains safe to run unattended.
#
#   - Open a GitHub Issue summarising the failure + log snippet
#   - Page / iMessage / email the maintainer
#   - Attempt a code-level patch (NEVER do this automatically)
#
# Until those exist, all we do is print the suggestion below.

# ---------- 6. surface result to the operator ----------
echo "self-heal: ts=${TS} category=${category} exit=${EXIT_CODE}"
echo "self-heal: snippet -> ${HEAL_SNIPPET}"
echo "self-heal: status  -> ${HEAL_STATUS}"
echo "self-heal: suggested next action -> ${suggestion}"

# Logger, not a healer. Always exit 0 so the parent runner's own
# exit code reflects the scrape result, not our bookkeeping.
exit 0
