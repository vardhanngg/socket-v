"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const dotenv_1 = __importDefault(require("dotenv"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const cloudinary_1 = require("cloudinary");
const cors_1 = __importDefault(require("cors"));

dotenv_1.default.config();

console.log("Cloudinary config env vars:", {
    cloud_name: process.env.CLOUD_NAME,
    api_key: process.env.CLOUD_KEY,
    api_secret: process.env.CLOUD_SECRET ? '***' : undefined,
});

cloudinary_1.v2.config({
    cloud_name: process.env.CLOUD_NAME,
    api_key: process.env.CLOUD_KEY,
    api_secret: process.env.CLOUD_SECRET,
});

let corsOrigins = '*';
if (process.env.CORS_ORIGIN) {
    try {
        corsOrigins = process.env.CORS_ORIGIN.split(',')
            .map(origin => origin.trim())
            .filter(origin => origin && /^https?:\/\/[\w\-.:]+$/.test(origin));
        console.log('Parsed CORS origins:', corsOrigins);
        if (corsOrigins.length === 0) {
            console.warn('No valid CORS origins found, falling back to *');
            corsOrigins = '*';
        }
    } catch (err) {
        console.error('Error parsing CORS_ORIGIN:', err instanceof Error ? err.message : String(err));
        corsOrigins = '*';
    }
}

const app = (0, express_1.default)();
const server = http_1.default.createServer(app);

app.use((0, cors_1.default)({ origin: corsOrigins, methods: ['GET', 'POST', 'OPTIONS'] }));

const io = new socket_io_1.Server(server, {
    cors: { origin: corsOrigins, methods: ['GET', 'POST'] },
});

/* ------------------ MEDIA UPLOAD SETUP ------------------ */
const uploadDir = path_1.default.resolve('./uploads');
if (!fs_1.default.existsSync(uploadDir)) fs_1.default.mkdirSync(uploadDir);

const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const userName = req.body.name || 'anonymous';
        const sanitizedUserName = userName.replace(/\s+/g, '_');
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const fileExtension = path_1.default.extname(file.originalname);
        cb(null, sanitizedUserName + '-' + unique + fileExtension);
    },
});
const upload = (0, multer_1.default)({ storage });

/* ------------------ SESSION SYSTEM ------------------ */
const sessions = {};

function generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
    if (sessions[code]) return generateCode();
    return code;
}

io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id}, transport: ${socket.conn.transport.name}`);
    socket.conn.on('upgrade', () => console.log(`Upgraded to WebSocket: ${socket.id}`));

    socket.on('create-session', ({ name } = {}) => {
        const code = generateCode();
        socket.join(code);
        const displayName = (name && name.trim()) ? name : 'Host';
        socket.data.displayName = displayName;
        sessions[code] = { hostId: socket.id, participants: {} };
        sessions[code].participants[socket.id] = { name: displayName, isHost: true };
        socket.emit('session-created', { code });
        socket.emit('user-joined', { userId: socket.id, isHost: true, name: displayName });
        io.to(code).emit('participantsUpdate', sessions[code].participants);
        console.log(`📀 Session created: ${code} by host ${displayName}`);
    });

    socket.on('transfer-host', ({ code, newHostId }) => {
        if (!code || !sessions[code]) {
            socket.emit('error', { message: 'Invalid session for host transfer' });
            return;
        }
        if (socket.id !== sessions[code].hostId) {
            socket.emit('error', { message: 'Only the current host can transfer host rights' });
            return;
        }
        // Update participants map
        if (sessions[code].participants[socket.id]) sessions[code].participants[socket.id].isHost = false;
        if (sessions[code].participants[newHostId]) sessions[code].participants[newHostId].isHost = true;
        sessions[code].hostId = newHostId;
        io.to(code).emit('host-transferred', { newHostId });
        io.to(code).emit('participantsUpdate', sessions[code].participants);
        console.log(`👑 Host rights in ${code} transferred to ${newHostId}`);
    });

    socket.on('join-session', ({ code, name }, callback) => {
        if (!code || !sessions[code]) {
            if (callback) callback(false);
            socket.emit('error', { message: 'Invalid session code' });
            return;
        }
        socket.join(code);
        const isHost = socket.id === sessions[code].hostId;
        const displayName = (name && name.trim()) ? name : 'Guest';
        socket.data.displayName = displayName;
        sessions[code].participants[socket.id] = { name: displayName, isHost };
        io.to(code).emit('user-joined', { userId: socket.id, name: displayName, isHost });
        io.to(code).emit('participantsUpdate', sessions[code].participants);
        socket.emit('session-joined', { code, isHost, name: displayName });
        if (callback) callback(true);
        socket.to(sessions[code].hostId).emit('request-state', { forUser: socket.id });
        console.log(`✅ User ${socket.id} (${displayName}) joined session ${code}`);
    });

    socket.on('playback-control', (data) => {
        const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
        if (!code || socket.id !== sessions[code].hostId) {
            socket.emit('error', { message: 'Only host can control playback' });
            return;
        }
        io.to(code).emit('playback-control', data);
        console.log(`🎵 Playback control in ${code}: ${data.action}`);
    });

    socket.on('sync-state', (data) => {
        const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
        if (!code || socket.id !== sessions[code].hostId) return;
        io.to(code).emit('sync-state', data);
    });

    socket.on('provide-state', ({ forUser, state }) => {
        const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
        if (!code || socket.id !== sessions[code].hostId) return;
        io.to(forUser).emit('sync-state', state);
    });

    socket.on('chat-message', ({ user, message, time }) => {
        const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
        if (!code) return;
        const displayName = socket.data.displayName || (user && user.trim()) || 'Guest';
        console.log(`💬 Chat in ${code} from ${displayName}: ${message}`);
        io.to(code).emit('chat-message', { user: displayName, message, time });
    });

    socket.on('suggest-song', ({ code, song, from }) => {
        if (!code || !sessions[code]) return;
        io.to(sessions[code].hostId).emit('song-suggested', { song, from });
        console.log(`✋ Song suggested in ${code} by ${from}: ${song?.title}`);
    });
    socket.on('kick-participant', ({ code, userId }) => {
        if (!code || !sessions[code]) return;
        if (socket.id !== sessions[code].hostId) {
            socket.emit('error', { message: 'Only host can remove participants' });
            return;
        }
        const name = sessions[code].participants[userId]?.name || 'Guest';
        io.to(userId).emit('kicked');
        delete sessions[code].participants[userId];
        io.to(code).emit('user-left', { userId, name });
        io.to(code).emit('participantsUpdate', sessions[code].participants);
        const kickedSocket = io.sockets.sockets.get(userId);
        if (kickedSocket) kickedSocket.leave(code);
        console.log(`👟 User ${userId} (${name}) kicked from session ${code}`);
    });

    socket.on('media-share', ({ code, fileUrl, fileType, user }) => {
        if (!sessions[code]) return;
        io.to(code).emit('media-share', { user, fileUrl, fileType });
        console.log(`📤 Media shared in ${code} by ${user}: ${fileUrl}`);
    });

    socket.on('leave-session', ({ code }) => {
        if (!code || !sessions[code]) return;
        socket.leave(code);
        const name = socket.data.displayName || 'Guest';
        delete sessions[code].participants[socket.id];
        io.to(code).emit('user-left', { userId: socket.id, name });
        if (socket.id === sessions[code].hostId) {
            const remaining = Object.entries(sessions[code].participants);
            if (remaining.length > 0) {
                const [newHostId, newHostData] = remaining[0];
                sessions[code].hostId = newHostId;
                sessions[code].participants[newHostId].isHost = true;
                io.to(code).emit('host-transferred', { newHostId });
                io.to(code).emit('participantsUpdate', sessions[code].participants);
                console.log(`👑 Host auto-transferred to ${newHostData.name} in session ${code}`);
            } else {
                io.to(code).emit('session-ended', { message: 'Host left the session' });
                delete sessions[code];
                console.log(`❌ Session ${code} ended (host ${name} left, no participants)`);
            }
        } else {
            io.to(code).emit('participantsUpdate', sessions[code].participants);
        }
        console.log(`👋 User ${socket.id} (${name}) left session ${code}`);
    });

    socket.on('disconnect', () => {
        const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
        if (code) {
            const name = socket.data.displayName || 'Guest';
            delete sessions[code].participants[socket.id];
            io.to(code).emit('user-left', { userId: socket.id, name });
            if (socket.id === sessions[code].hostId) {
                const remaining = Object.entries(sessions[code].participants);
                if (remaining.length > 0) {
                    const [newHostId, newHostData] = remaining[0];
                    sessions[code].hostId = newHostId;
                    sessions[code].participants[newHostId].isHost = true;
                    io.to(code).emit('host-transferred', { newHostId });
                    io.to(code).emit('participantsUpdate', sessions[code].participants);
                    console.log(`👑 Host auto-transferred to ${newHostData.name} in session ${code}`);
                } else {
                    io.to(code).emit('session-ended', { message: 'Host left the session' });
                    delete sessions[code];
                    console.log(`❌ Session ${code} ended (host ${name} disconnected, no participants)`);
                }
            } else {
                io.to(code).emit('participantsUpdate', sessions[code].participants);
            }
            console.log(`👋 User ${socket.id} (${name}) disconnected from ${code}`);
        }
    });
});

/* ------------------ EXPRESS ROUTES ------------------ */
app.get('/health', (req, res) => res.status(200).json({ status: 'OK' }));

app.post('/upload', upload.single('media'), async (req, res) => {
    const file = req.file;
    const userName = req.body.name;
    if (!file || !userName) return res.status(400).json({ error: 'No file uploaded or name missing' });
    try {
        const result = await cloudinary_1.v2.uploader.upload(file.path, { folder: 'vibron_uploads' });
        fs_1.default.unlinkSync(file.path);
        res.json({ fileUrl: result.secure_url, fileType: file.mimetype });
    } catch (err) {
        console.error('Upload to Cloudinary failed:', err);
        res.status(500).json({ error: 'Cloudinary upload failed' });
    }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🚀 Listen Together server running on port ${PORT}`));
