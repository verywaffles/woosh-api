const express = require("express");

module.exports = function createSocialRouter(db, authenticateToken) {
  const router = express.Router();

  // Additive schema setup: existing accounts and posts are preserved.
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_follows (
      follower_id INTEGER NOT NULL,
      followed_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, followed_id),
      CHECK (follower_id != followed_id),
      FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (followed_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_id INTEGER NOT NULL,
      actor_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      woosh_id INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (woosh_id) REFERENCES wooshes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON user_follows(follower_id);
    CREATE INDEX IF NOT EXISTS idx_user_follows_followed ON user_follows(followed_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, is_read, created_at);
  `);

  const blocked = (a, b) => {
    try {
      return Boolean(db.prepare(`
        SELECT 1 FROM user_blocks
        WHERE (blocker_id = ? AND blocked_id = ?)
           OR (blocker_id = ? AND blocked_id = ?)
      `).get(a, b, b, a));
    } catch {
      return false;
    }
  };

  const addNotification = (recipientId, actorId, type, wooshId = null) => {
    if (!recipientId || !actorId || recipientId === actorId) return;
    if (blocked(recipientId, actorId)) return;
    db.prepare(`
      INSERT INTO notifications (recipient_id, actor_id, type, woosh_id)
      VALUES (?, ?, ?, ?)
    `).run(recipientId, actorId, type, wooshId);
  };

  const trendingHashtags = (limit = 10, query = "") => {
    const posts = db.prepare(`
      SELECT text FROM wooshes
      WHERE text IS NOT NULL AND text != ''
      ORDER BY id DESC LIMIT 1000
    `).all();
    const counts = new Map();
    const needle = String(query).replace(/^#/, "").toLowerCase();
    for (const post of posts) {
      const seen = new Set();
      for (const match of String(post.text || "").matchAll(/#([a-zA-Z0-9_]+)/g)) {
        const tag = match[1];
        const key = tag.toLowerCase();
        if (needle && !key.includes(needle)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = counts.get(key) || { tag, postCount: 0 };
        entry.postCount += 1;
        counts.set(key, entry);
      }
    }
    return [...counts.values()]
      .sort((a, b) => b.postCount - a.postCount || a.tag.localeCompare(b.tag))
      .slice(0, limit);
  };

  const mapWoosh = (row) => ({
    id: row.id,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    profilePicture: row.profile_picture || null,
    text: row.text || "",
    image: row.image || null,
    createdAt: row.created_at,
    likeCount: row.like_count || 0,
    commentCount: row.comment_count || 0,
  });

  router.get("/explore", (_req, res) => {
    try {
      const popularWooshes = db.prepare(`
        SELECT w.id, w.user_id, w.text, w.image, w.created_at,
          u.username, u.display_name, u.profile_picture,
          (SELECT COUNT(*) FROM likes l WHERE l.woosh_id = w.id) AS like_count,
          (SELECT COUNT(*) FROM comments c WHERE c.woosh_id = w.id) AS comment_count
        FROM wooshes w
        JOIN users u ON u.id = w.user_id
        WHERE w.rewooshed_from_id IS NULL
        ORDER BY like_count DESC, comment_count DESC, w.id DESC
        LIMIT 10
      `).all().map(mapWoosh);

      const recentUsers = db.prepare(`
        SELECT u.id, u.username, u.display_name AS displayName, u.bio,
          u.profile_picture AS profilePicture,
          (SELECT COUNT(*) FROM wooshes w WHERE w.user_id = u.id) AS postCount
        FROM users u
        ORDER BY u.id DESC LIMIT 10
      `).all();

      res.json({
        hashtags: trendingHashtags(10),
        popularWooshes,
        recentUsers,
      });
    } catch (error) {
      console.error("Explore error:", error);
      res.status(500).json({ error: "Could not load Explore." });
    }
  });

  router.get("/search", (req, res) => {
    try {
      const query = String(req.query.q || "").trim().slice(0, 100);
      if (!query) return res.json({ users: [], wooshes: [], hashtags: [] });

      const plainQuery = query.replace(/^@/, "").replace(/^#/, "").toLowerCase();
      const like = `%${plainQuery.replace(/[\\%_]/g, "\\$&")}%`;

      const users = db.prepare(`
        SELECT u.id, u.username, u.display_name AS displayName, u.bio,
          u.profile_picture AS profilePicture,
          (SELECT COUNT(*) FROM wooshes w WHERE w.user_id = u.id) AS postCount
        FROM users u
        WHERE lower(u.username) LIKE ? ESCAPE '\\'
           OR lower(u.display_name) LIKE ? ESCAPE '\\'
        ORDER BY postCount DESC, u.id DESC LIMIT 20
      `).all(like, like);

      const wooshes = db.prepare(`
        SELECT w.id, w.user_id, w.text, w.image, w.created_at,
          u.username, u.display_name, u.profile_picture,
          (SELECT COUNT(*) FROM likes l WHERE l.woosh_id = w.id) AS like_count,
          (SELECT COUNT(*) FROM comments c WHERE c.woosh_id = w.id) AS comment_count
        FROM wooshes w JOIN users u ON u.id = w.user_id
        WHERE lower(COALESCE(w.text, '')) LIKE ? ESCAPE '\\'
        ORDER BY w.id DESC LIMIT 30
      `).all(like).map(mapWoosh);

      res.json({
        users,
        wooshes,
        hashtags: trendingHashtags(20, plainQuery),
      });
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({ error: "Search failed." });
    }
  });

  router.get("/wooshes/following", authenticateToken, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT w.id, w.user_id, w.text, w.image, w.created_at,
          u.username, u.display_name, u.profile_picture,
          (SELECT COUNT(*) FROM likes l WHERE l.woosh_id = w.id) AS like_count,
          (SELECT COUNT(*) FROM comments c WHERE c.woosh_id = w.id) AS comment_count
        FROM wooshes w
        JOIN users u ON u.id = w.user_id
        JOIN user_follows f ON f.followed_id = w.user_id
        WHERE f.follower_id = ?
          AND w.rewooshed_from_id IS NULL
        ORDER BY w.id DESC LIMIT 100
      `).all(req.user.userId).filter((row) => !blocked(req.user.userId, row.user_id));
      res.json({ wooshes: rows.map(mapWoosh) });
    } catch (error) {
      console.error("Following feed error:", error);
      res.status(500).json({ error: "Could not load Following feed." });
    }
  });

  router.get("/notifications/unread-count", authenticateToken, (req, res) => {
    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS count FROM notifications
        WHERE recipient_id = ? AND is_read = 0
      `).get(req.user.userId);
      res.json({ count: row.count || 0 });
    } catch (error) {
      console.error("Unread notification count error:", error);
      res.status(500).json({ error: "Could not load notification count." });
    }
  });

  router.get("/notifications", authenticateToken, (req, res) => {
    try {
      const notifications = db.prepare(`
        SELECT n.id, n.type, n.woosh_id AS wooshId, n.is_read AS isRead,
          n.created_at AS createdAt, u.username AS actorUsername,
          w.text AS wooshText
        FROM notifications n
        JOIN users u ON u.id = n.actor_id
        LEFT JOIN wooshes w ON w.id = n.woosh_id
        WHERE n.recipient_id = ?
        ORDER BY n.id DESC LIMIT 100
      `).all(req.user.userId).map((item) => ({
        ...item,
        isRead: Boolean(item.isRead),
      }));
      res.json({ notifications });
    } catch (error) {
      console.error("Notifications error:", error);
      res.status(500).json({ error: "Could not load notifications." });
    }
  });

  router.patch("/notifications/:id/read", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid notification ID." });
    db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient_id = ?").run(id, req.user.userId);
    res.json({ message: "Notification marked as read." });
  });

  router.patch("/notifications/read-all", authenticateToken, (req, res) => {
    db.prepare("UPDATE notifications SET is_read = 1 WHERE recipient_id = ?").run(req.user.userId);
    res.json({ message: "Notifications marked as read." });
  });

  router.get("/users/:username/follow-status", (req, res) => {
    try {
      const target = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(req.params.username);
      if (!target) return res.status(404).json({ error: "User not found." });
      if (!req.headers.authorization) return res.json({ isFollowing: false });
      authenticateToken(req, res, () => {
        const isFollowing = target.id !== req.user.userId && Boolean(db.prepare(
          "SELECT 1 FROM user_follows WHERE follower_id = ? AND followed_id = ?"
        ).get(req.user.userId, target.id));
        res.json({ isFollowing });
      });
    } catch (error) {
      console.error("Follow status error:", error);
      res.status(500).json({ error: "Could not load follow status." });
    }
  });

  router.post("/users/:username/follow", authenticateToken, (req, res) => {
    try {
      const target = db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(req.params.username);
      if (!target) return res.status(404).json({ error: "User not found." });
      if (target.id === req.user.userId) return res.status(400).json({ error: "You cannot follow yourself." });
      if (blocked(req.user.userId, target.id)) return res.status(403).json({ error: "You cannot follow this account." });
      db.prepare("INSERT OR IGNORE INTO user_follows (follower_id, followed_id) VALUES (?, ?)").run(req.user.userId, target.id);
      addNotification(target.id, req.user.userId, "follow");
      const count = db.prepare("SELECT COUNT(*) AS count FROM user_follows WHERE followed_id = ?").get(target.id).count;
      res.json({ isFollowing: true, followersCount: count });
    } catch (error) {
      console.error("Follow account error:", error);
      res.status(500).json({ error: "Could not follow account." });
    }
  });

  router.delete("/users/:username/follow", authenticateToken, (req, res) => {
    try {
      const target = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(req.params.username);
      if (!target) return res.status(404).json({ error: "User not found." });
      db.prepare("DELETE FROM user_follows WHERE follower_id = ? AND followed_id = ?").run(req.user.userId, target.id);
      const count = db.prepare("SELECT COUNT(*) AS count FROM user_follows WHERE followed_id = ?").get(target.id).count;
      res.json({ isFollowing: false, followersCount: count });
    } catch (error) {
      console.error("Unfollow account error:", error);
      res.status(500).json({ error: "Could not unfollow account." });
    }
  });

  return router;
};
