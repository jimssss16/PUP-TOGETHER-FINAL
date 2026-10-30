'use strict';
/*
  PUP TOGETHER server
  - No packages to install. Needs Node.js 18 or newer.
  - Run:  node server.js     then open  http://localhost:3000
  - Optional settings (environment variables):
      PORT            port number (default 3000)
      DATA_FILE       where to save data (default ./data.json)
      PROFESSOR_CODE  lets professors sign up on their own with this secret code.
                      If you leave it unset, only the admin can create professor accounts.
      AUTH_RATE_MAX   log in / sign-up tries per minute per address (default 10)

  Roles:  student, professor, admin
  The first time the server starts it creates the admin account listed in SEED_ADMIN below.
  Its password is stored as a salted scrypt hash, not as plain text.
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PROFESSOR_CODE = process.env.PROFESSOR_CODE || '';
const AUTH_RATE_MAX = Number(process.env.AUTH_RATE_MAX) || 10;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY = 64 * 1024;
const INDEX_FILE = path.join(__dirname, 'index.html');
const LOGO_FILE = path.join(__dirname, 'pup-logo.png');

/* The first admin account. Created once, on the very first start. */
const SEED_ADMIN = {
  name: 'Antoine James Camaganakan',
  username: 'james',
  studentId: '2026-00183-TG-0',
  salt: '906416bd22d01c37b3dc020abbf39f9a',
  hash: '8d9d45593280ba8be17c75675c9e13c2d55101562fdfd25f2b36afa795f59347fe226244811073ca687852567c662d873382b81777a2476ac043eb4c0b979856'
};

const ROLES = ['student', 'professor', 'admin'];
const STUDENT_ID_RE = /^\d{4}-\d{5}-[A-Z]{2}-\d$/;

/* ---------------- Storage ---------------- */
let db = { users: [], sessions: [], posts: [], messages: [], settings: { signupOpen: true }, meta: { seeded: false } };

function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (d && Array.isArray(d.users)) {
      db = {
        users: d.users,
        sessions: Array.isArray(d.sessions) ? d.sessions : [],
        posts: Array.isArray(d.posts) ? d.posts : [],
        messages: Array.isArray(d.messages) ? d.messages : [],
        settings: { signupOpen: !(d.settings && d.settings.signupOpen === false) },
        meta: { seeded: !!(d.meta && d.meta.seeded) }
      };
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      try { fs.renameSync(DATA_FILE, DATA_FILE + '.corrupt-' + Date.now()); } catch (_) { /* ignore */ }
      console.error('The data file could not be read. A backup copy was kept and a fresh one was started.');
    }
  }
  db.users.forEach((u) => { if (typeof u.studentId !== 'string') u.studentId = ''; if (!ROLES.includes(u.role)) u.role = 'student'; });
  if (!db.meta.seeded) {
    if (!db.users.some((u) => u.username === SEED_ADMIN.username)) {
      db.users.push({
        id: crypto.randomUUID(), username: SEED_ADMIN.username, name: SEED_ADMIN.name, role: 'admin',
        studentId: SEED_ADMIN.studentId, salt: SEED_ADMIN.salt, hash: SEED_ADMIN.hash, created: Date.now()
      });
    }
    db.meta.seeded = true;
    flush();
  }
}
let saveTimer = null;
function flush() {
  try {
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Could not save data:', e.message);
  }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, 200);
}

/* ---------------- Helpers ---------------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function fail(status, message) { throw new HttpError(status, message); }

function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0, tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return reject(new HttpError(413, 'That is too much to send at once.'));
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new HttpError(400, 'Invalid request.'));
        resolve(v);
      } catch (e) { reject(new HttpError(400, 'Invalid request.')); }
    });
    req.on('error', reject);
  });
}

function cleanStr(v, min, max, label) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') fail(400, label + ' is not valid.');
  const s = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (s.length < min) fail(400, label + (min <= 1 ? ' is required.' : ' is too short.'));
  if (s.length > max) fail(400, label + ' is too long.');
  return s;
}
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

function hashPassword(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function verifyPassword(pw, user) {
  const a = Buffer.from(hashPassword(pw, user.salt), 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function setPassword(user, pw) {
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = hashPassword(pw, user.salt);
}
function cleanPassword(v) {
  if (typeof v !== 'string') fail(400, 'Password is not valid.');
  if (v.length < 6) fail(400, 'Password must be at least 6 characters.');
  if (v.length > 72) fail(400, 'Password is too long.');
  return v;
}

const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let h = hits.get(key);
  if (!h || h.reset < now) { h = { n: 0, reset: now + windowMs }; hits.set(key, h); }
  h.n++;
  if (h.n > max) fail(429, 'Too many tries. Please wait a minute and try again.');
}
setInterval(() => {
  const now = Date.now();
  for (const [k, h] of hits) if (h.reset < now) hits.delete(k);
}, 5 * 60 * 1000).unref();

function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.socket.remoteAddress || 'unknown';
}

const isStaff = (u) => u.role === 'professor' || u.role === 'admin';
const adminCount = () => db.users.filter((u) => u.role === 'admin').length;

/* What each kind of viewer is allowed to see about an account. */
function publicUser(u) { return { id: u.id, username: u.username, name: u.name, role: u.role }; }
function selfUser(u) { return { id: u.id, username: u.username, name: u.name, role: u.role, studentId: u.studentId || '' }; }
function adminUser(u) { return { id: u.id, username: u.username, name: u.name, role: u.role, studentId: u.studentId || '', created: u.created || 0 }; }

function checkName(v) { return cleanStr(v, 2, 40, 'Full name'); }
function checkUsername(v) {
  const s = cleanStr(v, 3, 20, 'Username').toLowerCase();
  if (!/^[a-z0-9_.]+$/.test(s)) fail(400, 'Username can only use letters, numbers, _ and .');
  return s;
}
function checkStudentId(raw, role) {
  const s = cleanStr(raw, 0, 20, 'Student ID').toUpperCase();
  if (role === 'student') {
    if (!STUDENT_ID_RE.test(s)) fail(400, 'Student ID must look like 2026-00183-TG-0.');
  } else if (s && !/^[A-Z0-9-]{3,20}$/.test(s)) {
    fail(400, 'ID can only use letters, numbers, and dashes.');
  }
  return s;
}
function ensureUnique(username, studentId, exceptId) {
  if (db.users.some((u) => u.id !== exceptId && u.username === username)) fail(409, 'That username is already taken.');
  if (studentId && db.users.some((u) => u.id !== exceptId && u.studentId && u.studentId.toUpperCase() === studentId)) {
    fail(409, 'That student ID already has an account.');
  }
}

function newSession(uid) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.sessions = db.sessions.filter((s) => s.exp > now);
  db.sessions.push({ th: sha(token), uid, exp: now + SESSION_MS });
  return token;
}
function getAuth(req) {
  const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
  if (!m) fail(401, 'Please log in.');
  const th = sha(m[1]);
  const now = Date.now();
  const s = db.sessions.find((x) => x.th === th && x.exp > now);
  if (!s) fail(401, 'Please log in again.');
  const user = db.users.find((x) => x.id === s.uid);
  if (!user) fail(401, 'Please log in again.');
  return { user, session: s };
}

function publicPost(p, usersById) {
  const a = usersById.get(p.authorId);
  return {
    id: p.id, kind: p.kind, title: p.title, body: p.body, due: p.due || null, at: p.at,
    authorId: p.authorId, authorName: a ? a.name : 'Former member', authorRole: a ? a.role : 'student'
  };
}

/* ---------------- Routes ---------------- */
async function api(req, res, p, m) {
  if (p === '/api/ping' && m === 'GET') return send(res, 200, { ok: true });

  if (p === '/api/config' && m === 'GET') {
    return send(res, 200, { signupOpen: !!db.settings.signupOpen, professorSignup: !!PROFESSOR_CODE });
  }

  if (p === '/api/register' && m === 'POST') {
    rateLimit('auth:' + clientIp(req), AUTH_RATE_MAX, 60 * 1000);
    if (!db.settings.signupOpen) fail(403, 'Sign-ups are closed. Please ask your admin to create an account for you.');
    const b = await readJson(req);
    const role = b.role === 'professor' ? 'professor' : 'student';
    if (role === 'professor') {
      if (!PROFESSOR_CODE) fail(403, 'Professor accounts are created by the admin.');
      const given = crypto.createHash('sha256').update(String(b.code || '')).digest();
      const real = crypto.createHash('sha256').update(PROFESSOR_CODE).digest();
      if (!crypto.timingSafeEqual(given, real)) fail(403, 'That professor code is not correct.');
    }
    const name = checkName(b.name);
    const username = checkUsername(b.username);
    const studentId = checkStudentId(b.studentId, role);
    const password = cleanPassword(b.password);
    ensureUnique(username, studentId, null);
    const user = { id: crypto.randomUUID(), username, name, role, studentId, created: Date.now() };
    setPassword(user, password);
    db.users.push(user);
    const token = newSession(user.id);
    scheduleSave();
    return send(res, 201, { token, user: selfUser(user) });
  }

  if (p === '/api/login' && m === 'POST') {
    rateLimit('auth:' + clientIp(req), AUTH_RATE_MAX, 60 * 1000);
    const b = await readJson(req);
    const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const user = db.users.find((u) => u.username === username);
    if (!user || !password || password.length > 200 || !verifyPassword(password, user)) fail(401, 'Wrong username or password.');
    const token = newSession(user.id);
    scheduleSave();
    return send(res, 200, { token, user: selfUser(user) });
  }

  /* Everything below needs a login. */
  const { user, session } = getAuth(req);

  if (p === '/api/me' && m === 'GET') return send(res, 200, { user: selfUser(user) });

  if (p === '/api/logout' && m === 'POST') {
    db.sessions = db.sessions.filter((s) => s !== session);
    scheduleSave();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/me/password' && m === 'POST') {
    rateLimit('pw:' + user.id, 8, 60 * 1000);
    const b = await readJson(req);
    if (typeof b.current !== 'string' || !verifyPassword(b.current, user)) fail(403, 'Your current password is not correct.');
    const next = cleanPassword(b.next);
    setPassword(user, next);
    db.sessions = db.sessions.filter((s) => s.uid !== user.id || s === session);
    scheduleSave();
    return send(res, 200, { ok: true });
  }

  if (p === '/api/users' && m === 'GET') return send(res, 200, { users: db.users.map(publicUser) });

  /* ----- Admin only: manage accounts ----- */
  if (p.startsWith('/api/admin/')) {
    if (user.role !== 'admin') fail(403, 'Only admins can do that.');

    if (p === '/api/admin/users' && m === 'GET') {
      return send(res, 200, { users: db.users.map(adminUser), settings: db.settings });
    }

    if (p === '/api/admin/users' && m === 'POST') {
      const b = await readJson(req);
      const role = ROLES.includes(b.role) ? b.role : 'student';
      const name = checkName(b.name);
      const username = checkUsername(b.username);
      const studentId = checkStudentId(b.studentId, role);
      const password = cleanPassword(b.password);
      ensureUnique(username, studentId, null);
      const nu = { id: crypto.randomUUID(), username, name, role, studentId, created: Date.now() };
      setPassword(nu, password);
      db.users.push(nu);
      scheduleSave();
      return send(res, 201, { user: adminUser(nu) });
    }

    let mt = /^\/api\/admin\/users\/([a-f0-9-]{36})$/.exec(p);
    if (mt && m === 'PATCH') {
      const target = db.users.find((u) => u.id === mt[1]);
      if (!target) fail(404, 'That account was not found.');
      const b = await readJson(req);
      const newRole = b.role === undefined ? target.role : b.role;
      if (!ROLES.includes(newRole)) fail(400, 'Choose a valid role.');
      if (target.role === 'admin' && newRole !== 'admin' && adminCount() <= 1) fail(400, 'There must be at least one admin.');
      const newName = b.name === undefined ? target.name : checkName(b.name);
      const newId = (b.studentId === undefined && newRole === target.role) ? target.studentId : checkStudentId(b.studentId === undefined ? target.studentId : b.studentId, newRole);
      ensureUnique(target.username, newId, target.id);
      let newPw = null;
      if (b.password !== undefined && b.password !== '') newPw = cleanPassword(b.password);
      target.name = newName; target.role = newRole; target.studentId = newId;
      if (newPw) {
        setPassword(target, newPw);
        db.sessions = db.sessions.filter((s) => s.uid !== target.id || (target.id === user.id && s === session));
      }
      scheduleSave();
      return send(res, 200, { user: adminUser(target) });
    }

    if (mt && m === 'DELETE') {
      const target = db.users.find((u) => u.id === mt[1]);
      if (!target) fail(404, 'That account was not found.');
      if (target.id === user.id) fail(400, 'You cannot remove your own account.');
      if (target.role === 'admin' && adminCount() <= 1) fail(400, 'There must be at least one admin.');
      db.users = db.users.filter((u) => u.id !== target.id);
      db.sessions = db.sessions.filter((s) => s.uid !== target.id);
      db.messages = db.messages.filter((x) => x.from !== target.id && x.to !== target.id);
      scheduleSave();
      return send(res, 200, { ok: true });
    }

    if (p === '/api/admin/settings' && m === 'PUT') {
      const b = await readJson(req);
      if (typeof b.signupOpen !== 'boolean') fail(400, 'Invalid setting.');
      db.settings.signupOpen = b.signupOpen;
      scheduleSave();
      return send(res, 200, { settings: db.settings });
    }

    fail(404, 'Not found.');
  }

  /* ----- Posts and activities ----- */
  if (p === '/api/posts' && m === 'GET') {
    const byId = new Map(db.users.map((u) => [u.id, u]));
    const posts = db.posts.slice().reverse().slice(0, 200).map((x) => publicPost(x, byId));
    return send(res, 200, { posts });
  }

  if (p === '/api/posts' && m === 'POST') {
    const b = await readJson(req);
    const kind = b.kind === 'activity' ? 'activity' : b.kind === 'post' ? 'post' : null;
    if (!kind) fail(400, 'Choose a post type.');
    if (kind === 'activity' && !isStaff(user)) fail(403, 'Only professors and admins can post activities.');
    const now = Date.now();
    let recent = 0;
    for (let i = db.posts.length - 1; i >= 0 && db.posts[i].at > now - 60000; i--) if (db.posts[i].authorId === user.id) recent++;
    if (recent >= 10) fail(429, 'You are posting too fast. Please wait a moment.');
    let title, body, due = null;
    if (kind === 'activity') {
      title = cleanStr(b.title, 1, 100, 'Title');
      body = cleanStr(b.body, 0, 1000, 'Instructions');
      if (!isValidDate(b.due)) fail(400, 'Please choose a valid due date.');
      due = b.due;
    } else {
      title = cleanStr(b.title, 0, 100, 'Title');
      body = cleanStr(b.body, 1, 1000, 'Post');
    }
    const post = { id: crypto.randomUUID(), kind, title, body, due, authorId: user.id, at: now };
    db.posts.push(post);
    scheduleSave();
    return send(res, 201, { post: publicPost(post, new Map(db.users.map((u) => [u.id, u]))) });
  }

  let mt = /^\/api\/posts\/([a-f0-9-]{36})$/.exec(p);
  if (mt && m === 'DELETE') {
    const i = db.posts.findIndex((x) => x.id === mt[1]);
    if (i === -1) fail(404, 'That post was not found.');
    if (db.posts[i].authorId !== user.id && !isStaff(user)) fail(403, 'You can only delete your own posts.');
    db.posts.splice(i, 1);
    scheduleSave();
    return send(res, 200, { ok: true });
  }

  /* ----- Private messages ----- */
  if (p === '/api/threads' && m === 'GET') {
    const map = new Map();
    for (const msg of db.messages) {
      if (msg.from !== user.id && msg.to !== user.id) continue;
      const other = msg.from === user.id ? msg.to : msg.from;
      let t = map.get(other);
      if (!t) { t = { userId: other, last: null, unread: 0 }; map.set(other, t); }
      t.last = { id: msg.id, from: msg.from, text: msg.text, at: msg.at };
      if (msg.to === user.id && !msg.read) t.unread++;
    }
    return send(res, 200, { threads: Array.from(map.values()) });
  }

  mt = /^\/api\/messages\/([a-f0-9-]{36})(\/read)?$/.exec(p);
  if (mt) {
    const otherId = mt[1];
    const other = db.users.find((u) => u.id === otherId);
    if (!other) fail(404, 'That person was not found.');

    if (mt[2] && m === 'POST') {
      let changed = false;
      for (const msg of db.messages) {
        if (msg.from === otherId && msg.to === user.id && !msg.read) { msg.read = true; changed = true; }
      }
      if (changed) scheduleSave();
      return send(res, 200, { ok: true });
    }

    if (!mt[2] && m === 'GET') {
      const list = db.messages
        .filter((x) => (x.from === user.id && x.to === otherId) || (x.from === otherId && x.to === user.id))
        .slice(-200)
        .map((x) => ({ id: x.id, from: x.from, to: x.to, text: x.text, at: x.at, read: !!x.read }));
      return send(res, 200, { messages: list });
    }

    if (!mt[2] && m === 'POST') {
      if (otherId === user.id) fail(400, 'You cannot message yourself.');
      const b = await readJson(req);
      const text = cleanStr(b.text, 1, 1000, 'Message');
      const now = Date.now();
      let recent = 0;
      for (let i = db.messages.length - 1; i >= 0 && db.messages[i].at > now - 60000; i--) if (db.messages[i].from === user.id) recent++;
      if (recent >= 30) fail(429, 'You are sending messages too fast. Please wait a moment.');
      const msg = { id: crypto.randomUUID(), from: user.id, to: otherId, text, at: now, read: false };
      db.messages.push(msg);
      scheduleSave();
      return send(res, 201, { message: { id: msg.id, from: msg.from, to: msg.to, text: msg.text, at: msg.at, read: false } });
    }
  }

  fail(404, 'Not found.');
}

const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const m = req.method;
    if (p.startsWith('/api/')) return await api(req, res, p, m);

    if (m !== 'GET' && m !== 'HEAD') fail(405, 'Method not allowed.');
    if (p === '/' || p === '/index.html') {
      const html = fs.readFileSync(INDEX_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': html.length,
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      });
      return res.end(m === 'HEAD' ? undefined : html);
    }
    if (p === '/pup-logo.png' || p === '/favicon.ico') {
      const img = fs.readFileSync(LOGO_FILE);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': img.length,
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(m === 'HEAD' ? undefined : img);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong on the server.' });
  }
});

loadDb();
function shutdown() { if (saveTimer) clearTimeout(saveTimer); flush(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log('PUP TOGETHER is running at http://localhost:' + PORT);
  console.log('Admin login: username "james" (the password you gave me). Change it after your first login.');
  console.log(PROFESSOR_CODE ? 'Professors can also sign up with the PROFESSOR_CODE.' : 'Professor accounts are created by the admin (Accounts page).');
});
