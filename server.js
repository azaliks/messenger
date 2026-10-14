const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const TURN_USERNAME = '07354b48071e5473f623d7a9';
const TURN_CREDENTIAL = 'p9aioMeZ5mqY2lhl';

const AVATARS_DIR = path.join(__dirname, 'avatars');
const VOICE_DIR = path.join(__dirname, 'voice');
const IMAGES_DIR = path.join(__dirname, 'images');
[AVATARS_DIR, VOICE_DIR, IMAGES_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const uploadAvatar = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, AVATARS_DIR), filename: (req, file, cb) => cb(null, req.session.user.login + '-' + Date.now() + path.extname(file.originalname).toLowerCase()) }) });
const uploadVoice = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, VOICE_DIR), filename: (req, file, cb) => cb(null, 'voice-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + (path.extname(file.originalname) || '.webm')) }) });
const uploadImage = multer({ storage: multer.diskStorage({ destination: (req, file, cb) => cb(null, IMAGES_DIR), filename: (req, file, cb) => cb(null, 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + path.extname(file.originalname).toLowerCase()) }), limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, ['image/jpeg','image/png','image/gif','image/webp'].includes(file.mimetype)) });

function readUsers() { return JSON.parse(fs.readFileSync('users.json', 'utf-8')); }
function writeUsers(d) { fs.writeFileSync('users.json', JSON.stringify(d, null, 2), 'utf-8'); }
function readMessages() { return JSON.parse(fs.readFileSync('messages.json', 'utf-8')); }
function writeMessages(d) { fs.writeFileSync('messages.json', JSON.stringify(d, null, 2), 'utf-8'); }
function readChangelog() { return JSON.parse(fs.readFileSync('changelog.json', 'utf-8')); }
function writeChangelog(d) { fs.writeFileSync('changelog.json', JSON.stringify(d, null, 2), 'utf-8'); }

function addSystemMessage(text) {
    const data = readMessages();
    const msg = { id: 'sys-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), login: '__system__', name: 'СИСТЕМА', text: text, time: new Date().toISOString(), reactions: {}, system: true };
    data.messages.push(msg);
    writeMessages(data);
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

function checkAchievements(login) {
    const users = readUsers();
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
    writeUsers(users);
    return newOnes;
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const sessionMiddleware = session({ secret: 'pacan-secret-key', resave: false, saveUninitialized: false });
app.use(sessionMiddleware);
app.use(express.static(__dirname));
app.use('/avatars', express.static(AVATARS_DIR));
app.use('/voice', express.static(VOICE_DIR));
app.use('/images', express.static(IMAGES_DIR));
io.engine.use(sessionMiddleware);

// ==== Онлайн и вызовы ====
const onlineUsers = new Map();       // socket.id -> login
const duelInvites = new Map();       // "from:to" -> true (кто кого вызвал)

io.on('connection', (socket) => {
    const user = socket.request.session && socket.request.session.user;
    if (!user) { socket.disconnect(); return; }
    onlineUsers.set(socket.id, user.login);
    io.emit('online', Array.from(onlineUsers.values()));

    // ==== ДУЭЛЬ ====
    socket.on('duel:invite', ({ to }) => {
        const targetSocketId = [...onlineUsers.entries()].find(([, login]) => login === to)?.[0];
        if (!targetSocketId) { socket.emit('duel:offline', { to }); return; }

        const key = `${user.login}:${to}`;
        duelInvites.set(key, Date.now());

        // Системное сообщение в чат
        addSystemMessage(`⚔️ ${user.name} вызывает ${to} на битву копейщиков! ${to}, зайди в /game и вызови ${user.name} в ответ.`);
        io.emit('chat:refresh');

        // Проверим, ответный вызов уже есть?
        const reverseKey = `${to}:${user.login}`;
        if (duelInvites.has(reverseKey)) {
            // Оба вызвали друг друга — старт!
            duelInvites.delete(key);
            duelInvites.delete(reverseKey);

            addSystemMessage(`⚔️ Битва началась: ${user.login} vs ${to}!`);
            io.emit('chat:refresh');

            // Кто хост? Первый, кто вызвал — тот, чей ключ был создан раньше. Оба равны — берём юзера.
            const hostLogin = user.login;
            const clientLogin = to;

            // Шлём host сигнал
            const hostSocketId = [...onlineUsers.entries()].find(([, login]) => login === hostLogin)?.[0];
            const clientSocketId = [...onlineUsers.entries()].find(([, login]) => login === clientLogin)?.[0];

            if (hostSocketId) io.to(hostSocketId).emit('duel:start', { youAreHost: true, opponentLogin: clientLogin });
            if (clientSocketId) io.to(clientSocketId).emit('duel:start', { youAreHost: false, opponentLogin: hostLogin });
        }
    });

    socket.on('duel:state', ({ to, state }) => {
        const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0];
        if (t) io.to(t).emit('duel:state', { state });
    });

    socket.on('duel:end', ({ to, winnerName, loserName }) => {
        const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0];
        if (t) io.to(t).emit('duel:ended', { winnerName, loserName });
        addSystemMessage(`⚔️ ${winnerName} победил ${loserName} в битве копейщиков!`);
        io.emit('chat:refresh');
    });

    socket.on('duel:leave', ({ to }) => {
        const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0];
        if (t) io.to(t).emit('duel:opponentLeft', { byName: user.name });
    });

    // ==== ЗВОНКИ ====
    socket.on('call:offer', ({ to, offer }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:incoming', { from: user.login, fromName: user.name, offer }); else socket.emit('call:offline', { to }); });
    socket.on('call:answer', ({ to, answer }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:answered', { answer }); });
    socket.on('call:ice', ({ to, candidate }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:ice', { candidate }); });
    socket.on('call:end', ({ to }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:ended'); });
    socket.on('call:reject', ({ to }) => { const t = [...onlineUsers.entries()].find(([, l]) => l === to)?.[0]; if (t) io.to(t).emit('call:rejected'); });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        io.emit('online', Array.from(onlineUsers.values()));
    });
});

app.get('/api/turn', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    res.json({ iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: ['turn:global.relay.metered.ca:80','turn:global.relay.metered.ca:80?transport=tcp','turn:global.relay.metered.ca:443','turns:global.relay.metered.ca:443?transport=tcp'], username: TURN_USERNAME, credential: TURN_CREDENTIAL }
    ]});
});

app.get('/login', (req, res) => {
    let errorMsg = '';
    if (req.query.error === '1') errorMsg = 'Неверный логин или пароль';
    if (req.query.error === 'banned') errorMsg = '🚫 Ты забанен. Обратись к админу.';
    res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Вход</title><style>
        * { box-sizing: border-box; }
        body { font-family: "gg sans","Helvetica Neue",Helvetica,Arial,sans-serif; background:#313338; color:#dbdee1; margin:0; height:100vh; display:flex; justify-content:center; align-items:center; padding:20px; }
        form { background:#313338; padding:32px; border-radius:8px; width:100%; max-width:420px; text-align:center; }
        h2 { color:#f2f3f5; font-size:24px; font-weight:600; margin:0 0 8px; }
        .sub { color:#b5bac1; font-size:15px; margin-bottom:24px; }
        label { display:block; text-align:left; color:#b5bac1; font-size:12px; font-weight:700; text-transform:uppercase; margin-bottom:8px; margin-top:16px; }
        input { width:100%; padding:12px; background:#1e1f22; border:none; border-radius:4px; color:#dbdee1; font-family:inherit; font-size:15px; outline:none; }
        input:focus { outline:2px solid #5865f2; }
        button { width:100%; padding:12px; margin-top:24px; background:#5865f2; color:white; border:none; border-radius:4px; cursor:pointer; font-family:inherit; font-size:16px; font-weight:600; }
        button:hover { background:#4752c4; }
        .error { color:#fa777c; font-size:14px; margin-top:12px; min-height:20px; }
    </style></head><body><form method="POST" action="/login">
        <h2>С возвращением!</h2><p class="sub">Вход только для своих</p>
        <label for="login">Логин</label><input type="text" id="login" name="login" placeholder="Введи логин" required autofocus>
        <label for="password">Пароль</label><input type="password" id="password" name="password" placeholder="Введи пароль" required>
        <button type="submit">Войти</button>
        <p class="error">${errorMsg}</p>
    </form></body></html>`);
});

app.post('/login', (req, res) => {
    const { login, password } = req.body;
    const data = readUsers();
    const user = data.users.find(u => u.login === login && u.password === password);
    if (!user) return res.redirect('/login?error=1');
    const p = checkPunishments(user);
    if (p.changed) writeUsers(data);
    if (p.banned) return res.redirect('/login?error=banned');
    user.lastLogin = new Date().toISOString();
    writeUsers(data);
    req.session.user = { login: user.login, name: user.name, nickname: user.nickname, role: user.role };
    if (user.role === 'admin') return res.redirect('/admin');
    res.redirect('/');
});

app.get('/api/me', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const user = readUsers().users.find(u => u.login === req.session.user.login);
    if (!user) return res.status(404).json({ error: 'user not found' });
    const p = checkPunishments(user);
    res.json({ login: user.login, name: user.name, nickname: user.nickname, role: user.role, avatar: user.avatar || null, phrase: user.phrase || '', achievements: user.achievements || [], stats: user.stats || {}, warnings: user.warnings || [], muted: p.muted, mutedUntil: p.mutedUntil });
});

app.post('/api/ping', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = readUsers();
    const user = data.users.find(u => u.login === req.session.user.login);
    if (!user) return res.status(404).json({ error: 'user not found' });
    user.lastPing = new Date().toISOString();
    writeUsers(data);
    res.json({ ok: true });
});

app.get('/api/users', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    res.json(readUsers().users.map(u => ({ login: u.login, name: u.name, avatar: u.avatar || null })));
});

app.get('/api/rating', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const users = readUsers().users;
    const rating = users.map(u => ({ login: u.login, name: u.name, avatar: u.avatar || null, messages: (u.stats && u.stats.messages) || 0, voices: (u.stats && u.stats.voices) || 0, images: (u.stats && u.stats.images) || 0, reactions: (u.stats && u.stats.reactions) || 0, calls: (u.stats && u.stats.calls) || 0, achievements: (u.achievements || []).length })).sort((a, b) => (b.messages + b.voices * 2 + b.images * 2) - (a.messages + a.voices * 2 + a.images * 2));
    res.json(rating);
});

app.get('/api/quotes', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    res.json(JSON.parse(fs.readFileSync('quotes.json', 'utf-8')).quotes);
});

app.post('/api/quotes', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const msg = readMessages().messages.find(m => m.id === req.body.messageId);
    if (!msg) return res.status(404).json({ error: 'message not found' });
    const quotesData = JSON.parse(fs.readFileSync('quotes.json', 'utf-8'));
    if (quotesData.quotes.find(q => q.messageId === req.body.messageId)) return res.json({ ok: true, already: true });
    quotesData.quotes.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), messageId: msg.id, author: msg.name, authorLogin: msg.login, text: msg.text, savedBy: req.session.user.login, savedAt: new Date().toISOString() });
    fs.writeFileSync('quotes.json', JSON.stringify(quotesData, null, 2), 'utf-8');
    res.json({ ok: true });
});

app.delete('/api/quotes/:id', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const quotesData = JSON.parse(fs.readFileSync('quotes.json', 'utf-8'));
    quotesData.quotes = quotesData.quotes.filter(q => q.id !== req.params.id);
    fs.writeFileSync('quotes.json', JSON.stringify(quotesData, null, 2), 'utf-8');
    res.json({ ok: true });
});

app.get('/api/changelog', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    if (req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    res.json(readChangelog().changes.slice().reverse());
});

app.post('/api/sys', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'empty' });
    const msg = addSystemMessage(text.trim().slice(0, 500));
    res.json(msg);
});

app.post('/api/moderate', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const { action, target, duration } = req.body;
    const data = readUsers();
    const user = data.users.find(u => u.login === target);
    if (!user) return res.status(404).json({ error: 'user not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Нельзя модерировать админа' });

    const ms = duration ? parseDuration(duration) : undefined;
    const isForever = duration === 'forever';
    const until = isForever ? new Date('9999-12-31').toISOString() : (ms ? new Date(Date.now() + ms).toISOString() : null);
    const durRu = duration ? parseDurationRu(duration) : '';
    const adminName = req.session.user.nickname || req.session.user.name;

    switch (action) {
        case 'mute': user.mutedUntil = until; addSystemMessage(`🔇 ${user.nickname} замучен на ${durRu} (${adminName})`); break;
        case 'unmute': user.mutedUntil = null; addSystemMessage(`🔊 ${user.nickname} размучен (${adminName})`); break;
        case 'ban': user.bannedUntil = until; addSystemMessage(`🚫 ${user.nickname} забанен на ${durRu} (${adminName})`); break;
        case 'unban': user.bannedUntil = null; addSystemMessage(`✅ ${user.nickname} разбанен (${adminName})`); break;
        case 'kick':
            for (const [sid, login] of onlineUsers.entries()) { if (login === target) io.to(sid).emit('kicked'); }
            addSystemMessage(`👢 ${user.nickname} кикнут (${adminName})`);
            break;
        case 'warn':
            if (!user.warnings) user.warnings = [];
            user.warnings.push({ by: req.session.user.login, time: new Date().toISOString() });
            if (user.warnings.length === 3) {
                user.mutedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
                user.warnings = [];
                writeUsers(data);
                addSystemMessage(`⚠️ ${user.nickname} получил 3-й варн → автомут на 15 минут`);
                return res.json({ ok: true, autoMuted: true });
            }
            addSystemMessage(`⚠️ ${user.nickname} получил предупреждение (${adminName}). Варнов: ${user.warnings.length}/3`);
            break;
        case 'clearWarns': user.warnings = []; addSystemMessage(`🧹 ${user.nickname}: варны сброшены (${adminName})`); break;
        default: return res.status(400).json({ error: 'unknown action' });
    }
    writeUsers(data);
    res.json({ ok: true, action, target, duration: duration || null });
});

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
app.get('/changelog', (req, res) => { if (!req.session.user) return res.redirect('/login'); if (req.session.user.role !== 'admin') return res.status(403).send('Только для админа'); res.sendFile(path.join(__dirname, 'changelog.html')); });

app.get('/api/profile/:login', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const user = readUsers().users.find(u => u.login === req.params.login);
    if (!user) return res.status(404).json({ error: 'user not found' });
    const p = checkPunishments(user);
    res.json({ login: user.login, name: user.name, nickname: user.nickname, avatar: user.avatar || null, phrase: user.phrase || '', achievements: user.achievements || [], stats: user.stats || {}, warnings: user.warnings || [], muted: p.muted, mutedUntil: p.mutedUntil, banned: p.banned, bannedUntil: p.bannedUntil, isOwn: user.login === req.session.user.login });
});

app.post('/api/profile/avatar', uploadAvatar.single('avatar'), (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const data = readUsers();
    const user = data.users.find(u => u.login === req.session.user.login);
    if (user.avatar) { const old = path.join(AVATARS_DIR, path.basename(user.avatar)); if (fs.existsSync(old)) fs.unlinkSync(old); }
    user.avatar = '/avatars/' + req.file.filename;
    writeUsers(data);
    res.json({ ok: true, avatar: user.avatar });
});

app.post('/api/profile/phrase', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const { phrase } = req.body;
    if (typeof phrase !== 'string') return res.status(400).json({ error: 'invalid' });
    const data = readUsers();
    const user = data.users.find(u => u.login === req.session.user.login);
    user.phrase = phrase.trim().slice(0, 200);
    writeUsers(data);
    res.json({ ok: true, phrase: user.phrase });
});

app.post('/api/profile/credentials', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const { newLogin, newPassword } = req.body;
    if (!newLogin && !newPassword) return res.status(400).json({ error: 'nothing to change' });
    const data = readUsers();
    const user = data.users.find(u => u.login === req.session.user.login);
    if (!user) return res.status(404).json({ error: 'user not found' });
    const oldLogin = user.login;
    const oldPassword = user.password;
    const changes = [];
    if (newLogin && newLogin.trim() && newLogin !== oldLogin) {
        const trimmed = newLogin.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
        if (trimmed.length < 3) return res.status(400).json({ error: 'Логин минимум 3 символа' });
        if (data.users.find(u => u.login === trimmed)) return res.status(400).json({ error: 'Такой логин уже занят' });
        user.login = trimmed; user.name = trimmed;
        changes.push({ field: 'login', from: oldLogin, to: trimmed });
        const msgs = readMessages();
        msgs.messages.forEach(m => { if (m.login === oldLogin) m.login = trimmed; });
        writeMessages(msgs);
        const quotes = JSON.parse(fs.readFileSync('quotes.json', 'utf-8'));
        quotes.quotes.forEach(q => { if (q.authorLogin === oldLogin) q.authorLogin = trimmed; });
        fs.writeFileSync('quotes.json', JSON.stringify(quotes, null, 2), 'utf-8');
    }
    if (newPassword && newPassword !== oldPassword) {
        if (newPassword.length < 3) return res.status(400).json({ error: 'Пароль минимум 3 символа' });
        user.password = newPassword;
        changes.push({ field: 'password', from: oldPassword, to: newPassword });
    }
    if (changes.length === 0) return res.json({ ok: true, changes: [] });
    writeUsers(data);
    const log = readChangelog();
    changes.forEach(c => { log.changes.push({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 6), user: user.login, oldLogin, field: c.field, from: c.from, to: c.to, time: new Date().toISOString() }); });
    writeChangelog(log);
    if (newLogin && newLogin.trim()) { req.session.user.login = user.login; req.session.user.name = user.name; }
    res.json({ ok: true, changes: changes.map(c => c.field), newLogin: user.login });
});

app.get('/api/messages', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = readMessages();
    const users = readUsers().users;
    res.json(data.messages.map(m => {
        if (m.system) return { ...m, avatar: null, reactions: {} };
        const u = users.find(x => x.login === m.login);
        return { ...m, avatar: u && u.avatar ? u.avatar : null, reactions: m.reactions || {} };
    }));
});

app.post('/api/messages', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const usersData = readUsers();
    const user = usersData.users.find(u => u.login === req.session.user.login);
    const p = checkPunishments(user);
    if (p.changed) writeUsers(usersData);
    if (p.muted) return res.status(403).json({ error: 'Ты в муте' });
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'empty' });
    const data = readMessages();
    const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), login: req.session.user.login, name: req.session.user.name, text: text.trim(), time: new Date().toISOString(), reactions: {} };
    data.messages.push(msg);
    writeMessages(data);
    if (!user.stats) user.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 };
    user.stats.messages = (user.stats.messages || 0) + 1;
    writeUsers(usersData);
    const newAch = checkAchievements(req.session.user.login);
    res.json({ ...msg, newAchievements: newAch });
});

app.post('/api/voice', uploadVoice.single('voice'), (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const usersData = readUsers();
    const user = usersData.users.find(u => u.login === req.session.user.login);
    const p = checkPunishments(user);
    if (p.changed) writeUsers(usersData);
    if (p.muted) return res.status(403).json({ error: 'Ты в муте' });
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const duration = req.body.duration || 0;
    const data = readMessages();
    const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), login: req.session.user.login, name: req.session.user.name, text: '▶ Голосовое', voice: '/voice/' + req.file.filename, duration: parseInt(duration) || 0, time: new Date().toISOString(), reactions: {} };
    data.messages.push(msg);
    writeMessages(data);
    if (!user.stats) user.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 };
    user.stats.voices = (user.stats.voices || 0) + 1;
    writeUsers(usersData);
    checkAchievements(req.session.user.login);
    res.json(msg);
});

app.post('/api/image', uploadImage.single('image'), (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const usersData = readUsers();
    const user = usersData.users.find(u => u.login === req.session.user.login);
    const p = checkPunishments(user);
    if (p.changed) writeUsers(usersData);
    if (p.muted) return res.status(403).json({ error: 'Ты в муте' });
    if (!req.file) return res.status(400).json({ error: 'no file' });
    const data = readMessages();
    const msg = { id: Date.now() + '-' + Math.random().toString(36).slice(2, 8), login: req.session.user.login, name: req.session.user.name, text: '📷 Картинка', image: '/images/' + req.file.filename, time: new Date().toISOString(), reactions: {} };
    data.messages.push(msg);
    writeMessages(data);
    if (!user.stats) user.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 };
    user.stats.images = (user.stats.images || 0) + 1;
    writeUsers(usersData);
    checkAchievements(req.session.user.login);
    res.json(msg);
});

app.delete('/api/messages/:id', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = readMessages();
    const idx = data.messages.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    const msg = data.messages[idx];
    const isOwn = msg.login === req.session.user.login;
    const isAdmin = req.session.user.role === 'admin';
    if (msg.system && !isAdmin) return res.status(403).json({ error: 'no permission' });
    if (!isOwn && !isAdmin) return res.status(403).json({ error: 'no permission' });
    if (msg.voice) { const p = path.join(VOICE_DIR, path.basename(msg.voice)); if (fs.existsSync(p)) fs.unlinkSync(p); }
    if (msg.image) { const p = path.join(IMAGES_DIR, path.basename(msg.image)); if (fs.existsSync(p)) fs.unlinkSync(p); }
    data.messages.splice(idx, 1);
    writeMessages(data);
    res.json({ ok: true });
});

app.post('/api/messages/:id/react', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const { emoji, action } = req.body;
    const ALLOWED = ['😂', '🔥', '👍', '💀'];
    if (!ALLOWED.includes(emoji)) return res.status(400).json({ error: 'bad emoji' });
    const data = readMessages();
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
    writeMessages(data);
    const users = readUsers();
    const u = users.users.find(x => x.login === myLogin);
    if (!u.stats) u.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 };
    if (action !== 'remove') u.stats.reactions = (u.stats.reactions || 0) + 1;
    writeUsers(users);
    checkAchievements(myLogin);
    const avatar = (users.users.find(x => x.login === msg.login) || {}).avatar || null;
    res.json({ ...msg, avatar });
});

const COMMANDS_LIST = [
    { cmd: '/mute', desc: 'Замутить участника (5м, 15м, 1ч, 1д, 7д, навсегда)' },
    { cmd: '/unmute', desc: 'Снять мут' },
    { cmd: '/warn', desc: 'Предупреждение. 3 варна = автомут 15 мин' },
    { cmd: '/clearwarns', desc: 'Сбросить варны' },
    { cmd: '/ban', desc: 'Забанить' },
    { cmd: '/unban', desc: 'Снять бан' },
    { cmd: '/kick', desc: 'Кикнуть (разлогинить)' },
    { cmd: '/sys текст', desc: 'Написать от лица СИСТЕМЫ' }
];

app.get('/admin', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== 'admin') return res.status(403).send('Доступ только для админа');
    const data = readUsers();
    const msgs = readMessages();
    const quotes = JSON.parse(fs.readFileSync('quotes.json', 'utf-8'));
    const now = Date.now();
    const ONE_MINUTE = 60 * 1000;
    const totalMessages = msgs.messages.length;
    const totalVoice = msgs.messages.filter(m => m.voice).length;
    const totalImages = msgs.messages.filter(m => m.image).length;

    const rows = data.users.map(u => {
        let status, statusColor;
        if (!u.lastLogin) { status = 'Не заходил'; statusColor = '#80848e'; }
        else if (u.lastPing && (now - new Date(u.lastPing).getTime() < ONE_MINUTE)) { status = 'В сети'; statusColor = '#23a55a'; }
        else { status = 'Заходил'; statusColor = '#949ba4'; }
        const p = checkPunishments(u);
        let punish = '';
        if (p.banned) punish += `<span class="pun ban">🚫 БАН</span>`;
        if (p.muted) punish += `<span class="pun mute">🔇 МУТ</span>`;
        const warns = (u.warnings || []).length;
        if (warns) punish += `<span class="pun warn">⚠️ ${warns}</span>`;
        const lastTime = u.lastLogin ? new Date(u.lastLogin).toLocaleString('ru-RU', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
        const initial = (u.nickname || '?').charAt(0).toUpperCase();
        const avatarHtml = u.avatar ? `<img src="${u.avatar}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;">` : `<div class="avatar">${initial}</div>`;
        const stats = u.stats || {};
        return `<tr>
            <td><div class="user-cell">${avatarHtml}<span class="nickname">${u.nickname}</span>${punish}</div></td>
            <td class="muted">${u.login}</td>
            <td class="muted">${lastTime}</td>
            <td><span class="status" style="color:${statusColor};"><span class="dot" style="background:${statusColor};"></span>${status}</span></td>
            <td class="muted">${stats.messages || 0}</td>
            <td class="muted">${stats.voices || 0}</td>
            <td class="muted">${stats.images || 0}</td>
            <td><button class="reset-btn" onclick="resetStats('${u.login}')">Сброс</button></td>
        </tr>`;
    }).join('');

    const cmdRows = COMMANDS_LIST.map(c => `<tr><td class="cmd-name">${c.cmd}</td><td class="muted">${c.desc}</td></tr>`).join('');

    res.send(`<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Админка</title><style>
        * { box-sizing: border-box; }
        body { font-family: "gg sans","Helvetica Neue",Helvetica,Arial,sans-serif; background:#313338; color:#dbdee1; margin:0; padding:40px 20px; min-height:100vh; }
        h1 { color:#f2f3f5; font-size:24px; font-weight:600; text-align:center; margin:0 0 8px; }
        h2 { color:#f2f3f5; font-size:18px; font-weight:600; margin:32px 0 12px; text-align:center; }
        .sub { text-align:center; color:#b5bac1; font-size:14px; margin-bottom:24px; }
        .stats-grid { max-width:1200px; margin:0 auto 24px; display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; }
        .stat-card { background:#2b2d31; padding:16px; border-radius:8px; text-align:center; }
        .stat-card .num { font-size:26px; font-weight:700; color:#5865f2; }
        .stat-card .lbl { color:#949ba4; font-size:12px; margin-top:4px; }
        .actions { max-width:1200px; margin:0 auto 16px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap; }
        .action-btn { padding:10px 18px; border-radius:6px; border:none; cursor:pointer; font-family:inherit; font-size:14px; font-weight:600; color:white; }
        .action-btn.danger { background:#f23f43; }
        .action-btn.danger:hover { background:#d63031; }
        .container { max-width:1200px; margin:0 auto; background:#2b2d31; border-radius:8px; overflow:hidden; box-shadow:0 8px 16px rgba(0,0,0,0.24); }
        table { border-collapse:collapse; width:100%; }
        th, td { padding:12px 16px; text-align:left; font-size:14px; }
        th { background:#1e1f22; color:#b5bac1; font-size:11px; font-weight:700; text-transform:uppercase; }
        tr { border-bottom:1px solid #3f4147; }
        tr:last-child { border-bottom:none; }
        tr:hover td { background:#35373c; }
        .user-cell { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
        .avatar { width:36px; height:36px; border-radius:50%; background:#5865f2; color:white; display:flex; align-items:center; justify-content:center; font-weight:600; font-size:15px; flex-shrink:0; }
        .nickname { color:#f2f3f5; font-weight:600; }
        .pun { padding:2px 8px; border-radius:10px; font-size:11px; font-weight:700; }
        .pun.ban { background:#3a1a1b; color:#f23f43; }
        .pun.mute { background:#3a2a1a; color:#f0a030; }
        .pun.warn { background:#2a2a1a; color:#f0d030; }
        .muted { color:#949ba4; }
        .status { display:inline-flex; align-items:center; gap:6px; font-weight:500; }
        .dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
        .reset-btn { background:#4e5058; color:#fff; border:none; border-radius:4px; padding:4px 10px; cursor:pointer; font-size:12px; }
        .reset-btn:hover { background:#5d6069; }
        .cmd-name { color:#5865f2; font-family:monospace; font-size:14px; font-weight:600; }
        .footer { text-align:center; margin-top:24px; display:flex; gap:16px; justify-content:center; flex-wrap:wrap; }
        .footer a { color:#00a8fc; text-decoration:none; font-size:15px; }
        .footer a:hover { text-decoration:underline; }
    </style></head><body>
    <h1>Админка</h1>
    <p class="sub">Полная статистика и управление</p>
    <div class="stats-grid">
        <div class="stat-card"><div class="num">${totalMessages}</div><div class="lbl">Сообщений</div></div>
        <div class="stat-card"><div class="num">${totalVoice}</div><div class="lbl">Голосовых</div></div>
        <div class="stat-card"><div class="num">${totalImages}</div><div class="lbl">Картинок</div></div>
        <div class="stat-card"><div class="num">${quotes.quotes.length}</div><div class="lbl">В цитатнике</div></div>
    </div>
    <div class="actions">
        <button class="action-btn danger" onclick="clearChat()">🗑️ Очистить чат</button>
        <button class="action-btn danger" onclick="clearQuotes()">🗑️ Очистить цитатник</button>
        <button class="action-btn danger" onclick="clearLogins()">🗑️ Очистить журнал входов</button>
    </div>
    <div class="container"><table>
        <tr><th>Кличка</th><th>Логин</th><th>Последний вход</th><th>Статус</th><th>Сообщ.</th><th>Голос.</th><th>Карт.</th><th></th></tr>
        ${rows}
    </table></div>

    <h2>📖 Список команд (только админ)</h2>
    <div class="container"><table>
        <tr><th>Команда</th><th>Описание</th></tr>
        ${cmdRows}
    </table></div>

    <div class="footer">
        <a href="/chat">→ В чат</a>
        <a href="/rating">→ Рейтинг</a>
        <a href="/quotes">→ Цитатник</a>
        <a href="/changelog">→ Журнал изменений</a>
    </div>
    <script>
        fetch('/api/ping', { method: 'POST' });
        setInterval(() => { fetch('/api/ping', { method: 'POST' }); }, 30000);
        async function resetStats(login) { if (!confirm('Сбросить статистику ' + login + '?')) return; const r = await fetch('/api/admin/reset/' + login, { method: 'POST' }); if (r.ok) location.reload(); else alert('Ошибка'); }
        async function clearChat() { if (!confirm('Удалить ВСЕ сообщения?')) return; const r = await fetch('/api/admin/clear-chat', { method: 'POST' }); if (r.ok) alert('Чат очищен'); else alert('Ошибка'); }
        async function clearQuotes() { if (!confirm('Удалить ВСЕ цитаты?')) return; const r = await fetch('/api/admin/clear-quotes', { method: 'POST' }); if (r.ok) alert('Цитатник очищен'); else alert('Ошибка'); }
        async function clearLogins() { if (!confirm('Сбросить даты последнего входа?')) return; const r = await fetch('/api/admin/clear-logins', { method: 'POST' }); if (r.ok) { alert('Журнал входов очищен'); location.reload(); } else alert('Ошибка'); }
    </script>
    </body></html>`);
});

app.post('/api/admin/reset/:login', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const data = readUsers();
    const user = data.users.find(u => u.login === req.params.login);
    if (!user) return res.status(404).json({ error: 'not found' });
    user.stats = { messages: 0, voices: 0, images: 0, reactions: 0, calls: 0 };
    user.achievements = [];
    writeUsers(data);
    res.json({ ok: true });
});

app.post('/api/admin/clear-chat', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    writeMessages({ messages: [] });
    res.json({ ok: true });
});

app.post('/api/admin/clear-quotes', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    fs.writeFileSync('quotes.json', JSON.stringify({ quotes: [] }, null, 2), 'utf-8');
    res.json({ ok: true });
});

app.post('/api/admin/clear-logins', (req, res) => {
    if (!req.session.user || req.session.user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
    const data = readUsers();
    data.users.forEach(u => { u.lastLogin = null; u.lastPing = null; });
    writeUsers(data);
    res.json({ ok: true });
});

server.listen(PORT, () => console.log(`Сервер запущен: http://localhost:${PORT}`));