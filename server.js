const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const TURN_USERNAME = '07354b48071e5473f623d7a9';
const TURN_CREDENTIAL = 'p9aioMeZ5mqY2lhl';
const SUPABASE_URL = 'https://anndslyocbqgpbwshwqa.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFubmRzbHlvY2JxZ3Bid3Nod3FhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MjA2NDUwMiwiZXhwIjoyMTA3NjQwNTAyfQ.N1GUvfL7H1OoJ47HGWjhTjUyqxNXJscd6RJpmMnocGg';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { realtime: { transport: ws } });

const AVATARS_DIR = path.join(__dirname, 'avatars');
const VOICE_DIR = path.join(__dirname, 'voice');
const IMAGES_DIR = path.join(__dirname, 'images');
[AVATARS_DIR, VOICE_DIR, IMAGES_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const uploadAvatar = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, AVATARS_DIR), filename: (req, file, cb) => cb(null, req.session.user.login + '-' + Date.now() + path.extname(file.originalname).toLowerCase()) }) });
const uploadVoice = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, VOICE_DIR), filename: (req, file, cb) => cb(null, 'voice-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + (path.extname(file.originalname) || '.webm')) }) });
const uploadImage = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, IMAGES_DIR), filename: (req, file, cb) => cb(null, 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + path.extname(file.originalname).toLowerCase()) }), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, ['image/jpeg','image/png','image/gif','image/webp'].includes(file.mimetype)) });

// ====== SUPABASE CRUD ======
async function readUsers() { const { data, error } = await supabase.from('users').select('data'); if (error) { console.error('readUsers error:', error); return { users: [] }; } return { users: data.map(r => r.data) }; }
async function writeUsers(d) { const rows = d.users.map(u => ({ login: u.login, data: u, updated_at: new Date().toISOString() })); const { error } = await supabase.from('users').upsert(rows, { onConflict: 'login' }); if (error) console.error('writeUsers error:', error); }
async function readMessages() { const { data, error } = await supabase.from('messages').select('data').order('created_at', { ascending: true }); if (error) return { messages: [] }; return { messages: data.map(r => r.data) }; }
async function writeMessages(d) { const { data: existing } = await supabase.from('messages').select('id'); const existingIds = new Set((existing || []).map(r => r.id)); const newIds = new Set(d.messages.map(m => m.id)); const toDelete = [...existingIds].filter(id => !newIds.has(id)); if (toDelete.length) await supabase.from('messages').delete().in('id', toDelete); if (d.messages.length) { const rows = d.messages.map(m => ({ id: m.id, data: m, created_at: m.time || new Date().toISOString() })); await supabase.from('messages').upsert(rows, { onConflict: 'id' }); } }
async function readQuotes() { const { data, error } = await supabase.from('quotes').select('data').order('created_at', { ascending: true }); if (error) return { quotes: [] }; return { quotes: data.map(r => r.data) }; }
async function writeQuotes(d) { const { data: existing } = await supabase.from('quotes').select('id'); const existingIds = new Set((existing || []).map(r => r.id)); const newIds = new Set(d.quotes.map(q => q.id)); const toDelete = [...existingIds].filter(id => !newIds.has(id)); if (toDelete.length) await supabase.from('quotes').delete().in('id', toDelete); if (d.quotes.length) { const rows = d.quotes.map(q => ({ id: q.id, data: q, created_at: q.savedAt || new Date().toISOString() })); await supabase.from('quotes').upsert(rows, { onConflict: 'id' }); } }
async function readDmChats() { const { data, error } = await supabase.from('dm_chats').select('*'); if (error) { console.error('readDmChats:', error); return []; } return data.map(r => ({ id: r.id, type: r.type, name: r.name, members: r.members, created_at: r.created_at, created_by: r.created_by })); }
async function writeDmChat(chat) { await supabase.from('dm_chats').upsert({ id: chat.id, type: chat.type, name: chat.name || null, members: chat.members, created_by: chat.created_by || null }, { onConflict: 'id' }); }
async function readDmMessages(chatId) { let q = supabase.from('dm_messages').select('*').order('time', { ascending: true }); if (chatId) q = q.eq('chat_id', chatId); const { data, error } = await q; if (error) { console.error('readDmMessages:', error); return []; } return data; }
async function writeDmMessage(msg) { await supabase.from('dm_messages').upsert({ id: msg.id, chat_id: msg.chat_id, from_login: msg.from_login, from_name: msg.from_name, text: msg.text || null, image: msg.image || null, voice: msg.voice || null, duration: msg.duration || null, time: msg.time, read_by: msg.read_by || [] }, { onConflict: 'id' }); }
async function deleteDmMessage(id) { await supabase.from('dm_messages').delete().eq('id', id); }
function dmChatIdForPrivate(a, b) { return 'dm-' + [a, b].sort().join('-'); }

async function readChangelog() { const { data, error } = await supabase.from('changelog').select('data').order('created_at', { ascending: true }); if (error) return { changes: [] }; return { changes: data.map(r => r.data) }; }
async function writeChangelog(d) { const { data: existing } = await supabase.from('changelog').select('id'); const existingIds = new Set((existing || []).map(r => r.id)); const newIds = new Set(d.changes.map(c => c.id)); const toDelete = [...existingIds].filter(id => !newIds.has(id)); if (toDelete.length) await supabase.from('changelog').delete().in('id', toDelete); if (d.changes.length) { const rows = d.changes.map(c => ({ id: c.id, data: c, created_at: c.time || new Date().toISOString() })); await supabase.from('changelog').upsert(rows, { onConflict: 'id' }); } }

async function addSystemMessage(text) { const data = await readMessages(); const msg = { id: 'sys-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), login: '__system__', name: 'СИСТЕМА', text: text, time: new Date().toISOString(), reactions: {}, system: true }; data.messages.push(msg); await writeMessages(data); return msg; }

function checkPunishments(user) { if (!user) return { muted: false, banned: false }; const now = Date.now(); let changed = false; let result = { muted: false, banned: false, mutedUntil: null, bannedUntil: null }; if (user.mutedUntil) { if (new Date(user.mutedUntil).getTime() > now) { result.muted = true; result.mutedUntil = user.mutedUntil; } else { user.mutedUntil = null; changed = true; } } if (user.bannedUntil) { if (new Date(user.bannedUntil).getTime() > now) { result.banned = true; result.bannedUntil = user.bannedUntil; } else { user.bannedUntil = null; changed = true; } } return { ...result, changed }; }
function parseDuration(str) { const map = { '5m': 5*60*1000, '15m': 15*60*1000, '1h': 60*60*1000, '1d': 24*60*60*1000, '7d': 7*24*60*60*1000, 'forever': null }; return map[str] !== undefined ? map[str] : undefined; }
function parseDurationRu(str) { const map = { '5m': '5 минут', '15m': '15 минут', '1h': '1 час', '1d': '1 день', '7d': '7 дней', 'forever': 'навсегда' }; return map[str] || str; }

async function checkAchievements(login) { const users = await readUsers(); const user = users.users.find(u => u.login === login); if (!user) return []; if (!user.achievements) user.achievements = []; if (!user.stats) user.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 }; const newOnes = []; const add = (k) => { if (!user.achievements.includes(k)) { user.achievements.push(k); newOnes.push(k); } }; const s = user.stats; if (s.messages >= 1) add('first_message'); if (s.messages >= 10) add('ten_messages'); if (s.messages >= 100) add('hundred_messages'); if (s.voices >= 1) add('first_voice'); if (s.voices >= 10) add('ten_voices'); if (s.images >= 1) add('first_image'); if (s.images >= 10) add('ten_images'); if (s.reactions >= 1) add('first_reaction'); if (s.reactions >= 100) add('hundred_reactions'); if (s.calls >= 1) add('first_call'); if (s.calls >= 10) add('ten_calls'); const hour = new Date().getHours(); if (hour >= 3 && hour < 5) add('night_owl'); if (hour >= 5 && hour < 7) add('early_bird'); await writeUsers(users); return newOnes; }

const DAILY_REWARD = 10; const DAILY_COOLDOWN = 24 * 60 * 60 * 1000; const DUEL_REWARD = 20; const COLOR_PRICE = 50; const BADGE_PRICE = 30; const STATUS_PRICE = 10; const REACTION_PRICE = 20; const FORBIDDEN_STATUS_WORDS = ['админ', 'admin', 'azaliks', 'система', 'system'];

function ensureCoinFields(user) { if (typeof user.coins !== 'number') user.coins = 0; if (!user.lastDaily) user.lastDaily = null; if (!user.lastDuelReward) user.lastDuelReward = null; if (!Array.isArray(user.colors)) user.colors = []; if (!Array.isArray(user.badges)) user.badges = []; if (!user.currentColor) user.currentColor = null; if (!user.currentBadge) user.currentBadge = null; if (!user.status) user.status = null; if (!Array.isArray(user.extraReactions)) user.extraReactions = []; if (typeof user.isAdmin === 'undefined') user.isAdmin = (user.role === 'admin'); }
function isForbiddenStatus(text) { if (!text) return false; const low = text.toLowerCase(); return FORBIDDEN_STATUS_WORDS.some(w => low.includes(w)); }
function isAdminUser(user) { return user && (user.role === 'admin' || user.isAdmin === true); }

app.use(express.urlencoded({ extended: true })); app.use(express.json());
const sessionMiddleware = session({ secret: 'pacan-secret-key', resave: false, saveUninitialized: false });
app.use(sessionMiddleware); app.use(express.static(__dirname));
app.get('/manifest.json', (req, res) => { res.setHeader('Content-Type', 'application/manifest+json'); res.sendFile(path.join(__dirname, 'manifest.json')); });
app.get('/sw.js', (req, res) => { res.setHeader('Content-Type', 'application/javascript'); res.setHeader('Service-Worker-Allowed', '/'); res.sendFile(path.join(__dirname, 'sw.js')); });
app.use('/avatars', express.static(AVATARS_DIR)); app.use('/voice', express.static(VOICE_DIR)); app.use('/images', express.static(IMAGES_DIR));
io.engine.use(sessionMiddleware);

const onlineUsers = new Map(); const duelInvites = new Map(); const tttInvites = new Map();

io.on('connection', (socket) => {
    const user = socket.request.session && socket.request.session.user;
    if (!user) { socket.disconnect(); return; }
    onlineUsers.set(socket.id, user.login); io.emit('online', Array.from(onlineUsers.values()));

    socket.on('duel:invite', async ({ to }) => { const targetSocketId = [...onlineUsers.entries()].find(([, login]) => login === to)?.[0]; if (!targetSocketId) { socket.emit('duel:offline', { to }); return; } const key = `${user.login}:${to}`; duelInvites.set(key, Date.now()); await addSystemMessage(`⚔️ ${user.name} вызывает ${to} на битву копейщиков! ${to}, зайди в /game и вызови ${user.name} в ответ.`); io.emit('chat:refresh'); const reverseKey = `${to}:${user.login}`; if (duelInvites.has(reverseKey)) { duelInvites.delete(key); duelInvites.delete(reverseKey); await addSystemMessage(`⚔️ Битва началась: ${user.login} vs ${to}!`); io.emit('chat:refresh'); const hostSocketId = [...onlineUsers.entries()].find(([, login]) => login === user.login)?.[0]; const clientSocketId = [...onlineUsers.entries()].find(([, login]) => login === to)?.[0]; if (hostSocketId) io.to(hostSocketId).emit('duel:start', { youAreHost: true, opponentLogin: to }); if (clientSocketId) io.to(clientSocketId).emit('duel:start', { youAreHost: false, opponentLogin: user.login }); } });
    socket.on('duel:state', ({ to, state }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('duel:state', { state }); });
    socket.on('duel:end', async ({ to, winnerLogin, winnerName, loserName }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('duel:ended', { winnerName, loserName }); const usersData = await readUsers(); const winner = usersData.users.find(u => u.login === winnerLogin); let rewardText = ''; if (winner && !isAdminUser(winner)) { ensureCoinFields(winner); const now = Date.now(); if (!winner.lastDuelReward || now - new Date(winner.lastDuelReward).getTime() > DAILY_COOLDOWN) { winner.coins += DUEL_REWARD; winner.lastDuelReward = new Date().toISOString(); rewardText = ` (+${DUEL_REWARD} монет)`; } } await writeUsers(usersData); await addSystemMessage(`⚔️ ${winnerName} победил ${loserName} в битве копейщиков!${rewardText}`); io.emit('chat:refresh'); });
    socket.on('duel:leave', ({ to }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('duel:opponentLeft', { byName: user.name }); });

    socket.on('ttt:invite', async ({ to }) => { const targetSocketId = [...onlineUsers.entries()].find(([, login]) => login === to)?.[0]; if (!targetSocketId) { socket.emit('ttt:offline', { to }); return; } const key = `${user.login}:${to}`; tttInvites.set(key, Date.now()); await addSystemMessage(`⭕ ${user.name} вызывает ${to} в крестики-нолики! ${to}, зайди в /tictactoe и вызови в ответ.`); io.emit('chat:refresh'); const reverseKey = `${to}:${user.login}`; if (tttInvites.has(reverseKey)) { tttInvites.delete(key); tttInvites.delete(reverseKey); await addSystemMessage(`❌ Началась игра в крестики-нолики: ${user.login} vs ${to}!`); io.emit('chat:refresh'); const hostSocketId = [...onlineUsers.entries()].find(([, login]) => login === user.login)?.[0]; const clientSocketId = [...onlineUsers.entries()].find(([, login]) => login === to)?.[0]; if (hostSocketId) io.to(hostSocketId).emit('ttt:start', { youAreHost: true, opponentLogin: to, yourSymbol: 'X' }); if (clientSocketId) io.to(clientSocketId).emit('ttt:start', { youAreHost: false, opponentLogin: user.login, yourSymbol: 'O' }); } });
    socket.on('ttt:move', ({ to, board, nextTurn }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('ttt:state', { board, nextTurn }); });
    socket.on('ttt:end', async ({ to, winnerName, loserName, draw }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('ttt:ended', { winnerName, loserName, draw }); if (draw) await addSystemMessage(`🤝 Ничья в крестиках-ноликах: ${winnerName} vs ${loserName}`); else await addSystemMessage(`🏆 ${winnerName} победил ${loserName} в крестиках-ноликах!`); io.emit('chat:refresh'); });
    socket.on('ttt:leave', ({ to }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('ttt:opponentLeft', { byName: user.name }); });

    socket.on('dm:notify', ({ to }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('dm:new', { from: user.login }); });
    socket.on('typing', ({ chatId, isAnon }) => { socket.broadcast.emit('user:typing', { login: isAnon ? '__anon__' : user.login, name: isAnon ? 'Аноним' : user.name, chatId }); });

    socket.on('call:offer', ({ to, offer }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:incoming', { from: user.login, fromName: user.name, offer }); else socket.emit('call:offline', { to }); });
    socket.on('call:answer', ({ to, answer }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:answered', { answer }); });
    socket.on('call:ice', ({ to, candidate }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:ice', { candidate }); });
    socket.on('call:end', ({ to }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:ended'); });
    socket.on('call:reject', ({ to }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:rejected'); });

    socket.on('admin:start-abuse', ({ target }) => { const u = socket.request.session && socket.request.session.user; if (!u || u.role !== 'admin') return; if (target === 'all') io.emit('abuse:a90-start'); else { const ts = [...onlineUsers.entries()].find(([, login]) => login === target)?.[0]; if (ts) { io.to(ts).emit('abuse:a90-start'); socket.emit('abuse:a90-start'); } } });
    socket.on('admin:shock', ({ target }) => { const u = socket.request.session && socket.request.session.user; if (!u || u.role !== 'admin') return; if (target === 'all') io.emit('abuse:shock'); else { const ts = [...onlineUsers.entries()].find(([, login]) => login === target)?.[0]; if (ts) { io.to(ts).emit('abuse:shock'); socket.emit('abuse:shock'); } } });
    socket.on('admin:kick', ({ target }) => { const u = socket.request.session && socket.request.session.user; if (!u || u.role !== 'admin') return; const ts = [...onlineUsers.entries()].find(([, login]) => login === target)?.[0]; if (ts) io.to(ts).emit('abuse:kicked', { login: target }); });
    socket.on('admin:explode', ({ target }) => { if (socket.request.session.user.role !== 'admin') return; if (target === 'all') io.emit('abuse:explode'); else { const sid = [...onlineUsers.entries()].find(([, l]) => l === target)?.[0]; if (sid) io.to(sid).emit('abuse:explode'); } });
    socket.on('admin:music', ({ target }) => { if (socket.request.session.user.role !== 'admin') return; if (target === 'all') io.emit('abuse:music'); else { const sid = [...onlineUsers.entries()].find(([, l]) => l === target)?.[0]; if (sid) io.to(sid).emit('abuse:music'); } });
    socket.on('admin:flip', ({ target }) => { if (socket.request.session.user.role !== 'admin') return; if (target === 'all') io.emit('abuse:flip'); else { const sid = [...onlineUsers.entries()].find(([, l]) => l === target)?.[0]; if (sid) io.to(sid).emit('abuse:flip'); } });

    socket.on('disconnect', () => { onlineUsers.delete(socket.id); io.emit('online', Array.from(onlineUsers.values())); });
});
// ====== API ЗВОНКОВ И АВТОРИЗАЦИИ ======
app.get('/api/turn', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    res.json({ iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: ['turn:global.relay.metered.ca:80','turn:global.relay.metered.ca:80?transport=tcp','turn:global.relay.metered.ca:443','turns:global.relay.metered.ca:443?transport=tcp'], username: TURN_USERNAME, credential: TURN_CREDENTIAL }
    ]});
});

app.get('/login', (req, res) => { res.sendFile(path.join(__dirname, 'login.html')); });

app.post('/login', async (req, res) => {
    const { login, password } = req.body;
    const data = await readUsers();
    const user = data.users.find(u => u.login === login && u.password === password);
    if (!user) return res.redirect('/login?error=1');
    const p = checkPunishments(user);
    if (p.changed) await writeUsers(data);
    if (p.banned) return res.redirect('/login?error=banned');
    user.lastLogin = new Date().toISOString();
    ensureCoinFields(user);
    await writeUsers(data);
    req.session.user = { login: user.login, name: user.name, nickname: user.nickname, role: user.role };
    if (user.role === 'admin') return res.redirect('/admin');
    res.redirect('/');
});

app.post('/api/quick-login', async (req, res) => {
    const { login } = req.body;
    if (!login) return res.status(400).json({ error: 'no login' });
    const data = await readUsers();
    const user = data.users.find(u => u.login === login);
    if (!user) return res.status(404).json({ error: 'user not found' });
    const p = checkPunishments(user);
    if (p.banned) return res.status(403).json({ error: 'banned' });
    user.lastLogin = new Date().toISOString();
    ensureCoinFields(user);
    await writeUsers(data);
    req.session.user = { login: user.login, name: user.name, nickname: user.nickname, role: user.role };
    res.json({ ok: true, redirect: user.role === 'admin' ? '/admin' : '/chat' });
});

app.get('/api/me', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = await readUsers();
    const user = data.users.find(u => u.login === req.session.user.login);
    if (!user) return res.status(404).json({ error: 'user not found' });
    ensureCoinFields(user);
    await writeUsers(data);
    const p = checkPunishments(user);
    const now = Date.now();
    const dailyReady = !user.lastDaily || now - new Date(user.lastDaily).getTime() > DAILY_COOLDOWN;
    res.json({
        login: user.login, name: user.name, nickname: user.nickname, role: user.role,
        avatar: user.avatar || null, phrase: user.phrase || '',
        achievements: user.achievements || [], stats: user.stats || {},
        warnings: user.warnings || [], muted: p.muted, mutedUntil: p.mutedUntil,
        coins: user.coins || 0, colors: user.colors || [], badges: user.badges || [],
        currentColor: user.currentColor || null, currentBadge: user.currentBadge || null,
        status: user.status || null, extraReactions: user.extraReactions || [],
        isAdmin: isAdminUser(user), dailyReady: dailyReady
    });
});

app.get('/api/online', (req, res) => { if (!req.session.user) return res.status(401).json({ error: 'not logged in' }); res.json(Array.from(onlineUsers.values())); });
app.get('/api/users', async (req, res) => { if (!req.session.user) return res.status(401).json({ error: 'not logged in' }); const data = await readUsers(); res.json(data.users.map(u => ({ login: u.login, name: u.name, avatar: u.avatar || null, coins: u.coins || 0, badge: u.role === 'admin' ? '👑' : (u.currentBadge || null), color: u.currentColor || null }))); });
app.get('/api/rating', async (req, res) => { if (!req.session.user) return res.status(401).json({ error: 'not logged in' }); const data = await readUsers(); const rating = data.users.map(u => ({ login: u.login, name: u.name, avatar: u.avatar || null, coins: u.coins || 0, messages: (u.stats && u.stats.messages) || 0, voices: (u.stats && u.stats.voices) || 0, images: (u.stats && u.stats.images) || 0, reactions: (u.stats && u.stats.reactions) || 0, calls: (u.stats && u.stats.calls) || 0, achievements: (u.achievements || []).length })).sort((a, b) => (b.messages + b.voices * 2 + b.images * 2) - (a.messages + a.voices * 2 + a.images * 2)); res.json(rating); });

// ====== СООБЩЕНИЯ ======
app.get('/api/messages', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = await readMessages();
    const usersData = await readUsers();
    const users = usersData.users;
    const isAdmin = req.session.user.role === 'admin';
    const filtered = data.messages.filter(m => !m.hidden || isAdmin || m.login === req.session.user.login);
    res.json(filtered.map(m => {
        if (m.system) return { ...m, avatar: null, reactions: {} };
        if (m.login === '__anon__' || m.isAnon) {
            const realAuthor = usersData.users.find(x => x.login === m.anon_author_login);
            return { ...m, avatar: null, badge: '🕵️‍♂️', color: '#80848e', status: null, reactions: m.reactions || {}, realLogin: isAdmin ? (m.anon_author_login || m.login) : null };
        }
        const u = users.find(x => x.login === m.login);
        const isAdm = u && (u.role === 'admin');
        return { ...m, avatar: u && u.avatar ? u.avatar : null, badge: isAdm ? '👑' : (u && u.currentBadge ? u.currentBadge : null), color: u && u.currentColor ? u.currentColor : null, status: u && u.status ? u.status : null, reactions: m.reactions || {} };
    }));
});

app.post('/api/messages', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const usersData = await readUsers();
    const user = usersData.users.find(u => u.login === req.session.user.login);
    const p = checkPunishments(user);
    if (p.changed) await writeUsers(usersData);
    if (p.muted) return res.status(403).json({ error: 'Ты в муте' });
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'empty' });
    const data = await readMessages();
    const isAnon = req.body.anon === true;
    const msg = { 
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), 
        login: isAnon ? '__anon__' : req.session.user.login, 
        name: isAnon ? 'Аноним' : req.session.user.name, 
        text: text.trim(), 
        time: new Date().toISOString(), 
        reactions: {},
        isAnon: isAnon,
        anon_author_login: isAnon ? req.session.user.login : null
    };
    if (user.shadowbanned) msg.hidden = true;
    data.messages.push(msg);
    await writeMessages(data);
    if (!user.stats) user.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 };
    user.stats.messages = (user.stats.messages || 0) + 1;
    await writeUsers(usersData);
    const newAch = await checkAchievements(req.session.user.login);
    res.json({ ...msg, newAchievements: newAch });
});

app.post('/api/voice', uploadVoice.single('voice'), async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const usersData = await readUsers();
    const user = usersData.users.find(u => u.login === req.session.user.login);
    const p = checkPunishments(user);
    if (p.changed) await writeUsers(usersData);
    if (p.muted) return res.status(403).json({ error: 'Ты в муте' });
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const duration = req.body.duration || 0;
    const data = await readMessages();
    const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), login: req.session.user.login, name: req.session.user.name, text: '▶ Голосовое', voice: '/voice/' + req.file.filename, duration: parseInt(duration) || 0, time: new Date().toISOString(), reactions: {} };
    data.messages.push(msg);
    await writeMessages(data);
    if (!user.stats) user.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 };
    user.stats.voices = (user.stats.voices || 0) + 1;
    await writeUsers(usersData);
    await checkAchievements(req.session.user.login);
    res.json(msg);
});

app.post('/api/image', uploadImage.single('image'), async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const usersData = await readUsers();
    const user = usersData.users.find(u => u.login === req.session.user.login);
    const p = checkPunishments(user);
    if (p.changed) await writeUsers(usersData);
    if (p.muted) return res.status(403).json({ error: 'Ты в муте' });
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const data = await readMessages();
    const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), login: req.session.user.login, name: req.session.user.name, text: '📷 Картинка', image: '/images/' + req.file.filename, time: new Date().toISOString(), reactions: {} };
    data.messages.push(msg);
    await writeMessages(data);
    if (!user.stats) user.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 };
    user.stats.images = (user.stats.images || 0) + 1;
    await writeUsers(usersData);
    await checkAchievements(req.session.user.login);
    res.json(msg);
});

app.delete('/api/messages/:id', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = await readMessages();
    const idx = data.messages.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const msg = data.messages[idx];
    const isOwn = msg.login === req.session.user.login || (msg.isAnon && msg.anon_author_login === req.session.user.login);
    const isAdmin = req.session.user.role === 'admin';
    if (msg.system && !isAdmin) return res.status(403).json({ error: 'no permission' });
    if (!isOwn && !isAdmin) return res.status(403).json({ error: 'no permission' });
    if (msg.voice) { const p = path.join(VOICE_DIR, path.basename(msg.voice)); if (fs.existsSync(p)) fs.unlinkSync(p); }
    if (msg.image) { const p = path.join(IMAGES_DIR, path.basename(msg.image)); if (fs.existsSync(p)) fs.unlinkSync(p); }
    data.messages.splice(idx, 1);
    await writeMessages(data);
    res.json({ ok: true });
});

app.post('/api/messages/:id/react', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const { emoji, action } = req.body;
    const ALLOWED = ['😂', '🔥', '👍', '💀', '🎉', '💯', '🤡', '❤️'];
    if (!ALLOWED.includes(emoji)) return res.status(400).json({ error: 'bad emoji' });
    const data = await readMessages();
    const msg = data.messages.find(m => m.id === req.params.id);
    if (!msg) return res.status(404).json({ error: 'not found' });
    if (msg.system) return res.status(400).json({ error: 'no reactions on system' });
    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
    const myLogin = req.session.user.login;
    if (action === 'remove') {
        const i = msg.reactions[emoji].findIndex(l => l === myLogin);
        if (i !== -1) msg.reactions[emoji].splice(i, 1);
    } else {
        Object.keys(msg.reactions).forEach(k => {
            msg.reactions[k] = msg.reactions[k].filter(l => l !== myLogin);
            if (msg.reactions[k].length === 0) delete msg.reactions[k];
        });
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        msg.reactions[emoji].push(myLogin);
    }
    await writeMessages(data);
    const users = await readUsers();
    const u = users.users.find(x => x.login === myLogin);
    if (!u.stats) u.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 };
    if (action !== 'remove') u.stats.reactions = (u.stats.reactions || 0) + 1;
    await writeUsers(users);
    await checkAchievements(myLogin);
    const avatar = (users.users.find(x => x.login === msg.login) || {}).avatar || null;
    res.json({ ...msg, avatar });
});

// ====== ЛИЧНЫЕ ЧАТЫ ======
app.get('/api/dm/chats', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const me = req.session.user.login;
    const all = await readDmChats();
    const mine = all.filter(c => Array.isArray(c.members) && c.members.includes(me));
    const usersData = await readUsers();
    const dmMsgs = await readDmMessages();
    const result = mine.map(c => {
        let name = c.name; let avatar = null;
        if (c.type === 'private') {
            const otherLogin = c.members.find(l => l !== me);
            const other = usersData.users.find(u => u.login === otherLogin);
            if (other) { name = other.name; avatar = other.avatar || null; }
        }
        const chatMsgs = dmMsgs.filter(m => m.chat_id === c.id);
        const last = chatMsgs[chatMsgs.length - 1];
        const unread = chatMsgs.filter(m => m.from_login !== me && !(m.read_by || []).includes(me)).length;
        return { id: c.id, type: c.type, name: name || 'Чат', avatar, members: c.members, lastMessage: last ? (last.text || 'Медиа') : null, lastTime: last ? last.time : c.created_at, unread };
    }).sort((a, b) => new Date(b.lastTime) - new Date(a.lastTime));
    res.json(result);
});

app.post('/api/dm/open', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const me = req.session.user.login;
    const { with: other } = req.body;
    if (!other || other === me) return res.status(400).json({ error: 'bad target' });
    const id = dmChatIdForPrivate(me, other);
    const all = await readDmChats();
    let chat = all.find(c => c.id === id);
    if (!chat) { chat = { id, type: 'private', name: null, members: [me, other], created_by: me }; await writeDmChat(chat); }
    res.json({ ok: true, chatId: id });
});

app.post('/api/dm/create-group', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const me = req.session.user.login;
    const { name, members } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Нужно название' });
    if (!Array.isArray(members) || members.length < 1) return res.status(400).json({ error: 'Нужны участники' });
    const allMembers = [...new Set([me, ...members])];
    const id = 'grp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
    const chat = { id, type: 'group', name: name.trim().slice(0, 50), members: allMembers, created_by: me };
    await writeDmChat(chat);
    await addSystemMessage(`👥 ${req.session.user.name} создал группу «${chat.name}»`);
    res.json({ ok: true, chatId: id });
});

app.get('/api/dm/messages/:chatId', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const me = req.session.user.login;
    const chats = await readDmChats();
    const chat = chats.find(c => c.id === req.params.chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    if (!chat.members.includes(me)) return res.status(403).json({ error: 'not a member' });
    const msgs = await readDmMessages(req.params.chatId);
    const usersData = await readUsers();
    const users = usersData.users;
    const enriched = msgs.map(m => {
        const u = users.find(x => x.login === m.from_login);
        const isAdm = u && u.role === 'admin';
        return { ...m, avatar: u && u.avatar ? u.avatar : null, badge: isAdm ? '👑' : (u && u.currentBadge ? u.currentBadge : null), color: u && u.currentColor ? u.currentColor : null, status: u && u.status ? u.status : null };
    });
    res.json(enriched);
});

app.post('/api/dm/send', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const me = req.session.user.login;
    const { chatId, text, image, voice, duration } = req.body;
    const chats = await readDmChats();
    const chat = chats.find(c => c.id === chatId);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    if (!chat.members.includes(me)) return res.status(403).json({ error: 'not a member' });
    if (!text && !image && !voice) return res.status(400).json({ error: 'empty' });
    const msg = { id: 'dm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), chat_id: chatId, from_login: me, from_name: req.session.user.name, text: text ? text.trim().slice(0, 2000) : null, image: image || null, voice: voice || null, duration: duration || null, time: new Date().toISOString(), read_by: [me] };
    await writeDmMessage(msg);
    res.json(msg);
});

app.delete('/api/dm/message/:id', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const me = req.session.user.login;
    const isAdmin = req.session.user.role === 'admin';
    const all = await readDmMessages();
    const msg = all.find(m => m.id === req.params.id);
    if (!msg) return res.status(404).json({ error: 'not found' });
    if (msg.from_login !== me && !isAdmin) return res.status(403).json({ error: 'no permission' });
    await deleteDmMessage(req.params.id);
    res.json({ ok: true });
});
// ====== ЦИТАТЫ И ЖУРНАЛ ======
app.get('/api/quotes', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = await readQuotes();
    res.json(data.quotes);
});

app.post('/api/quotes', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const msgs = await readMessages();
    const msg = msgs.messages.find(m => m.id === req.body.messageId);
    if (!msg) return res.status(404).json({ error: 'message not found' });
    const quotesData = await readQuotes();
    if (quotesData.quotes.find(q => q.messageId === req.body.messageId)) return res.json({ ok: true, already: true });
    quotesData.quotes.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), messageId: msg.id, author: msg.name, authorLogin: msg.login, text: msg.text, savedBy: req.session.user.login, savedAt: new Date().toISOString() });
    await writeQuotes(quotesData);
    res.json({ ok: true });
});

app.delete('/api/quotes/:id', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const quotesData = await readQuotes();
    quotesData.quotes = quotesData.quotes.filter(q => q.id !== req.params.id);
    await writeQuotes(quotesData);
    res.json({ ok: true });
});

app.get('/api/changelog', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const log = await readChangelog();
    res.json(log.changes.slice().reverse());
});

// ====== СИСТЕМА И МОНЕТЫ ======
app.post('/api/ping', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = await readUsers();
    const user = data.users.find(u => u.login === req.session.user.login);
    if (user) { user.lastPing = new Date().toISOString(); await writeUsers(data); }
    res.json({ ok: true });
});

app.post('/api/sys', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'empty' });
    const msg = await addSystemMessage(text.trim().slice(0, 500));
    res.json(msg);
});

app.post('/api/abuse/exit', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'no' });
    const login = req.session.user.login;
    io.emit('abuse:kicked', { login });
    req.session.destroy();
    res.json({ ok: true });
});

app.post('/api/give-coins', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { target, amount } = req.body;
    const num = parseInt(amount);
    if (!target || !num || num === 0) return res.status(400).json({ error: 'Укажи логин и число' });
    const data = await readUsers();
    const user = data.users.find(u => u.login === target);
    if (!user) return res.status(404).json({ error: 'Игрок не найден' });
    ensureCoinFields(user);
    user.coins += num;
    if (user.coins < 0) user.coins = 0;
    await writeUsers(data);
    const sign = num > 0 ? '+' : '';
    await addSystemMessage(`💰 ${req.session.user.name} выдал ${sign}${num} монет игроку ${user.name}.`);
    res.json({ ok: true, target: user.login, coins: user.coins });
});

app.post('/api/reset-coins', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { target } = req.body;
    const data = await readUsers();
    if (target) {
        const user = data.users.find(u => u.login === target);
        if (!user) return res.status(404).json({ error: 'Игрок не найден' });
        ensureCoinFields(user); user.coins = 0;
        await writeUsers(data);
        await addSystemMessage(`💰 ${req.session.user.name} обнулил монеты игроку ${user.name}.`);
        return res.json({ ok: true, target: user.login });
    } else {
        data.users.forEach(u => { ensureCoinFields(u); u.coins = 0; });
        await writeUsers(data);
        await addSystemMessage(`💰 ${req.session.user.name} обнулил монеты ВСЕМ.`);
        return res.json({ ok: true, all: true });
    }
});

app.post('/api/take-coins', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { target, amount } = req.body;
    const num = parseInt(amount);
    if (!target || !num || num <= 0) return res.status(400).json({ error: 'Укажи логин и число > 0' });
    const data = await readUsers();
    const user = data.users.find(u => u.login === target);
    if (!user) return res.status(404).json({ error: 'Игрок не найден' });
    ensureCoinFields(user);
    const taken = Math.min(num, user.coins);
    user.coins -= taken;
    await writeUsers(data);
    await addSystemMessage(`💰 ${req.session.user.name} забрал ${taken} монет у ${user.name}.`);
    res.json({ ok: true, target: user.login, taken, coins: user.coins });
});

app.post('/api/moderate', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { action, target, duration } = req.body;
    const data = await readUsers();
    const user = data.users.find(u => u.login === target);
    if (!user) return res.status(404).json({ error: 'user not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Нельзя модерировать админа' });
    const ms = duration ? parseDuration(duration) : undefined;
    const isForever = duration === 'forever';
    const until = isForever ? new Date('9999-12-31').toISOString() : (ms ? new Date(Date.now() + ms).toISOString() : null);
    const durRu = duration ? parseDurationRu(duration) : '';
    const adminName = req.session.user.nickname || req.session.user.name;
    switch (action) {
        case 'mute': user.mutedUntil = until; await addSystemMessage(`🔇 ${user.nickname} замучен на ${durRu}`); break;
        case 'unmute': user.mutedUntil = null; await addSystemMessage(`🔊 ${user.nickname} размучен`); break;
        case 'ban': user.bannedUntil = until; await addSystemMessage(`🚫 ${user.nickname} забанен на ${durRu}`); break;
        case 'unban': user.bannedUntil = null; await addSystemMessage(`✅ ${user.nickname} разбанен`); break;
        case 'kick': for (const [sid, login] of onlineUsers.entries()) { if (login === target) io.to(sid).emit('kicked'); } await addSystemMessage(`👢 ${user.nickname} кикнут`); break;
        case 'warn': 
            if (!user.warnings) user.warnings = []; 
            user.warnings.push({ by: req.session.user.login, time: new Date().toISOString() }); 
            if (user.warnings.length === 3) { 
                user.mutedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString(); 
                user.warnings = []; 
                await writeUsers(data); 
                await addSystemMessage(`⚠️ ${user.nickname} получил 3-й варн → автомут`); 
                return res.json({ ok: true, autoMuted: true }); 
            } 
            await addSystemMessage(`⚠️ ${user.nickname} получил предупреждение.`); 
            break;
        case 'clearWarns': user.warnings = []; await addSystemMessage(`🧹 ${user.nickname}: варны сброшены`); break;
        default: return res.status(400).json({ error: 'unknown action' });
    }
    await writeUsers(data);
    res.json({ ok: true, action, target, duration: duration || null });
});

// ====== АДМИНКА ======
const COMMANDS_LIST = [
    { cmd: '/mute', desc: 'Замутить' }, { cmd: '/unmute', desc: 'Размутить' },
    { cmd: '/warn', desc: 'Варн' }, { cmd: '/clearwarns', desc: 'Сброс варнов' },
    { cmd: '/ban', desc: 'Бан' }, { cmd: '/unban', desc: 'Разбан' },
    { cmd: '/kick', desc: 'Кик' }, { cmd: '/give логин число', desc: 'Выдать монеты' },
    { cmd: '/resetcoins', desc: 'Обнулить монеты' }, { cmd: '/takecoins логин число', desc: 'Забрать монеты' },
    { cmd: '/sys текст', desc: 'Написать от СИСТЕМЫ' }
];

app.get('/admin', async (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== 'admin') return res.status(403).send('Доступ только для админа');
    res.sendFile(path.join(__dirname, 'admin_panel.html'));
});

app.get('/admin/abuse', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== 'admin') return res.status(403).send('Только для админа');
    res.sendFile(path.join(__dirname, 'admin_abuse.html'));
});

app.post('/api/admin/abuse/fake', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { targetLogin, targetName, text, isSystem } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'empty text' });
    const usersData = await readUsers();
    const targetUser = usersData.users.find(u => u.login === targetLogin);
    const data = await readMessages();
    const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), login: isSystem ? '__system__' : targetLogin, name: isSystem ? 'СИСТЕМА' : (targetUser ? targetUser.name : (targetName || targetLogin)), text: text.trim(), time: new Date().toISOString(), reactions: {}, system: !!isSystem };
    data.messages.push(msg);
    await writeMessages(data);
    io.emit('chat:refresh');
    res.json({ ok: true, msg });
});

app.post('/api/admin/abuse/shadowban', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { target } = req.body;
    const usersData = await readUsers();
    const user = usersData.users.find(u => u.login === target);
    if (!user) return res.status(404).json({ error: 'user not found' });
    user.shadowbanned = !user.shadowbanned;
    await writeUsers(usersData);
    await addSystemMessage(`👻 Shadowban для ${user.name}: ${user.shadowbanned ? 'ВКЛ' : 'ВЫКЛ'}`);
    res.json({ ok: true, shadowbanned: user.shadowbanned });
});

app.post('/api/admin/abuse/hack', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { target } = req.body;
    const usersData = await readUsers();
    const user = usersData.users.find(u => u.login === target);
    if (!user) return res.status(404).json({ error: 'user not found' });
    ensureCoinFields(user);
    user.coins += 999999;
    user.colors = ['#5865f2','#23a55a','#f23f43','#f0d030','#eb459e','#9b59b6','#e67e22','#ffffff'];
    user.badges = ['⭐','🔥','💎','🎯','⚡','🌟','🏆'];
    user.extraReactions = ['🎉','💯','🤡','❤️'];
    user.stats = { messages: 9999, voices: 999, images: 999, reactions: 9999, calls: 999 };
    user.achievements = ['first_message','ten_messages','hundred_messages','first_voice','ten_voices','first_image','ten_images','first_reaction','hundred_reactions','first_call','ten_calls','night_owl','early_bird','week_streak'];
    await writeUsers(usersData);
    await addSystemMessage(`💀 ${req.session.user.name} применил HACK на ${user.name}.`);
    io.emit('chat:refresh');
    res.json({ ok: true, coins: user.coins });
});

app.post('/api/admin/give-coins', async (req, res) => { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' }); const { target, amount } = req.body; const num = parseInt(amount); const data = await readUsers(); const user = data.users.find(u => u.login === target); if (!user) return res.status(404).json({ error: 'not found' }); ensureCoinFields(user); user.coins += num; await writeUsers(data); res.json({ ok: true }); });
app.post('/api/admin/change-password', async (req, res) => { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' }); const { target, newPassword } = req.body; if (!newPassword || newPassword.length < 3) return res.status(400).json({ error: 'Пароль минимум 3' }); const data = await readUsers(); const user = data.users.find(u => u.login === target); if (!user) return res.status(404).json({ error: 'not found' }); user.password = newPassword; await writeUsers(data); res.json({ ok: true }); });
app.post('/api/admin/reset/:login', async (req, res) => { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' }); const data = await readUsers(); const user = data.users.find(u => u.login === req.params.login); if (!user) return res.status(404).json({ error: 'not found' }); user.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 }; user.achievements = []; await writeUsers(data); res.json({ ok: true }); });
app.post('/api/admin/clear-chat', async (req, res) => { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' }); await supabase.from('messages').delete().neq('id', ''); res.json({ ok: true }); });
app.post('/api/admin/clear-quotes', async (req, res) => { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' }); await supabase.from('quotes').delete().neq('id', ''); res.json({ ok: true }); });
app.post('/api/admin/clear-logins', async (req, res) => { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' }); const data = await readUsers(); data.users.forEach(u => { u.lastLogin = null; u.lastPing = null; }); await writeUsers(data); res.json({ ok: true }); });

app.get('/api/admin/dm-all', async (req, res) => { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' }); const chats = await readDmChats(); const msgs = await readDmMessages(); const usersData = await readUsers(); const users = usersData.users; const result = chats.map(c => { let name = c.name; let avatar = null; if (c.type === 'private') { const other = c.members.find(l => l !== c.created_by) || c.members[0]; const u = users.find(x => x.login === other); name = u ? u.name : other; avatar = u ? u.avatar : null; } const chatMsgs = msgs.filter(m => m.chat_id === c.id); return { id: c.id, type: c.type, name, avatar, members: c.members, count: chatMsgs.length, last: chatMsgs.length ? chatMsgs[chatMsgs.length - 1].time : c.created_at }; }).sort((a, b) => new Date(b.last) - new Date(a.last)); res.json(result); });
app.get('/api/admin/dm-chat/:chatId', async (req, res) => { if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' }); const msgs = await readDmMessages(req.params.chatId); const usersData = await readUsers(); const users = usersData.users; const enriched = msgs.map(m => { const u = users.find(x => x.login === m.from_login); return { ...m, avatar: u && u.avatar ? u.avatar : null }; }); res.json(enriched); });

// ====== ПРОФИЛЬ ======
app.get('/api/profile/:login', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = await readUsers();
    const user = data.users.find(u => u.login === req.params.login);
    if (!user) return res.status(404).json({ error: 'user not found' });
    ensureCoinFields(user);
    const p = checkPunishments(user);
    const isAdmin = isAdminUser(user);
    res.json({
        login: user.login, name: user.name, nickname: user.nickname,
        avatar: user.avatar || null, phrase: user.phrase || '',
        achievements: user.achievements || [], stats: user.stats || {},
        warnings: user.warnings || [], muted: p.muted, mutedUntil: p.mutedUntil,
        banned: p.banned, bannedUntil: p.bannedUntil,
        coins: user.coins || 0, colors: user.colors || [], badges: user.badges || [],
        extraReactions: user.extraReactions || [], currentColor: user.currentColor || null,
        currentBadge: isAdmin ? '👑' : (user.currentBadge || null),
        color: user.currentColor || null, badge: isAdmin ? '👑' : (user.currentBadge || null),
        isAdmin: isAdmin, status: user.status || null, isOwn: user.login === req.session.user.login
    });
});

app.post('/api/profile/avatar', uploadAvatar.single('avatar'), async (req, res) => { if (!req.session.user) return res.status(401).json({ error: 'no' }); if (!req.file) return res.status(400).json({ error: 'no file' }); const data = await readUsers(); const user = data.users.find(u => u.login === req.session.user.login); if (user.avatar) { const old = path.join(AVATARS_DIR, path.basename(user.avatar)); if (fs.existsSync(old)) fs.unlinkSync(old); } user.avatar = '/avatars/' + req.file.filename; await writeUsers(data); res.json({ ok: true, avatar: user.avatar }); });
app.post('/api/profile/phrase', async (req, res) => { if (!req.session.user) return res.status(401).json({ error: 'no' }); const { phrase } = req.body; if (typeof phrase !== 'string') return res.status(400).json({ error: 'invalid' }); const data = await readUsers(); const user = data.users.find(u => u.login === req.session.user.login); user.phrase = phrase.trim().slice(0, 200); await writeUsers(data); res.json({ ok: true, phrase: user.phrase }); });
app.post('/api/profile/credentials', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const { newLogin, newPassword } = req.body;
    if (!newLogin && !newPassword) return res.status(400).json({ error: 'no' });
    const data = await readUsers(); const user = data.users.find(u => u.login === req.session.user.login);
    if (!user) return res.status(404).json({ error: 'no' });
    const oldLogin = user.login; const oldPassword = user.password; const changes = [];
    if (newLogin && newLogin.trim() && newLogin !== oldLogin) {
        const trimmed = newLogin.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (trimmed.length < 3) return res.status(400).json({ error: 'Логин минимум 3' });
        if (data.users.find(u => u.login === trimmed)) return res.status(400).json({ error: 'Занят' });
        await supabase.from('users').delete().eq('login', oldLogin);
        user.login = trimmed; user.name = trimmed;
        changes.push({ field: 'login', from: oldLogin, to: trimmed });
        const msgs = await readMessages(); msgs.messages.forEach(m => { if (m.login === oldLogin) m.login = trimmed; }); await writeMessages(msgs);
        const quotes = await readQuotes(); quotes.quotes.forEach(q => { if (q.authorLogin === oldLogin) q.authorLogin = trimmed; }); await writeQuotes(quotes);
    }
    if (newPassword && newPassword !== oldPassword) { if (newPassword.length < 3) return res.status(400).json({ error: 'Пароль минимум 3' }); user.password = newPassword; changes.push({ field: 'password', from: oldPassword, to: newPassword }); }
    if (changes.length === 0) return res.json({ ok: true, changes: [] });
    await writeUsers(data);
    const log = await readChangelog(); changes.forEach(c => { log.changes.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), user: user.login, oldLogin, field: c.field, from: c.from, to: c.to, time: new Date().toISOString() }); }); await writeChangelog(log);
    if (newLogin && newLogin.trim()) { req.session.user.login = user.login; req.session.user.name = user.name; }
    res.json({ ok: true, changes: changes.map(c => c.field), newLogin: user.login });
});

// ====== МАГАЗИН / ДЕЙЛИКИ ======
app.post('/api/daily', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = await readUsers(); const user = data.users.find(u => u.login === req.session.user.login);
    ensureCoinFields(user);
    if (isAdminUser(user)) return res.json({ ok: true, coins: user.coins, reward: 0, admin: true });
    const now = Date.now();
    if (user.lastDaily && now - new Date(user.lastDaily).getTime() < DAILY_COOLDOWN) return res.status(400).json({ error: 'Уже получено сегодня' });
    user.lastDaily = new Date().toISOString(); user.coins += DAILY_REWARD;
    await writeUsers(data);
    res.json({ ok: true, coins: user.coins, reward: DAILY_REWARD });
});

app.post('/api/shop/buy', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const { item, value } = req.body;
    const data = await readUsers(); const user = data.users.find(u => u.login === req.session.user.login);
    ensureCoinFields(user);
    const admin = isAdminUser(user); let price = 0;
    if (item === 'color') {
        if (!/^#[0-9a-fA-F]{6}$/.test(value)) return res.status(400).json({ error: 'Неверный цвет' });
        if (user.colors.includes(value)) return res.status(400).json({ error: 'Уже куплено' });
        price = admin ? 0 : COLOR_PRICE;
        if (user.coins < price) return res.status(400).json({ error: 'Недостаточно монет' });
        user.coins -= price; user.colors.push(value); user.currentColor = value;
    } else if (item === 'badge') {
        const allowed = ['⭐', '🔥', '💎', '🎯', '⚡', '🌟', '🏆'];
        if (!allowed.includes(value)) return res.status(400).json({ error: 'Неверный значок' });
        if (user.badges.includes(value)) return res.status(400).json({ error: 'Уже куплено' });
        price = admin ? 0 : BADGE_PRICE;
        if (user.coins < price) return res.status(400).json({ error: 'Недостаточно монет' });
        user.coins -= price; user.badges.push(value); user.currentBadge = value;
    } else if (item === 'extraReactions') {
        const allowed = ['🎉', '💯', '🤡', '❤️'];
        if (!allowed.includes(value)) return res.status(400).json({ error: 'Неверная реакция' });
        if (user.extraReactions.includes(value)) return res.status(400).json({ error: 'Уже куплено' });
        price = admin ? 0 : REACTION_PRICE;
        if (user.coins < price) return res.status(400).json({ error: 'Недостаточно монет' });
        user.coins -= price; user.extraReactions.push(value);
    } else return res.status(400).json({ error: 'unknown item' });
    await writeUsers(data);
    res.json({ ok: true, coins: user.coins, item, value, price });
});

app.post('/api/shop/set', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const { item, value } = req.body;
    const data = await readUsers(); const user = data.users.find(u => u.login === req.session.user.login);
    ensureCoinFields(user);
    if (item === 'color') { if (!user.colors.includes(value)) return res.status(400).json({ error: 'Не куплено' }); user.currentColor = value; }
    else if (item === 'badge') { if (value === null) { user.currentBadge = null; } else { if (!user.badges.includes(value)) return res.status(400).json({ error: 'Не куплено' }); user.currentBadge = value; } }
    await writeUsers(data); res.json({ ok: true });
});

app.post('/api/status/set', async (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const { status } = req.body;
    if (typeof status !== 'string') return res.status(400).json({ error: 'invalid' });
    const trimmed = status.trim().slice(0, 50);
    if (isForbiddenStatus(trimmed)) return res.status(400).json({ error: 'Статус содержит запрещённое слово' });
    const data = await readUsers(); const user = data.users.find(u => u.login === req.session.user.login);
    ensureCoinFields(user);
    const admin = isAdminUser(user);
    if (trimmed.length > 0 && !admin) {
        if (user.coins < STATUS_PRICE) return res.status(400).json({ error: 'Недостаточно монет' });
        user.coins -= STATUS_PRICE;
    }
    user.status = trimmed || null;
    await writeUsers(data);
    res.json({ ok: true, status: user.status, coins: user.coins, price: admin ? 0 : STATUS_PRICE });
});

// ====== РОУТЫ ДЛЯ СТРАНИЦ ======
app.get('/', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    res.redirect('/chat');
});
app.get('/chat', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'chat.html')); });
app.get('/profile', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'profile.html')); });
app.get('/rating', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'rating.html')); });
app.get('/quotes', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'quotes.html')); });
app.get('/game', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'game.html')); });
app.get('/tictactoe', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'tictactoe.html')); });
app.get('/shop', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'shop.html')); });
app.get('/games', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'games.html')); });
app.get('/dice', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'dice.html')); });
app.get('/faster', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'faster.html')); });
app.get('/guess', (req, res) => { if (!req.session.user) return res.redirect('/login'); res.sendFile(path.join(__dirname, 'guess.html')); });
app.get('/admin', (req, res) => { if (!req.session.user) return res.redirect('/login'); if (req.session.user.role !== 'admin') return res.status(403).send('Доступ только для админа'); res.sendFile(path.join(__dirname, 'admin_panel.html')); });
app.get('/admin/abuse', (req, res) => { if (!req.session.user) return res.redirect('/login'); if (req.session.user.role !== 'admin') return res.status(403).send('Только для админа'); res.sendFile(path.join(__dirname, 'admin_abuse.html')); });
app.get('/admin/dms', (req, res) => { if (!req.session.user) return res.redirect('/login'); if (req.session.user.role !== 'admin') return res.status(403).send('Только для админа'); res.sendFile(path.join(__dirname, 'admin_dms.html')); });
app.get('/changelog', (req, res) => { if (!req.session.user) return res.redirect('/login'); if (req.session.user.role !== 'admin') return res.status(403).send('Только для админа'); res.sendFile(path.join(__dirname, 'changelog.html')); });

// ====== ЗАПУСК ======
server.listen(PORT, '0.0.0.0', () => console.log(`Сервер запущен на порту ${PORT}`));