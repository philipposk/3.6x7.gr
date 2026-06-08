# 3.6x7.gr

Public showcase for `smyths-scraper` running on an hourly cron. Live at [3.6x7.gr](https://3.6x7.gr).

A small, single-shot scrape fires every hour, diffs against the previous run, and pushes the result to GitHub Pages. No backend, no DB, no queue — just NDJSON files in `data/` and a static site on top.

---

## Architecture

```
[launchd cron, every hour @ :07]
        │
        ▼
   scripts/runner.sh
        │
        ▼
   docker run smyths-scraper:test   (linux/amd64)
        │
        ├── Tor (in-container)  — fresh exit IP per run
        ├── Xvfb                 — virtual display
        ├── patchright           — stealth Playwright fork
        └── real Chrome          — not Chromium, not headless-shell
        │
        ▼
   fetch 40 URLs → parse JSON-LD
        │
        ▼
   write  data/runs/<ts>.ndjson
          data/reports/<ts>.json
        │
        ▼
   scripts/diff.js
        │  diff vs previous run
        ▼
   write  data/changes/<ts>.json
        │
        ▼
   scripts/update-timeline.js
        │  prepend entry, recompute summary
        ▼
   git commit + push
        │
        ▼
   GitHub Pages rebuilds 3.6x7.gr

[on failure]
   scripts/self-heal.sh — classify error, log, suggest action
```

The whole loop runs on the local Mac. Nothing in this repo runs on GitHub's infrastructure except the static site itself.

---

## Layout

```
.
├── index.html                  # the site
├── assets/                     # css, js, fonts
│
├── data/
│   ├── runs/                   # raw NDJSON, one file per hourly run
│   │   └── 2026-06-08T1407Z.ndjson
│   ├── reports/                # per-run parsed JSON
│   │   └── 2026-06-08T1407Z.json
│   ├── changes/                # diff vs previous run
│   │   └── 2026-06-08T1407Z.json
│   ├── timeline.json           # rolling history the site reads
│   ├── latest-changes.json     # most recent diff, pinned for the site
│   └── run-summary.json        # most recent run stats
│
├── scripts/
│   ├── runner.sh               # the cron entrypoint
│   ├── diff.js                 # run-vs-run diff
│   ├── update-timeline.js      # prepends to timeline.json
│   └── self-heal.sh            # classify+log failures
│
├── secrets/
│   └── .env.example            # template; real .env is gitignored
│
└── launchd/
    └── gr.3-6x7.hourly.plist   # the cron definition
```

There is no `.github/workflows/` directory. The hourly is a **local launchd job**, not a GitHub Action — see [Deliberately not included](#deliberately-not-included).

---

## Setup

Assumes macOS and that you have access to the private `smyths-scraper` repo.

1. **Install Docker Desktop.** Open it once so the daemon is running.
2. **Build the scraper image:**
   ```
   git clone git@github.com:philipposk/smyths-scraper.git
   cd smyths-scraper
   docker build --platform linux/amd64 -t smyths-scraper:test .
   ```
3. **Clone this repo** next to it:
   ```
   git clone git@github.com:philipposk/3.6x7.gr.git
   cd 3.6x7.gr
   ```
4. **Fill in secrets:**
   ```
   cp secrets/.env.example secrets/.env
   # edit secrets/.env — GH token, optional captcha keys, etc.
   ```
5. **Install the launchd plist.** The plist file itself has a comment block at the top with the exact `launchctl bootstrap` / `kickstart` commands for your user — copy them from there rather than from this README, so they stay in sync.

To stop the cron later, the same plist comment block has the `bootout` command.

---

## Data shapes

The front-end reads three files. They are all plain JSON and small enough to ship to the browser as-is.

### `data/timeline.json`

Rolling history of the last N runs. New entries are prepended.

```json
{
  "updated_at": "2026-06-08T14:07:00Z",
  "entries": [
    {
      "run_id": "2026-06-08T1407Z",
      "started_at": "2026-06-08T14:07:00Z",
      "duration_ms": 48211,
      "urls_attempted": 40,
      "urls_ok": 40,
      "changes": 3
    }
  ]
}
```

### `data/latest-changes.json`

The diff produced by the most recent run.

```json
{
  "run_id": "2026-06-08T1407Z",
  "compared_to": "2026-06-08T1307Z",
  "changes": [
    {
      "url": "https://www.smythstoys.com/uk/en-gb/toys/lego/c/SM010101",
      "field": "price",
      "before": "59.99",
      "after": "54.99"
    },
    {
      "url": "https://www.smythstoys.com/uk/en-gb/.../p/12345",
      "field": "availability",
      "before": "InStock",
      "after": "OutOfStock"
    }
  ]
}
```

### `data/run-summary.json`

Snapshot of the most recent run, used for the top-of-page status block.

```json
{
  "run_id": "2026-06-08T1407Z",
  "finished_at": "2026-06-08T14:07:48Z",
  "ok": true,
  "urls_attempted": 40,
  "urls_ok": 40,
  "urls_failed": 0,
  "tor_exit_country": "DE",
  "image_tag": "smyths-scraper:test",
  "self_heal_triggered": false
}
```

---

## Deliberately not included

A few things you might expect to see but won't find here, and why:

- **GitHub Actions runner.** The scrape needs Tor with rotating exit IPs and a real (not headless) Chrome. GitHub-hosted runners block both — Tor outbound is rate-limited/flagged, and Smyths' bot defence (Imperva) reads the static GH-runner IP range as datacentre traffic and serves captchas. Running it locally on a residential connection sidesteps both.
- **Multi-lane fleet.** This is one shot per hour, one container, one IP. The bigger fan-out architecture lives in the `hydrascrape` workspace and is not what this site is showing.
- **Full sitemap discovery.** Only 40 fixed URLs are scraped — a curated showcase set, not a full crawl. The 7,671-product UK catalogue lives in the upstream scraper repo, not here.

---

## Lineage

- **[philipposk/smyths-scraper](https://github.com/philipposk/smyths-scraper)** *(private)* — the actual scraper image this site runs. Tor + Xvfb + patchright + Chrome, the only stack that reliably gets past Smyths' Imperva wall.
- **[1.6x7.gr](https://1.6x7.gr)** — the original showcase, full 58k-product snapshot. Static dump, no hourly cron, no diffs.
- **hydrascrape** — the broader ecosystem these pieces sit in: captcha-vision-solver, multi-lane orchestration, and the other targets beyond Smyths.

3.6x7.gr is the "live heartbeat" view of one slice of that work.
