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

// ==== TURN-сервер (Metered) ====
const TURN_USERNAME = '07354b48071e5473f623d7a9';
const TURN_CREDENTIAL = 'p9aioMeZ5mqY2lhl';

// ==== Папка для аватарок ====
const AVATARS_DIR = path.join(__dirname, 'avatars');
if (!fs.existsSync(AVATARS_DIR)) {
    fs.mkdirSync(AVATARS_DIR, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, AVATARS_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const name = req.session.user.login + '-' + Date.now() + ext;
        cb(null, name);
    }
});
const upload = multer({ storage });

// ==== Чтение и запись ====
function readUsers() {
    return JSON.parse(fs.readFileSync('users.json', 'utf-8'));
}
function writeUsers(data) {
    fs.writeFileSync('users.json', JSON.stringify(data, null, 2), 'utf-8');
}
function readMessages() {
    return JSON.parse(fs.readFileSync('messages.json', 'utf-8'));
}
function writeMessages(data) {
    fs.writeFileSync('messages.json', JSON.stringify(data, null, 2), 'utf-8');
}

// ==== Настройки ====
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const sessionMiddleware = session({
    secret: 'pacan-secret-key',
    resave: false,
    saveUninitialized: false
});
app.use(sessionMiddleware);
app.use(express.static(__dirname));
app.use('/avatars', express.static(AVATARS_DIR));

// Делим сессию с Socket.IO, чтобы знать, кто подключился
io.engine.use(sessionMiddleware);

// ==== Онлайн-пользователи (socket.id -> login) ====
const onlineUsers = new Map();

// ==== Socket.IO: сигналинг звонков ====
io.on('connection', (socket) => {
    const user = socket.request.session && socket.request.session.user;
    if (!user) {
        socket.disconnect();
        return;
    }

    onlineUsers.set(socket.id, user.login);

    // Кто сейчас онлайн
    io.emit('online', Array.from(onlineUsers.values()));

    // Звонок: передаём предложение конкретному пользователю
    socket.on('call:offer', ({ to, offer }) => {
        const targetSocketId = [...onlineUsers.entries()]
            .find(([, login]) => login === to)?.[0];
        if (targetSocketId) {
            io.to(targetSocketId).emit('call:incoming', {
                from: user.login,
                fromName: user.name,
                offer
            });
        } else {
            socket.emit('call:offline', { to });
        }
    });

    // Ответ на звонок (принят / отклонён)
    socket.on('call:answer', ({ to, answer }) => {
        const targetSocketId = [...onlineUsers.entries()]
            .find(([, login]) => login === to)?.[0];
        if (targetSocketId) {
            io.to(targetSocketId).emit('call:answered', { answer });
        }
    });

    // ICE-кандидаты
    socket.on('call:ice', ({ to, candidate }) => {
        const targetSocketId = [...onlineUsers.entries()]
            .find(([, login]) => login === to)?.[0];
        if (targetSocketId) {
            io.to(targetSocketId).emit('call:ice', { candidate });
        }
    });

    // Завершение звонка
    socket.on('call:end', ({ to }) => {
        const targetSocketId = [...onlineUsers.entries()]
            .find(([, login]) => login === to)?.[0];
        if (targetSocketId) {
            io.to(targetSocketId).emit('call:ended');
        }
    });

    // Отклонение
    socket.on('call:reject', ({ to }) => {
        const targetSocketId = [...onlineUsers.entries()]
            .find(([, login]) => login === to)?.[0];
        if (targetSocketId) {
            io.to(targetSocketId).emit('call:rejected');
        }
    });

    socket.on('disconnect', () => {
        onlineUsers.delete(socket.id);
        io.emit('online', Array.from(onlineUsers.values()));
    });
});

// ==== TURN-данные для браузера ====
app.get('/api/turn', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });

    res.json({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            {
                urls: [
                    'turn:global.relay.metered.ca:80',
                    'turn:global.relay.metered.ca:80?transport=tcp',
                    'turn:global.relay.metered.ca:443',
                    'turns:global.relay.metered.ca:443?transport=tcp'
                ],
                username: TURN_USERNAME,
                credential: TURN_CREDENTIAL
            }
        ]
    });
});

// ==== Страница входа ====
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/login', (req, res) => {
    const { login, password } = req.body;
    const data = readUsers();
    const user = data.users.find(u => u.login === login && u.password === password);

    if (!user) return res.redirect('/login?error=1');

    user.lastLogin = new Date().toISOString();
    writeUsers(data);

    req.session.user = {
        login: user.login,
        name: user.name,
        nickname: user.nickname,
        role: user.role
    };

    if (user.role === 'admin') return res.redirect('/admin');
    res.redirect('/');
});

// ==== API ====
app.get('/api/me', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = readUsers();
    const user = data.users.find(u => u.login === req.session.user.login);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json({
        login: user.login,
        name: user.name,
        nickname: user.nickname,
        role: user.role,
        avatar: user.avatar || null,
        phrase: user.phrase || ''
    });
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

// Список всех пользователей (для выбора кому звонить)
app.get('/api/users', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = readUsers();
    const users = data.users.map(u => ({
        login: u.login,
        name: u.name,
        avatar: u.avatar || null
    }));
    res.json(users);
});

// ==== Главная ====
app.get('/', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    res.redirect('/chat');
});

app.get('/chat', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'chat.html'));
});

app.get('/profile', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'profile.html'));
});

app.get('/api/profile/:login', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = readUsers();
    const user = data.users.find(u => u.login === req.params.login);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json({
        login: user.login,
        name: user.name,
        nickname: user.nickname,
        avatar: user.avatar || null,
        phrase: user.phrase || '',
        isOwn: user.login === req.session.user.login
    });
});

app.post('/api/profile/avatar', upload.single('avatar'), (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    if (!req.file) return res.status(400).json({ error: 'no file' });

    const data = readUsers();
    const user = data.users.find(u => u.login === req.session.user.login);
    if (!user) return res.status(404).json({ error: 'user not found' });

    if (user.avatar) {
        const oldPath = path.join(AVATARS_DIR, path.basename(user.avatar));
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

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
    if (!user) return res.status(404).json({ error: 'user not found' });

    user.phrase = phrase.trim().slice(0, 200);
    writeUsers(data);
    res.json({ ok: true, phrase: user.phrase });
});

// ==== Чат ====
app.get('/api/messages', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = readMessages();
    const users = readUsers().users;
    const enriched = data.messages.map(m => {
        const u = users.find(x => x.login === m.login);
        return { ...m, avatar: u && u.avatar ? u.avatar : null };
    });
    res.json(enriched);
});

app.post('/api/messages', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'empty' });

    const data = readMessages();
    const message = {
        id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
        login: req.session.user.login,
        name: req.session.user.name,
        text: text.trim(),
        time: new Date().toISOString()
    };
    data.messages.push(message);
    writeMessages(data);
    res.json(message);
});

app.delete('/api/messages/:id', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = readMessages();
    const idx = data.messages.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    const msg = data.messages[idx];
    const isOwn = msg.login === req.session.user.login;
    const isAdmin = req.session.user.role === 'admin';
    if (!isOwn && !isAdmin) return res.status(403).json({ error: 'no permission' });

    data.messages.splice(idx, 1);
    writeMessages(data);
    res.json({ ok: true });
});

// ==== Админка ====
app.get('/admin', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role !== 'admin') return res.status(403).send('Доступ только для админа');

    const data = readUsers();
    const now = Date.now();
    const ONE_MINUTE = 60 * 1000;

    const rows = data.users.map(u => {
        let status, statusColor;
        if (!u.lastLogin) {
            status = 'Не заходил на сайт';
            statusColor = '#80848e';
        } else if (u.lastPing && (now - new Date(u.lastPing).getTime() < ONE_MINUTE)) {
            status = 'В сети';
            statusColor = '#23a55a';
        } else {
            status = 'Заходил';
            statusColor = '#949ba4';
        }
        const lastTime = u.lastLogin
            ? new Date(u.lastLogin).toLocaleString('ru-RU', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            })
            : '—';

        const initial = (u.nickname || '?').charAt(0).toUpperCase();
        const avatarHtml = u.avatar
            ? `<img src="${u.avatar}" alt="" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
            : `<div class="avatar">${initial}</div>`;

        return `
            <tr>
                <td>
                    <div class="user-cell">
                        ${avatarHtml}
                        <span class="nickname">${u.nickname}</span>
                    </div>
                </td>
                <td class="muted">${lastTime}</td>
                <td>
                    <span class="status" style="color: ${statusColor};">
                        <span class="dot" style="background: ${statusColor};"></span>
                        ${status}
                    </span>
                </td>
            </tr>
        `;
    }).join('');

    res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Админка</title>
            <style>
                * { box-sizing: border-box; }
                body {
                    font-family: "gg sans", "Helvetica Neue", Helvetica, Arial, sans-serif;
                    background: #313338; color: #dbdee1;
                    margin: 0; padding: 40px 20px; min-height: 100vh;
                }
                h1 { color: #f2f3f5; font-size: 24px; font-weight: 600; text-align: center; margin: 0 0 8px; }
                .sub { text-align: center; color: #b5bac1; font-size: 14px; margin-bottom: 32px; }
                .container {
                    max-width: 800px; margin: 0 auto; background: #2b2d31;
                    border-radius: 8px; overflow: hidden; box-shadow: 0 8px 16px rgba(0,0,0,0.24);
                }
                table { border-collapse: collapse; width: 100%; }
                th, td { padding: 14px 20px; text-align: left; }
                th {
                    background: #1e1f22; color: #b5bac1; font-size: 12px;
                    font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em;
                }
                tr { border-bottom: 1px solid #3f4147; }
                tr:last-child { border-bottom: none; }
                tr:hover td { background: #35373c; }
                .user-cell { display: flex; align-items: center; gap: 12px; }
                .avatar {
                    width: 36px; height: 36px; border-radius: 50%; background: #5865f2;
                    color: white; display: flex; align-items: center; justify-content: center;
                    font-weight: 600; font-size: 15px; flex-shrink: 0;
                }
                .nickname { color: #f2f3f5; font-weight: 600; font-size: 15px; }
                .muted { color: #949ba4; font-size: 14px; }
                .status { display: inline-flex; align-items: center; gap: 6px; font-size: 14px; font-weight: 500; }
                .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
                .footer { text-align: center; margin-top: 24px; }
                .footer a { color: #00a8fc; text-decoration: none; font-size: 15px; }
                .footer a:hover { text-decoration: underline; }
            </style>
        </head>
        <body>
            <h1>Кто заходил</h1>
            <p class="sub">Статус «В сети» обновляется в реальном времени</p>
            <div class="container">
                <table>
                    <tr><th>Кличка</th><th>Последний вход</th><th>Статус</th></tr>
                    ${rows}
                </table>
            </div>
            <div class="footer">
                <a href="/chat">→ Перейти в чат</a>
            </div>
            <script>
                fetch('/api/ping', { method: 'POST' });
                setInterval(() => { fetch('/api/ping', { method: 'POST' }); }, 30000);
            </script>
        </body>
        </html>
    `);
});

// ==== Запуск ====
server.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
});