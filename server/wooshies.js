const express = require("express");

module.exports = function createWooshiesRouter(db, authenticateToken) {
  const router = express.Router();

  const mapWooshie = (row) => ({
    id: row.id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    profilePicture: row.profile_picture || null,
    videoUrl: row.video_url,
    caption: row.caption || "",
    createdAt: row.created_at,
    likeCount: row.like_count || 0,
    likedByMe: Boolean(row.liked_by_me),
  });

  router.get("/", (req, res) => {
    try {
      const viewerId = Number(req.query.viewerId) || 0;
      const rows = db.prepare(`
        SELECT
          w.id, w.user_id, w.video_url, w.caption, w.created_at,
          u.username, u.display_name, u.profile_picture,
          (SELECT COUNT(*) FROM wooshie_likes l WHERE l.wooshie_id = w.id) AS like_count,
          EXISTS(
            SELECT 1 FROM wooshie_likes mine
            WHERE mine.wooshie_id = w.id AND mine.user_id = ?
          ) AS liked_by_me
        FROM wooshies w
        JOIN users u ON u.id = w.user_id
        ORDER BY w.id DESC
        LIMIT 100
      `).all(viewerId);
      res.json({ wooshies: rows.map(mapWooshie) });
    } catch (error) {
      console.error("Load Wooshies error:", error);
      res.status(500).json({ error: "Could not load Wooshies." });
    }
  });

  router.post("/", authenticateToken, (req, res) => {
    try {
      const videoUrl = typeof req.body.videoUrl === "string" ? req.body.videoUrl.trim() : "";
      const caption = typeof req.body.caption === "string" ? req.body.caption.trim() : "";
      if (!videoUrl) return res.status(400).json({ error: "A video URL is required." });
      if (videoUrl.length > 2048) return res.status(400).json({ error: "Video URL is too long." });
      if (caption.length > 500) return res.status(400).json({ error: "Caption must be 500 characters or less." });
      let parsed;
      try { parsed = new URL(videoUrl); } catch { return res.status(400).json({ error: "Enter a valid video URL." }); }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return res.status(400).json({ error: "Video URL must use HTTP or HTTPS." });
      }
      const result = db.prepare(`
        INSERT INTO wooshies (user_id, video_url, caption)
        VALUES (?, ?, ?)
      `).run(req.user.userId, videoUrl, caption);
      const row = db.prepare(`
        SELECT w.id, w.user_id, w.video_url, w.caption, w.created_at,
          u.username, u.display_name, u.profile_picture, 0 AS like_count, 0 AS liked_by_me
        FROM wooshies w JOIN users u ON u.id = w.user_id WHERE w.id = ?
      `).get(Number(result.lastInsertRowid));
      res.status(201).json({ wooshie: mapWooshie(row) });
    } catch (error) {
      console.error("Create Wooshie error:", error);
      res.status(500).json({ error: "Could not create Wooshie." });
    }
  });

  router.post("/:id/like", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid Wooshie ID." });
    try {
      if (!db.prepare("SELECT id FROM wooshies WHERE id = ?").get(id)) {
        return res.status(404).json({ error: "Wooshie not found." });
      }
      const existingLike = db.prepare("SELECT 1 FROM wooshie_likes WHERE user_id = ? AND wooshie_id = ?").get(req.user.userId, id);
      if (existingLike) {
        db.prepare("DELETE FROM wooshie_likes WHERE user_id = ? AND wooshie_id = ?").run(req.user.userId, id);
      } else {
        db.prepare("INSERT INTO wooshie_likes (user_id, wooshie_id) VALUES (?, ?)").run(req.user.userId, id);
      }
      const likeCount = db.prepare("SELECT COUNT(*) AS count FROM wooshie_likes WHERE wooshie_id = ?").get(id).count;
      res.json({ liked: !existingLike, likeCount });
    } catch (error) {
      console.error("Toggle Wooshie like error:", error);
      res.status(500).json({ error: "Could not update like." });
    }
  });

  return router;
};
