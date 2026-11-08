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
const stemsMsg = r => ({ t: 'stems', v: r.v, files: r.published.map(f => ({ id: f.id, name: f.name, size: f.size })) });
function wipe(r) { fs.rmSync(dir(r), { recursive: true, force: true }); r.pending = []; r.published = null; r.bytes = 0; }
function catchUp(ws, r) {
  if (!r.state) return;
  if (r.state.playing) {
    const at = Date.now() + 300;
    send(ws, { t: 'tx', a: 'play', at, pos: r.state.pos + (at - r.state.at) / 1000 });
  } else send(ws, { t: 'tx', a: 'seek', pos: r.state.pos });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const parts = u.pathname.split('/').filter(Boolean);
  const r = rooms.get(clean(u.searchParams.get('room') || parts[1]));
  const authed = r && r.token && req.headers['x-token'] === r.token;

  if (u.pathname === '/health') { res.end('ok'); return; }

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
      room = r; r.clients.add(ws);
      send(ws, { t: 'joined', host: isHost, code, token: isHost ? r.token : undefined });
      if (!isHost) { if (r.published) send(ws, stemsMsg(r)); catchUp(ws, r); }
      announce(r);
      return;
    }

    if (m.t === 'catchup' && room && !isHost) { catchUp(ws, room); return; }

    if (!isHost || !room) return;

    if (m.t === 'publish') {
      room.published = room.pending; room.pending = []; room.v++;
      room.clients.forEach(c => c !== ws && send(c, stemsMsg(room)));
      return;
    }

    if (m.t === 'tx') {
      if (m.a === 'play') room.state = { playing: true, at: m.at, pos: m.pos };
      else if (m.a === 'pause' || m.a === 'seek') room.state = { playing: false, pos: m.pos };
      else if(m.a!=='click')return;
      room.clients.forEach(c => send(c, { t: 'tx', a: m.a, at: m.at, pos: m.pos }));
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.clients.delete(ws);
    if (room.host === ws) room.host = null;
    if (!room.clients.size) { wipe(room); rooms.delete(room.code); } else announce(room);
  });
});

server.listen(process.env.PORT || 3000, () => console.log('Band Stems running on port ' + (process.env.PORT || 3000)));
