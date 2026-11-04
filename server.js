const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// server files must not be downloadable by players
const privateFiles = ['/server.js', '/package.json', '/package-lock.json'];
app.use((req, res, next) => (privateFiles.includes(req.path) ? res.sendStatus(404) : next()));
app.use(express.static(path.join(__dirname), { dotfiles: 'ignore' }));

const players = {}; // socket id -> { id, name, tutor, x, y, aim, hold, health, maxHealth, dead, invincible }

// keeps text from clients short and safe to draw
function cleanText(value, maximumLength) {
    return typeof value === 'string' ? value.trim().slice(0, maximumLength) : '';
}

// keeps numbers from clients finite and inside a sensible range
function cleanNumber(value, minimum, maximum, fallback = 0) {
    return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

function cleanId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 64 ? value : null;
}

io.on('connection', (socket) => {
    // the client sends its name and tutor once it has connected
    socket.on('join', (data) => {
        const name = cleanText(data && data.name, 11);
        const tutor = cleanText(data && data.tutor, 3);
        if (!name || !tutor) {
            return; // ignore bad joins
        }

        // Not announced to the others until the first position arrives, otherwise they would see this player at 0,0 first.
        players[socket.id] = {
            id: socket.id, name, tutor, ready: false,
            x: 0, y: 0, aim: 0, hold: 80, health: 100, maxHealth: 100, dead: false, invincible: false
        };
        const readyPlayers = {};
        Object.values(players).forEach((other) => {
            if (other.ready) {
                readyPlayers[other.id] = other;
            }
        });
        socket.emit('currentPlayers', readyPlayers); // everyone already here
    });

    // position, aim, health and status of a player, sent about 20 times a second
    socket.on('playerMovement', (data) => {
        const player = players[socket.id];
        if (!player || !data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) {
            return; // not joined yet, or bad numbers
        }

        player.x = data.x;
        player.y = data.y;
        player.aim = cleanNumber(data.aim, -10, 10);
        player.hold = cleanNumber(data.hold, 0, 500, 80);
        player.maxHealth = cleanNumber(data.maxHealth, 1, 10000, 100);
        player.health = cleanNumber(data.health, 0, 10000, player.maxHealth);
        player.dead = data.dead === true;
        player.invincible = data.invincible === true;

        if (!player.ready) { // the first position, now everyone else can be told about this player
            player.ready = true;
            socket.broadcast.emit('newPlayer', player);
            return;
        }
        socket.broadcast.emit('playerMoved', player);
    });

    // The attacker works out that a hit landed, the victim owns their own health, so the damage is passed on to them.
    socket.on('damage', (data) => {
        const targetId = cleanId(data && data.targetId);
        if (!players[socket.id] || !targetId || targetId === socket.id || !players[targetId]) {
            return;
        }
        const amount = cleanNumber(data.amount, 0, 100);
        if (amount > 0) {
            io.to(targetId).emit('tookDamage', { amount, from: socket.id });
        }
    });

    // Bullets and bombs only exist for real on the screen of the player who made them, everyone else just gets a copy to look at.
    socket.on('bulletSpawn', (data) => {
        const id = cleanId(data && data.id);
        if (!players[socket.id] || !id) {
            return;
        }
        socket.broadcast.emit('bulletSpawn', {
            id, ownerId: socket.id,
            x: cleanNumber(data.x, -1e5, 1e5), y: cleanNumber(data.y, -1e5, 1e5),
            vx: cleanNumber(data.vx, -5000, 5000), vy: cleanNumber(data.vy, -5000, 5000),
            size: cleanNumber(data.size, 1, 200, 5),
            rotation: cleanNumber(data.rotation, -100, 100),
            texture: data.texture === 'fireball' ? 'fireball' : 'bullet',
            tint: Number.isFinite(data.tint) ? data.tint : null
        });
    });

    socket.on('bulletUpdate', (data) => {
        const id = cleanId(data && data.id);
        if (!players[socket.id] || !id) {
            return;
        }
        socket.broadcast.emit('bulletUpdate', {
            id,
            x: cleanNumber(data.x, -1e5, 1e5), y: cleanNumber(data.y, -1e5, 1e5),
            vx: cleanNumber(data.vx, -5000, 5000), vy: cleanNumber(data.vy, -5000, 5000)
        });
    });

    socket.on('bulletRemoved', (data) => {
        const id = cleanId(data && data.id);
        if (players[socket.id] && id) {
            socket.broadcast.emit('bulletRemoved', { id });
        }
    });

    socket.on('bombPlaced', (data) => {
        const id = cleanId(data && data.id);
        if (!players[socket.id] || !id) {
            return;
        }
        socket.broadcast.emit('bombPlaced', {
            id, ownerId: socket.id,
            x: cleanNumber(data.x, -1e5, 1e5), y: cleanNumber(data.y, -1e5, 1e5)
        });
    });

    socket.on('bombExploded', (data) => {
        const id = cleanId(data && data.id);
        if (!players[socket.id] || !id) {
            return;
        }
        socket.broadcast.emit('bombExploded', {
            id,
            x: cleanNumber(data.x, -1e5, 1e5), y: cleanNumber(data.y, -1e5, 1e5)
        });
    });

    // A sword deflected someone else's bullet, only the bullet's owner can actually change it, so it is sent to them.
    socket.on('deflectBullet', (data) => {
        const ownerId = cleanId(data && data.ownerId);
        const id = cleanId(data && data.id);
        if (!players[socket.id] || !ownerId || !id || !players[ownerId]) {
            return;
        }
        io.to(ownerId).emit('bulletDeflected', { id, angle: cleanNumber(data.angle, -100, 100), by: socket.id });
    });

    socket.on('disconnect', () => {
        if (players[socket.id]) {
            const wasReady = players[socket.id].ready;
            delete players[socket.id];
            if (wasReady) {
                io.emit('playerDisconnected', socket.id);
            }
        }
    });
});

const port = process.env.PORT || 3000; // Render sets PORT
server.listen(port, () => console.log(`Server running on port ${port}`));
