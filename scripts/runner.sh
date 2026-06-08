#!/usr/bin/env bash
# scripts/runner.sh
# Hourly job: run Smyths scraper docker image, diff results, update site data, commit & push.
# Safe to re-run. Designed for cron with empty PATH.
#
# Exit codes:
#   0 = success (scrape ran and produced data)
#   1 = scrape failure (docker exited non-zero, report missing, or zero successes)
#   2 = setup failure (docker not found, urls.txt missing, repo missing, etc.)

set -euo pipefail

# ----- PATH (cron has empty PATH) -----
export PATH="/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"

# ----- Absolute paths -----
REPO="/Users/phktistakis/smyths-scraper-site"
SCRIPTS_DIR="$REPO/scripts"
DATA_DIR="$REPO/data"
RUNS_DIR="$DATA_DIR/runs"
REPORTS_DIR="$DATA_DIR/reports"
CHANGES_DIR="$DATA_DIR/changes"
LOGS_DIR="$REPO/logs"
URLS_FILE="$DATA_DIR/urls.txt"
ENV_FILE="$REPO/secrets/.env"
TIMELINE_FILE="$DATA_DIR/timeline.json"
SUMMARY_FILE="$DATA_DIR/run-summary.json"
LATEST_CHANGES_FILE="$DATA_DIR/latest-changes.json"
CRON_LOG="$LOGS_DIR/cron.log"
LOCK_FILE="/tmp/smyths-runner.lock"
DOCKER_IMAGE="smyths-scraper:test"
DOCKER_TIMEOUT_SEC=1800

# ----- Timestamp -----
TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_LOG="$LOGS_DIR/$TS.log"

# ----- Helpers -----
log_cron() {
  mkdir -p "$LOGS_DIR" 2>/dev/null || true
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$CRON_LOG" 2>/dev/null || true
}

die_setup() {
  log_cron "SETUP-FAIL ts=$TS msg=$*"
  echo "SETUP FAIL: $*" >&2
  exit 2
}

# ----- Single-instance lock (macOS lacks flock; use mkdir/PID file) -----
acquire_lock() {
  if mkdir "$LOCK_FILE" 2>/dev/null; then
    echo "$$" > "$LOCK_FILE/pid"
    trap 'rm -rf "$LOCK_FILE"' EXIT INT TERM
    return 0
  fi
  # Stale lock check: if PID file exists but process is dead, take over.
  if [ -f "$LOCK_FILE/pid" ]; then
    local old_pid
    old_pid="$(cat "$LOCK_FILE/pid" 2>/dev/null || echo "")"
    if [ -n "$old_pid" ] && ! kill -0 "$old_pid" 2>/dev/null; then
      log_cron "STALE-LOCK pid=$old_pid clearing"
      rm -rf "$LOCK_FILE"
      mkdir "$LOCK_FILE" 2>/dev/null || die_setup "could not reclaim lock"
      echo "$$" > "$LOCK_FILE/pid"
      trap 'rm -rf "$LOCK_FILE"' EXIT INT TERM
      return 0
    fi
  fi
  log_cron "LOCKED another runner active; skipping ts=$TS"
  echo "another runner is active; exiting" >&2
  exit 0
}

# Run a command with a timeout, portable (no coreutils `timeout`).
# Usage: run_with_timeout <secs> <cmd...>
run_with_timeout() {
  local secs="$1"; shift
  "$@" &
  local cmd_pid=$!
  (
    sleep "$secs"
    if kill -0 "$cmd_pid" 2>/dev/null; then
      kill -TERM "$cmd_pid" 2>/dev/null || true
      sleep 5
      kill -KILL "$cmd_pid" 2>/dev/null || true
    fi
  ) &
  local watchdog_pid=$!
  local rc=0
  wait "$cmd_pid" 2>/dev/null || rc=$?
  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true
  return "$rc"
}

# ----- Pre-flight -----
[ -d "$REPO/.git" ] || die_setup "repo not found at $REPO"
[ -f "$URLS_FILE" ] || die_setup "urls.txt missing at $URLS_FILE"
[ -f "$ENV_FILE" ]  || die_setup ".env missing at $ENV_FILE"
command -v docker >/dev/null 2>&1 || die_setup "docker not on PATH"
command -v node   >/dev/null 2>&1 || die_setup "node not on PATH"
command -v git    >/dev/null 2>&1 || die_setup "git not on PATH"

mkdir -p "$RUNS_DIR" "$REPORTS_DIR" "$CHANGES_DIR" "$LOGS_DIR"

acquire_lock

log_cron "START ts=$TS"

# ----- Run scraper -----
NDJSON_OUT="$RUNS_DIR/$TS.ndjson"
REPORT_OUT="$REPORTS_DIR/$TS.json"

set +e
run_with_timeout "$DOCKER_TIMEOUT_SEC" \
  docker run --rm \
    --env-file "$ENV_FILE" \
    -v "$URLS_FILE":/app/urls.txt:ro \
    -v "$RUNS_DIR":/out \
    -v "$REPORTS_DIR":/reports \
    "$DOCKER_IMAGE" \
    run -i /app/urls.txt -o "/out/$TS.ndjson" -r "/reports/$TS.json" -s factory \
  >"$RUN_LOG" 2>&1
DOCKER_RC=$?
set -e

log_cron "DOCKER-EXIT rc=$DOCKER_RC ts=$TS"

# ----- Determine run status -----
RUN_STATUS="success"
FAIL_REASON=""
SUCCESS_COUNT=0
TOTAL_COUNT=0
CHANGE_COUNT=0

if [ "$DOCKER_RC" -ne 0 ]; then
  RUN_STATUS="failed"
  FAIL_REASON="docker exit $DOCKER_RC"
elif [ ! -f "$REPORT_OUT" ]; then
  RUN_STATUS="failed"
  FAIL_REASON="report missing: $REPORT_OUT"
else
  # Parse successCount / totalCount from report (tolerate missing fields).
  SUCCESS_COUNT="$(node -e '
    try {
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const n = r.successCount ?? r.success ?? (Array.isArray(r.results) ? r.results.filter(x => x.ok || x.success).length : 0);
      process.stdout.write(String(n|0));
    } catch (e) { process.stdout.write("0"); }
  ' "$REPORT_OUT" 2>/dev/null || echo 0)"
  TOTAL_COUNT="$(node -e '
    try {
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const n = r.totalCount ?? r.total ?? (Array.isArray(r.results) ? r.results.length : 0);
      process.stdout.write(String(n|0));
    } catch (e) { process.stdout.write("0"); }
  ' "$REPORT_OUT" 2>/dev/null || echo 0)"
  if [ "${SUCCESS_COUNT:-0}" -le 0 ]; then
    RUN_STATUS="failed"
    FAIL_REASON="successCount=0"
  fi
fi

# ----- Diff step (only if success) -----
CHANGES_FILE=""
if [ "$RUN_STATUS" = "success" ]; then
  set +e
  node "$SCRIPTS_DIR/diff.js" "$TS" >>"$RUN_LOG" 2>&1
  DIFF_RC=$?
  set -e
  if [ "$DIFF_RC" -ne 0 ]; then
    log_cron "DIFF-FAIL rc=$DIFF_RC ts=$TS (continuing; run still counts as success)"
  else
    CHANGES_FILE="$CHANGES_DIR/$TS.json"
    if [ -f "$CHANGES_FILE" ]; then
      CHANGE_COUNT="$(node -e '
        try {
          const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
          const n = r.changeCount ?? (Array.isArray(r.changes) ? r.changes.length : 0);
          process.stdout.write(String(n|0));
        } catch (e) { process.stdout.write("0"); }
      ' "$CHANGES_FILE" 2>/dev/null || echo 0)"
    fi
  fi
fi

# ----- Build failure event payload (stderr tail) for timeline -----
STDERR_TAIL=""
if [ "$RUN_STATUS" = "failed" ] && [ -f "$RUN_LOG" ]; then
  STDERR_TAIL="$(tail -n 30 "$RUN_LOG" 2>/dev/null || true)"
fi

# ----- Update timeline.json (prepend) -----
node - "$TIMELINE_FILE" "$TS" "$RUN_STATUS" "$SUCCESS_COUNT" "$TOTAL_COUNT" "$CHANGE_COUNT" "$FAIL_REASON" "$STDERR_TAIL" <<'NODE'
const fs = require("fs");
const [,, file, ts, status, succ, total, changes, reason, tail] = process.argv;
let timeline = [];
try { timeline = JSON.parse(fs.readFileSync(file, "utf8")); if (!Array.isArray(timeline)) timeline = []; } catch (_) { timeline = []; }
const entry = {
  ts,
  status,
  successCount: parseInt(succ, 10) || 0,
  totalCount: parseInt(total, 10) || 0,
  changeCount: parseInt(changes, 10) || 0,
};
if (status === "failed") {
  entry.failure = { reason: reason || "unknown", stderrTail: tail || "" };
}
timeline.unshift(entry);
// Cap timeline length to avoid unbounded growth.
if (timeline.length > 2000) timeline.length = 2000;
fs.writeFileSync(file, JSON.stringify(timeline, null, 2) + "\n");
NODE

# ----- Update run-summary.json -----
node - "$TIMELINE_FILE" "$SUMMARY_FILE" <<'NODE'
const fs = require("fs");
const [,, timelineFile, summaryFile] = process.argv;
let timeline = [];
try { timeline = JSON.parse(fs.readFileSync(timelineFile, "utf8")); if (!Array.isArray(timeline)) timeline = []; } catch (_) { timeline = []; }
const now = Date.now();
const DAY = 24 * 60 * 60 * 1000;
function parseTs(s) {
  // "20260608T143000Z" -> Date
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || "");
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +m[6]));
}
const last24 = timeline.filter(e => {
  const d = parseTs(e.ts);
  return d && (now - d.getTime() <= DAY);
});
const last24Success = last24.filter(e => e.status === "success");
const last24Changes = last24Success.reduce((a, e) => a + (e.changeCount || 0), 0);
const summary = {
  totalRuns: timeline.length,
  last24hRuns: last24.length,
  last24hSuccessRatePct: last24.length === 0 ? 0 : Math.round((last24Success.length / last24.length) * 100),
  last24hChangeCount: last24Changes,
  lastRunTs: timeline[0]?.ts || null,
  lastRunStatus: timeline[0]?.status || null,
  updatedAt: new Date().toISOString(),
};
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n");
NODE

# ----- Commit & push (only if there are tracked changes) -----
cd "$REPO"
git add data/ logs/ 2>/dev/null || true
if ! git diff --cached --quiet 2>/dev/null; then
  COMMIT_MSG="run $TS status=$RUN_STATUS success=$SUCCESS_COUNT/$TOTAL_COUNT changes=$CHANGE_COUNT"
  if git commit -m "$COMMIT_MSG" >>"$RUN_LOG" 2>&1; then
    log_cron "COMMIT ts=$TS msg=\"$COMMIT_MSG\""
    if git push >>"$RUN_LOG" 2>&1; then
      log_cron "PUSH-OK ts=$TS"
    else
      log_cron "PUSH-FAIL ts=$TS (will retry next run)"
    fi
  else
    log_cron "COMMIT-FAIL ts=$TS"
  fi
else
  log_cron "NO-CHANGES ts=$TS"
fi

# ----- Final log + exit -----
log_cron "END ts=$TS status=$RUN_STATUS success=$SUCCESS_COUNT/$TOTAL_COUNT changes=$CHANGE_COUNT"

if [ "$RUN_STATUS" = "success" ]; then
  exit 0
else
  exit 1
fi
