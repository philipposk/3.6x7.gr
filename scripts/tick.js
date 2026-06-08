#!/usr/bin/env node
'use strict';
// tick.js — one monitoring tick for the 3.6x7.gr showcase.
//
// Called every ~4.5 min (by the Claude-code loop, or by cron). Each tick is idempotent:
//   1. INGEST  — any completed run (ndjson + report on disk) not yet in timeline.json
//                gets diffed vs the previous run, added to the timeline, summary recomputed.
//   2. KICK    — if no scrape container is running AND the newest run is older than
//                KICK_INTERVAL_SEC, launch a fresh detached scrape (writes a new ndjson+report
//                that a LATER tick ingests). A scrape takes ~5 min; we never block on it.
//   3. STUCK   — a scrape container running longer than STUCK_SEC is killed and logged as a
//                failed run; self-heal.sh is invoked to classify + suggest.
//   4. PUSH    — if anything changed on disk, commit + push so GitHub Pages rebuilds.
//
// Exit code: 0 normal, 1 push/commit failed, 2 setup problem (no docker / no image).
// All actions logged to logs/tick.log. Designed to be safe to run by hand at any time.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const RUNS = path.join(DATA, 'runs');
const REPORTS = path.join(DATA, 'reports');
const URLS = path.join(DATA, 'urls.txt');
const ENV_FILE = path.join(ROOT, 'secrets', '.env');
const TIMELINE = path.join(DATA, 'timeline.json');
const LOGS = path.join(ROOT, 'logs');
const LOG = path.join(LOGS, 'tick.log');

const IMAGE = process.env.IMAGE || 'smyths-scraper:test';
const KICK_INTERVAL_SEC = parseInt(process.env.KICK_INTERVAL_SEC || '3600', 10); // hourly
const STUCK_SEC = parseInt(process.env.STUCK_SEC || '1200', 10);                  // 20 min
const MAX_PER_RUN = process.env.MAX_PER_RUN || '40';
const NAME_PREFIX = 'smyths-run-';

for (const d of [RUNS, REPORTS, LOGS, path.join(DATA, 'changes')]) fs.mkdirSync(d, { recursive: true });

function log(msg) {
  const line = `[${stampNow()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}
function stampNow() {
  // Avoid Date.now()-free constraint? This is a real script (not a workflow) — Date is fine.
  return new Date().toISOString();
}
function sh(cmd, opts = {}) {
  return cp.execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}
function shSafe(cmd, opts = {}) {
  try { return { ok: true, out: sh(cmd, opts) }; }
  catch (e) { return { ok: false, out: (e.stdout || '') + (e.stderr || ''), err: e.message }; }
}
// Compact ISO tag (20260608T183044Z) <-> Date
function tagToDate(tag) {
  const m = String(tag).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`) : new Date(NaN);
}
function nowTag() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function dockerOk() {
  if (!shSafe('docker version --format "{{.Server.Version}}"').ok) return false;
  if (!shSafe(`docker image inspect ${IMAGE}`).ok) return false;
  return true;
}
function runningContainers() {
  const r = shSafe(`docker ps --filter name=${NAME_PREFIX} --format "{{.Names}}|{{.RunningFor}}|{{.CreatedAt}}"`);
  if (!r.ok) return [];
  return r.out.split('\n').filter(Boolean).map((l) => {
    const [name, runningFor, createdAt] = l.split('|');
    return { name, runningFor, createdAt };
  });
}

// ---- 1. INGEST completed-but-unrecorded runs ------------------------------
function ingest() {
  const timeline = readJson(TIMELINE, []);
  const known = new Set(timeline.map((e) => e.ts));
  // A run is "complete" when both ndjson and report exist.
  const reportTags = fs.readdirSync(REPORTS).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  const fresh = reportTags.filter((t) => !known.has(t)).sort(); // oldest first
  let ingested = 0;
  for (const tag of fresh) {
    const ndjson = path.join(RUNS, `${tag}.ndjson`);
    if (!fs.existsSync(ndjson)) { log(`ingest: report ${tag} has no ndjson — skip`); continue; }
    const report = readJson(path.join(REPORTS, `${tag}.json`), null);
    if (!report) { log(`ingest: report ${tag} unreadable — skip`); continue; }
    // diff vs previous
    const d = shSafe(`node ${path.join(__dirname, 'diff.js')} ${tag}`, { cwd: ROOT });
    log(`ingest ${tag}: diff ${d.ok ? d.out.trim() : 'FAILED ' + d.out.slice(0, 200)}`);
    // timeline entry
    const status = (report.success > 0) ? 'success' : 'failed';
    const dur = report.startedAt && report.finishedAt
      ? Math.round((Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000) : 0;
    const env = { TS: tag, STATUS: status, EXIT_CODE: status === 'success' ? '0' : '1',
      DURATION_SEC: String(dur), ...process.env };
    const u = shSafe(`node ${path.join(__dirname, 'update-timeline.js')}`, { cwd: ROOT, env });
    log(`ingest ${tag}: timeline ${u.ok ? u.out.trim() : 'FAILED ' + u.out.slice(0, 200)}`);
    ingested++;
  }
  return ingested;
}

// ---- 2. KICK a new scrape if due ------------------------------------------
function newestReportAgeSec() {
  const reportTags = fs.readdirSync(REPORTS).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).sort();
  if (!reportTags.length) return Infinity;
  const newest = reportTags[reportTags.length - 1];
  const d = tagToDate(newest);
  if (isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / 1000;
}
function kickIfDue() {
  const running = runningContainers();
  if (running.length) { log(`kick: scrape already running (${running.map((r) => r.name).join(',')}) — skip`); return null; }
  const age = newestReportAgeSec();
  if (age < KICK_INTERVAL_SEC) { log(`kick: newest run ${Math.round(age / 60)}min old < ${Math.round(KICK_INTERVAL_SEC / 60)}min — not due`); return null; }
  if (!fs.existsSync(URLS)) { log('kick: no urls.txt — cannot scrape'); return null; }
  const tag = nowTag();
  const name = `${NAME_PREFIX}${tag}`;
  const envFlag = fs.existsSync(ENV_FILE) ? `--env-file ${ENV_FILE}` : '';
  const cmd = `docker run -d --rm --platform linux/amd64 --name ${name} ${envFlag} ` +
    `-e SOLVE_ENABLED=1 -e SOLVE_FREE_ONLY=0 -e ROTATE_ON_FAILS=2 -e MAX_PER_RUN=${MAX_PER_RUN} ` +
    `-v ${URLS}:/app/urls.txt:ro -v ${RUNS}:/out -v ${REPORTS}:/reports ` +
    `${IMAGE} run -i /app/urls.txt -o /out/${tag}.ndjson -r /reports/${tag}.json -s factory`;
  const r = shSafe(cmd);
  if (r.ok) { log(`kick: launched ${name} (container ${r.out.trim().slice(0, 12)})`); return tag; }
  log(`kick: FAILED to launch — ${r.out.slice(0, 200)}`);
  return null;
}

// ---- 3. STUCK detection ----------------------------------------------------
function killStuck() {
  for (const c of runningContainers()) {
    const created = Date.parse(c.createdAt);
    const ageSec = isNaN(created) ? 0 : (Date.now() - created) / 1000;
    if (ageSec > STUCK_SEC) {
      log(`stuck: ${c.name} running ${Math.round(ageSec / 60)}min > ${Math.round(STUCK_SEC / 60)}min — killing`);
      shSafe(`docker kill ${c.name}`);
      const tag = c.name.replace(NAME_PREFIX, '');
      // self-heal logger (best-effort)
      const log_ = path.join(LOGS, `${tag}.log`);
      shSafe(`bash ${path.join(__dirname, 'self-heal.sh')} ${tag} 124 ${log_}`);
      // failed timeline entry
      const env = { TS: tag, STATUS: 'failed', EXIT_CODE: '124', DURATION_SEC: String(Math.round(ageSec)),
        ERROR_TAIL: `container ${c.name} exceeded ${STUCK_SEC}s and was killed`, ...process.env };
      shSafe(`node ${path.join(__dirname, 'update-timeline.js')}`, { cwd: ROOT, env });
    }
  }
}

// ---- 4. PUSH if dirty ------------------------------------------------------
function pushIfDirty() {
  const st = shSafe('git status --porcelain data/', { cwd: ROOT });
  if (!st.ok) { log('push: git status failed'); return false; }
  if (!st.out.trim()) { log('push: nothing changed'); return true; }
  shSafe('git add -A data/', { cwd: ROOT });
  const c = shSafe(`git -c user.email=phktistakis@gmail.com -c user.name=philipposk commit -q -m "tick: update run data + timeline ($(date -u +%H:%MZ))"`, { cwd: ROOT });
  if (!c.ok) { log('push: commit failed — ' + c.out.slice(0, 200)); return false; }
  const p = shSafe('git push', { cwd: ROOT });
  log(`push: ${p.ok ? 'pushed' : 'FAILED ' + p.out.slice(0, 200)}`);
  return p.ok;
}

// --------------------------------------------------------------------------
function main() {
  log('=== tick start ===');
  if (!dockerOk()) { log('FATAL: docker or image unavailable — self-heal needed (rebuild image)'); process.exit(2); }
  killStuck();
  const n = ingest();
  if (n) log(`ingested ${n} new run(s)`);
  const kicked = kickIfDue();
  pushIfDirty();
  const running = runningContainers();
  log(`=== tick end (ingested=${n} kicked=${kicked || 'no'} running=${running.length}) ===`);
}
main();
