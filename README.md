# amibroker-analysis-runner

Runs long **Optimize**, **Walk-Forward**, **Scan**, **Explore** and **Backtest** jobs for the AmiBroker web app on free GitHub Actions machines,
so they keep going while your phone is off. The same buttons still work on the phone itself. Data is read from your R2 bucket (same files the app uses). End-of-day data only.

## One-time setup (about 10 minutes, all from a phone browser is possible)

1. **Create a new GitHub repo** (e.g. `amibroker-analysis-runner`) and upload the contents of this folder
   (`.github`, `src`, `test`, `package.json`). Private is safest; see "Limits" below.
2. **Allow the workflow to write**: repo → Settings → Actions → General → *Workflow permissions* → **Read and write permissions**. Save.
3. **Tell it where the app code is**: repo → Settings → Secrets and variables → Actions → *Variables* → New variable
   `ENGINE_REPO` = `your-user/amibroker-web-engine` (the repo that holds the app's `js/` folder).
   If that repo is private, also add a *secret* `ENGINE_TOKEN` = a token that can read it (Contents: read).
4. **Create a token for the app**: GitHub → Settings → Developer settings → Fine-grained tokens → Generate.
   Only this runner repo; permissions **Contents: Read and write** and **Actions: Read and write**. Copy it.
5. In the app: Analysis → **Run on GitHub…** → fill *Runner repo* (`your-user/amibroker-analysis-runner`), *Token*, *Save & test*.

## Using it
Analysis window: pick formula, symbols, range, (for Optimize / Walk-Forward set Settings → Optimize) → Run on GitHub → **Send Scan / Explore / Backtest / Optimize / Walk-Forward**.
Close the app. Later open Analysis → Run on GitHub…: progress and time left are shown; when finished tap **View result**.
Tap a row in the table to run a backtest of those values on your phone as usual.

How it works: the app writes `jobs/<id>/job.json` to this repo and starts the `analysis` workflow. Optimize / Walk-Forward: the combinations are split over N machines
(default 6, max 20). Scan / Explore: the symbols are split over the machines, at most one machine per 100 symbols. Backtest: one machine (the trades of all symbols share one portfolio). A run lasts at most ~6 hours; if the job needs longer it saves its progress and starts the next run by itself (up to 30 runs).
Results come back as `jobs/<id>/result.json`.

## Limits and honest notes
- Free GitHub accounts get about 2,000 Actions minutes/month on **private** repos (public repos: unlimited). 6 machines × 3 hours = 1,080 minutes.
  Big jobs can use the month's quota. Check Settings → Billing.
- GitHub's terms restrict Actions to project-related use and forbid using it as a general compute service. Optimizing strategies for a
  project in the same account is a grey area; heavy use could get the repo's Actions limited. Use at your own risk.
- Intraday time frames and `Study()` drawings are not available on the runner. Breadth data saved only on your phone (ADLine, TRIN ...) is not available there either.
- Scan / Explore: `StockNum` counts inside each machine's share. Explore keeps the first 60,000 rows in your formula's sort order (the summary rows still count ALL rows). Results are stored compressed (60,000 rows is about 3 MB); a result must stay under 60 MB.
- Free machines have ~7 GB RAM; a very large symbol list with long history may run out of memory: send fewer symbols or use more machines.
- Anything in `jobs/` is stored in the repo: formula code and results. Keep the repo private if the formula is secret.
- To cancel a job: Open on GitHub → Actions → the run → Cancel. Delete old `jobs/<id>` folders to save space.

## Tests
`npm test` also checks that Scan, Explore and Backtest give the same answer on several machines as on one, and that the new pack format v2 is read.
`ENGINE_DIR=/path/to/amibroker-web-engine npm test` (uses a fake R2 and fake GitHub; no network).

## Keeping Cloudflare R2 reads (Class B) near zero

Each shard used to read market data straight from R2 with thousands of small Range requests. Now:

1. The `plan` job asks the data host for `manifest.json` and a HEAD of `recent.json` (3 requests) and builds a cache key from them.
2. If the Actions cache has that key, **nothing is downloaded**. Otherwise every data file is downloaded once (about 1 request per file) and cached.
3. All shards and the merge job restore that cache and read from a local server (`DATA_DIR=data`). Zero requests reach R2 while the job runs.

Result: a few dozen R2 requests per data update instead of thousands per job. The cache key changes only when your data changes.

Note: GitHub evicts caches unused for 7 days and keeps 10 GB per repo; the next run simply downloads again.

### Fully R2-free (optional): GitHub Release assets
Git itself is not suitable for these files (100 MB per file limit, history grows forever). Release assets are: up to 2 GB per file, free downloads.

1. In `nse-data-engine`, after converting to parquet/packs, upload every file to a release in this repo, with `/` in the path replaced by `__` (e.g. `packs/2024.pack` -> `packs__2024.pack`), including `manifest.json` and `recent.json`:
   `gh release upload data-latest <files> --clobber --repo <you>/amibroker-analysis-runner`
2. In this repo: Settings > Secrets and variables > Actions > Variables > add `DATA_RELEASE_URL` = `https://github.com/<you>/amibroker-analysis-runner/releases/download/data-latest`
3. The runner then downloads from the release instead of R2 (still cached).
