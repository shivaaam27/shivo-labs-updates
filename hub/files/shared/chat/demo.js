// ONE source: shared/chat/demo.js (the phone app has a copy made by `node shared/sync.mjs`).
// "Look around first": a pretend chat server inside the page, with a sample team, so the Chat screens
// can be explored before the real server is set up. Nothing leaves the device; it resets when you leave.
// It answers the same requests as chat/worker and sends the same live events.
const REPLIES = ['Sounds good 👍', 'On it, will update you shortly.', 'Asante! 🙏', 'Can we talk about this at 3?', 'Done ✅', 'Let me check and come back to you.', '😂 true', 'Perfect, thanks!'];

export function createDemo(emit) {
  const now = Date.now(), min = 60e3, hr = 3600e3, day = 864e5;
  const users = [
    { id: 'me', name: 'Shivam Parmar', color: '#4F7A5A', role: 'owner', status: 'Building Shivo Labs', online: true },
    { id: 'asha', name: 'Asha Mushi', color: '#3E6E8E', role: 'admin', status: 'In the office until 5', online: true },
    { id: 'baraka', name: 'Baraka John', color: '#8E5A3E', role: 'member', status: 'Sales', online: false, last_seen: now - 25 * min },
    { id: 'neema', name: 'Neema Said', color: '#6B4F8E', role: 'member', status: 'Design', online: true },
    { id: 'david', name: 'David Kim', color: '#3E8E7A', role: 'member', status: 'On leave until Monday', online: false, last_seen: now - 2 * day },
  ].map((u) => ({ removed: false, last_seen: 0, ...u }));
  const chats = [
    { id: 'team', kind: 'group', name: 'Team', topic: 'Everyone in the team', created: now - 30 * day, members: ['me', 'asha', 'baraka', 'neema', 'david'], admins: ['me'] },
    { id: 'dm-asha', kind: 'dm', name: '', topic: '', created: now - 20 * day, members: ['me', 'asha'], admins: [] },
    { id: 'sales', kind: 'group', name: 'Sales', topic: 'Leads, quotes and follow-ups', created: now - 15 * day, members: ['me', 'baraka', 'asha'], admins: ['baraka'], muted: true },
    { id: 'dm-neema', kind: 'dm', name: '', topic: '', created: now - 10 * day, members: ['me', 'neema'], admins: [] },
    { id: 'notes', kind: 'dm', name: '', topic: '', created: now - 30 * day, members: ['me'], admins: [] },
  ];
  // a little picture, so photos can be tried without a camera
  const photo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7FB08B"/><stop offset="1" stop-color="#3E6E8E"/></linearGradient></defs><rect width="640" height="420" fill="url(#g)"/><circle cx="500" cy="110" r="46" fill="#F5F5F2" opacity=".85"/><path d="M0 330 170 200l120 100 110-80 240 150v50H0z" fill="#141517" opacity=".55"/><text x="32" y="390" font-family="sans-serif" font-size="26" fill="#F5F5F2">New shop front · Dar es Salaam</text></svg>');
  const files = new Map([['photo1', photo]]);
  let seq = 0, fileN = 0;
  const msgs = [];
  const add = (chat, user, ago, text, extra = {}) => { const m = { id: ++seq, chat, user, ts: now - ago, kind: 'text', text, file: null, reply: null, rx: {}, edited: 0, deleted: false, pinned: false, fwd: false, ...extra }; msgs.push(m); return m; };
  add('team', 'me', 30 * day, 'created the group', { kind: 'system' });
  add('team', 'asha', 2 * day, 'Morning team! Reminder: stock count on Friday.');
  const pinned = add('team', 'me', 2 * day - 5 * min, 'Thanks Asha. Everyone please be in by *8:30* on Friday.', { pinned: true, rx: { '👍': ['asha', 'neema', 'baraka'] } });
  add('team', 'baraka', 26 * hr, 'Here is the new shop front 👇', { file: { key: 'photo1', name: 'shop-front.png', type: 'image/png', size: 182000, w: 640, h: 420 } });
  add('team', 'neema', 25 * hr, 'Looks great! 😍', { rx: { '❤️': ['me', 'asha'] } });
  const q = add('team', 'asha', 3 * hr, '@Shivam Parmar can you check the October report before the meeting?');
  add('team', 'me', 2.9 * hr, 'Yes, I will look at it this afternoon.', { reply: { id: q.id, user: 'asha', text: q.text } });
  add('team', 'david', 50 * min, 'I am off until Monday, Neema has my keys.');
  add('dm-asha', 'me', 5 * hr, 'Did the supplier send the new prices?');
  add('dm-asha', 'asha', 4.8 * hr, 'Not yet, I will call them.');
  add('dm-asha', 'asha', 12 * min, 'They just sent them. Prices are up 4%.');
  add('dm-asha', 'asha', 11 * min, 'Should I go ahead with the order?');
  add('sales', 'baraka', 6 * hr, 'Three new leads from the expo 🎉');
  add('sales', 'baraka', 40 * min, 'Quote for Furaha Ltd is ready, please review.', { file: { key: 'quote', name: 'Quote - Furaha Ltd.pdf', type: 'application/pdf', size: 248000 } });
  add('dm-neema', 'neema', 2 * day, 'I sent you the new logo files.');
  add('dm-neema', 'me', 2 * day - 10 * min, 'Got them, thank you!');
  add('notes', 'me', 3 * day, 'Ideas: loyalty card for regular customers; WhatsApp ordering.');
  // who has read up to where (your own unread: the last two from Asha, and the Sales quote)
  const reads = new Map();
  const setRead = (chat, user, id) => reads.set(chat + '|' + user, id);
  for (const c of chats) for (const u of c.members) setRead(c.id, u, Math.max(0, ...msgs.filter((m) => m.chat === c.id).map((m) => m.id)));
  setRead('dm-asha', 'me', msgs.find((m) => m.text.startsWith('Not yet')).id);
  setRead('sales', 'me', msgs.find((m) => m.text.startsWith('Three')).id);
  setRead('team', 'david', pinned.id);
  const invites = [];

  const getRead = (chat, user) => reads.get(chat + '|' + user) || 0;
  const chat = (id) => chats.find((c) => c.id === id);
  const user = (id) => users.find((u) => u.id === id);
  const fail = (msg) => { throw new Error(msg); };
  const copy = (m) => JSON.parse(JSON.stringify(m));
  const top = (c) => Math.max(0, ...msgs.filter((m) => m.chat === c).map((m) => m.id));
  const chatOut = (c) => {
    const mine = msgs.filter((m) => m.chat === c.id);
    const unreadList = mine.filter((m) => m.id > getRead(c.id, 'me') && m.user !== 'me' && !m.deleted && m.kind !== 'system');
    return { id: c.id, kind: c.kind, name: c.name, topic: c.topic, created: c.created, muted: c.muted ? 1 : 0, fav: c.fav ? 1 : 0, archived: c.archived ? 1 : 0,
      my_role: c.admins.includes('me') ? 'admin' : 'member', last_read: getRead(c.id, 'me'), unread: unreadList.length,
      mentions: unreadList.filter((m) => m.text.includes('@Shivam Parmar')).length,
      members: c.members.map((u) => ({ user: u, role: c.admins.includes(u) ? 'admin' : 'member', last_read: getRead(c.id, u) })), last: mine.length ? copy(mine[mine.length - 1]) : null };
  };
  const changed = (m) => emit({ t: 'msg.up', m: copy(m) });
  const system = (c, text) => { const m = add(c, 'me', 0, text, { kind: 'system', ts: Date.now() }); emit({ t: 'msg', m: copy(m) }); };
  const later = (ms, fn) => setTimeout(fn, ms);

  // a teammate reads your message, types, and answers
  function answer(c, mine) {
    const others = chat(c).members.filter((u) => u !== 'me');
    if (!others.length) return;
    const who = others.find((u) => user(u).online) || others[0];
    later(700, () => { setRead(c, who, mine.id); emit({ t: 'read', chat: c, user: who, upto: mine.id }); });
    later(1400, () => emit({ t: 'typing', chat: c, user: who, on: true }));
    later(3200, () => {
      emit({ t: 'typing', chat: c, user: who, on: false });
      const m = add(c, who, 0, REPLIES[Math.floor(Math.random() * REPLIES.length)], { ts: Date.now() });
      setRead(c, who, m.id);
      emit({ t: 'msg', m: copy(m) });
    });
  }

  function act(a) {
    const find = (id) => msgs.find((m) => m.id === +id) || fail('Message not found');
    switch (a.type) {
      case 'send': {
        const c = chat(a.chat) || fail('Chat not found');
        const r = a.reply ? msgs.find((m) => m.id === +a.reply) : null;
        const m = add(c.id, 'me', 0, String(a.text || '').trim().slice(0, 4000), { ts: Date.now(), file: a.file || null, fwd: !!a.fwd, reply: r ? { id: r.id, user: r.user, text: r.text, file: r.file } : null });
        setRead(c.id, 'me', m.id); c.archived = false;
        emit({ t: 'msg', m: copy(m), cid: a.cid });
        answer(c.id, m);
        return { m: copy(m), cid: a.cid };
      }
      case 'edit': { const m = find(a.id); m.text = String(a.text).trim(); m.edited = Date.now(); changed(m); return { ok: true }; }
      case 'delete': { const m = find(a.id); Object.assign(m, { deleted: true, text: '', file: null, rx: {}, pinned: false }); changed(m); return { ok: true }; }
      case 'react': {
        const m = find(a.id), list = (m.rx[a.emoji] ||= []);
        const i = list.indexOf('me'); if (i >= 0) list.splice(i, 1); else list.push('me');
        if (!list.length) delete m.rx[a.emoji];
        changed(m); return { ok: true };
      }
      case 'pin': { const m = find(a.id); m.pinned = !!a.on; changed(m); if (a.on) system(m.chat, 'pinned a message'); return { ok: true }; }
      case 'read': { const t = Math.min(+a.upto || top(a.chat), top(a.chat)); if (t > getRead(a.chat, 'me')) { setRead(a.chat, 'me', t); emit({ t: 'read', chat: a.chat, user: 'me', upto: t }); } return { ok: true }; }
      case 'chat.dm': {
        let c = chats.find((x) => x.kind === 'dm' && x.members.length === (a.user === 'me' ? 1 : 2) && x.members.includes(a.user));
        if (!c) { c = { id: 'dm-' + a.user, kind: 'dm', name: '', topic: '', created: Date.now(), members: a.user === 'me' ? ['me'] : ['me', a.user], admins: [] }; chats.push(c); }
        c.archived = false; emit({ t: 'resync' }); return { chat: c.id };
      }
      case 'chat.group': {
        const c = { id: 'g' + Date.now(), kind: 'group', name: String(a.name).trim().slice(0, 60) || fail('Give the group a name'), topic: '', created: Date.now(), members: ['me', ...(a.users || [])], admins: ['me'] };
        chats.push(c); system(c.id, `created the group “${c.name}”`); emit({ t: 'resync' }); return { chat: c.id };
      }
      case 'chat.update': { const c = chat(a.chat); if (a.name && a.name !== c.name) { c.name = a.name; system(c.id, `renamed the group to “${a.name}”`); } if (a.topic !== undefined) c.topic = a.topic; emit({ t: 'resync' }); return { ok: true }; }
      case 'chat.add': { const c = chat(a.chat); for (const u of a.users || []) if (!c.members.includes(u)) { c.members.push(u); setRead(c.id, u, top(c.id)); system(c.id, `added ${user(u).name}`); } emit({ t: 'resync' }); return { ok: true }; }
      case 'chat.remove': {
        const c = chat(a.chat); system(c.id, a.user === 'me' ? 'left the group' : `removed ${user(a.user).name}`);
        c.members = c.members.filter((u) => u !== a.user); c.admins = c.admins.filter((u) => u !== a.user);
        if (a.user === 'me') chats.splice(chats.indexOf(c), 1);
        emit({ t: 'resync' }); return { ok: true };
      }
      case 'chat.role': { const c = chat(a.chat); c.admins = a.role === 'admin' ? [...new Set([...c.admins, a.user])] : c.admins.filter((u) => u !== a.user); emit({ t: 'resync' }); return { ok: true }; }
      case 'chat.prefs': { const c = chat(a.chat); for (const k of ['muted', 'fav', 'archived']) if (a[k] !== undefined) c[k] = !!a[k]; emit({ t: 'resync' }); return { ok: true }; }
      case 'profile': { const me = user('me'); if (a.name?.trim()) me.name = a.name.trim(); if (a.status !== undefined) me.status = a.status; emit({ t: 'resync' }); return { ok: true }; }
      case 'invite.create': {
        const al = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', code = Array.from({ length: 8 }, () => al[Math.floor(Math.random() * al.length)]).join('');
        invites.unshift({ code, uses: +a.uses || 1, expires: Date.now() + (+a.days || 7) * day, created: Date.now() }); return { code };
      }
      case 'invite.revoke': invites.splice(invites.findIndex((i) => i.code === a.code), 1); return { ok: true };
      case 'user.role': { user(a.user).role = a.role === 'admin' ? 'admin' : 'member'; emit({ t: 'resync' }); return { ok: true }; }
      case 'user.remove': { const u = user(a.user); u.removed = true; u.online = false; for (const c of chats) if (c.kind === 'group') c.members = c.members.filter((x) => x !== u.id); emit({ t: 'resync' }); return { ok: true }; }
      case 'signout': return { ok: true };
    }
    fail('Not available in the demo');
  }

  return {
    url: (key) => files.get(key) || 'data:text/plain,' + encodeURIComponent('This is a sample file in the demo.'),
    async request(path, { method = 'GET', body } = {}) {
      await new Promise((r) => setTimeout(r, 120));   // feels like a real network
      const [p, qs] = path.split('?'), q = new URLSearchParams(qs || '');
      if (p === 'sync') return { me: 'me', files: true, users: users.map(copy), chats: chats.map(chatOut) };
      if (p === 'messages') {
        const list = msgs.filter((m) => m.chat === q.get('chat'));
        if (q.get('pinned')) return { messages: list.filter((m) => m.pinned && !m.deleted).map(copy) };
        return { messages: list.map(copy), more: false };
      }
      if (p === 'search') {
        const t = (q.get('q') || '').toLowerCase(), c = q.get('chat');
        const mine = new Set(chats.map((x) => x.id));
        return { messages: msgs.filter((m) => mine.has(m.chat) && (!c || m.chat === c) && !m.deleted && m.kind !== 'system' && (m.text.toLowerCase().includes(t) || m.file?.name.toLowerCase().includes(t))).reverse().map(copy) };
      }
      if (p === 'invites') return { invites: invites.filter((i) => i.uses > 0) };
      if (p === 'act') return act(JSON.parse(body));
      if (p === 'files' && method === 'PUT') { const key = 'local' + ++fileN; files.set(key, URL.createObjectURL(body)); return { key }; }
      fail('Not available in the demo');
    },
  };
}
