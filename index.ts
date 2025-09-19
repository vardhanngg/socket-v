import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const server = http.createServer(app);

// Parse CORS_ORIGIN safely
let corsOrigins: string | string[] = '*'; // Default to wildcard for safety
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
  } catch (err: any) { // Explicitly type err as 'any' or 'Error'
    console.error('Error parsing CORS_ORIGIN:', err instanceof Error ? err.message : String(err));
    corsOrigins = '*';
  }
}

const io = new Server(server, {
  cors: {
    origin: corsOrigins,
    methods: ['GET', 'POST'],
  },
});

// In-memory storage for sessions (code -> {hostId: socket.id})
const sessions: { [code: string]: { hostId: string } } = {};

// Generate unique 6-char code
function generateCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  if (sessions[code]) return generateCode();
  return code;
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}, transport: ${socket.conn.transport.name}`);
  socket.conn.on('upgrade', () => console.log(`Upgraded to WebSocket: ${socket.id}`));

  socket.on('create-session', () => {
    const code = generateCode();
    socket.join(code);
    sessions[code] = { hostId: socket.id };
    socket.emit('session-created', { code });
    socket.emit('user-joined', { userId: socket.id, isHost: true });
    console.log(`Session created: ${code} by host ${socket.id}`);
  });

  socket.on('transfer-host', ({ code, newHostId }) => {
  // check session exists
  if (!code || !sessions[code]) {
    socket.emit('error', { message: 'Invalid session for host transfer' });
    return;
  }

  // only current host can transfer
  if (socket.id !== sessions[code].hostId) {
    socket.emit('error', { message: 'Only the current host can transfer host rights' });
    return;
  }

  // update host
  sessions[code].hostId = newHostId;

  // notify everyone in the session
  io.to(code).emit('host-transferred', { newHostId });

  console.log(`Host rights for session ${code} transferred to ${newHostId}`);
});
  

socket.on('join-session', ({ code, name }, callback) => {
  if (!code || !sessions[code]) {
    if (callback) callback(false);
    socket.emit('error', { message: 'Invalid session code' });
    return;
  }

  socket.join(code);

  const isHost = socket.id === sessions[code].hostId;
  const displayName = name && name.trim() ? name : "Guest";

  // broadcast join with name
  io.to(code).emit('user-joined', { userId: socket.id, name: displayName, isHost });

  // tell just this client that they joined successfully
  socket.emit('session-joined', { code, isHost, name: displayName });

  // if frontend expected callback, send success
  if (callback) callback(true);

  // request state from host
  socket.to(sessions[code].hostId).emit('request-state', { forUser: socket.id });

  console.log(`User ${socket.id} (${displayName}) joined session ${code}`);
});


  socket.on('playback-control', (data) => {
    const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
    if (!code || socket.id !== sessions[code].hostId) {
      socket.emit('error', { message: 'Only host can control playback' });
      return;
    }
    io.to(code).emit('playback-control', data);
    console.log(`Playback control in ${code}: ${data.action}`);
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
/*
  socket.on('chat-message', ({ message }) => {
    const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
    if (!code) return;
    io.to(code).emit('chat-message', { userId: socket.id, message });
  });*/

  socket.on('chat-message', ({ user, message, time }) => {
  const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
  if (!code) return;

  io.to(code).emit('chat-message', {
    user: user && user.trim() ? user : 'Guest',
    message,
    time
  });
});


  socket.on('leave-session', ({ code }) => {
    if (!code || !sessions[code]) return;
    socket.leave(code);
    io.to(code).emit('user-left', { userId: socket.id });
    if (socket.id === sessions[code].hostId) {
      io.to(code).emit('session-ended', { message: 'Host left the session' });
      delete sessions[code];
      console.log(`Session ${code} ended (host left)`);
    }
    console.log(`User ${socket.id} left session ${code}`);
  });

  socket.on('disconnect', () => {
    const code = Array.from(socket.rooms).find((r) => r !== socket.id && sessions[r]);
    if (code) {
      io.to(code).emit('user-left', { userId: socket.id });
      if (socket.id === sessions[code].hostId) {
        io.to(code).emit('session-ended', { message: 'Host left the session' });
        delete sessions[code];
        console.log(`Session ${code} ended (host left)`);
      }
      console.log(`User ${socket.id} left session ${code}`);
    }
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK' });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Listen Together server running on port ${PORT}`);
});   