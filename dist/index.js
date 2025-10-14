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
dotenv_1.default.config();
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
// Parse CORS_ORIGIN safely
let corsOrigins = '*'; // Default to wildcard for safety
if (process.env.CORS_ORIGIN) {
    try {
        corsOrigins = process.env.CORS_ORIGIN.split(',')
            .map(origin => origin.trim())
            .filter(origin => origin && /^https?:\/\/[\w\-.:]+$/.test(origin)); // Validate URLs
        console.log('Parsed CORS origins:', corsOrigins);
        if (corsOrigins.length === 0) {
            console.warn('No valid CORS origins found, falling back to *');
            corsOrigins = '*';
        }
    }
    catch (err) {
        console.error('Error parsing CORS_ORIGIN:', err instanceof Error ? err.message : String(err));
        corsOrigins = '*';
    }
}
const io = new socket_io_1.Server(server, {
    cors: {
        origin: corsOrigins,
        methods: ['GET', 'POST'],
    },
});
/* ------------------ MEDIA UPLOAD SETUP ------------------ */
// Create /uploads folder if missing
const uploadDir = path_1.default.resolve('./uploads');
if (!fs_1.default.existsSync(uploadDir))
    fs_1.default.mkdirSync(uploadDir);
// Configure Multer for local file uploads
const storage = multer_1.default.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, unique + path_1.default.extname(file.originalname));
    },
});
const upload = (0, multer_1.default)({ storage });
// Serve uploaded files as static content
app.use('/uploads', express_1.default.static(uploadDir));
/* ------------------ EXISTING SESSION SYSTEM ------------------ */
// In-memory storage for sessions (code -> {hostId: socket.id})
const sessions = {};
// Generate unique 6-char code
function generateCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    if (sessions[code])
        return generateCode();
    return code;
}
io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id} (name not set yet), transport: ${socket.conn.transport.name}`);
    socket.conn.on('upgrade', () => console.log(`Upgraded to WebSocket: ${socket.id}`));
    socket.on('create-session', () => {
        const code = generateCode();
        socket.join(code);
        sessions[code] = { hostId: socket.id };
        socket.emit('session-created', { code });
        socket.emit('user-joined', { userId: socket.id, isHost: true });
        console.log(`📀 Session created: ${code} by host ${socket.data.displayName || socket.id}`);
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
        sessions[code].hostId = newHostId;
        io.to(code).emit('host-transferred', { newHostId });
        console.log(`👑 Host rights in ${code} transferred from ${socket.data.displayName || socket.id} to ${newHostId}`);
    });
    socket.on('join-session', ({ code, name }, callback) => {
        if (!code || !sessions[code]) {
            if (callback)
                callback(false);
            socket.emit('error', { message: 'Invalid session code' });
            return;
        }
        socket.join(code);
        const isHost = socket.id === sessions[code].hostId;
        const displayName = name && name.trim() ? name : 'Guest';
        socket.data.displayName = displayName;
        io.to(code).emit('user-joined', {
            userId: socket.id,
            name: displayName,
            isHost
        });
        socket.emit('session-joined', { code, isHost, name: displayName });
        if (callback)
            callback(true);
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
        console.log(`🎵 Playback control in ${code} by ${socket.data.displayName || socket.id}: ${data.action}`);
    });
    socket.on('sync-state', (data) => {
        const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
        if (!code || socket.id !== sessions[code].hostId)
            return;
        io.to(code).emit('sync-state', data);
    });
    socket.on('provide-state', ({ forUser, state }) => {
        const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
        if (!code || socket.id !== sessions[code].hostId)
            return;
        io.to(forUser).emit('sync-state', state);
    });
    socket.on('chat-message', ({ user, message, time }) => {
        const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
        if (!code)
            return;
        const displayName = socket.data.displayName || (user && user.trim()) || 'Guest';
        console.log(`💬 Chat in ${code} from ${displayName}: ${message}`);
        io.to(code).emit('chat-message', {
            user: displayName,
            message,
            time
        });
    });
    /* ------------------ 🖼️ MEDIA SHARE EVENT ------------------ */
    socket.on('media-share', ({ code, fileUrl, fileType, user }) => {
        if (!sessions[code])
            return;
        io.to(code).emit('media-share', { user, fileUrl, fileType });
        console.log(`📤 Media shared in ${code} by ${user}: ${fileUrl}`);
    });
    socket.on('leave-session', ({ code }) => {
        if (!code || !sessions[code])
            return;
        socket.leave(code);
        const name = socket.data.displayName || 'Guest';
        io.to(code).emit('user-left', { userId: socket.id, name });
        if (socket.id === sessions[code].hostId) {
            io.to(code).emit('session-ended', { message: 'Host left the session' });
            delete sessions[code];
            console.log(`❌ Session ${code} ended (host ${name} left)`);
        }
        console.log(`👋 User ${socket.id} (${name}) left session ${code}`);
    });
    socket.on('disconnect', () => {
        const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
        if (code) {
            const name = socket.data.displayName || 'Guest';
            io.to(code).emit('user-left', { userId: socket.id, name });
            if (socket.id === sessions[code].hostId) {
                io.to(code).emit('session-ended', { message: 'Host left the session' });
                delete sessions[code];
                console.log(`❌ Session ${code} ended (host ${name} disconnected)`);
            }
            console.log(`👋 User ${socket.id} (${name}) disconnected from session ${code}`);
        }
    });
});
/* ------------------ EXPRESS ROUTES ------------------ */
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK' });
});
// Media upload route
app.post('/upload', upload.single('media'), (req, res) => {
    if (!req.file)
        return res.status(400).json({ error: 'No file uploaded' });
    const fileUrl = `${process.env.BASE_URL || 'http://localhost:3001'}/uploads/${req.file.filename}`;
    res.json({ fileUrl, fileType: req.file.mimetype });
});
/* ------------------ START SERVER ------------------ */
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`🚀 Listen Together server running on port ${PORT}`);
});
