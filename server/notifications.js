module.exports = function notificationRoutes(db, authenticateToken) {
  const express = require("express");
  const router = express.Router();

  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipient_id INTEGER NOT NULL,
      actor_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('follow', 'like', 'comment')),
      woosh_id INTEGER,
      comment_id INTEGER,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (woosh_id) REFERENCES wooshes(id) ON DELETE CASCADE,
      FOREIGN KEY (comment_id) REFERENCES comments(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created
      ON notifications(recipient_id, is_read, created_at DESC);
  `);

  router.get("/notifications", authenticateToken, (req, res) => {
    try {
      const rows = db.prepare(`
        SELECT n.id, n.type, n.woosh_id AS wooshId, n.comment_id AS commentId,
          n.is_read AS isRead, n.created_at AS createdAt,
          u.username AS actorUsername, u.display_name AS actorDisplayName,
          u.profile_picture AS actorProfilePicture, COALESCE(w.text, '') AS wooshText
        FROM notifications n
        JOIN users u ON u.id = n.actor_id
        LEFT JOIN wooshes w ON w.id = n.woosh_id
        WHERE n.recipient_id = ?
        ORDER BY n.created_at DESC, n.id DESC
        LIMIT 100
      `).all(req.user.userId);
      res.json({ notifications: rows.map((row) => ({ ...row, isRead: Boolean(row.isRead) })) });
    } catch (error) {
      console.error("Load notifications error:", error);
      res.status(500).json({ error: "Could not load notifications." });
    }
  });

  router.get("/notifications/unread-count", authenticateToken, (req, res) => {
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE recipient_id = ? AND is_read = 0").get(req.user.userId);
      res.json({ count: row.count });
    } catch (error) {
      console.error("Unread notification count error:", error);
      res.status(500).json({ error: "Could not load unread count." });
    }
  });

  router.patch("/notifications/:id/read", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid notification ID." });
    try {
      const result = db.prepare("UPDATE notifications SET is_read = 1 WHERE id = ? AND recipient_id = ?").run(id, req.user.userId);
      if (!result.changes) return res.status(404).json({ error: "Notification not found." });
      res.json({ success: true });
    } catch (error) {
      console.error("Mark notification read error:", error);
      res.status(500).json({ error: "Could not update notification." });
    }
  });

  router.patch("/notifications/read-all", authenticateToken, (req, res) => {
    try {
      const result = db.prepare("UPDATE notifications SET is_read = 1 WHERE recipient_id = ? AND is_read = 0").run(req.user.userId);
      res.json({ success: true, updated: result.changes });
    } catch (error) {
      console.error("Mark all notifications read error:", error);
      res.status(500).json({ error: "Could not update notifications." });
    }
  });

  return router;
};
