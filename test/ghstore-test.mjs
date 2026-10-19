// Run: node test/ghstore-test.mjs -- the GitHub store against a stand-in of the GitHub contents API (sha rules, simultaneous commits, dispatch)
import http from 'node:http'; import crypto from 'node:crypto';
import { GhStore } from '../src/store.mjs';
let pass = 0, fail = 0; const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };
const files = new Map(), dispatches = []; let conflicts = 0, injected = 0, puts = 0;
const server = http.createServer((q, r) => {
  let body = ''; q.on('data', (d) => { body += d; }); q.on('end', () => {
    const u = new URL(q.url, 'http://x'), m = /^\/repos\/o\/r\/contents\/(.+)$/.exec(u.pathname), send = (c, o) => { r.writeHead(c, { 'content-type': 'application/json' }); r.end(JSON.stringify(o)); };
    if (q.headers.authorization !== 'Bearer tok') return send(401, {});
    if (m && q.method === 'GET') { const f = files.get(m[1]); return f ? send(200, { sha: f.sha, content: f.content, encoding: 'base64' }) : send(404, {}); }
    if (m && q.method === 'PUT') {
      puts++; const b = JSON.parse(body), f = files.get(m[1]);
      if (puts % 4 === 0) { injected++; return send(409, { message: 'is at another commit' }); }   // another shard committed at the same moment
      if (f && b.sha !== f.sha) { conflicts++; return send(b.sha ? 409 : 422, {}); }
      const sha = crypto.createHash('sha1').update(b.content + puts).digest('hex'); files.set(m[1], { sha, content: b.content }); return send(f ? 200 : 201, { content: { sha } });
    }
    if (/actions\/workflows\/analysis.yml\/dispatches$/.test(u.pathname) && q.method === 'POST') { dispatches.push(JSON.parse(body)); r.writeHead(204); return r.end(); }
    send(404, {});
  });
}).listen(0);
await new Promise((res) => server.once('listening', res));
const mk = () => new GhStore({ repo: 'o/r', token: 'tok', apiBase: `http://localhost:${server.address().port}` });
const a = mk(), b = mk();
ok(await a.get('jobs/x/job.json') === null, 'missing file is null');
await a.put('jobs/x/job.json', { n: 1 }); ok((await b.get('jobs/x/job.json')).n === 1, 'written file can be read by another client');
await Promise.all([a.put('jobs/x/shard-0.json', { i: 0 }), b.put('jobs/x/shard-1.json', { i: 1 }), a.put('jobs/x/progress-0.json', { p: 1 })]);
ok((await b.get('jobs/x/shard-0.json')).i === 0 && (await a.get('jobs/x/shard-1.json')).i === 1, 'simultaneous writes of different files');
await a.put('jobs/x/job.json', { n: 2 }); await a.put('jobs/x/job.json', { n: 3 }); ok((await b.get('jobs/x/job.json')).n === 3, 'updates replace the file (sha handled)');
await b.put('jobs/x/job.json', { n: 4 }); ok((await a.get('jobs/x/job.json')).n === 4, 'an update from a client that never read the file first');
ok(injected > 0, `retries after ${injected} refused commits worked`);
await a.dispatch({ job: 'x' }); ok(dispatches.length === 1 && dispatches[0].inputs.job === 'x' && dispatches[0].ref === 'main', 'next run is started');
let err = ''; try { await new GhStore({ repo: 'o/r', token: 'bad', apiBase: `http://localhost:${server.address().port}` }).get('a'); } catch (e) { err = e.message; } ok(/401/.test(err), 'a wrong token is reported');
server.close(); console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
