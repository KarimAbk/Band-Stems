const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const LIMIT = 200 * 1024 * 1024; // per room
const TMP = path.join(os.tmpdir(), 'band-stems');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const rooms = new Map();
const clean = s => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
const send = (ws, o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
const dir = r => path.join(TMP, r.code);
const announce = r => r.clients.forEach(c => send(c, { t: 'peers', n: r.clients.size, host: !!r.host }));
const stemsMsg = (r, sep) => ({ t: 'stems', v: r.v, sep: !!sep, names: r.names || null, files: r.published.map(f => ({ id: f.id, name: f.name, size: f.size })) });
function wipe(r) { fs.rmSync(dir(r), { recursive: true, force: true }); r.pending = []; r.published = null; r.bytes = 0; r.names = null; }
function catchUp(ws, r) {
  if (!r.state) return;
  if (r.state.playing) {
    const at = Date.now() + 300;
    send(ws, { t: 'tx', a: 'play', at, pos: r.state.pos + (at - r.state.at) / 1000 });
  } else send(ws, { t: 'tx', a: 'seek', pos: r.state.pos });
}

// ---- Mac separator: the Mac polls this server, so nothing is exposed on the Mac ----
const KEY = process.env.SEPARATOR_KEY || '';
const JOBS = path.join(TMP, 'jobs'); fs.mkdirSync(JOBS, { recursive: true });
const MB = 1024 * 1024;
const jobs = new Map(), queue = [];
let waiters = [], lastPoll = 0, lastOnline = false;
const macOnline = () => !!KEY && (Date.now() - lastPoll < 45000 || [...jobs.values()].some(j => j.state === 'running'));
const keyOk = req => { const a = Buffer.from(String(req.headers['x-key'] || '')), b = Buffer.from(KEY); return !!KEY && a.length === b.length && crypto.timingSafeEqual(a, b); };
const sepNote = (r, o) => r.clients.forEach(c => send(c, { t: 'sep', ...o }));
function dropJob(job) { jobs.delete(job.id); if (job.room.job === job) job.room.job = null; fs.rmSync(job.dir, { recursive: true, force: true }); }
function dispatch() {
  while (waiters.length && queue.length) {
    const job = jobs.get(queue.shift());
    if (!job) continue;
    const w = waiters.shift(); clearTimeout(w.timer);
    job.state = 'running';
    w.res.writeHead(200, { 'Content-Type': 'application/json' });
    w.res.end(JSON.stringify({ id: job.id, name: job.name }));
    sepNote(job.room, { msg: 'Separating on the Mac…' });
  }
}
function body(req, cb) { let s = ''; req.on('data', c => { if (s.length < 10000) s += c; }); req.on('end', () => { try { cb(JSON.parse(s || '{}')); } catch { cb({}); } }); }
setInterval(() => {
  const o = macOnline();
  if (o !== lastOnline) { lastOnline = o; rooms.forEach(r => r.clients.forEach(c => send(c, { t: 'sepinfo', online: o }))); }
  jobs.forEach(j => { if (Date.now() - j.started > 30 * 60 * 1000) { sepNote(j.room, { err: 'Timed out' }); dropJob(j); } });
}, 5000);

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const parts = u.pathname.split('/').filter(Boolean);
  const r = rooms.get(clean(u.searchParams.get('room') || parts[1]));
  const authed = r && r.token && req.headers['x-token'] === r.token;

  if (u.pathname === '/health') { res.end('ok'); return; }

  // Host uploads a song to be separated
  if (parts[0] === 'separate' && req.method === 'POST') {
    const fail = (c, m) => { res.writeHead(c); res.end(m); req.resume(); };
    if (!KEY) return fail(503, 'Separation is not set up on this server');
    if (!authed) return fail(403, 'Not the host');
    if (!macOnline()) return fail(503, 'The Mac separator is offline');
    if (r.job) return fail(409, 'A song is already being separated');
    const len = +req.headers['content-length'] || 0;
    if (!len || len > 60 * MB) return fail(413, 'Song must be under 60 MB');
    const id = crypto.randomBytes(8).toString('hex'), jd = path.join(JOBS, id);
    fs.mkdirSync(jd, { recursive: true });
    const out = fs.createWriteStream(path.join(jd, 'input'));
    req.pipe(out);
    out.on('finish', () => {
      const job = { id, room: r, name: decodeURIComponent(req.headers['x-name'] || 'song').slice(0, 120), state: 'queued', dir: jd, started: Date.now(), stems: [] };
      wipe(r); jobs.set(id, job); r.job = job; queue.push(id);
      sepNote(r, { msg: 'Song received. Waiting for the Mac…' });
      dispatch();
      res.writeHead(202); res.end('ok');
    });
    req.on('aborted', () => { out.destroy(); fs.rmSync(jd, { recursive: true, force: true }); });
    return;
  }

  // Calls from the Mac
  if (parts[0] === 'sep') {
    if (!keyOk(req)) { res.writeHead(403); res.end('Wrong key, or SEPARATOR_KEY is not set on the server'); req.resume(); return; }
    lastPoll = Date.now();
    if (parts[1] === 'next') {
      const w = { res };
      w.timer = setTimeout(() => { waiters = waiters.filter(x => x !== w); lastPoll = Date.now(); res.writeHead(204); res.end(); }, 25000);
      res.on('close', () => { clearTimeout(w.timer); waiters = waiters.filter(x => x !== w); });
      waiters.push(w); dispatch(); return;
    }
    const job = jobs.get(parts[2]);
    if (!job) { res.writeHead(410); res.end('Job gone'); req.resume(); return; }
    const jr = job.room;
    if (parts[1] === 'input') {
      const fp = path.join(job.dir, 'input');
      res.writeHead(200, { 'Content-Length': fs.statSync(fp).size });
      fs.createReadStream(fp).pipe(res); return;
    }
    if (parts[1] === 'status') { body(req, b => { sepNote(jr, { msg: String(b.msg || '').slice(0, 120) }); res.end('ok'); }); return; }
    if (parts[1] === 'result') {
      const len = +req.headers['content-length'] || 0;
      if (rooms.get(jr.code) !== jr || !len || jr.bytes + len > LIMIT) { res.writeHead(413); res.end(); req.resume(); return; }
      const fid = crypto.randomBytes(8).toString('hex'), name = clean(u.searchParams.get('name')) || 'stem';
      fs.mkdirSync(dir(jr), { recursive: true });
      jr.bytes += len;
      const out = fs.createWriteStream(path.join(dir(jr), fid));
      req.pipe(out);
      out.on('finish', () => { job.stems.push({ id: fid, name, size: len, type: 'audio/mpeg' }); res.end('ok'); });
      return;
    }
    if (parts[1] === 'done') {
      req.resume();
      if (rooms.get(jr.code) === jr && job.stems.length) {
        jr.published = job.stems; jr.pending = []; jr.v++;
        jr.clients.forEach(c => send(c, stemsMsg(jr, true)));
      } else sepNote(jr, { err: 'No stems came back' });
      dropJob(job); res.end('ok'); return;
    }
    if (parts[1] === 'fail') { body(req, b => { sepNote(jr, { err: String(b.msg || 'Unknown error').slice(0, 200) }); dropJob(job); res.end('ok'); }); return; }
    res.writeHead(404); res.end(); return;
  }

  if (parts[0] === 'clear' && req.method === 'POST') {
    if (!authed) { res.writeHead(403); res.end(); return; }
    wipe(r); res.end('ok'); return;
  }

  if (parts[0] === 'upload' && req.method === 'POST') {
    if (!authed) { res.writeHead(403); res.end(); req.resume(); return; }
    const len = +req.headers['content-length'] || 0;
    if (!len || r.bytes + len > LIMIT) { res.writeHead(413); res.end('Room limit is 200 MB'); req.resume(); return; }
    const id = crypto.randomBytes(8).toString('hex');
    const name = decodeURIComponent(req.headers['x-name'] || 'stem').slice(0, 120);
    fs.mkdirSync(dir(r), { recursive: true });
    const fp = path.join(dir(r), id), out = fs.createWriteStream(fp);
    r.bytes += len;
    req.pipe(out);
    out.on('finish', () => { r.pending.push({ id, name, size: len, type: req.headers['content-type'] }); res.end('ok'); });
    req.on('aborted', () => { r.bytes -= len; out.destroy(); fs.rm(fp, () => {}); });
    return;
  }

  if (parts[0] === 'f' && parts.length === 3) {
    const f = r && [...(r.published || []), ...r.pending].find(x => x.id === parts[2]);
    if (!f) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': f.type || 'application/octet-stream', 'Content-Length': f.size, 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(dir(r), f.id)).pipe(res);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page);
});

const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  let room = null, isHost = false;

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'ping') { send(ws, { t: 'pong', t0: m.t0, ts: Date.now() }); return; }

    if (m.t === 'join' && !room) {
      const code = clean(m.room);
      if (!code) return;
      let r = rooms.get(code);
      if (!r) { r = { code, clients: new Set(), host: null, state: null, token: null, pending: [], published: null, v: 0, bytes: 0 }; rooms.set(code, r); }
      if (m.host) {
        if (r.host && r.host !== ws) { r.clients.delete(r.host); r.host.close(); }
        r.host = ws; isHost = true; r.token = crypto.randomBytes(12).toString('hex');
      }
      ws.cid = (r.nextId = (r.nextId || 0) + 1);
      room = r; r.clients.add(ws);
      send(ws, { t: 'joined', host: isHost, code, cid: ws.cid, sep: macOnline(), token: isHost ? r.token : undefined });
      if (!isHost) { if (r.published) send(ws, stemsMsg(r)); catchUp(ws, r); }
      announce(r);
      return;
    }

    if (m.t === 'catchup' && room && !isHost) { catchUp(ws, room); return; }

    if (!isHost || !room) return;

    if (m.t === 'publish') {
      room.published = room.pending; room.pending = []; room.v++; room.names = null;
      room.clients.forEach(c => c !== ws && send(c, stemsMsg(room)));
      return;
    }

    if (m.t === 'tx') {
      let ids, names, bpm, beats;
      if (m.a === 'play') {
        room.state = { playing: true, at: m.at, pos: m.pos };
        beats = Math.min(16, Math.max(0, Math.floor(+m.beats) || 0));
        bpm = Math.min(300, Math.max(30, +m.bpm || 120));
      }
      else if (m.a === 'pause' || m.a === 'seek') room.state = { playing: false, pos: m.pos };
      else if (m.a === 'calib') ids = [ws.cid, ...[...room.clients].filter(c => c !== ws).map(c => c.cid)];
      else if (m.a === 'names') {
        if (!Array.isArray(m.names)) return;
        names = m.names.slice(0, 12).map(x => typeof x === 'string' ? x.slice(0, 24) : '');
        room.names = names;
      }
      else if (m.a !== 'click' && m.a !== 'setlat') return;
      room.clients.forEach(c => send(c, { t: 'tx', a: m.a, at: m.at, pos: m.pos, ids, ms: m.ms, names, bpm, beats }));
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.clients.delete(ws);
    if (room.host === ws) room.host = null;
    if (!room.clients.size) { if (room.job) dropJob(room.job); wipe(room); rooms.delete(room.code); } else announce(room);
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Band Stems running on port ' + (process.env.PORT || 3000)));
