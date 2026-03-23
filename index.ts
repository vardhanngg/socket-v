import dotenv from "dotenv";

dotenv.config();

import { v2 as cloudinary } from "cloudinary";
console.log("Cloudinary config env vars:", {
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET ? '***' : undefined,
});

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET,
});

import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import path from "path";
import fs from "fs";
import cors from "cors";
let corsOrigins: string | string[] = "*"; // ✅ fixed type
if (process.env.CORS_ORIGIN) {
  try {
    corsOrigins = process.env.CORS_ORIGIN.split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin && /^https?:\/\/[\w\-.:]+$/.test(origin));
    console.log("Parsed CORS origins:", corsOrigins);
    if (corsOrigins.length === 0) {
      console.warn("No valid CORS origins found, falling back to *");
      corsOrigins = "*";
    }
  } catch (err) {
    console.error(
      "Error parsing CORS_ORIGIN:",
      err instanceof Error ? err.message : String(err)
    );
    corsOrigins = "*";
  }
}

const app = express();
const server = http.createServer(app);

// Parse CORS_ORIGIN safely
app.use(cors({
  origin: corsOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
}));



const io = new Server(server, {
  cors: {
    origin: corsOrigins,
    methods: ["GET", "POST"],
  },
});

/* ------------------ MEDIA UPLOAD SETUP ------------------ */

// Create /uploads folder if missing
const uploadDir = path.resolve("./uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Configure Multer for local file uploads
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const userName = req.body.name || "anonymous"; // Get name from request or default to "anonymous"
    const sanitizedUserName = userName.replace(/\s+/g, "_"); // Replace spaces with underscores
    const unique = Date.now() + "-" + Math.round(Math.random() * 1e9); // Generate unique suffix
    const fileExtension = path.extname(file.originalname); // Extract file extension
    
    // Create filename: "username-uniqueNumber.extension"
    cb(null, sanitizedUserName + "-" + unique + fileExtension);
  },
});

const upload = multer({ storage });

// Serve uploaded files as static content
//app.use("/uploads", express.static(uploadDir));

/* ------------------ EXISTING SESSION SYSTEM ------------------ */

// ✅ add proper typing for sessions
const sessions: Record<string, { hostId: string; participants: Record<string, { name: string; isHost: boolean }> }> = {};

// Generate unique 6-char code
function generateCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  if (sessions[code]) return generateCode();
  return code;
}

io.on("connection", (socket) => {
  console.log(
    `🔌 New connection: ${socket.id} (name not set yet), transport: ${socket.conn.transport.name}`
  );
  socket.conn.on("upgrade", () =>
    console.log(`Upgraded to WebSocket: ${socket.id}`)
  );

  socket.on("create-session", () => {
    const code = generateCode();
    socket.join(code);
    sessions[code] = {
      hostId: socket.id,
      participants: {}
    };
    // Add host to participants right away (name set later on join-session)
    sessions[code].participants[socket.id] = { name: socket.data.displayName || 'Host', isHost: true };
    socket.emit("session-created", { code });
    socket.emit("user-joined", { userId: socket.id, isHost: true });
    io.to(code).emit("participantsUpdate", sessions[code].participants);
    console.log(
      `📀 Session created: ${code} by host ${socket.data.displayName || socket.id}`
    );
  });

  socket.on("transfer-host", ({ code, newHostId }) => {
    if (!code || !sessions[code]) {
      socket.emit("error", { message: "Invalid session for host transfer" });
      return;
    }
    if (socket.id !== sessions[code].hostId) {
      socket.emit("error", {
        message: "Only the current host can transfer host rights",
      });
      return;
    }

    sessions[code].hostId = newHostId;
    io.to(code).emit("host-transferred", { newHostId });

    console.log(
      `👑 Host rights in ${code} transferred from ${
        socket.data.displayName || socket.id
      } to ${newHostId}`
    );
  });

  socket.on("join-session", ({ code, name }, callback) => {
    if (!code || !sessions[code]) {
      if (callback) callback(false);
      socket.emit("error", { message: "Invalid session code" });
      return;
    }

    socket.join(code);

    const isHost = socket.id === sessions[code].hostId;
    const displayName = name && name.trim() ? name : "Guest";
    socket.data.displayName = displayName;

    // Add to participants map
    sessions[code].participants[socket.id] = { name: displayName, isHost };

    io.to(code).emit("user-joined", {
      userId: socket.id,
      name: displayName,
      isHost,
    });

    // Send authoritative participant list to all
    io.to(code).emit("participantsUpdate", sessions[code].participants);

    socket.emit("session-joined", { code, isHost, name: displayName });
    if (callback) callback(true);

    socket.to(sessions[code].hostId).emit("request-state", {
      forUser: socket.id,
    });

    console.log(`✅ User ${socket.id} (${displayName}) joined session ${code}`);
  });

  socket.on("playback-control", (data) => {
    const code = Array.from(socket.rooms).find(
      (r) => r !== socket.id && sessions[r]
    );
    if (!code || socket.id !== sessions[code].hostId) {
      socket.emit("error", { message: "Only host can control playback" });
      return;
    }
    io.to(code).emit("playback-control", data);
    console.log(
      `🎵 Playback control in ${code} by ${
        socket.data.displayName || socket.id
      }: ${data.action}`
    );
  });

  socket.on("sync-state", (data) => {
    const code = Array.from(socket.rooms).find(
      (r) => r !== socket.id && sessions[r]
    );
    if (!code || socket.id !== sessions[code].hostId) return;
    io.to(code).emit("sync-state", data);
  });

  socket.on("provide-state", ({ forUser, state }) => {
    const code = Array.from(socket.rooms).find(
      (r) => r !== socket.id && sessions[r]
    );
    if (!code || socket.id !== sessions[code].hostId) return;
    io.to(forUser).emit("sync-state", state);
  });

  socket.on("chat-message", ({ user, message, time }) => {
    const code = Array.from(socket.rooms).find(
      (r) => r !== socket.id && sessions[r]
    );
    if (!code) return;

    const displayName =
      socket.data.displayName || (user && user.trim()) || "Guest";

    console.log(`💬 Chat in ${code} from ${displayName}: ${message}`);

    io.to(code).emit("chat-message", {
      user: displayName,
      message,
      time,
    });
  });

  /* ------------------ 🎵 SONG SUGGESTION EVENT ------------------ */
  socket.on("suggest-song", ({ code, song, from }) => {
    if (!code || !sessions[code]) return;
    io.to(sessions[code].hostId).emit("song-suggested", { song, from });
    console.log(`✋ Song suggested in ${code} by ${from}: ${song?.title}`);
  });

  socket.on("kick-participant", ({ code, userId }) => {
    if (!code || !sessions[code]) return;
    if (socket.id !== sessions[code].hostId) {
      socket.emit("error", { message: "Only host can remove participants" });
      return;
    }
    const name = sessions[code].participants[userId]?.name || "Guest";
    // Tell the kicked user
    io.to(userId).emit("kicked");
    // Tell the room
    delete sessions[code].participants[userId];
    io.to(code).emit("user-left", { userId, name });
    io.to(code).emit("participantsUpdate", sessions[code].participants);
    // Force disconnect from room
    const kickedSocket = io.sockets.sockets.get(userId);
    if (kickedSocket) kickedSocket.leave(code);
    console.log(`👟 User ${userId} (${name}) kicked from session ${code}`);
  });

  /* ------------------ 🖼️ MEDIA SHARE EVENT ------------------ */
  socket.on("media-share", ({ code, fileUrl, fileType, user }) => {
    if (!sessions[code]) return;
    io.to(code).emit("media-share", { user, fileUrl, fileType });
    console.log(`📤 Media shared in ${code} by ${user}: ${fileUrl}`);
  });

  socket.on("leave-session", ({ code }) => {
    if (!code || !sessions[code]) return;

    socket.leave(code);

    const name = socket.data.displayName || "Guest";

    // Remove from participants map
    delete sessions[code].participants[socket.id];

    io.to(code).emit("user-left", { userId: socket.id, name });
    // Send authoritative updated list
    io.to(code).emit("participantsUpdate", sessions[code].participants);

    if (socket.id === sessions[code].hostId) {
      io.to(code).emit("session-ended", { message: "Host left the session" });
      delete sessions[code];
      console.log(`❌ Session ${code} ended (host ${name} left)`);
    }
    console.log(`👋 User ${socket.id} (${name}) left session ${code}`);
  });

  socket.on("disconnect", () => {
    const code = Array.from(socket.rooms).find(
      (r) => r !== socket.id && sessions[r]
    );

    if (code) {
      const name = socket.data.displayName || "Guest";

      // Remove from participants map
      delete sessions[code].participants[socket.id];

      io.to(code).emit("user-left", { userId: socket.id, name });
      // Send authoritative updated list
      io.to(code).emit("participantsUpdate", sessions[code].participants);

      if (socket.id === sessions[code].hostId) {
        io.to(code).emit("session-ended", {
          message: "Host left the session",
        });
        delete sessions[code];
        console.log(`❌ Session ${code} ended (host ${name} disconnected)`);
      }

      console.log(`👋 User ${socket.id} (${name}) disconnected from ${code}`);
    }
  });
});

/* ------------------ EXPRESS ROUTES ------------------ */

app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK" });
});

// ✅ Typed file upload route
app.post("/upload", upload.single("media"), async (req, res) => {
  const file = req.file as Express.Multer.File | undefined;
  const userName = req.body.name; // Ensure that the user's name is passed in the request

  if (!file || !userName) {
    return res.status(400).json({ error: "No file uploaded or name missing" });
  }

  try {
    const result = await cloudinary.uploader.upload(file.path, {
      folder: "vibron_uploads", // optional: name of folder in Cloudinary
    });

    // Delete temp file after upload
    fs.unlinkSync(file.path);

    res.json({ fileUrl: result.secure_url, fileType: file.mimetype });
  } catch (err) {
    console.error("Upload to Cloudinary failed:", err);
    res.status(500).json({ error: "Cloudinary upload failed" });
  }
});



/* ------------------ START SERVER ------------------ */
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 Listen Together server running on port ${PORT}`);
});
