'use strict';
/*
  PUP TOGETHER update patcher.
  Put this file in the same folder as server.js and index.html, then run:
      node apply-update.js
  It makes server.js.bak and index.html.bak first, then edits both files.
  Every edit must match exactly once, or nothing is written.
*/
const fs = require('fs');
const path = require('path');
const dir = process.argv[2] || __dirname;
const MARK = 'PUP-UPDATE-2';

function once(src, find, repl, label) {
  const parts = src.split(find);
  if (parts.length !== 2) throw new Error('Could not apply "' + label + '" (found ' + (parts.length - 1) + ' matches).');
  return parts.join(repl);
}
function times(src, find, repl, n, label) {
  const parts = src.split(find);
  if (parts.length !== n + 1) throw new Error('Could not apply "' + label + '" (found ' + (parts.length - 1) + ' matches, expected ' + n + ').');
  return parts.join(repl);
}

/* ================= SERVER ================= */
const SERVER_ROUTES = String.raw`/* PUP-UPDATE-2 */
  /* ----- Profile picture ----- */
  if (p === '/api/me/avatar' && m === 'PUT') {
    rateLimit('av:' + user.id, 10, 60 * 1000);
    const b = await readJson(req, 300 * 1024);
    const img = typeof b.image === 'string' ? b.image : '';
    if (img.length > 250000 || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/]+=*$/.test(img)) fail(400, 'Please choose a smaller JPG, PNG, or WebP picture.');
    user.avatar = img; user.avatarAt = Date.now();
    scheduleSave();
    return send(res, 200, { user: selfUser(user) });
  }
  if (p === '/api/me/avatar' && m === 'DELETE') {
    delete user.avatar; user.avatarAt = Date.now();
    scheduleSave();
    return send(res, 200, { user: selfUser(user) });
  }

  /* ----- Events and study groups (shared, saved on the server) ----- */
  const mc = /^\/api\/(events|groups)(?:\/([a-f0-9-]{36})(?:\/(toggle))?)?$/.exec(p);
  if (mc) {
    const kind = mc[1], list = db[kind], id = mc[2], tog = mc[3];
    const view = (x) => {
      const a = db.users.find((u) => u.id === x.authorId);
      const base = { id: x.id, authorId: x.authorId, authorName: a ? a.name : 'Former member', at: x.at, count: x.people.length, joined: x.people.includes(user.id) };
      return kind === 'events'
        ? Object.assign(base, { title: x.title, date: x.date, time: x.time, place: x.place })
        : Object.assign(base, { name: x.name, subject: x.subject, schedule: x.schedule, desc: x.desc });
    };
    if (!id && m === 'GET') return send(res, 200, { [kind]: list.slice().reverse().slice(0, 300).map(view) });
    if (!id && m === 'POST') {
      rateLimit('mk:' + user.id, 20, 60 * 1000);
      const b = await readJson(req);
      const rec = { id: crypto.randomUUID(), authorId: user.id, at: Date.now(), people: [user.id] };
      if (kind === 'events') {
        rec.title = cleanStr(b.title, 1, 80, 'Event name');
        if (!isValidDate(b.date)) fail(400, 'Please choose a valid date.');
        rec.date = b.date;
        rec.time = /^\d{2}:\d{2}$/.test(b.time || '') ? b.time : '';
        rec.place = cleanStr(b.place, 0, 60, 'Place');
      } else {
        rec.name = cleanStr(b.name, 1, 50, 'Group name');
        rec.subject = cleanStr(b.subject, 0, 30, 'Subject') || 'General';
        rec.schedule = cleanStr(b.schedule, 0, 40, 'Schedule');
        rec.desc = cleanStr(b.desc, 0, 140, 'Description');
      }
      list.push(rec);
      scheduleSave();
      return send(res, 201, { entry: view(rec) });
    }
    const rec = id ? list.find((x) => x.id === id) : null;
    if (!rec) fail(404, 'That entry was not found.');
    if (tog && m === 'POST') {
      const i = rec.people.indexOf(user.id);
      if (i > -1) rec.people.splice(i, 1); else rec.people.push(user.id);
      scheduleSave();
      return send(res, 200, { entry: view(rec) });
    }
    if (!tog && m === 'DELETE') {
      if (rec.authorId !== user.id && !isStaff(user)) fail(403, 'You can only delete your own entries.');
      list.splice(list.indexOf(rec), 1);
      scheduleSave();
      return send(res, 200, { ok: true });
    }
  }

  /* ----- Admin only: manage accounts ----- */`;

const SERVER_PATCH = String.raw`let mt = /^\/api\/posts\/([a-f0-9-]{36})$/.exec(p);
  if (mt && m === 'PATCH') {
    const post = db.posts.find((x) => x.id === mt[1]);
    if (!post) fail(404, 'That post was not found.');
    if (post.kind !== 'announcement') fail(400, 'Only announcements can be edited.');
    if (!isStaff(user) || (post.authorId !== user.id && user.role !== 'admin')) fail(403, 'You can only edit your own announcements.');
    const b = await readJson(req);
    post.title = cleanStr(b.title, 1, 100, 'Title');
    post.body = cleanStr(b.body, 1, 2000, 'Announcement');
    post.edited = Date.now();
    scheduleSave();
    return send(res, 200, { post: publicPost(post, new Map(db.users.map((u) => [u.id, u]))) });
  }`;

const SERVER_AVATAR_FILE = String.raw`const am = /^\/avatar\/([a-f0-9-]{36})$/.exec(p);
    const au = am ? db.users.find((u) => u.id === am[1]) : null;
    const ad = au && au.avatar ? /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(au.avatar) : null;
    if (ad) {
      const buf = Buffer.from(ad[2], 'base64');
      res.writeHead(200, { 'Content-Type': ad[1], 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
      return res.end(m === 'HEAD' ? undefined : buf);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });`;

function patchServer(s) {
  if (s.includes(MARK)) throw new Error('server.js is already updated.');
  s = once(s, 'posts: [], messages: [], settings: { signupOpen: true }', 'posts: [], events: [], groups: [], messages: [], settings: { signupOpen: true }', 'db defaults');
  s = once(s, 'messages: Array.isArray(d.messages) ? d.messages : [],', 'messages: Array.isArray(d.messages) ? d.messages : [],\n        events: Array.isArray(d.events) ? d.events : [],\n        groups: Array.isArray(d.groups) ? d.groups : [],', 'db load');
  s = once(s, 'function readJson(req) {', 'function readJson(req, limit) {', 'readJson signature');
  s = once(s, 'if (size > MAX_BODY) { tooBig = true; return; }', 'if (size > (limit || MAX_BODY)) { tooBig = true; return; }', 'readJson limit');
  s = times(s, 'name: u.name, role: u.role', 'name: u.name, role: u.role, avatarV: u.avatar ? (u.avatarAt || 1) : 0', 3, 'user shapes');
  s = once(s, "authorRole: a ? a.role : 'student'", "authorRole: a ? a.role : 'student', edited: p.edited || null", 'post shape');
  s = once(s, "const kind = b.kind === 'activity' ? 'activity' : b.kind === 'post' ? 'post' : null;", "const kind = b.kind === 'activity' ? 'activity' : b.kind === 'announcement' ? 'announcement' : b.kind === 'post' ? 'post' : null;", 'post kinds');
  s = once(s, "if (kind === 'activity' && !isStaff(user)) fail(403, 'Only professors and admins can post activities.');", "if ((kind === 'activity' || kind === 'announcement') && !isStaff(user)) fail(403, 'Only professors and admins can post activities and announcements.');", 'staff check');
  s = once(s, 'let title, body, due = null;', "let title, body, due = null;\n    if (kind === 'announcement') { title = cleanStr(b.title, 1, 100, 'Title'); body = cleanStr(b.body, 1, 2000, 'Announcement'); }\n    else", 'announcement body');
  s = once(s, 'let mt = /^\\/api\\/posts\\/([a-f0-9-]{36})$/.exec(p);', SERVER_PATCH, 'announcement edit');
  s = once(s, '/* ----- Admin only: manage accounts ----- */', SERVER_ROUTES, 'new routes');
  s = once(s, 'db.sessions = db.sessions.filter((s) => s.uid !== target.id);', 'db.sessions = db.sessions.filter((s) => s.uid !== target.id);\n      db.events.concat(db.groups).forEach((x) => { x.people = x.people.filter((i) => i !== target.id); });', 'cleanup on delete');
  s = once(s, "res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });", SERVER_AVATAR_FILE, 'avatar file');
  return s;
}

/* ================= FRONTEND ================= */
const CSS = String.raw`/* PUP-UPDATE-2 */
.av{overflow:hidden}
.av img{width:100%; height:100%; object-fit:cover; display:block}
.av.xl{width:84px; height:84px; font-size:2rem; border:3px solid var(--gold)}
.sr-file{position:absolute; width:1px; height:1px; opacity:0; overflow:hidden}
.acct-card{display:flex; align-items:center; gap:16px; padding:18px; margin:18px 0 12px; border-radius:18px; color:#fff; background:linear-gradient(120deg,var(--maroon-d),var(--maroon))}
.acct-card.role-professor{background:linear-gradient(120deg,#5a3d06,var(--gold-d))}
.acct-card.role-student{background:linear-gradient(120deg,#2b1b1d,#4d2c30)}
.acct-card .av.xl{flex:none}
.acct-info{min-width:0}
.acct-info small{display:block; color:var(--gold); letter-spacing:.1em; text-transform:uppercase; font-size:.66rem}
.acct-card.role-professor small{color:#fff}
.acct-info b{display:block; font-size:1.1rem; overflow-wrap:anywhere; margin:2px 0 6px}
.role-pill{display:inline-block; padding:2px 12px; border-radius:99px; background:rgba(255,255,255,.2); font-size:.76rem; font-weight:600}
.photo-actions{display:flex; gap:8px; flex-wrap:wrap; align-items:center}
.acct-actions{display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:16px}
.acct-actions .danger-ghost{grid-column:1/-1}
.ann-list{gap:16px}
.ann{list-style:none; background:var(--surface); border:1px solid var(--line); border-left:6px solid var(--gold); border-radius:var(--radius); padding:20px; box-shadow:var(--shadow); transition:transform .2s,border-color .2s}
.ann:hover{transform:translateY(-2px)}
.ann-top{display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:6px}
.ann-tag{display:inline-flex; align-items:center; gap:6px; padding:3px 12px; border-radius:99px; background:var(--gold); color:var(--maroon-d); font-size:.72rem; font-weight:600; letter-spacing:.06em; text-transform:uppercase}
.ann-tools{display:flex; gap:2px}
.ann h4{font-size:1.15rem; overflow-wrap:anywhere}
.ann .body{margin-top:6px; white-space:pre-wrap; overflow-wrap:anywhere}
.ann-by{display:flex; align-items:center; gap:10px; margin-top:14px; font-size:.86rem}
.ann-by small{display:block; color:var(--muted); font-size:.74rem}
.ann-strip{margin-top:22px}
.ann-strip .ann{box-shadow:none; margin-bottom:12px}
.card,.btn,.nav a,.person{transition:transform .2s,box-shadow .2s,background-color .2s,border-color .2s}
.btn:active:not(:disabled){transform:scale(.98)}
@media (max-width:700px){.page-head .btn{width:100%}}
@media (max-width:520px){.modal-foot .btn{flex:1 1 100%}.acct-actions{grid-template-columns:1fr}.acct-card{padding:14px}.av.xl{width:68px; height:68px; font-size:1.6rem}}
/* ---------- Responsive ---------- */`;

const JS = String.raw`/* ===== PUP-UPDATE-2 ===== */
function evs() { return shared.events || []; }
function grps() { return shared.groups || []; }
function seedLocal() { return { tasks: [], doneActs: {} }; }
function loadLocal() {
  try {
    var raw = lsGet(localKey());
    if (raw) {
      var d = JSON.parse(raw);
      if (d && Array.isArray(d.tasks)) {
        var tasks = d.tasks.filter(function (t) { return !((t.id === 't1' || t.id === 't2') && /^(Finish the Module 5 slide deck|Read Chapter 4 notes)$/.test(t.title)); });
        var done = d.doneActs && typeof d.doneActs === 'object' && !Array.isArray(d.doneActs) ? d.doneActs : {};
        return { tasks: tasks, doneActs: done };
      }
    }
  } catch (e) { /* fall through */ }
  return seedLocal();
}
function avatar(u, cls) {
  var prof = !!u && (u.role === 'professor' || u.role === 'admin');
  var inner = u && u.id && u.avatarV ? '<img src="/avatar/' + esc(u.id) + '?v=' + esc(u.avatarV) + '" alt="">' : esc(initial(u ? u.name : '?'));
  return '<span class="av' + (prof ? ' prof' : '') + (cls ? ' ' + cls : '') + '" aria-hidden="true">' + inner + '</span>';
}
function render() {
  renderBase();
  if (!session || !session.user || !local) return;
  $profile.innerHTML = avatar(me()) + '<span class="pname">' + esc(me().name) + '</span>';
}
function putEntry(kind, entry) {
  var list = shared[kind] || (shared[kind] = []), i = -1;
  list.forEach(function (x, k) { if (x.id === entry.id) i = k; });
  if (i > -1) list[i] = entry; else list.unshift(entry);
  mut++; sigs[kind] = '';
}
function canDelEntry(x) { return x.authorId === me().id || isStaff(); }

/* ----- data loading ----- */
function enterApp() {
  local = loadLocal();
  return Promise.all([api('GET', '/api/users'), api('GET', '/api/posts'), api('GET', '/api/threads'), api('GET', '/api/events'), api('GET', '/api/groups')]).then(function (r) {
    sigs.users = JSON.stringify(r[0].users); applyUsers(r[0].users);
    sigs.posts = JSON.stringify(r[1].posts); applyPosts(r[1].posts);
    sigs.threads = JSON.stringify(r[2].threads); applyThreads(r[2].threads);
    sigs.events = JSON.stringify(r[3].events); shared.events = r[3].events;
    sigs.groups = JSON.stringify(r[4].groups); shared.groups = r[4].groups;
    var self = shared.byId[me().id]; if (self) session.user.avatarV = self.avatarV;
    show($('boot'), false); show($('authScreen'), false); show($('app'), true);
    setOnline(true);
    if (!VIEWS[location.hash.replace('#', '')]) location.hash = '#dashboard';
    render();
    if (currentView() === 'accounts') loadAdmin();
    startPolling();
  });
}
function refreshShared() {
  var r = mut, cw = ui.chatWith;
  var jobs = [
    api('GET', '/api/users'), api('GET', '/api/posts'), api('GET', '/api/threads'),
    cw && currentView() === 'messages' ? api('GET', '/api/messages/' + cw) : Promise.resolve(null),
    isAdmin() && currentView() === 'accounts' ? api('GET', '/api/admin/users') : Promise.resolve(null),
    api('GET', '/api/events'), api('GET', '/api/groups')
  ];
  return Promise.all(jobs).then(function (res) {
    if (r !== mut || !session) return;
    var changed = false;
    changed = setSig('users', res[0].users, applyUsers) || changed;
    changed = setSig('posts', res[1].posts, applyPosts) || changed;
    changed = setSig('threads', res[2].threads, applyThreads) || changed;
    changed = setSig('events', res[5].events, function (v) { shared.events = v; }) || changed;
    changed = setSig('groups', res[6].groups, function (v) { shared.groups = v; }) || changed;
    if (res[4]) changed = setSig('admin', res[4], applyAdmin) || changed;
    if (res[3] && cw === ui.chatWith) changed = setSig('convo', res[3].messages, applyConvo) || changed;
    var self = shared.byId[me().id]; if (self) session.user.avatarV = self.avatarV;
    if (changed) render();
    if (cw && cw === ui.chatWith) markRead(cw);
  });
}

/* ----- announcements ----- */
function announcements() { return shared.posts.filter(function (p) { return p.kind === 'announcement'; }); }
function canEditAnn(p) { return isStaff() && (p.authorId === me().id || isAdmin()); }
function annWhen(p) { return new Date(p.at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
function annCard(p, compact) {
  var a = authorOf(p);
  var tools = compact ? '' : (canEditAnn(p) ? '<button type="button" class="icon-btn" data-action="edit-announcement" data-id="' + esc(p.id) + '" aria-label="Edit announcement">' + icon('edit', 17) + '</button>' : '') + deleteBtn(p);
  return '<li class="ann"><div class="ann-top"><span class="ann-tag">' + icon('bell', 14) + 'Announcement</span><div class="ann-tools">' + tools + '</div></div>' +
    '<h4>' + esc(p.title) + '</h4><p class="body' + (compact ? ' clamp' : '') + '">' + esc(p.body) + '</p>' +
    '<div class="ann-by">' + avatar(a) + '<div><b>' + esc(a.name) + '</b> ' + roleChip(a.role) + '<small>' + esc(annWhen(p)) + (p.edited ? ' &middot; edited' : '') + '</small></div></div></li>';
}
function announcementsView() {
  var list = announcements();
  return '<div class="page-head"><div><h2>Announcements</h2><p>Updates from your professors and admins.</p></div>' +
    (isStaff() ? '<button type="button" class="btn primary" data-action="new-announcement">' + icon('plus', 18) + 'New announcement</button>' : '') + '</div>' +
    (list.length ? '<ul class="list ann-list">' + list.map(function (p) { return annCard(p, false); }).join('') + '</ul>'
      : '<section class="card"><div class="empty"><b>No announcements yet</b>' + (isStaff() ? 'Tap "New announcement" to post the first one.' : 'Check back soon.') + '</div></section>');
}
function dashboardView() {
  var html = dashboardViewBase(), list = announcements().slice(0, 2);
  var strip = '<section class="card ann-strip"><div class="card-head"><h3>Announcements</h3><a href="#announcements">View all</a></div>' +
    (list.length ? '<ul class="list">' + list.map(function (p) { return annCard(p, true); }).join('') + '</ul>' : '<div class="empty"><b>No announcements yet</b>Updates from professors and admins will show up here.</div>') + '</section>';
  return html.replace('<section class="stats">', strip + '<section class="stats">');
}
function formAnnouncement(p) {
  if (!isStaff()) return;
  openForm({
    title: p ? 'Edit announcement' : 'New announcement', sub: p ? '' : 'Everyone on PUP TOGETHER will see this.', submit: p ? 'Save changes' : 'Publish',
    fields: [
      { name: 'title', label: 'Title', required: true, max: 100, autofocus: true, value: p ? p.title : '' },
      { name: 'body', label: 'Message', type: 'textarea', required: true, max: 2000, value: p ? p.body : '' }
    ],
    onSubmit: function (d) {
      var req = p ? api('PATCH', '/api/posts/' + p.id, { title: d.title, body: d.body }) : api('POST', '/api/posts', { kind: 'announcement', title: d.title, body: d.body });
      return req.then(function (r) {
        mut++; sigs.posts = '';
        var i = -1; shared.posts.forEach(function (x, k) { if (x.id === r.post.id) i = k; });
        if (i > -1) shared.posts[i] = r.post; else shared.posts.unshift(r.post);
        render(); toast(p ? 'Announcement updated' : 'Announcement published');
      });
    }
  });
}

/* ----- events and study groups (shared) ----- */
function upcomingEvents() { return evs().filter(function (e) { return diffDays(e.date) >= 0; }).sort(byWhen); }
function eventRow(e, full) {
  var past = diffDays(e.date) < 0, d = parseISO(e.date);
  var meta = [fmtTime(e.time), e.place].filter(Boolean).map(esc).join(' &middot; ') || esc(fmtDate(e.date, { weekday: 'long' }));
  return '<li class="event' + (past ? ' past' : '') + '">' +
    '<div class="date-badge"><span>' + esc(d.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()) + '</span><b>' + d.getDate() + '</b></div>' +
    '<div class="event-main"><p class="event-title">' + esc(e.title) + '</p><p class="event-meta">' + meta + '</p><p class="event-meta">By ' + esc(e.authorName) + ' &middot; ' + e.count + ' going</p></div>' +
    (full ? '<div class="event-actions">' +
      (past ? '' : '<button type="button" class="btn tiny ' + (e.joined ? 'primary' : 'light') + '" data-action="rsvp" data-id="' + esc(e.id) + '" data-focus-key="rsvp-' + esc(e.id) + '">' + (e.joined ? icon('check', 14) + 'Going' : 'RSVP') + '</button>') +
      (canDelEntry(e) ? '<button type="button" class="icon-btn danger" data-action="delete-event" data-id="' + esc(e.id) + '" aria-label="Delete ' + esc(e.title) + '">' + icon('trash', 17) + '</button>' : '') + '</div>'
      : (e.joined ? '<span class="chip">Going</span>' : '')) + '</li>';
}
function groupCard(g) {
  return '<article class="card group"><div><span class="chip">' + esc(g.subject || 'General') + '</span></div><h3>' + esc(g.name) + '</h3>' +
    (g.desc ? '<p class="desc">' + esc(g.desc) + '</p>' : '') +
    '<div class="meta">' + (g.schedule ? '<span>' + icon('clock', 16) + esc(g.schedule) + '</span>' : '') +
    '<span>' + icon('users', 16) + plural(g.count, 'member') + '</span><span>Created by ' + esc(g.authorName) + '</span></div>' +
    '<div class="foot"><button type="button" class="btn ' + (g.joined ? 'light' : 'primary') + '" data-action="toggle-group" data-id="' + esc(g.id) + '" data-focus-key="grp-' + esc(g.id) + '">' + (g.joined ? 'Leave group' : 'Join group') + '</button>' +
    (canDelEntry(g) ? '<button type="button" class="icon-btn danger" data-action="delete-group" data-id="' + esc(g.id) + '" aria-label="Delete ' + esc(g.name) + '">' + icon('trash', 17) + '</button>' : '') + '</div></article>';
}
function groupsView() {
  var groups = grps().slice().sort(function (a, b) {
    if (a.joined !== b.joined) return a.joined ? -1 : 1;
    return String(a.name).localeCompare(String(b.name));
  });
  return '<div class="page-head"><div><h2>Study Groups</h2><p>Plan study groups with your classmates. Everyone can see and join them.</p></div>' +
    '<button type="button" class="btn primary" data-action="new-group">' + icon('plus', 18) + 'New group</button></div>' +
    (groups.length ? '<div class="cards">' + groups.map(groupCard).join('') + '</div>'
      : '<section class="card"><div class="empty"><b>No group study sessions available yet</b>Create the first one.</div></section>');
}
function calendarHTML() {
  var y = ui.cal.y, m = ui.cal.m, start = new Date(y, m, 1).getDay(), dim = new Date(y, m + 1, 0).getDate();
  var evDates = {}, dueDates = {};
  evs().forEach(function (e) { evDates[e.date] = true; });
  local.tasks.forEach(function (t) { if (!t.done) dueDates[t.due] = true; });
  activities().forEach(function (a) { if (isOpenAct(a) && (isStaff() || !actDone(a))) dueDates[a.due] = true; });
  var today = todayISO();
  var cells = WEEKDAYS.map(function (d) { return '<div class="cal-dow">' + d.charAt(0) + '</div>'; }).join('');
  var i;
  for (i = 0; i < start; i++) cells += '<span></span>';
  for (i = 1; i <= dim; i++) {
    var iso = String(y).padStart(4, '0') + '-' + pad(m + 1) + '-' + pad(i);
    var label = parseISO(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
    cells += '<button type="button" class="cal-day' + (iso === today ? ' today' : '') + '" data-action="new-event" data-date="' + iso + '" aria-label="Add an event on ' + esc(label) + '">' +
      '<span>' + i + '</span><i class="dots">' + (evDates[iso] ? '<b class="dot gold"></b>' : '') + (dueDates[iso] ? '<b class="dot maroon"></b>' : '') + '</i></button>';
  }
  var title = new Date(y, m, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  return '<div class="cal-head"><button type="button" class="icon-btn" data-action="cal-prev" aria-label="Previous month">' + icon('left', 20) + '</button><h3>' + esc(title) + '</h3>' +
    '<button type="button" class="icon-btn" data-action="cal-next" aria-label="Next month">' + icon('right', 20) + '</button></div><div class="cal-grid">' + cells + '</div>' +
    '<div class="legend"><span><b class="dot gold"></b>Event</span><span><b class="dot maroon"></b>Something due</span>' +
    '<button type="button" class="btn tiny light" data-action="cal-today" style="margin-left:auto">Today</button></div>';
}
function eventsView() {
  var sorted = evs().slice().sort(byWhen);
  var up = sorted.filter(function (e) { return diffDays(e.date) >= 0; });
  var past = sorted.filter(function (e) { return diffDays(e.date) < 0; }).reverse().slice(0, 5);
  return '<div class="page-head"><div><h2>Events</h2><p>Tap any day on the calendar to add an event. Activity due dates show up too.</p></div>' +
    '<button type="button" class="btn primary" data-action="new-event" data-date="' + todayISO() + '">' + icon('plus', 18) + 'New event</button></div>' +
    '<div class="events-layout"><section class="card">' + calendarHTML() + '</section><section class="card"><p class="sub-h">Upcoming</p>' +
    (up.length ? '<ul class="list">' + up.map(function (e) { return eventRow(e, true); }).join('') + '</ul>' : '<div class="empty"><b>No events available yet</b>Pick a day on the calendar to add one.</div>') +
    (past.length ? '<p class="sub-h">Recently passed</p><ul class="list">' + past.map(function (e) { return eventRow(e, true); }).join('') + '</ul>' : '') + '</section></div>';
}
function formEvent(date) {
  openForm({
    title: 'New event', sub: 'Everyone will see it on the calendar.', submit: 'Add event',
    fields: [
      { name: 'title', label: 'Event name', required: true, max: 80, autofocus: true, placeholder: 'e.g., Study session' },
      { name: 'date', label: 'Date', type: 'date', required: true, value: isValidISO(date || '') ? date : todayISO() },
      { name: 'time', label: 'Time', type: 'time', value: '17:00' },
      { name: 'place', label: 'Place', max: 60, placeholder: 'e.g., Library' }
    ],
    validate: function (d) { return isValidISO(d.date) ? '' : 'Please choose a valid date.'; },
    onSubmit: function (d) {
      return api('POST', '/api/events', { title: d.title, date: d.date, time: d.time, place: d.place }).then(function (r) { putEntry('events', r.entry); render(); toast('Event added'); });
    }
  });
}
function formGroup() {
  openForm({
    title: 'New study group', sub: 'You will join it automatically.', submit: 'Create group',
    fields: [
      { name: 'name', label: 'Group name', required: true, max: 50, autofocus: true, placeholder: 'e.g., Physics Review Squad' },
      { name: 'subject', label: 'Subject', max: 30, placeholder: 'e.g., Science' },
      { name: 'schedule', label: 'When do you meet?', max: 40, placeholder: 'e.g., Mon, 5:00 PM' },
      { name: 'desc', label: 'About the group', type: 'textarea', max: 140, placeholder: 'What will you do together?' }
    ],
    onSubmit: function (d) {
      return api('POST', '/api/groups', { name: d.name, subject: d.subject, schedule: d.schedule, desc: d.desc }).then(function (r) { putEntry('groups', r.entry); render(); toast('Group created'); });
    }
  });
}

/* ----- account card and profile picture ----- */
function openAccount() {
  var u = me();
  $modal.innerHTML = '<div class="modal-card"><div class="modal-head"><h3>Your account</h3><button type="button" class="icon-btn" data-action="close-modal" aria-label="Close">' + icon('x', 20) + '</button></div>' +
    '<div class="acct-card role-' + esc(u.role) + '">' + avatar(u, 'xl') + '<div class="acct-info"><small>PUP TOGETHER member</small><b>' + esc(u.name) + '</b><span class="role-pill">' + esc(roleLabel(u.role)) + '</span></div></div>' +
    '<div class="photo-actions"><label class="btn light tiny" for="avatarFile">' + (u.avatarV ? 'Change photo' : 'Upload photo') + '</label>' +
    (u.avatarV ? '<button type="button" class="btn danger-ghost tiny" data-action="remove-avatar">Remove photo</button>' : '') +
    '<input type="file" id="avatarFile" class="sr-file" accept="image/jpeg,image/png,image/webp"></div>' +
    '<dl class="kv"><dt>Username</dt><dd>@' + esc(u.username) + '</dd><dt>Role</dt><dd>' + esc(roleLabel(u.role)) + '</dd><dt>Student ID</dt><dd>' + esc(u.studentId || 'Not set') + '</dd></dl>' +
    '<div class="acct-actions"><button type="button" class="btn light" data-action="change-password">Change password</button>' +
    '<button type="button" class="btn primary" data-action="logout">' + icon('logout', 16) + 'Log out</button>' +
    '<button type="button" class="btn danger-ghost" data-action="reset-planner">Clear my tasks</button></div></div>';
  openDialog();
}
function setSelfAvatar(user) {
  session.user = Object.assign({}, session.user, { avatarV: user.avatarV });
  var e = shared.byId[user.id]; if (e) e.avatarV = user.avatarV;
  mut++; sigs.users = '';
  render();
  if ($modal.open) openAccount();
}
function readAvatar(file) {
  return new Promise(function (resolve, reject) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error('Please choose a JPG, PNG, or WebP image.'));
    if (file.size > 12 * 1024 * 1024) return reject(new Error('That image is too large (12 MB max).'));
    var fr = new FileReader();
    fr.onerror = function () { reject(new Error('That image could not be read.')); };
    fr.onload = function () {
      var img = new Image();
      img.onerror = function () { reject(new Error('That image could not be read.')); };
      img.onload = function () {
        var s = Math.min(img.width, img.height), c = document.createElement('canvas'), x;
        c.width = c.height = 256; x = c.getContext('2d');
        x.fillStyle = '#fff'; x.fillRect(0, 0, 256, 256);
        x.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 256, 256);
        resolve(c.toDataURL('image/jpeg', 0.85));
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}
document.addEventListener('change', function (e) {
  var el = e.target;
  if (!el || el.id !== 'avatarFile' || !el.files || !el.files[0]) return;
  readAvatar(el.files[0]).then(function (data) { return api('PUT', '/api/me/avatar', { image: data }); })
    .then(function (r) { setSelfAvatar(r.user); toast('Profile picture updated'); })
    .catch(function (err) { toast(err.message); });
});
document.addEventListener('click', function (e) {
  var el = e.target.closest('[data-action]');
  if (!el) return;
  var a = el.getAttribute('data-action'), id = el.getAttribute('data-id'), item;
  if (a === 'remove-avatar') {
    api('DELETE', '/api/me/avatar').then(function (r) { setSelfAvatar(r.user); toast('Profile picture removed'); }).catch(function (err) { toast(err.message); });
  } else if (a === 'new-announcement') {
    formAnnouncement(null);
  } else if (a === 'edit-announcement') {
    item = findById(shared.posts, id); if (item) formAnnouncement(item);
  } else if (a === 'rsvp' || a === 'toggle-group') {
    var kind = a === 'rsvp' ? 'events' : 'groups';
    api('POST', '/api/' + kind + '/' + id + '/toggle', {}).then(function (r) {
      putEntry(kind, r.entry); render();
      toast(kind === 'events' ? (r.entry.joined ? 'You are going' : 'RSVP removed') : (r.entry.joined ? 'You joined ' + r.entry.name : 'You left ' + r.entry.name));
    }).catch(function (err) { toast(err.message); });
  } else if (a === 'delete-event' || a === 'delete-group') {
    var k2 = a === 'delete-event' ? 'events' : 'groups';
    item = findById(shared[k2] || [], id);
    if (item && window.confirm('Delete "' + (item.title || item.name) + '"?')) {
      api('DELETE', '/api/' + k2 + '/' + id).then(function () { removeById(shared[k2], id); mut++; sigs[k2] = ''; render(); toast('Deleted'); })
        .catch(function (err) { toast(err.message); });
    }
  }
});
$('menuBtn').innerHTML = icon('menu', 22);`;

function patchHtml(s) {
  if (s.includes(MARK)) throw new Error('index.html is already updated.');
  s = once(s, '/* ---------- Responsive ---------- */', CSS, 'css');
  s = once(s, "dashboard: 'Dashboard', activities: 'Activities',", "dashboard: 'Dashboard', announcements: 'Announcements', activities: 'Activities',", 'views');
  s = once(s, "{ dashboard: 'home', activities: 'clipboard',", "{ dashboard: 'home', announcements: 'bell', activities: 'clipboard',", 'nav icons');
  s = once(s, 'var builders = { dashboard: dashboardView,', 'var builders = { dashboard: dashboardView, announcements: announcementsView,', 'builders');
  s = once(s, 'function render() {', 'function renderBase() {', 'render');
  s = once(s, 'function dashboardView() {', 'function dashboardViewBase() {', 'dashboard');
  s = once(s, "case 'toggle-group':", "case 'toggle-group-old':", 'old group case');
  s = once(s, "case 'delete-group':", "case 'delete-group-old':", 'old delete group case');
  s = once(s, "case 'rsvp':", "case 'rsvp-old':", 'old rsvp case');
  s = once(s, "case 'delete-event':", "case 'delete-event-old':", 'old delete event case');
  s = once(s, "'Reset your tasks, study groups, and events to the starter examples?'", "'Clear all of your tasks and activity checkmarks?'", 'reset text');
  s = once(s, "$('menuBtn').innerHTML = icon('menu', 22);", JS, 'main block');
  return s;
}

/* ================= RUN ================= */
try {
  const sp = path.join(dir, 'server.js'), hp = path.join(dir, 'index.html');
  const server = fs.readFileSync(sp, 'utf8'), html = fs.readFileSync(hp, 'utf8');
  const newServer = patchServer(server), newHtml = patchHtml(html);
  fs.writeFileSync(sp + '.bak', server);
  fs.writeFileSync(hp + '.bak', html);
  fs.writeFileSync(sp, newServer);
  fs.writeFileSync(hp, newHtml);
  console.log('Done. Backups saved as server.js.bak and index.html.bak. Restart the server: node server.js');
} catch (e) {
  console.error('Nothing was changed. ' + e.message);
  process.exit(1);
}
