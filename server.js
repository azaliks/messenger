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
async function readUsers() {
    const { data, error } = await supabase.from('users').select('data');
    if (error) { console.error('readUsers error:', error); return { users: [] }; }
    return { users: data.map(r => r.data) };
}
async function writeUsers(d) {
    const rows = d.users.map(u => ({ login: u.login, data: u, updated_at: new Date().toISOString() }));
    const { error } = await supabase.from('users').upsert(rows, { onConflict: 'login' });
    if (error) console.error('writeUsers error:', error);
}
async function readMessages() {
    const { data, error } = await supabase.from('messages').select('data').order('created_at', { ascending: true });
    if (error) return { messages: [] };
    return { messages: data.map(r => r.data) };
}
async function writeMessages(d) {
    const { data: existing } = await supabase.from('messages').select('id');
    const existingIds = new Set((existing || []).map(r => r.id));
    const newIds = new Set(d.messages.map(m => m.id));
    const toDelete = [...existingIds].filter(id => !newIds.has(id));
    if (toDelete.length) await supabase.from('messages').delete().in('id', toDelete);
    if (d.messages.length) {
        const rows = d.messages.map(m => ({ id: m.id, data: m, created_at: m.time || new Date().toISOString() }));
        await supabase.from('messages').upsert(rows, { onConflict: 'id' });
    }
}
async function readQuotes() {
    const { data, error } = await supabase.from('quotes').select('data').order('created_at', { ascending: true });
    if (error) return { quotes: [] };
    return { quotes: data.map(r => r.data) };
}
async function writeQuotes(d) {
    const { data: existing } = await supabase.from('quotes').select('id');
    const existingIds = new Set((existing || []).map(r => r.id));
    const newIds = new Set(d.quotes.map(q => q.id));
    const toDelete = [...existingIds].filter(id => !newIds.has(id));
    if (toDelete.length) await supabase.from('quotes').delete().in('id', toDelete);
    if (d.quotes.length) {
        const rows = d.quotes.map(q => ({ id: q.id, data: q, created_at: q.savedAt || new Date().toISOString() }));
        await supabase.from('quotes').upsert(rows, { onConflict: 'id' });
    }
}
async function readDmChats() {
    const { data, error } = await supabase.from('dm_chats').select('*');
    if (error) { console.error('readDmChats:', error); return []; }
    return data.map(r => ({ id: r.id, type: r.type, name: r.name, members: r.members, created_at: r.created_at, created_by: r.created_by }));
}
async function writeDmChat(chat) {
    await supabase.from('dm_chats').upsert({
        id: chat.id, type: chat.type, name: chat.name || null, members: chat.members, created_by: chat.created_by || null
    }, { onConflict: 'id' });
}
async function readDmMessages(chatId) {
    let q = supabase.from('dm_messages').select('*').order('time', { ascending: true });
    if (chatId) q = q.eq('chat_id', chatId);
    const { data, error } = await q;
    if (error) { console.error('readDmMessages:', error); return []; }
    return data;
}
async function writeDmMessage(msg) {
    await supabase.from('dm_messages').upsert({
        id: msg.id, chat_id: msg.chat_id, from_login: msg.from_login, from_name: msg.from_name,
        text: msg.text || null, image: msg.image || null, voice: msg.voice || null, duration: msg.duration || null,
        time: msg.time, read_by: msg.read_by || []
    }, { onConflict: 'id' });
}
async function deleteDmMessage(id) { await supabase.from('dm_messages').delete().eq('id', id); }
function dmChatIdForPrivate(a, b) { return 'dm-' + [a, b].sort().join('-'); }

async function readChangelog() {
    const { data, error } = await supabase.from('changelog').select('data').order('created_at', { ascending: true });
    if (error) return { changes: [] };
    return { changes: data.map(r => r.data) };
}
async function writeChangelog(d) {
    const { data: existing } = await supabase.from('changelog').select('id');
    const existingIds = new Set((existing || []).map(r => r.id));
    const newIds = new Set(d.changes.map(c => c.id));
    const toDelete = [...existingIds].filter(id => !newIds.has(id));
    if (toDelete.length) await supabase.from('changelog').delete().in('id', toDelete);
    if (d.changes.length) {
        const rows = d.changes.map(c => ({ id: c.id, data: c, created_at: c.time || new Date().toISOString() }));
        await supabase.from('changelog').upsert(rows, { onConflict: 'id' });
    }
}

async function addSystemMessage(text) {
    const data = await readMessages();
    const msg = { id: 'sys-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), login: '__system__', name: 'СИСТЕМА', text: text, time: new Date().toISOString(), reactions: {}, system: true };
    data.messages.push(msg);
    await writeMessages(data);
    return msg;
}

function checkPunishments(user) {
    if (!user) return { muted: false, banned: false };
    const now = Date.now();
    let changed = false;
    let result = { muted: false, banned: false, mutedUntil: null, bannedUntil: null };
    if (user.mutedUntil) {
        if (new Date(user.mutedUntil).getTime() > now) { result.muted = true; result.mutedUntil = user.mutedUntil; }
        else { user.mutedUntil = null; changed = true; }
    }
    if (user.bannedUntil) {
        if (new Date(user.bannedUntil).getTime() > now) { result.banned = true; result.bannedUntil = user.bannedUntil; }
        else { user.bannedUntil = null; changed = true; }
    }
    return { ...result, changed };
}

function parseDuration(str) {
    const map = { '5m': 5*60*1000, '15m': 15*60*1000, '1h': 60*60*1000, '1d': 24*60*60*1000, '7d': 7*24*60*60*1000, 'forever': null };
    return map[str] !== undefined ? map[str] : undefined;
}
function parseDurationRu(str) {
    const map = { '5m': '5 минут', '15m': '15 минут', '1h': '1 час', '1d': '1 день', '7d': '7 дней', 'forever': 'навсегда' };
    return map[str] || str;
}

async function checkAchievements(login) {
    const users = await readUsers();
    const user = users.users.find(u => u.login === login);
    if (!user) return [];
    if (!user.achievements) user.achievements = [];
    if (!user.stats) user.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 };
    const newOnes = [];
    const add = (k) => { if (!user.achievements.includes(k)) { user.achievements.push(k); newOnes.push(k); } };
    const s = user.stats;
    if (s.messages >= 1) add('first_message');
    if (s.messages >= 10) add('ten_messages');
    if (s.messages >= 100) add('hundred_messages');
    if (s.voices >= 1) add('first_voice');
    if (s.voices >= 10) add('ten_voices');
    if (s.images >= 1) add('first_image');
    if (s.images >= 10) add('ten_images');
    if (s.reactions >= 1) add('first_reaction');
    if (s.reactions >= 100) add('hundred_reactions');
    if (s.calls >= 1) add('first_call');
    if (s.calls >= 10) add('ten_calls');
    const hour = new Date().getHours();
    if (hour >= 3 && hour < 5) add('night_owl');
    if (hour >= 5 && hour < 7) add('early_bird');
    await writeUsers(users);
    return newOnes;
}

const DAILY_REWARD = 10;
const DAILY_COOLDOWN = 24 * 60 * 60 * 1000;
const DUEL_REWARD = 20;
const COLOR_PRICE = 50;
const BADGE_PRICE = 30;
const STATUS_PRICE = 10;
const REACTION_PRICE = 20;
const FORBIDDEN_STATUS_WORDS = ['админ', 'admin', 'azaliks', 'система', 'system'];

function ensureCoinFields(user) {
    if (typeof user.coins !== 'number') user.coins = 0;
    if (!user.lastDaily) user.lastDaily = null;
    if (!user.lastDuelReward) user.lastDuelReward = null;
    if (!Array.isArray(user.colors)) user.colors = [];
    if (!Array.isArray(user.badges)) user.badges = [];
    if (!user.currentColor) user.currentColor = null;
    if (!user.currentBadge) user.currentBadge = null;
    if (!user.status) user.status = null;
    if (!Array.isArray(user.extraReactions)) user.extraReactions = [];
    if (typeof user.isAdmin === 'undefined') user.isAdmin = (user.role === 'admin');
}
function isForbiddenStatus(text) {
    if (!text) return false;
    const low = text.toLowerCase();
    return FORBIDDEN_STATUS_WORDS.some(w => low.includes(w));
}
function isAdminUser(user) { return user && (user.role === 'admin' || user.isAdmin === true); }

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const sessionMiddleware = session({ secret: 'pacan-secret-key', resave: false, saveUninitialized: false });
app.use(sessionMiddleware);
app.use(express.static(__dirname));

app.get('/manifest.json', (req, res) => { res.setHeader('Content-Type', 'application/manifest+json'); res.sendFile(path.join(__dirname, 'manifest.json')); });
app.get('/sw.js', (req, res) => { res.setHeader('Content-Type', 'application/javascript'); res.setHeader('Service-Worker-Allowed', '/'); res.sendFile(path.join(__dirname, 'sw.js')); });
app.use('/avatars', express.static(AVATARS_DIR));
app.use('/voice', express.static(VOICE_DIR));
app.use('/images', express.static(IMAGES_DIR));
io.engine.use(sessionMiddleware);

const onlineUsers = new Map();
const duelInvites = new Map();
const tttInvites = new Map();

io.on('connection', (socket) => {
    const user = socket.request.session && socket.request.session.user;
    if (!user) { socket.disconnect(); return; }
    onlineUsers.set(socket.id, user.login);
    io.emit('online', Array.from(onlineUsers.values()));

    // ==== ДУЭЛЬ ====
    socket.on('duel:invite', async ({ to }) => {
        const targetSocketId = [...onlineUsers.entries()].find(([, login]) => login === to)?.[0];
        if (!targetSocketId) { socket.emit('duel:offline', { to }); return; }
        const key = `${user.login}:${to}`;
        duelInvites.set(key, Date.now());
        await addSystemMessage(`⚔️ ${user.name} вызывает ${to} на битву копейщиков! ${to}, зайди в /game и вызови ${user.name} в ответ.`);
        io.emit('chat:refresh');
        const reverseKey = `${to}:${user.login}`;
        if (duelInvites.has(reverseKey)) {
            duelInvites.delete(key); duelInvites.delete(reverseKey);
            await addSystemMessage(`⚔️ Битва началась: ${user.login} vs ${to}!`);
            io.emit('chat:refresh');
            const hostSocketId = [...onlineUsers.entries()].find(([, login]) => login === user.login)?.[0];
            const clientSocketId = [...onlineUsers.entries()].find(([, login]) => login === to)?.[0];
            if (hostSocketId) io.to(hostSocketId).emit('duel:start', { youAreHost: true, opponentLogin: to });
            if (clientSocketId) io.to(clientSocketId).emit('duel:start', { youAreHost: false, opponentLogin: user.login });
        }
    });
    socket.on('duel:state', ({ to, state }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('duel:state', { state }); });
    socket.on('duel:end', async ({ to, winnerLogin, winnerName, loserName }) => {
        const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0];
        if (t) io.to(t).emit('duel:ended', { winnerName, loserName });
        const usersData = await readUsers();
        const winner = usersData.users.find(u => u.login === winnerLogin);
        let rewardText = '';
        if (winner && !isAdminUser(winner)) {
            ensureCoinFields(winner);
            const now = Date.now();
            if (!winner.lastDuelReward || now - new Date(winner.lastDuelReward).getTime() > DAILY_COOLDOWN) {
                winner.coins += DUEL_REWARD;
                winner.lastDuelReward = new Date().toISOString();
                rewardText = ` (+${DUEL_REWARD} монет)`;
            }
        }
        await writeUsers(usersData);
        await addSystemMessage(`⚔️ ${winnerName} победил ${loserName} в битве копейщиков!${rewardText}`);
        io.emit('chat:refresh');
    });
    socket.on('duel:leave', ({ to }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('duel:opponentLeft', { byName: user.name }); });

    // ==== КРЕСТИКИ-НОЛИКИ ====
    socket.on('ttt:invite', async ({ to }) => {
        const targetSocketId = [...onlineUsers.entries()].find(([, login]) => login === to)?.[0];
        if (!targetSocketId) { socket.emit('ttt:offline', { to }); return; }
        const key = `${user.login}:${to}`;
        tttInvites.set(key, Date.now());
        await addSystemMessage(`⭕ ${user.name} вызывает ${to} в крестики-нолики! ${to}, зайди в /tictactoe и вызови в ответ.`);
        io.emit('chat:refresh');
        const reverseKey = `${to}:${user.login}`;
        if (tttInvites.has(reverseKey)) {
            tttInvites.delete(key); tttInvites.delete(reverseKey);
            await addSystemMessage(`❌ Началась игра в крестики-нолики: ${user.login} vs ${to}!`);
            io.emit('chat:refresh');
            const hostSocketId = [...onlineUsers.entries()].find(([, login]) => login === user.login)?.[0];
            const clientSocketId = [...onlineUsers.entries()].find(([, login]) => login === to)?.[0];
            if (hostSocketId) io.to(hostSocketId).emit('ttt:start', { youAreHost: true, opponentLogin: to, yourSymbol: 'X' });
            if (clientSocketId) io.to(clientSocketId).emit('ttt:start', { youAreHost: false, opponentLogin: user.login, yourSymbol: 'O' });
        }
    });
    socket.on('ttt:move', ({ to, board, nextTurn }) => {
        const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0];
        if (t) io.to(t).emit('ttt:state', { board, nextTurn });
    });
    socket.on('ttt:end', async ({ to, winnerName, loserName, draw }) => {
        const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0];
        if (t) io.to(t).emit('ttt:ended', { winnerName, loserName, draw });
        if (draw) await addSystemMessage(`🤝 Ничья в крестиках-ноликах: ${winnerName} vs ${loserName}`);
        else await addSystemMessage(`🏆 ${winnerName} победил ${loserName} в крестиках-ноликах!`);
        io.emit('chat:refresh');
    });
    socket.on('ttt:leave', ({ to }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('ttt:opponentLeft', { byName: user.name }); });

    // ==== УВЕДОМЛЕНИЯ ====
    socket.on('dm:notify', ({ to }) => {
        const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0];
        if (t) io.to(t).emit('dm:new', { from: user.login });
    });

    // ==== ТАЙПЕР ====
    socket.on('typing', ({ chatId }) => {
        socket.broadcast.emit('user:typing', { login: user.login, name: user.name, chatId });
    });

    // ==== ЗВОНКИ ====
    socket.on('call:offer', ({ to, offer }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:incoming', { from: user.login, fromName: user.name, offer }); else socket.emit('call:offline', { to }); });
    socket.on('call:answer', ({ to, answer }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:answered', { answer }); });
    socket.on('call:ice', ({ to, candidate }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:ice', { candidate }); });
    socket.on('call:end', ({ to }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:ended'); });
    socket.on('call:reject', ({ to }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:rejected'); });

    // ==== АБЬЮЗЫ ====
    socket.on('admin:start-abuse', ({ target }) => {
        const u = socket.request.session && socket.request.session.user;
        if (!u || u.role !== 'admin') return;
        if (target === 'all') io.emit('abuse:a90-start');
        else {
            const targetSocketId = [...onlineUsers.entries()].find(([, login]) => login === target)?.[0];
            if (targetSocketId) { io.to(targetSocketId).emit('abuse:a90-start'); socket.emit('abuse:a90-start'); }
        }
    });
    socket.on('admin:shock', ({ target }) => {
        const u = socket.request.session && socket.request.session.user;
        if (!u || u.role !== 'admin') return;
        if (target === 'all') io.emit('abuse:shock');
        else {
            const targetSocketId = [...onlineUsers.entries()].find(([, login]) => login === target)?.[0];
            if (targetSocketId) { io.to(targetSocketId).emit('abuse:shock'); socket.emit('abuse:shock'); }
        }
    });
    socket.on('admin:kick', ({ target }) => {
        const u = socket.request.session && socket.request.session.user;
        if (!u || u.role !== 'admin') return;
        const targetSocketId = [...onlineUsers.entries()].find(([, login]) => login === target)?.[0];
        if (targetSocketId) io.to(targetSocketId).emit('abuse:kicked', { login: target });
    });
    // Новые абьюзы
    socket.on('admin:explode', ({ target }) => {
        if (socket.request.session.user.role !== 'admin') return;
        if (target === 'all') io.emit('abuse:explode');
        else { const sid = [...onlineUsers.entries()].find(([, l]) => l === target)?.[0]; if (sid) io.to(sid).emit('abuse:explode'); }
    });
    socket.on('admin:music', ({ target }) => {
        if (socket.request.session.user.role !== 'admin') return;
        if (target === 'all') io.emit('abuse:music');
        else { const sid = [...onlineUsers.entries()].find(([, l]) => l === target)?.[0]; if (sid) io.to(sid).emit('abuse:music'); }
    });
    socket.on('admin:flip', ({ target }) => {
        if (socket.request.session.user.role !== 'admin') return;
        if (target === 'all') io.emit('abuse:flip');
        else { const sid = [...onlineUsers.entries()].find(([, l]) => l === target)?.[0]; if (sid) io.to(sid).emit('abuse:flip'); }
    });

    socket.on('disconnect', () => { onlineUsers.delete(socket.id); io.emit('online', Array.from(onlineUsers.values())); });
});

// ... (API для логина, регистрации, профилей, сообщений, чатов и т.д. — они остались прежними, я не буду их дублировать, так как они занимают много места. В твоём файле они уже есть, просто добавь новые маршруты, которые ниже).

// ====== НОВЫЕ API ДЛЯ АДМИНКИ ======
app.post('/api/admin/give-coins', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { target, amount } = req.body;
    const num = parseInt(amount);
    const data = await readUsers();
    const user = data.users.find(u => u.login === target);
    if (!user) return res.status(404).json({ error: 'not found' });
    ensureCoinFields(user);
    user.coins += num;
    await writeUsers(data);
    res.json({ ok: true });
});

app.post('/api/admin/change-password', async (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { target, newPassword } = req.body;
    if (!newPassword || newPassword.length < 3) return res.status(400).json({ error: 'Пароль минимум 3 символа' });
    const data = await readUsers();
    const user = data.users.find(u => u.login === target);
    if (!user) return res.status(404).json({ error: 'not found' });
    user.password = newPassword;
    await writeUsers(data);
    res.json({ ok: true });
});

// ... (Остальные маршруты как были)
// ====== РОУТЫ ДЛЯ СТРАНИЦ ======
app.get('/', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    res.redirect('/chat');
});

app.get('/login', (req, res) => { res.sendFile(path.join(__dirname, 'login.html')); });
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

app.get('/admin', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== 'admin') return res.status(403).send('Доступ только для админа');
    res.sendFile(path.join(__dirname, 'admin_panel.html'));
});
app.get('/admin/abuse', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== 'admin') return res.status(403).send('Только для админа');
    res.sendFile(path.join(__dirname, 'admin_abuse.html'));
});
app.get('/admin/dms', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== 'admin') return res.status(403).send('Только для админа');
    res.sendFile(path.join(__dirname, 'admin_dms.html'));
});
app.get('/changelog', (req, res) => { 
    if (!req.session.user) return res.redirect('/login'); 
    if (req.session.user.role !== 'admin') return res.status(403).send('Только для админа'); 
    res.sendFile(path.join(__dirname, 'changelog.html')); 
});
server.listen(PORT, '0.0.0.0', () => console.log(`Сервер запущен на порту ${PORT}`));