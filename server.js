'use strict';
/* Trust Me backend. No dependencies: `node server.js` (Node 18+). Data lives in db.json. */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const ORIGIN = process.env.ORIGIN || '*';                 // set to your site's address once it is live
const SHOW_OTP = process.env.SHOW_OTP !== '0';            // returns the code in the API until a real SMS provider is added
const FRONTEND = path.join(__dirname, process.env.FRONTEND || 'TrustMe_1_0_9.html');

let db = { users: {}, sessions: {}, otps: {}, bookings: {}, messages: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))); } catch (e) {}
let timer;
const flush = () => { fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DB_FILE + '.tmp', DB_FILE); };
const save = () => { clearTimeout(timer); timer = setTimeout(flush, 150); };
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { try { flush(); } catch (e) {} process.exit(0); }));

const rid = () => crypto.randomBytes(6).toString('hex');
const fail = (c, m) => { throw { c, m }; };
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const phoneOf = p => {
  let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('234')) d = '0' + d.slice(3);
  if (!/^0\d{10}$/.test(d)) fail(400, 'Enter a valid Nigerian phone number.'); return d;
};
const pub = u => ({ id: u.id, name: u.name, role: u.role, camp: u.camp, batch: u.batch, pic: u.pic || null,
  ...(u.role === 'vendor' ? { cat: u.cat, pkgs: u.pkgs, verified: !!u.verified, jobs: u.jobs || 0 } : {}) });
const me = u => Object.assign(pub(u), { phone: u.phone, stream: u.stream || '', needs: u.needs || [] });
const auth = req => {
  const s = db.sessions[(req.headers.authorization || '').replace(/^Bearer /, '')];
  if (!s || !db.users[s.uid]) fail(401, 'Please sign in.'); return db.users[s.uid];
};
const vendorOnly = u => { if (u.role !== 'vendor') fail(403, 'Vendors only.'); };
const pkgIn = b => {
  const nm = str(b.nm, 60), price = Math.round(+b.price);
  if (nm.length < 2) fail(400, 'Give the package a name.'); if (!(price > 0)) fail(400, 'Add the fee in naira.');
  return { nm, price, desc: str(b.desc, 200), dur: str(b.dur, 30) };
};
const bview = b => Object.assign({}, b, { vendor: pub(db.users[b.vendorId]), corper: pub(db.users[b.corperId]) });

/* [method, path, handler, needs sign-in]. Booking stages match the app: 1 paid and waiting, 2 accepted,
   3 work finished, 4 released and done. The vendor moves 1>2>3, the corps member moves 3>4. */
const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true }), false],

  ['POST', /^\/api\/auth\/request-otp$/, c => {
    const p = phoneOf(c.body.phone), o = db.otps[p];
    if (o && Date.now() - o.sent < 30000) fail(429, 'Wait 30 seconds before asking for another code.');
    const code = String(crypto.randomInt(100000, 1000000));
    db.otps[p] = { code, sent: Date.now(), exp: Date.now() + 300000, tries: 0 }; save();
    if (SHOW_OTP) console.log('[otp]', p, code);          // replace with an SMS provider (e.g. Termii) before launch
    return { ok: true, ...(SHOW_OTP ? { devCode: code } : {}) };
  }, false],

  ['POST', /^\/api\/auth\/verify$/, c => {
    const b = c.body, p = phoneOf(b.phone), o = db.otps[p];
    if (!o || Date.now() > o.exp) fail(400, 'That code has expired. Ask for a new one.');
    if (++o.tries > 5) { delete db.otps[p]; save(); fail(429, 'Too many tries. Ask for a new code.'); }
    if (String(b.code) !== o.code) { save(); fail(400, 'That code is not right.'); }
    delete db.otps[p];
    let u = Object.values(db.users).find(x => x.phone === p); const isNew = !u;
    if (!u) {
      const role = b.role === 'vendor' ? 'vendor' : 'corper';
      u = { id: rid(), phone: p, role, name: str(b.name, 40), camp: str(b.camp, 60), batch: str(b.batch, 20),
            stream: str(b.stream, 10), needs: [], pic: null, created: Date.now() };
      if (role === 'vendor') {
        Object.assign(u, { cat: str(b.cat, 30), verified: false, jobs: 0, pkgs: [] });
        if (str(b.pkgName, 60) && +b.pkgFee > 0) u.pkgs.push({ id: rid(), nm: str(b.pkgName, 60), price: Math.round(+b.pkgFee), desc: '', dur: '' });
      }
      db.users[u.id] = u;
    }
    const token = crypto.randomBytes(24).toString('hex'); db.sessions[token] = { uid: u.id, at: Date.now() }; save();
    return { token, isNew, user: me(u) };
  }, false],

  ['GET', /^\/api\/me$/, c => me(c.u), true],
  ['PATCH', /^\/api\/me$/, c => {
    const b = c.body, u = c.u;
    for (const [k, n] of [['name', 40], ['camp', 60], ['batch', 20], ['stream', 10]]) if (k in b) u[k] = str(b[k], n);
    if (Array.isArray(b.needs)) u.needs = b.needs.slice(0, 20).map(x => str(x, 30));
    if ('pic' in b) {
      if (b.pic && (typeof b.pic !== 'string' || b.pic.length > 400000)) fail(413, 'That photo is too large.');
      u.pic = b.pic || null;
    }
    save(); return me(u);
  }, true],

  ['POST', /^\/api\/me\/packages$/, c => { vendorOnly(c.u); const p = Object.assign({ id: rid() }, pkgIn(c.body)); c.u.pkgs.push(p); save(); return p; }, true],
  ['PUT', /^\/api\/me\/packages\/(\w+)$/, c => {
    vendorOnly(c.u); const i = c.u.pkgs.findIndex(p => p.id === c.m[1]); if (i < 0) fail(404, 'Package not found.');
    c.u.pkgs[i] = Object.assign({ id: c.m[1] }, pkgIn(c.body)); save(); return c.u.pkgs[i];
  }, true],
  ['DELETE', /^\/api\/me\/packages\/(\w+)$/, c => {
    vendorOnly(c.u); if (c.u.pkgs.length < 2) fail(400, 'Keep at least one package.');
    c.u.pkgs = c.u.pkgs.filter(p => p.id !== c.m[1]); save(); return { ok: true };
  }, true],

  ['GET', /^\/api\/vendors$/, c => {
    const { cat, camp, q } = c.q, s = (q || '').toLowerCase();
    return Object.values(db.users).filter(v => v.role === 'vendor' && v.pkgs.length && (!cat || v.cat === cat) && (!camp || v.camp === camp)
      && (!s || (v.name + ' ' + v.pkgs.map(p => p.nm).join(' ')).toLowerCase().includes(s))).map(pub);
  }, true],
  ['GET', /^\/api\/vendors\/(\w+)$/, c => {
    const v = db.users[c.m[1]]; if (!v || v.role !== 'vendor') fail(404, 'Vendor not found.'); return pub(v);
  }, true],

  ['POST', /^\/api\/bookings$/, c => {
    if (c.u.role !== 'corper') fail(403, 'Only corps members can book.');
    const v = db.users[c.body.vendorId]; if (!v || v.role !== 'vendor') fail(404, 'Vendor not found.');
    const p = v.pkgs.find(x => x.id === c.body.pkgId); if (!p) fail(404, 'Package not found.');
    const b = { id: rid(), corperId: c.u.id, vendorId: v.id, what: p.nm, price: p.price, stage: 1,
                when: str(c.body.when, 60), where: str(c.body.where, 80), rated: false, created: Date.now() };
    db.bookings[b.id] = b; save(); return bview(b);
  }, true],
  ['GET', /^\/api\/bookings$/, c => Object.values(db.bookings)
    .filter(b => b[c.u.role === 'vendor' ? 'vendorId' : 'corperId'] === c.u.id)
    .sort((a, b) => b.created - a.created).map(bview), true],
  ['POST', /^\/api\/bookings\/(\w+)\/advance$/, c => {
    const b = db.bookings[c.m[1]]; if (!b || (b.vendorId !== c.u.id && b.corperId !== c.u.id)) fail(404, 'Booking not found.');
    const v = c.u.role === 'vendor';
    if (!((v && (b.stage === 1 || b.stage === 2)) || (!v && b.stage === 3))) fail(409, 'That step is not available right now.');
    b.stage++; b.updated = Date.now();
    if (b.stage === 4) db.users[b.vendorId].jobs = (db.users[b.vendorId].jobs || 0) + 1;
    save(); return bview(b);
  }, true],

  ['POST', /^\/api\/messages$/, c => {
    const to = db.users[c.body.to], text = str(c.body.text, 1000);
    if (!to || to.role === c.u.role) fail(400, 'You can only message the other side.'); if (!text) fail(400, 'Write a message first.');
    const m = { id: rid(), from: c.u.id, to: to.id, text, at: Date.now() }; db.messages.push(m); save(); return m;
  }, true],
  ['GET', /^\/api\/messages$/, c => {
    const last = {}; db.messages.forEach(m => { if (m.from === c.u.id || m.to === c.u.id) last[m.from === c.u.id ? m.to : m.from] = m; });
    return Object.entries(last).map(([o, m]) => ({ with: pub(db.users[o]), last: m })).sort((a, b) => b.last.at - a.last.at);
  }, true],
  ['GET', /^\/api\/messages\/(\w+)$/, c => db.messages.filter(m => (m.from === c.u.id && m.to === c.m[1]) || (m.to === c.u.id && m.from === c.m[1])), true],
];

const readBody = req => new Promise((ok, no) => {
  let s = ''; req.on('data', d => { s += d; if (s.length > 2e6) { no({ c: 413, m: 'Request too large.' }); req.destroy(); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no({ c: 400, m: 'Bad JSON.' }); } });
});

http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                 'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS' };
  const send = (code, obj) => { res.writeHead(code, Object.assign({ 'Content-Type': 'application/json' }, cors)); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {          // serves the app itself at /
    return fs.readFile(FRONTEND, (e, d) => {
      if (e) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
    });
  }
  try {
    const body = (req.method === 'GET' || req.method === 'DELETE') ? {} : await readBody(req);
    for (const [method, re, fn, needAuth] of routes) {
      const m = req.method === method && url.pathname.match(re); if (!m) continue;
      const c = { body, m, q: Object.fromEntries(url.searchParams) }; if (needAuth) c.u = auth(req);
      return send(200, fn(c));
    }
    send(404, { error: 'Not found' });
  } catch (e) {
    if (e && e.c) return send(e.c, { error: e.m });
    console.error(e); send(500, { error: 'Something went wrong.' });
  }
}).listen(PORT, () => console.log('Trust Me backend on port ' + PORT));
