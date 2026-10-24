const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

module.exports = function createProfileStatusesRouter(db, authenticateToken) {
  const router = express.Router();
  const uploadDir = path.join(__dirname, "uploads", "winds");
  fs.mkdirSync(uploadDir, { recursive: true });

  db.exec(`
    CREATE TABLE IF NOT EXISTS winds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      video_url TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_winds_expiration ON winds(expires_at);
    CREATE TABLE IF NOT EXISTS drops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_drops_expiration ON drops(expires_at);
    CREATE TABLE IF NOT EXISTS pinned_wooshes (
      user_id INTEGER NOT NULL,
      woosh_id INTEGER NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, woosh_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (woosh_id) REFERENCES wooshes(id) ON DELETE CASCADE
    );
  `);

  const storage = multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, uploadDir),
    filename: (_req, file, callback) => {
      const extension = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "");
      callback(null, crypto.randomUUID() + ([".mp4", ".mov", ".m4v", ".webm", ".ogg", ".ogv", ".3gp"].includes(extension) ? extension : ".video"));
    },
  });
  const allowedTypes = new Set(["video/mp4", "video/webm", "video/quicktime", "video/ogg", "video/x-m4v", "video/3gpp", "application/octet-stream"]);
  const allowedExtensions = new Set([".mp4", ".mov", ".m4v", ".webm", ".ogg", ".ogv", ".3gp"]);
  const upload = multer({
    storage,
    limits: { fileSize: 35 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, callback) => {
      const ext = path.extname(file.originalname).toLowerCase();
      callback(null, allowedTypes.has(file.mimetype) || allowedExtensions.has(ext));
    },
  });

  const removeWindFile = (videoUrl) => {
    const prefix = "/uploads/winds/";
    if (typeof videoUrl !== "string" || !videoUrl.startsWith(prefix)) return;
    const filename = path.basename(videoUrl);
    if (filename !== videoUrl.slice(prefix.length)) return;
    fs.unlink(path.join(uploadDir, filename), (error) => {
      if (error && error.code !== "ENOENT") console.error("Could not remove expired Wind video:", error);
    });
  };

  const cleanupExpiredStatuses = () => {
    try {
      const expired = db.prepare("SELECT id, video_url FROM winds WHERE expires_at <= datetime('now') OR user_id NOT IN (SELECT id FROM users)").all();
      const removeExpired = db.transaction(() => {
        db.prepare("DELETE FROM winds WHERE expires_at <= datetime('now') OR user_id NOT IN (SELECT id FROM users)").run();
        db.prepare("DELETE FROM drops WHERE expires_at <= datetime('now') OR user_id NOT IN (SELECT id FROM users)").run();
        db.prepare("DELETE FROM pinned_wooshes WHERE user_id NOT IN (SELECT id FROM users) OR woosh_id NOT IN (SELECT id FROM wooshes)").run();
      });
      removeExpired();
      expired.forEach((wind) => removeWindFile(wind.video_url));
    } catch (error) {
      console.error("Could not clean up expired profile statuses:", error);
    }
  };

  cleanupExpiredStatuses();
  const cleanupTimer = setInterval(cleanupExpiredStatuses, 5 * 60 * 1000);
  if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

  const probeDuration = (filePath) => new Promise((resolve, reject) => {
    const process = spawn("ffprobe", [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1", filePath,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    process.stdout.setEncoding("utf8");
    process.stderr.setEncoding("utf8");
    process.stdout.on("data", (chunk) => { stdout += chunk; });
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    process.on("error", reject);
    process.on("close", (code) => {
      const duration = Number.parseFloat(stdout.trim());
      if (code === 0 && Number.isFinite(duration)) resolve(duration);
      else reject(new Error(stderr.trim() || "Could not read video duration. Make sure FFprobe is installed."));
    });
  });

  const transcodeWind = (inputPath, outputPath) => new Promise((resolve, reject) => {
    const process = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath, "-t", "7",
      "-map", "0:v:0", "-map", "0:a?",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "25",
      "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+faststart", "-f", "mp4", outputPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    process.stderr.setEncoding("utf8");
    process.stderr.on("data", (chunk) => { stderr += chunk; });
    process.on("error", reject);
    process.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || "Could not process this video.")));
  });

  const publicWind = (row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    profilePicture: row.profile_picture || null,
    videoUrl: row.video_url,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });
  const publicDrop = (row) => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    profilePicture: row.profile_picture || null,
    text: row.text,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  });

  router.get("/users/:username/statuses", (req, res) => {
    cleanupExpiredStatuses();
    const user = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(req.params.username);
    if (!user) return res.status(404).json({ error: "User not found." });
    const winds = db.prepare(`
      SELECT w.id, w.video_url, w.created_at, w.expires_at, u.username, u.display_name, u.profile_picture
      FROM winds w JOIN users u ON u.id = w.user_id
      WHERE w.user_id = ? AND w.expires_at > datetime('now')
      ORDER BY w.created_at DESC
    `).all(user.id).map(publicWind);
    const drops = db.prepare(`
      SELECT d.id, d.text, d.created_at, d.expires_at, u.username, u.display_name, u.profile_picture
      FROM drops d JOIN users u ON u.id = d.user_id
      WHERE d.user_id = ? AND d.expires_at > datetime('now')
      ORDER BY d.created_at DESC
    `).all(user.id).map(publicDrop);
    return res.json({ winds, drops });
  });

  router.post("/winds", authenticateToken, (req, res) => {
    upload.single("video")(req, res, async (uploadError) => {
      if (uploadError) return res.status(400).json({ error: uploadError.code === "LIMIT_FILE_SIZE" ? "Wind videos must be 35 MB or smaller." : "Choose a supported video file." });
      if (!req.file) return res.status(400).json({ error: "Choose a video for your Wind." });
      let outputPath = "";
      try {
        const duration = await probeDuration(req.file.path);
        if (duration <= 0 || duration > 7) {
          fs.unlink(req.file.path, () => {});
          return res.status(400).json({ error: "Winds must be 7 seconds or shorter." });
        }
        const outputFilename = crypto.randomUUID() + ".mp4";
        outputPath = path.join(uploadDir, outputFilename);
        await transcodeWind(req.file.path, outputPath);
        fs.unlink(req.file.path, () => {});
        const videoUrl = "/uploads/winds/" + outputFilename;
        const result = db.prepare(`
          INSERT INTO winds (user_id, video_url, expires_at)
          VALUES (?, ?, datetime('now', '+12 hours'))
        `).run(req.user.userId, videoUrl);
        return res.status(201).json({ message: "Wind posted.", id: Number(result.lastInsertRowid), videoUrl, expiresInHours: 12 });
      } catch (error) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        if (outputPath) fs.unlink(outputPath, () => {});
        console.error("Create Wind error:", error);
        return res.status(400).json({ error: error.message?.includes("ffprobe") || error.message?.includes("FFprobe") ? "Video duration could not be checked. Please contact the server administrator." : "Could not process that Wind video. Try an MP4 or MOV file." });
      }
    });
  });

  router.delete("/winds/:id", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid Wind ID." });
    const wind = db.prepare("SELECT id, user_id, video_url FROM winds WHERE id = ?").get(id);
    if (!wind) return res.status(404).json({ error: "Wind not found or already expired." });
    if (wind.user_id !== req.user.userId) return res.status(403).json({ error: "You can only delete your own Winds." });
    db.prepare("DELETE FROM winds WHERE id = ?").run(id);
    removeWindFile(wind.video_url);
    return res.json({ message: "Wind deleted.", id });
  });

  router.post("/drops", authenticateToken, (req, res) => {
    cleanupExpiredStatuses();
    const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "A Drop cannot be empty." });
    if (text.length > 80) return res.status(400).json({ error: "Drops must be 80 characters or fewer." });
    const result = db.prepare(`
      INSERT INTO drops (user_id, text, expires_at)
      VALUES (?, ?, datetime('now', '+24 hours'))
    `).run(req.user.userId, text);
    return res.status(201).json({ message: "Drop posted.", id: Number(result.lastInsertRowid), expiresInHours: 24 });
  });

  router.delete("/drops/:id", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid Drop ID." });
    const drop = db.prepare("SELECT id, user_id FROM drops WHERE id = ?").get(id);
    if (!drop) return res.status(404).json({ error: "Drop not found or already expired." });
    if (drop.user_id !== req.user.userId) return res.status(403).json({ error: "You can only delete your own Drops." });
    db.prepare("DELETE FROM drops WHERE id = ?").run(id);
    return res.json({ message: "Drop deleted.", id });
  });

  router.get("/users/:username/pinned-wooshes", (req, res) => {
    const user = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(req.params.username);
    if (!user) return res.status(404).json({ error: "User not found." });
    db.prepare("DELETE FROM pinned_wooshes WHERE user_id NOT IN (SELECT id FROM users) OR woosh_id NOT IN (SELECT id FROM wooshes)").run();
    const wooshes = db.prepare(`
      SELECT w.id, w.user_id, w.text, w.image, w.created_at, u.username, u.display_name, u.profile_picture, p.position
      FROM pinned_wooshes p
      JOIN wooshes w ON w.id = p.woosh_id
      JOIN users u ON u.id = w.user_id
      WHERE p.user_id = ?
      ORDER BY p.position ASC, p.created_at ASC
    `).all(user.id);
    return res.json({ wooshes });
  });

  router.post("/pinned-wooshes/:wooshId", authenticateToken, (req, res) => {
    const wooshId = Number(req.params.wooshId);
    if (!Number.isInteger(wooshId) || wooshId < 1) return res.status(400).json({ error: "Invalid Woosh ID." });
    const woosh = db.prepare("SELECT id, user_id FROM wooshes WHERE id = ?").get(wooshId);
    if (!woosh) return res.status(404).json({ error: "Woosh not found." });
    if (woosh.user_id !== req.user.userId) return res.status(403).json({ error: "You can only pin your own Wooshes." });
    if (db.prepare("SELECT 1 FROM pinned_wooshes WHERE user_id = ? AND woosh_id = ?").get(req.user.userId, wooshId)) {
      return res.json({ message: "Woosh is already pinned." });
    }
    db.prepare("DELETE FROM pinned_wooshes WHERE user_id NOT IN (SELECT id FROM users) OR woosh_id NOT IN (SELECT id FROM wooshes)").run();
    const count = db.prepare("SELECT COUNT(*) AS count FROM pinned_wooshes WHERE user_id = ?").get(req.user.userId).count;
    if (count >= 3) return res.status(400).json({ error: "You can pin up to 3 Wooshes." });
    db.prepare("INSERT INTO pinned_wooshes (user_id, woosh_id, position) VALUES (?, ?, ?)").run(req.user.userId, wooshId, count);
    return res.status(201).json({ message: "Woosh pinned." });
  });

  router.delete("/pinned-wooshes/:wooshId", authenticateToken, (req, res) => {
    const wooshId = Number(req.params.wooshId);
    if (!Number.isInteger(wooshId) || wooshId < 1) return res.status(400).json({ error: "Invalid Woosh ID." });
    const result = db.prepare("DELETE FROM pinned_wooshes WHERE user_id = ? AND woosh_id = ?").run(req.user.userId, wooshId);
    if (!result.changes) return res.status(404).json({ error: "Pinned Woosh not found." });
    const remaining = db.prepare("SELECT woosh_id FROM pinned_wooshes WHERE user_id = ? ORDER BY position ASC, created_at ASC").all(req.user.userId);
    const updatePosition = db.prepare("UPDATE pinned_wooshes SET position = ? WHERE user_id = ? AND woosh_id = ?");
    db.transaction(() => remaining.forEach((row, index) => updatePosition.run(index, req.user.userId, row.woosh_id)))();
    return res.json({ message: "Woosh unpinned." });
  });

  return router;
};
