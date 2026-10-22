// Where a job lives: jobs/<id>/job.json (from the app), status.json, progress-<i>.json, shard-<i>.json, result.json.
// FsStore = a folder (local runs and tests). GhStore = the GitHub repo through its REST API (no git needed, works from Actions and from the phone).
import fs from 'node:fs/promises';
import path from 'node:path';

export class FsStore {
  constructor(dir) { this.dir = dir; }
  async get(p) { try { return JSON.parse(await fs.readFile(path.join(this.dir, p), 'utf8')); } catch (e) { return null; } }
  async put(p, obj) { const f = path.join(this.dir, p); await fs.mkdir(path.dirname(f), { recursive: true }); await fs.writeFile(f, JSON.stringify(obj)); }
  async dispatch() { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class GhStore {
  constructor({ repo, token, branch = 'main', workflow = 'analysis.yml', apiBase = 'https://api.github.com' }) { this.api = apiBase; this.repo = repo; this.token = token; this.branch = branch; this.workflow = workflow; this.sha = new Map(); this.q = Promise.resolve(); }
  _h(extra = {}) { return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra }; }
  async get(p) {
    const r = await fetch(`${this.api}/repos/${this.repo}/contents/${p}?ref=${this.branch}`, { headers: this._h() });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${r.status} reading ${p}`);
    const j = await r.json(); this.sha.set(p, j.sha);
    const txt = j.content ? Buffer.from(j.content, 'base64').toString('utf8') : await (await fetch(j.download_url, { headers: this._h() })).text();   // files over 1 MB come without content
    return JSON.parse(txt);
  }
  // One write at a time per machine, and many patient tries: 16 machines commit to the same branch, GitHub answers 409 to overlapping commits.
  put(p, obj) { const run = () => this._put(p, obj); const r = this.q.then(run, run); this.q = r.catch(() => {}); return r; }
  async _put(p, obj) {
    const body = Buffer.from(JSON.stringify(obj)).toString('base64');
    for (let attempt = 0; attempt < 30; attempt++) {
      if (!this.sha.has(p)) { try { await this.get(p); } catch (e) { /* new file */ } }
      const r = await fetch(`${this.api}/repos/${this.repo}/contents/${p}`, { method: 'PUT', headers: this._h({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ message: `analysis: ${p}`, content: body, branch: this.branch, ...(this.sha.get(p) ? { sha: this.sha.get(p) } : {}) }) });
      if (r.ok) { const j = await r.json(); this.sha.set(p, j.content.sha); return; }
      if (r.status === 403 || r.status === 429) { await sleep(Math.min(60000, 5000 * (attempt + 1))); continue; }   // secondary rate limit: wait
      if (r.status === 409 || r.status === 422 || r.status >= 500) { this.sha.delete(p); await sleep(Math.min(30000, 600 * 2 ** Math.min(attempt, 6)) * (0.5 + Math.random())); continue; }   // another shard committed at the same moment
      throw new Error(`GitHub ${r.status} writing ${p}: ${(await r.text()).slice(0, 200)}`);
    }
    throw new Error(`GitHub: could not write ${p} after several tries`);
  }
  async dispatch(inputs) {
    const r = await fetch(`${this.api}/repos/${this.repo}/actions/workflows/${this.workflow}/dispatches`, { method: 'POST', headers: this._h({ 'Content-Type': 'application/json' }), body: JSON.stringify({ ref: this.branch, inputs }) });
    if (!r.ok) throw new Error(`GitHub ${r.status} starting the next run: ${(await r.text()).slice(0, 200)}`);
    return true;
  }
}
