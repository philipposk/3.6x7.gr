# 3.6x7.gr

Public showcase for `smyths-scraper`. Live at [3.6x7.gr](https://3.6x7.gr).

A single-shot scrape of 40 fixed Smyths Toys product pages runs about once an hour, diffs against the previous run, and the result is pushed to GitHub Pages. No backend, no DB, no queue — just JSON files in `data/` and a static site on top.

---

## Architecture

```
[launchd: com.philipposk.smyths-tick, every 15 min]
        │
        ▼
   scripts/tick.js                         (zero LLM cost)
        │  • ingest finished runs → diff → update timeline → commit+push
        │  • kick a fresh scrape container when the last run is > ~1h old
        │  • kill stuck containers (>20 min), prune old artifacts + dangling images
        ▼
   docker run smyths-scraper:test          (linux/amd64, kicked ~hourly)
        ├── Tor (in-container)   — boot self-check verifies NEWNYM auth, fresh exit per run
        ├── Xvfb                 — virtual display (no GUI needed)
        ├── patchright           — patched Playwright fork (strips CDP signals)
        └── real Chrome          — channel:'chrome', headed but off-screen
        │
        ▼
   fetch 40 URLs → parse JSON-LD → (solve hCaptcha if challenged, save the puzzle)
        │
        ▼
   data/runs/<ts>.ndjson  +  data/reports/<ts>.json  +  data/captchas/<...>.png
        │                                                + data/captchas/captchas.json
        ▼  (next tick) scripts/diff.js → data/changes/<ts>.json
        ▼            scripts/update-timeline.js → data/timeline.json + data/run-summary.json
        ▼  git commit + push → GitHub Pages rebuilds 3.6x7.gr

[health + repair]  A Claude Code agent reviews ~hourly. If a run fails for a NEW reason
                   (e.g. Smyths changes markup), it diagnoses, patches the scraper code,
                   rebuilds the image, and pushes the fix to the smyths-scraper repo.
```

Everything runs on the local Mac. Nothing in this repo runs on GitHub's infrastructure except the static site itself.

---

## Layout

```
.
├── index.html                              # the dashboard (vanilla HTML/CSS/JS)
│
├── data/
│   ├── runs/<ts>.ndjson                    # raw product records, one file per run
│   ├── reports/<ts>.json                   # per-run robustness report
│   ├── changes/<ts>.json                   # diff vs the previous run
│   ├── captchas/                           # solved/failed puzzle images
│   │   ├── <ts>_doodle_aNN_solved.png
│   │   └── captchas.json                   # manifest the gallery renders
│   ├── timeline.json                       # rolling history the site reads (newest first)
│   ├── latest-changes.json                 # most recent diff, pinned for the site
│   ├── run-summary.json                    # headline KPIs
│   └── urls.txt                            # the 40 fixed product URLs
│
├── scripts/
│   ├── tick.js                             # ACTIVE entry point (runs every 15 min)
│   ├── diff.js                             # run-vs-run diff (by SKU)
│   ├── update-timeline.js                  # prepend timeline entry + recompute summary
│   ├── self-heal.sh                        # classify + log a failed run
│   └── com.philipposk.smyths-tick.plist    # launchd job → tick.js every 15 min
│
└── secrets/
    └── .env.example                        # template; real secrets/.env is gitignored
```

There is no `.github/workflows/`. The cron is a **local launchd job**, not a GitHub Action — see [Deliberately not included](#deliberately-not-included).

---

## Setup

Assumes macOS and access to the private `smyths-scraper` repo.

1. **Install Docker Desktop**, open it once so the daemon runs.
2. **Build the scraper image:**
   ```
   git clone git@github.com:philipposk/smyths-scraper.git
   cd smyths-scraper && docker buildx build --platform linux/amd64 -t smyths-scraper:test --load .
   ```
3. **Clone this repo** and fill secrets:
   ```
   git clone git@github.com:philipposk/3.6x7.gr.git smyths-scraper-site
   cd smyths-scraper-site
   cp secrets/.env.example secrets/.env   # add free vision-LLM keys; $0 defaults
   ```
4. **Install the launchd job.** The plist header (`scripts/com.philipposk.smyths-tick.plist`) has the exact `launchctl bootstrap` / `kickstart` / `bootout` commands — copy them from there so they stay in sync.

`tick.js` is also safe to run by hand at any time: `node scripts/tick.js`.

---

## Data shapes

The front-end reads five files, all plain JSON, small enough to ship to the browser.

### `data/timeline.json` — array, newest first

```json
[
  {
    "ts": "20260608T184919Z",
    "status": "success",
    "attempted": 40,
    "success": 40,
    "successRatePct": 100,
    "captchas": { "detected": 1, "solved": 1 },
    "torRotations": 0,
    "changeCount": 0,
    "durationSec": 236,
    "breakdown": { "attempted": 40, "success": 40, "redirect": 0, "captchaFail": 0, "block": 0, "parseFail": 0, "error": 0 }
  }
]
```
Failed runs carry `status:"failed"`, `exitCode`, `errorTail`, and a `note`.

### `data/latest-changes.json` — diff from the most recent run

```json
{
  "ts": "20260608T184919Z",
  "prevTs": "20260608T183044Z",
  "changes": [
    { "sku": "254392", "name": "...", "url": "https://www.smythstoys.com/...", "field": "price", "before": 59.99, "after": 54.99 }
  ],
  "stats": { "compared": 40, "unchanged": 40, "changed": 0, "newProducts": 0, "droppedProducts": 0 }
}
```
Products are matched across runs by **SKU**. The first run has no `prevTs`, so every product is `new`.

### `data/run-summary.json` — headline KPIs

```json
{ "totalRuns": 4, "last24hRuns": 4, "last24hSuccessRatePct": 100, "last24hChangeCount": 0, "lastRunTs": "20260608T184919Z", "lastRunStatus": "success" }
```

### `data/captchas/captchas.json` — gallery manifest, newest first

```json
[
  { "ts": "2026-06-08T18:50:26Z", "runTag": "20260608T184919Z", "type": "doodle", "vendor": "imperva", "attempt": 2, "solved": true, "legend": ["clock","megaphone","dinosaur"], "image": "20260608T184919Z_doodle_a02_solved.png" }
]
```

---

## Deliberately not included

- **GitHub Actions runner.** The scrape needs Tor with rotating exit IPs and a real (not headless) Chrome. GitHub-hosted runners block both — Tor outbound is flagged, and Smyths' Imperva reads the static runner IP range as datacentre traffic. Running locally on a residential connection sidesteps both.
- **Multi-lane fleet.** One shot per hour, one container, one Tor exit. The bigger fan-out lives in the `hydrascrape` workspace, not here.
- **Full sitemap discovery.** Only 40 fixed URLs — a curated showcase set, not a full crawl. The 58,605-product backfill is the earlier `1.6x7.gr` project.

---

## Lineage

- **[philipposk/smyths-scraper](https://github.com/philipposk/smyths-scraper)** *(private)* — the single-shot scraper image this site runs. patchright + Tor + free vision-LLM captcha solver, the stack that gets past Smyths' Imperva wall.
- **[1.6x7.gr](https://1.6x7.gr)** — the earlier one-shot backfill: a single snapshot of 58,605 UK Smyths products. No recurring cron, no diffs.
- **hydrascrape** — the broader ecosystem (multi-lane orchestration and other targets) these pieces sit in.

3.6x7.gr is the live, recurring-watcher view of that work.
