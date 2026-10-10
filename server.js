const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ==== Чтение и запись users.json ====
function readUsers() {
    return JSON.parse(fs.readFileSync('users.json', 'utf-8'));
}
function writeUsers(data) {
    fs.writeFileSync('users.json', JSON.stringify(data, null, 2), 'utf-8');
}

// ==== Чтение и запись messages.json ====
function readMessages() {
    return JSON.parse(fs.readFileSync('messages.json', 'utf-8'));
}
function writeMessages(data) {
    fs.writeFileSync('messages.json', JSON.stringify(data, null, 2), 'utf-8');
}

// ==== Настройки ====
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
    secret: 'pacan-secret-key',
    resave: false,
    saveUninitialized: false
}));
app.use(express.static(__dirname));

// ==== Страница входа ====
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// ==== Обработка входа ====
app.post('/login', (req, res) => {
    const { login, password } = req.body;
    const data = readUsers();
    const user = data.users.find(u => u.login === login && u.password === password);

    if (!user) {
        return res.redirect('/login?error=1');
    }

    user.lastLogin = new Date().toISOString();
    writeUsers(data);

    req.session.user = {
        login: user.login,
        name: user.name,
        nickname: user.nickname,
        role: user.role
    };

    if (user.role === 'admin') {
        return res.redirect('/admin');
    }
    res.redirect('/');
});

// ==== Кто я ====
app.get('/api/me', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    res.json(req.session.user);
});

// ==== Главная — редирект ====
app.get('/', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    if (req.session.user.role === 'admin') return res.redirect('/admin');
    res.redirect('/chat');
});

// ==== Страница чата ====
app.get('/chat', (req, res) => {
    if (!req.session.user) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'chat.html'));
});

// ==== API чата ====

// Получить все сообщения
app.get('/api/messages', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });
    const data = readMessages();
    res.json(data.messages);
});

// Отправить сообщение
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

// Удалить сообщение
app.delete('/api/messages/:id', (req, res) => {
    if (!req.session.user) return res.status(401).json({ error: 'not logged in' });

    const data = readMessages();
    const idx = data.messages.findIndex(m => m.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });

    const msg = data.messages[idx];
    const isOwn = msg.login === req.session.user.login;
    const isAdmin = req.session.user.role === 'admin';

    if (!isOwn && !isAdmin) {
        return res.status(403).json({ error: 'no permission' });
    }

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
        let status;
        if (!u.lastLogin) {
            status = 'Не заходил на сайт';
        } else {
            const diff = now - new Date(u.lastLogin).getTime();
            status = diff < ONE_MINUTE ? 'В сети' : 'Заходил';
        }
        const lastTime = u.lastLogin
            ? new Date(u.lastLogin).toLocaleString('ru-RU')
            : '—';

        return `
            <tr>
                <td>${u.nickname}</td>
                <td>${lastTime}</td>
                <td>${status}</td>
            </tr>
        `;
    }).join('');

    res.send(`
        <!DOCTYPE html>
        <html lang="ru">
        <head>
            <meta charset="UTF-8">
            <title>Админка</title>
            <style>
                body {
                    font-family: "Times New Roman", Times, serif;
                    background: #ffffff;
                    margin: 0;
                    padding: 40px;
                }
                h1 { color: blue; text-align: center; }
                table { border-collapse: collapse; width: 100%; max-width: 700px; margin: 0 auto; }
                th, td { border: 1px solid #ccc; padding: 10px; text-align: left; }
                th { background: #f0f0f0; }
                .chat-link {
                    display: block;
                    text-align: center;
                    margin: 20px auto 0;
                    color: blue;
                }
            </style>
        </head>
        <body>
            <h1>Кто заходил</h1>
            <table>
                <tr><th>Кличка</th><th>Последний вход</th><th>Статус</th></tr>
                ${rows}
            </table>
            <a class="chat-link" href="/chat">Перейти в чат</a>
        </body>
        </html>
    `);
});

// ==== Запуск ====
app.listen(PORT, () => {
    console.log(`Сервер запущен: http://localhost:${PORT}`);
});