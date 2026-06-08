#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const RUNS_DIR = path.join(ROOT, 'data', 'runs');
const CHANGES_DIR = path.join(ROOT, 'data', 'changes');
const LATEST_CHANGES = path.join(ROOT, 'data', 'latest-changes.json');

function usage() {
  console.error('Usage: node scripts/diff.js <TS>');
  process.exit(1);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readNdjson(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const out = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      console.error(`Skipping malformed line ${i + 1} in ${filePath}: ${err.message}`);
    }
  }
  return out;
}

function indexBySku(records) {
  const map = new Map();
  for (const rec of records) {
    if (!rec || rec.sourceId == null) continue;
    const sku = String(rec.sourceId);
    map.set(sku, rec);
  }
  return map;
}

function findPreviousRun(currentTs) {
  if (!fs.existsSync(RUNS_DIR)) return null;
  const entries = fs.readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith('.ndjson'))
    .sort();
  const currentName = `${currentTs}.ndjson`;
  const idx = entries.indexOf(currentName);
  let candidates;
  if (idx === -1) {
    // Current file not yet in dir listing (unlikely) — take everything lexicographically less.
    candidates = entries.filter((f) => f < currentName);
  } else {
    candidates = entries.slice(0, idx);
  }
  if (candidates.length === 0) return null;
  const prevName = candidates[candidates.length - 1];
  return {
    ts: prevName.replace(/\.ndjson$/, ''),
    path: path.join(RUNS_DIR, prevName),
  };
}

function nearlyEqualNumbers(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(Number(a) - Number(b)) <= 0.01;
}

function strEq(a, b) {
  const av = a == null ? '' : String(a);
  const bv = b == null ? '' : String(b);
  return av === bv;
}

function boolVal(v) {
  if (v === true || v === false) return v;
  if (v == null) return null;
  return Boolean(v);
}

function diffProduct(prev, curr) {
  const changes = [];
  const sku = String(curr.sourceId);
  const name = curr.title != null ? curr.title : (prev.title != null ? prev.title : '');
  const url = curr.url != null ? curr.url : (prev.url != null ? prev.url : '');

  // price (numeric, threshold 0.01)
  const prevPrice = prev.price == null ? null : Number(prev.price);
  const currPrice = curr.price == null ? null : Number(curr.price);
  const priceChanged =
    (prevPrice == null) !== (currPrice == null) ||
    (prevPrice != null && currPrice != null && !nearlyEqualNumbers(prevPrice, currPrice));
  if (priceChanged) {
    changes.push({ sku, name, url, field: 'price', before: prevPrice, after: currPrice });
  }

  // inStock (boolean flip)
  const prevStock = boolVal(prev.inStock);
  const currStock = boolVal(curr.inStock);
  if (prevStock !== currStock) {
    changes.push({ sku, name, url, field: 'inStock', before: prevStock, after: currStock });
  }

  // availabilityRaw (string)
  if (!strEq(prev.availabilityRaw, curr.availabilityRaw)) {
    changes.push({
      sku, name, url, field: 'availabilityRaw',
      before: prev.availabilityRaw == null ? null : String(prev.availabilityRaw),
      after: curr.availabilityRaw == null ? null : String(curr.availabilityRaw),
    });
  }

  // title (string)
  if (!strEq(prev.title, curr.title)) {
    changes.push({
      sku, name, url, field: 'title',
      before: prev.title == null ? null : String(prev.title),
      after: curr.title == null ? null : String(curr.title),
    });
  }

  // imageUrl (string)
  if (!strEq(prev.imageUrl, curr.imageUrl)) {
    changes.push({
      sku, name, url, field: 'imageUrl',
      before: prev.imageUrl == null ? null : String(prev.imageUrl),
      after: curr.imageUrl == null ? null : String(curr.imageUrl),
    });
  }

  // category (string)
  if (!strEq(prev.category, curr.category)) {
    changes.push({
      sku, name, url, field: 'category',
      before: prev.category == null ? null : String(prev.category),
      after: curr.category == null ? null : String(curr.category),
    });
  }

  return changes;
}

function main() {
  const ts = process.argv[2];
  if (!ts) usage();

  const currentPath = path.join(RUNS_DIR, `${ts}.ndjson`);
  if (!fs.existsSync(currentPath)) {
    console.error(`Current run file not found: ${currentPath}`);
    process.exit(1);
  }

  ensureDir(CHANGES_DIR);
  ensureDir(path.dirname(LATEST_CHANGES));

  const current = readNdjson(currentPath);
  const currentIdx = indexBySku(current);

  const prevInfo = findPreviousRun(ts);

  let result;

  if (!prevInfo) {
    result = {
      ts,
      prevTs: null,
      changes: [],
      stats: {
        compared: 0,
        unchanged: 0,
        changed: 0,
        newProducts: currentIdx.size,
        droppedProducts: 0,
      },
    };
  } else {
    const previous = readNdjson(prevInfo.path);
    const prevIdx = indexBySku(previous);

    const allChanges = [];
    let compared = 0;
    let unchanged = 0;
    let changed = 0;
    let newProducts = 0;
    let droppedProducts = 0;

    // Walk current: compare or count as new.
    for (const [sku, currRec] of currentIdx.entries()) {
      const prevRec = prevIdx.get(sku);
      if (!prevRec) {
        newProducts++;
        continue;
      }
      compared++;
      const productChanges = diffProduct(prevRec, currRec);
      if (productChanges.length === 0) {
        unchanged++;
      } else {
        changed++;
        for (const c of productChanges) allChanges.push(c);
      }
    }

    // Walk previous for drops.
    for (const [sku, prevRec] of prevIdx.entries()) {
      if (currentIdx.has(sku)) continue;
      droppedProducts++;
      allChanges.push({
        sku,
        name: prevRec.title == null ? '' : String(prevRec.title),
        url: prevRec.url == null ? '' : String(prevRec.url),
        field: 'dropped',
        before: prevRec.price == null ? null : Number(prevRec.price),
        after: null,
      });
    }

    result = {
      ts,
      prevTs: prevInfo.ts,
      changes: allChanges,
      stats: {
        compared,
        unchanged,
        changed,
        newProducts,
        droppedProducts,
      },
    };
  }

  const outPath = path.join(CHANGES_DIR, `${ts}.json`);
  const payload = JSON.stringify(result, null, 2);
  fs.writeFileSync(outPath, payload);
  fs.writeFileSync(LATEST_CHANGES, payload);

  console.log(
    `diff: ts=${ts} prevTs=${result.prevTs || 'none'} ` +
    `compared=${result.stats.compared} unchanged=${result.stats.unchanged} ` +
    `changed=${result.stats.changed} new=${result.stats.newProducts} ` +
    `dropped=${result.stats.droppedProducts} -> ${path.relative(ROOT, outPath)}`
  );
}

main();
