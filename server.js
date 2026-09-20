// Kalava — minimal real backend
// Express (REST) + Socket.IO (real-time) + a JSON file as the "database".
// Small on purpose: this is the Chaos Engine + comment threading slice of the
// full spec, built as a genuine client/server app instead of hardcoded UI state.

const path = require('path');
const fs = require('fs');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const SEED_PATH = path.join(__dirname, 'data', 'db.seed.json');

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.copyFileSync(SEED_PATH, DB_PATH);
  }
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
}
function saveDb() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

let db = loadDb();
const now = () => Math.floor(Date.now() / 1000);

// give every conversation runtime metrics derived from seed + real activity
function ensureRuntime(conv) {
  if (!conv._participants) {
    const uniq = new Set(conv.thread.map(c => c.user));
    conv._participants = uniq.size + (conv.seedParticipants || 0);
  }
  if (conv._commentCount === undefined) {
    conv._commentCount = conv.thread.length + (conv.seedComments || 0);
  }
  if (!conv._startedAt) conv._startedAt = now() + (conv.createdAt || -3600);
  if (conv._modActive === undefined) conv._modActive = !!conv.forceModerator;
  return conv;
}
Object.values(db.conversations).forEach(ensureRuntime);

const CHAOS_ROTATING = [
  '🔥 This conversation is heating up',
  '⚡ Kalava is watching this one',
  '🌀 Chaos level: high',
  '👀 Strangers keep joining this one',
];

// --- the Chaos Engine's core rule: state is a function of velocity, not just totals
function computeState(conv) {
  const c = conv._commentCount;
  const p = conv._participants;
  if (conv._modActive) return 'MOD';
  if (c >= 250 || p >= 80) return 'CHAOS';
  if (c >= 80 || p >= 25) return 'ACTIVE';
  if (c >= 20 || p >= 8) return 'HEATING';
  return 'NORMAL';
}

function publicConversation(id) {
  const conv = ensureRuntime(db.conversations[id]);
  const state = computeState(conv);
  const elapsed = Math.max(1, now() - conv._startedAt);
  const mins = Math.floor(elapsed / 60);
  const started = mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return {
    id,
    topic: conv.topic,
    author: conv.author,
    media: conv.media,
    branches: conv.branches,
    thread: conv.thread.map(hydrateComment),
    comments: conv._commentCount,
    participants: conv._participants,
    participantsPreview: participantsPreview(conv),
    started,
    state,
    modActive: conv._modActive,
  };
}
function hydrateComment(c) {
  const u = db.users[c.user] || { name: c.user, handle: '@' + c.user };
  return { ...c, authorName: u.name, authorHandle: u.handle, authorAvatar: u.avatar, authorRep: u.rep, isMod: !!u.isMod };
}

// the distinct handles actually visible in a thread right now — what the Chaos
// Engine surfaces as "who's in here", not just a raw participant count
function participantsPreview(conv) {
  const seen = new Set();
  const list = [];
  for (const c of conv.thread) {
    if (seen.has(c.user)) continue;
    seen.add(c.user);
    const u = db.users[c.user];
    if (!u) continue;
    list.push({ handle: u.handle, avatar: u.avatar, name: u.name, isMod: !!u.isMod });
    if (list.length >= 6) break;
  }
  return list;
}

const MOD_CLARIFICATION = "Moderator clarification: for the record, food preference is subjective and not something we adjudicate. The factual claim being debated — dish origin — traces to Senegalese thieboudienne; several culinary historians trace the Nigerian and Ghanaian variants from there. That's context, not a ranking.";
const SIM_REPLIES = [
  "Y'all are really out here arguing about this at 2am 💀",
  'Wait can someone actually link the source on this claim',
  'This thread aged into a full documentary',
  'New person just walked in and I\'m here for it',
  'Screenshotting this for the group chat',
  'The replies are becoming more entertaining than the take itself',
  'Someone tag a moderator before this gets worse 😭',
];
const SIM_USERS = ['chidi', 'amaka', 'sipho', 'wanjiru', 'fatou', 'zanele', 'kwabena'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- REST API ----------
app.get('/api/feed', (req, res) => {
  const feed = db.feed.map(item => {
    const u = db.users[item.user];
    const base = { ...item, authorName: u.name, authorHandle: u.handle, authorLoc: u.loc, authorAvatar: u.avatar, authorRep: u.rep, authorVerified: u.verified };
    if (item.kind === 'take' || item.kind === 'chaos') {
      const conv = publicConversation(item.id);
      base.state = conv.state;
      base.comments = conv.comments;
      base.participants = conv.participants;
      base.participantsPreview = conv.participantsPreview;
      base.started = conv.started;
    }
    return base;
  });
  res.json({ feed });
});

app.get('/api/users/:handle', (req, res) => {
  const u = db.users[req.params.handle];
  if (!u) return res.status(404).json({ error: 'not found' });
  res.json({ user: { ...u, handle: req.params.handle } });
});

app.get('/api/conversations/:id', (req, res) => {
  if (!db.conversations[req.params.id]) return res.status(404).json({ error: 'not found' });
  res.json({ conversation: publicConversation(req.params.id) });
});

app.post('/api/conversations/:id/comments', (req, res) => {
  const conv = db.conversations[req.params.id];
  if (!conv) return res.status(404).json({ error: 'not found' });
  const { user, text, parentId } = req.body;
  if (!user || !text) return res.status(400).json({ error: 'user and text required' });
  const id = 'u' + Math.random().toString(36).slice(2, 9);
  const comment = { id, user, text, parentId: parentId || null };
  conv.thread.push(comment);
  ensureRuntime(conv);
  conv._commentCount += 1;
  if (!conv.thread.slice(0, -1).some(c => c.user === user)) conv._participants += 1;
  const prevState = computeState(conv);
  const payload = publicConversation(req.params.id);
  saveDb();
  io.to('conv:' + req.params.id).emit('comment:new', hydrateComment(comment));
  io.to('conv:' + req.params.id).emit('state:update', { state: payload.state, comments: payload.comments, participants: payload.participants, participantsPreview: payload.participantsPreview, started: payload.started });
  res.json({ conversation: payload });
});

// Demo endpoint: simulate a burst of organic activity server-side, broadcast to
// everyone currently viewing this conversation (including other devices).
app.post('/api/conversations/:id/simulate', (req, res) => {
  const conv = db.conversations[req.params.id];
  if (!conv) return res.status(404).json({ error: 'not found' });
  ensureRuntime(conv);

  const bump = Math.floor(20 + Math.random() * 60);
  conv._commentCount += bump;
  conv._participants += Math.floor(2 + Math.random() * 8);

  const replyUser = SIM_USERS[Math.floor(Math.random() * SIM_USERS.length)];
  const replyText = SIM_REPLIES[Math.floor(Math.random() * SIM_REPLIES.length)];
  // reply to a random existing comment (not one of theirs) so it @-mentions someone real
  const candidates = conv.thread.filter(c => c.user !== replyUser);
  const parent = candidates[Math.floor(Math.random() * candidates.length)];
  const newComment = { id: 'u' + Math.random().toString(36).slice(2, 9), user: replyUser, text: replyText, parentId: parent ? parent.id : null };
  conv.thread.push(newComment);

  const wasModActive = conv._modActive;
  const newState = computeState(conv);
  let modComment = null;
  if (newState === 'CHAOS' && !wasModActive) {
    // Chaos Engine auto-escalates to a human moderator once the thread crosses threshold
    conv._modActive = true;
    modComment = { id: 'u' + Math.random().toString(36).slice(2, 9), user: 'moderator', text: MOD_CLARIFICATION, parentId: null };
    conv.thread.push(modComment);
  }

  const payload = publicConversation(req.params.id);
  saveDb();

  io.to('conv:' + req.params.id).emit('comment:new', hydrateComment(newComment));
  if (modComment) io.to('conv:' + req.params.id).emit('comment:new', hydrateComment(modComment));
  io.to('conv:' + req.params.id).emit('state:update', { state: payload.state, comments: payload.comments, participants: payload.participants, participantsPreview: payload.participantsPreview, started: payload.started, modActive: payload.modActive });

  res.json({ conversation: payload, rotatingLabel: CHAOS_ROTATING[Math.floor(Math.random() * CHAOS_ROTATING.length)] });
});

app.get('/api/discover', (req, res) => {
  const trending = Object.entries(db.conversations).map(([id, c]) => {
    const conv = publicConversation(id);
    return { id, topic: conv.topic, comments: conv.comments, state: conv.state, participantsPreview: conv.participantsPreview };
  });
  res.json({
    trending,
    topics: ['Nigerian Football', 'Afrobeats', 'African Tech', 'Lagos', 'Accra', 'African Politics', 'Fashion', 'Diaspora Life', 'Anime', 'Agriculture', 'Movies', 'History'],
    cities: [
      ['🇳🇬 Lagos', '2.1K active'], ['🇬🇭 Accra', '940 active'], ['🇰🇪 Nairobi', '1.3K active'],
      ['🇿🇦 Johannesburg', '860 active'], ['🇸🇳 Dakar', '410 active'],
    ],
    diaspora: [['🇬🇧 London', 'Nigerian diaspora'], ['🇺🇸 Atlanta', 'Ghanaian diaspora'], ['🇨🇦 Toronto', 'East African diaspora']],
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true, time: now() }));

// ---------- Socket.IO realtime ----------
io.on('connection', socket => {
  socket.on('join', convId => socket.join('conv:' + convId));
  socket.on('leave', convId => socket.leave('conv:' + convId));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Kalava backend listening on :' + PORT));
