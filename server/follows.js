// Follow relationships and follower counts.
module.exports = function followRoutes(db, authenticateToken) {
  const express = require("express");
  const router = express.Router();

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_follows (
      follower_id INTEGER NOT NULL,
      following_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (follower_id, following_id),
      CHECK (follower_id != following_id),
      FOREIGN KEY (follower_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (following_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_user_follows_following
      ON user_follows(following_id, follower_id);
  `);

  router.get("/users/:username/follow-status", authenticateToken, (req, res) => {
    const target = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(req.params.username);
    if (!target) return res.status(404).json({ error: "User not found." });
    const isFollowing = Boolean(db.prepare("SELECT 1 FROM user_follows WHERE follower_id = ? AND following_id = ?").get(req.user.userId, target.id));
    const followersCount = db.prepare("SELECT COUNT(*) AS count FROM user_follows WHERE following_id = ?").get(target.id).count;
    const followingCount = db.prepare("SELECT COUNT(*) AS count FROM user_follows WHERE follower_id = ?").get(target.id).count;
    res.json({ isFollowing, followersCount, followingCount });
  });

  router.post("/users/:username/follow", authenticateToken, (req, res) => {
    const target = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(req.params.username);
    if (!target) return res.status(404).json({ error: "User not found." });
    if (target.id === req.user.userId) return res.status(400).json({ error: "You cannot follow yourself." });
    const inserted = db.prepare("INSERT OR IGNORE INTO user_follows (follower_id, following_id) VALUES (?, ?)").run(req.user.userId, target.id);
    if (inserted.changes) {
      db.prepare("INSERT INTO notifications (recipient_id, actor_id, type) VALUES (?, ?, 'follow')").run(target.id, req.user.userId);
    }
    const followersCount = db.prepare("SELECT COUNT(*) AS count FROM user_follows WHERE following_id = ?").get(target.id).count;
    res.json({ isFollowing: true, followersCount });
  });

  router.delete("/users/:username/follow", authenticateToken, (req, res) => {
    const target = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(req.params.username);
    if (!target) return res.status(404).json({ error: "User not found." });
    if (target.id === req.user.userId) return res.status(400).json({ error: "You cannot unfollow yourself." });
    db.prepare("DELETE FROM user_follows WHERE follower_id = ? AND following_id = ?").run(req.user.userId, target.id);
    const followersCount = db.prepare("SELECT COUNT(*) AS count FROM user_follows WHERE following_id = ?").get(target.id).count;
    res.json({ isFollowing: false, followersCount });
  });

  return router;
};
