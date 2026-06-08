#!/usr/bin/env node
/**
 * scripts/update-timeline.js
 *
 * Append a timeline entry + recompute run-summary after each cron tick.
 *
 * Inputs (env vars):
 *   TS            ISO-ish tag e.g. 20260608T193000Z
 *   STATUS        "success" | "failed"
 *   EXIT_CODE     number (string)
 *   DURATION_SEC  number (string)
 *   ERROR_TAIL    optional last lines of stderr (only when failed)
 *
 * For SUCCESS runs it pulls:
 *   data/reports/<TS>.json   (robustness report)
 *   data/changes/<TS>.json   (diff)
 *
 * Writes:
 *   data/timeline.json       (capped at last 720 entries)
 *   data/run-summary.json    (rollups)
 *
 * Pure Node built-ins. No deps.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_DIR = path.join(DATA_DIR, 'reports');
const CHANGES_DIR = path.join(DATA_DIR, 'changes');
const TIMELINE_PATH = path.join(DATA_DIR, 'timeline.json');
const SUMMARY_PATH = path.join(DATA_DIR, 'run-summary.json');

const MAX_TIMELINE = 720; // 30 days at hourly

/** Convert "20260608T193000Z" -> "2026-06-08T19:30:00Z". */
function tagToIso(tag) {
  if (typeof tag !== 'string') return null;
  const m = tag.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (!m) {
    // Already-ISO fallback: trust it if Date.parse accepts.
    return Number.isFinite(Date.parse(tag)) ? tag : null;
  }
  const [, y, mo, d, h, mi, s] = m;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
}

function tsToMs(ts) {
  if (!ts) return NaN;
  const iso = tagToIso(ts) || ts;
  return Date.parse(iso);
}

function readJsonSafe(p, fallback) {
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function writeJsonPretty(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function toNumber(v, fallback) {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickFirstNumber(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fallback;
}

function pickFirstObject(obj, keys, fallback) {
  if (!obj || typeof obj !== 'object') return fallback;
  for (const k of keys) {
    const v = obj[k];
    if (v && typeof v === 'object') return v;
  }
  return fallback;
}

function buildSuccessEntry(ts) {
  const reportPath = path.join(REPORTS_DIR, `${ts}.json`);
  const changesPath = path.join(CHANGES_DIR, `${ts}.json`);

  const report = readJsonSafe(reportPath, {}) || {};
  const changes = readJsonSafe(changesPath, {}) || {};

  // Robustness report fields — tolerate a few naming variants so this
  // script does not get brittle if the report shape evolves slightly.
  const attempted = pickFirstNumber(
    report,
    ['attempted', 'totalAttempted', 'total'],
    0
  );
  const success = pickFirstNumber(
    report,
    ['success', 'succeeded', 'successful'],
    0
  );

  let successRatePct = pickFirstNumber(
    report,
    ['successRatePct', 'successRate'],
    null
  );
  if (successRatePct === null) {
    successRatePct = attempted > 0 ? (success / attempted) * 100 : 0;
  } else if (successRatePct > 0 && successRatePct <= 1) {
    // Report stored it as a 0..1 ratio; normalise to percent.
    successRatePct = successRatePct * 100;
  }
  successRatePct = Math.round(successRatePct * 100) / 100;

  const captchasRaw = pickFirstObject(report, ['captchas', 'captcha'], {}) || {};
  const captchas = {
    detected: pickFirstNumber(
      captchasRaw,
      ['detected', 'seen', 'encountered'],
      0
    ),
    solved: pickFirstNumber(captchasRaw, ['solved', 'passed'], 0),
  };

  const torRotations = pickFirstNumber(
    report,
    ['torRotations', 'torRotationCount', 'rotations'],
    0
  );

  const breakdown =
    pickFirstObject(report, ['breakdown', 'byCategory', 'categories'], null) ||
    undefined;

  // Diff payload — change count can show up under several names.
  let changeCount = pickFirstNumber(
    changes,
    ['changeCount', 'totalChanges', 'count'],
    null
  );
  if (changeCount === null) {
    // Fall back to summing array lengths if present.
    const added = Array.isArray(changes.added) ? changes.added.length : 0;
    const removed = Array.isArray(changes.removed) ? changes.removed.length : 0;
    const updated = Array.isArray(changes.updated)
      ? changes.updated.length
      : Array.isArray(changes.changed)
      ? changes.changed.length
      : 0;
    changeCount = added + removed + updated;
  }

  const entry = {
    ts,
    status: 'success',
    attempted,
    success,
    successRatePct,
    captchas,
    torRotations,
    changeCount,
    durationSec: toNumber(process.env.DURATION_SEC, 0),
  };
  if (breakdown) entry.breakdown = breakdown;
  return entry;
}

function buildFailedEntry(ts) {
  const entry = {
    ts,
    status: 'failed',
    exitCode: toNumber(process.env.EXIT_CODE, 1),
    durationSec: toNumber(process.env.DURATION_SEC, 0),
  };
  const errorTail = process.env.ERROR_TAIL;
  if (typeof errorTail === 'string' && errorTail.length > 0) {
    entry.errorTail = errorTail;
  }
  return entry;
}

function computeSummary(timeline) {
  const now = Date.now();
  const cutoff = now - 24 * 60 * 60 * 1000;

  const last24h = timeline.filter((e) => {
    const ms = tsToMs(e.ts);
    return Number.isFinite(ms) && ms >= cutoff;
  });

  const successIn24h = last24h.filter((e) => e.status === 'success');

  let last24hSuccessRatePct = 0;
  if (successIn24h.length > 0) {
    const sum = successIn24h.reduce(
      (acc, e) => acc + (typeof e.successRatePct === 'number' ? e.successRatePct : 0),
      0
    );
    last24hSuccessRatePct = Math.round((sum / successIn24h.length) * 100) / 100;
  }

  const last24hChangeCount = last24h.reduce(
    (acc, e) => acc + (typeof e.changeCount === 'number' ? e.changeCount : 0),
    0
  );

  const latest = timeline[0] || null;

  return {
    totalRuns: timeline.length,
    last24hRuns: last24h.length,
    last24hSuccessRatePct,
    last24hChangeCount,
    lastRunTs: latest ? latest.ts : null,
    lastRunStatus: latest ? latest.status : null,
  };
}

function main() {
  const ts = process.env.TS;
  const status = process.env.STATUS;

  if (!ts) {
    console.error('update-timeline: TS env var is required');
    process.exit(2);
  }
  if (status !== 'success' && status !== 'failed') {
    console.error(
      `update-timeline: STATUS must be "success" or "failed" (got: ${status})`
    );
    process.exit(2);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });

  const entry =
    status === 'success' ? buildSuccessEntry(ts) : buildFailedEntry(ts);

  // Load existing timeline (array). Tolerate corruption / wrong shape.
  let timeline = readJsonSafe(TIMELINE_PATH, []);
  if (!Array.isArray(timeline)) timeline = [];

  // Prepend newest entry, cap to MAX_TIMELINE.
  timeline.unshift(entry);
  if (timeline.length > MAX_TIMELINE) {
    timeline = timeline.slice(0, MAX_TIMELINE);
  }

  writeJsonPretty(TIMELINE_PATH, timeline);

  const summary = computeSummary(timeline);
  writeJsonPretty(SUMMARY_PATH, summary);

  console.log(
    `update-timeline: wrote ${status} entry ${ts} ` +
      `(timeline=${timeline.length}, last24h=${summary.last24hRuns})`
  );
}

main();
