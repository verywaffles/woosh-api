const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

module.exports = function createWooshiesRouter(db, authenticateToken) {
  const router = express.Router();
  const uploadDir = path.join(__dirname, "uploads", "wooshies");
  fs.mkdirSync(uploadDir, { recursive: true });

  // Safe, additive migration: existing Wooshies and accounts are preserved.
  db.exec(`
    CREATE TABLE IF NOT EXISTS wooshie_views (
      user_id INTEGER NOT NULL,
      wooshie_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, wooshie_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (wooshie_id) REFERENCES wooshies(id) ON DELETE CASCADE
    );
  `);
  // Accept common browser video MIME types and Apple video extensions. FFmpeg validates the actual file.
  const allowedExtensions = new Set([".mp4", ".m4v", ".mov", ".webm", ".ogg", ".ogv", ".3gp", ".3gpp", ".avi", ".mkv"]);
  const allowedTypes = new Set(["video/mp4", "video/webm", "video/quicktime", "video/ogg", "video/x-m4v", "video/3gpp", "video/x-msvideo", "video/x-matroska", "application/octet-stream"]);
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, "");
      cb(null, crypto.randomUUID() + ext);
    },
  });
  const upload = multer({
    storage,
    limits: { fileSize: 100 * 1024 * 1024, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, allowedTypes.has(file.mimetype) || allowedExtensions.has(ext));
    },
  });

  // Normalize every accepted upload to browser-friendly H.264/AAC MP4 and keep only its first 15 seconds.
  // This also handles common iPhone/iPad MOV files and HEVC input when the installed FFmpeg supports it.
  const transcodeVideo = (inputPath, outputPath) => new Promise((resolve, reject) => {
    const { spawn } = require("child_process");
    const ffmpeg = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", inputPath,
      "-t", "15",
      "-map", "0:v:0",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-f", "mp4",
      outputPath,
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let errorOutput = "";
    ffmpeg.stderr.setEncoding("utf8");
    ffmpeg.stderr.on("data", (chunk) => { errorOutput += chunk; });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorOutput.trim() || "FFmpeg could not convert the uploaded video."));
    });
  });
  const mapComment = (row) => ({ id: row.id, username: row.username, displayName: row.display_name, text: row.text, createdAt: row.created_at });
  const getComments = (id) => db.prepare(`
    SELECT c.id, c.text, c.created_at, u.username, u.display_name
    FROM wooshie_comments c JOIN users u ON u.id = c.user_id
    WHERE c.wooshie_id = ? ORDER BY c.id ASC LIMIT 200
  `).all(id).map(mapComment);
  const mapWooshie = (row) => ({
    id: row.id, userId: row.user_id, username: row.username, displayName: row.display_name,
    profilePicture: row.profile_picture || null, videoUrl: row.video_url, caption: row.caption || "",
    createdAt: row.created_at, likeCount: row.like_count || 0, likedByMe: Boolean(row.liked_by_me),
    commentCount: row.comment_count || 0, viewCount: row.view_count || 0, comments: getComments(row.id),
  });

  router.get("/", (req, res) => {
    try {
      const viewerId = Number(req.query.viewerId) || 0;
      const rows = db.prepare(`
        SELECT w.id, w.user_id, w.video_url, w.caption, w.created_at,
          u.username, u.display_name, u.profile_picture,
          (SELECT COUNT(*) FROM wooshie_likes l WHERE l.wooshie_id = w.id) AS like_count,
          (SELECT COUNT(*) FROM wooshie_comments c WHERE c.wooshie_id = w.id) AS comment_count,
          EXISTS(SELECT 1 FROM wooshie_likes mine WHERE mine.wooshie_id = w.id AND mine.user_id = ?) AS liked_by_me
        FROM wooshies w JOIN users u ON u.id = w.user_id ORDER BY w.id DESC LIMIT 100
      `).all(viewerId);
      res.json({ wooshies: rows.map(mapWooshie) });
    } catch (error) {
      console.error("Load Wooshies error:", error);
      res.status(500).json({ error: "Could not load Wooshies." });
    }
  });

  router.post("/", authenticateToken, (req, res) => {
    upload.single("video")(req, res, async (error) => {
      if (error) return res.status(400).json({ error: error.code === "LIMIT_FILE_SIZE" ? "Video must be 100 MB or smaller." : "Could not upload that video." });
      if (!req.file) return res.status(400).json({ error: "Choose a supported video file (MP4, WebM, MOV, or OGG)." });
      const outputFilename = crypto.randomUUID() + ".mp4";
      const outputPath = path.join(uploadDir, outputFilename);
      try {
        await transcodeVideo(req.file.path, outputPath);
        fs.unlink(req.file.path, () => {});
      } catch (conversionError) {
        fs.unlink(req.file.path, () => {});
        fs.unlink(outputPath, () => {});
        console.error("Wooshie video conversion error:", conversionError.message);
        return res.status(400).json({ error: "Couldn't process this video. Try an iPhone MOV or MP4 video." });
      }
      const caption = typeof req.body.caption === "string" ? req.body.caption.trim() : "";
      if (caption.length > 500) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ error: "Caption must be 500 characters or less." });
      }
      try {
        const videoUrl = "/uploads/wooshies/" + outputFilename;
        const result = db.prepare("INSERT INTO wooshies (user_id, video_url, caption) VALUES (?, ?, ?)").run(req.user.userId, videoUrl, caption);
        const row = db.prepare(`
          SELECT w.id, w.user_id, w.video_url, w.caption, w.created_at,
            u.username, u.display_name, u.profile_picture, 0 AS like_count, 0 AS liked_by_me, 0 AS comment_count, 0 AS view_count
          FROM wooshies w JOIN users u ON u.id = w.user_id WHERE w.id = ?
        `).get(Number(result.lastInsertRowid));
        res.status(201).json({ wooshie: mapWooshie(row) });
      } catch (dbError) {
        fs.unlink(outputPath, () => {});
        console.error("Create Wooshie error:", dbError);
        res.status(500).json({ error: "Could not publish Wooshie." });
      }
    });
  });

  router.delete("/:id", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid Wooshie ID." });
    try {
      const wooshie = db.prepare("SELECT id, user_id, video_url FROM wooshies WHERE id = ?").get(id);
      if (!wooshie) return res.status(404).json({ error: "Wooshie not found." });
      if (wooshie.user_id !== req.user.userId) return res.status(403).json({ error: "You can only delete your own Wooshies." });
      db.transaction(() => {
        db.prepare("DELETE FROM wooshie_comments WHERE wooshie_id = ?").run(id);
        db.prepare("DELETE FROM wooshie_likes WHERE wooshie_id = ?").run(id);
        db.prepare("DELETE FROM wooshies WHERE id = ?").run(id);
      })();
      const prefix = "/uploads/wooshies/";
      if (typeof wooshie.video_url === "string" && wooshie.video_url.startsWith(prefix)) {
        const filename = path.basename(wooshie.video_url);
        if (filename === wooshie.video_url.slice(prefix.length)) {
          fs.unlink(path.join(uploadDir, filename), (error) => {
            if (error && error.code !== "ENOENT") console.error("Could not remove deleted Wooshie video:", error);
          });
        }
      }
      return res.json({ message: "Wooshie deleted.", id });
    } catch (error) {
      console.error("Delete Wooshie error:", error);
      return res.status(500).json({ error: "Could not delete Wooshie." });
    }
  });


  // Count at most one view per signed-in viewer per Wooshie.
  router.post("/:id/view", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid Wooshie ID." });
    try {
      if (!db.prepare("SELECT id FROM wooshies WHERE id = ?").get(id)) return res.status(404).json({ error: "Wooshie not found." });
      db.prepare("INSERT OR IGNORE INTO wooshie_views (user_id, wooshie_id) VALUES (?, ?)").run(req.user.userId, id);
      const viewCount = db.prepare("SELECT COUNT(*) AS count FROM wooshie_views WHERE wooshie_id = ?").get(id).count;
      return res.json({ viewCount });
    } catch (error) {
      console.error("Record Wooshie view error:", error);
      return res.status(500).json({ error: "Could not record view." });
    }
  });

  router.post("/:id/like", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid Wooshie ID." });
    try {
      if (!db.prepare("SELECT id FROM wooshies WHERE id = ?").get(id)) return res.status(404).json({ error: "Wooshie not found." });
      const existing = db.prepare("SELECT 1 FROM wooshie_likes WHERE user_id = ? AND wooshie_id = ?").get(req.user.userId, id);
      if (existing) db.prepare("DELETE FROM wooshie_likes WHERE user_id = ? AND wooshie_id = ?").run(req.user.userId, id);
      else db.prepare("INSERT INTO wooshie_likes (user_id, wooshie_id) VALUES (?, ?)").run(req.user.userId, id);
      const likeCount = db.prepare("SELECT COUNT(*) AS count FROM wooshie_likes WHERE wooshie_id = ?").get(id).count;
      res.json({ liked: !existing, likeCount });
    } catch (error) {
      console.error("Toggle Wooshie like error:", error);
      res.status(500).json({ error: "Could not update like." });
    }
  });

  router.post("/:id/comments", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid Wooshie ID." });
    if (!text || text.length > 1000) return res.status(400).json({ error: "Comment must be between 1 and 1000 characters." });
    try {
      if (!db.prepare("SELECT id FROM wooshies WHERE id = ?").get(id)) return res.status(404).json({ error: "Wooshie not found." });
      const result = db.prepare("INSERT INTO wooshie_comments (user_id, wooshie_id, text) VALUES (?, ?, ?)").run(req.user.userId, id, text);
      const row = db.prepare(`
        SELECT c.id, c.text, c.created_at, u.username, u.display_name
        FROM wooshie_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?
      `).get(Number(result.lastInsertRowid));
      res.status(201).json({ comment: mapComment(row) });
    } catch (error) {
      console.error("Create Wooshie comment error:", error);
      res.status(500).json({ error: "Could not post comment." });
    }
  });
  return router;
};
