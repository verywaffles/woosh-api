const express = require("express");

module.exports = function createBlabbersRouter(db, authenticateToken) {
  const router = express.Router();

  db.exec(`
    CREATE TABLE IF NOT EXISTS blabbers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
      owner_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS blabber_members (
      blabber_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (blabber_id, user_id),
      FOREIGN KEY (blabber_id) REFERENCES blabbers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS blabber_invites (
      blabber_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      invited_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (blabber_id, user_id),
      FOREIGN KEY (blabber_id) REFERENCES blabbers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS blabber_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      blabber_id INTEGER NOT NULL,
      from_user_id INTEGER NOT NULL,
      to_user_id INTEGER NOT NULL,
      signal_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (blabber_id) REFERENCES blabbers(id) ON DELETE CASCADE,
      FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);

  const isMember = (roomId, userId) => !!db.prepare(
    "SELECT 1 FROM blabber_members WHERE blabber_id = ? AND user_id = ?"
  ).get(roomId, userId);
  const roomById = (roomId) => db.prepare(`
    SELECT b.id, b.name, b.visibility, b.owner_id, b.created_at,
      u.username AS owner_username,
      (SELECT COUNT(*) FROM blabber_members m WHERE m.blabber_id = b.id) AS member_count
    FROM blabbers b JOIN users u ON u.id = b.owner_id WHERE b.id = ?
  `).get(roomId);
  const visibleTo = (room, userId) => room && (
    room.visibility === "public" ||
    room.owner_id === userId ||
    isMember(room.id, userId) ||
    !!db.prepare("SELECT 1 FROM blabber_invites WHERE blabber_id = ? AND user_id = ?").get(room.id, userId)
  );
  const serializeRoom = (room, userId) => ({
    id: room.id, name: room.name, visibility: room.visibility,
    ownerId: room.owner_id, ownerUsername: room.owner_username,
    memberCount: room.member_count, createdAt: room.created_at,
    isMember: isMember(room.id, userId),
    isOwner: room.owner_id === userId,
    invited: !!db.prepare("SELECT 1 FROM blabber_invites WHERE blabber_id = ? AND user_id = ?").get(room.id, userId),
    members: db.prepare(`
      SELECT u.id, u.username, u.display_name AS displayName
      FROM blabber_members m JOIN users u ON u.id = m.user_id
      WHERE m.blabber_id = ? ORDER BY m.joined_at
    `).all(room.id)
  });

  router.get("/", authenticateToken, (req, res) => {
    try {
      const rooms = db.prepare(`
        SELECT b.id FROM blabbers b
        WHERE b.visibility = 'public'
          OR b.owner_id = ?
          OR EXISTS (SELECT 1 FROM blabber_members m WHERE m.blabber_id = b.id AND m.user_id = ?)
          OR EXISTS (SELECT 1 FROM blabber_invites i WHERE i.blabber_id = b.id AND i.user_id = ?)
        ORDER BY b.id DESC LIMIT 100
      `).all(req.user.userId, req.user.userId, req.user.userId)
        .map(({ id }) => serializeRoom(roomById(id), req.user.userId));
      res.json({ blabbers: rooms });
    } catch (error) {
      console.error("List Blabbers error:", error);
      res.status(500).json({ error: "Could not load Blabbers." });
    }
  });

  router.post("/", authenticateToken, (req, res) => {
    try {
      const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
      const visibility = req.body.visibility === "private" ? "private" : "public";
      const invitees = Array.isArray(req.body.invitees) ? req.body.invitees : [];
      if (!name || name.length > 60) return res.status(400).json({ error: "Blabber name must be 1–60 characters." });
      const create = db.transaction(() => {
        const result = db.prepare("INSERT INTO blabbers (name, visibility, owner_id) VALUES (?, ?, ?)").run(name, visibility, req.user.userId);
        const id = Number(result.lastInsertRowid);
        db.prepare("INSERT INTO blabber_members (blabber_id, user_id) VALUES (?, ?)").run(id, req.user.userId);
        if (visibility === "private") {
          for (const raw of invitees.slice(0, 50)) {
            const username = typeof raw === "string" ? raw.trim() : "";
            if (!username) continue;
            const user = db.prepare("SELECT id FROM users WHERE username = ? COLLATE NOCASE").get(username);
            if (user && user.id !== req.user.userId) {
              db.prepare("INSERT OR IGNORE INTO blabber_invites (blabber_id, user_id, invited_by) VALUES (?, ?, ?)").run(id, user.id, req.user.userId);
            }
          }
        }
        return id;
      });
      const id = create();
      res.status(201).json({ blabber: serializeRoom(roomById(id), req.user.userId) });
    } catch (error) {
      console.error("Create Blabber error:", error);
      res.status(500).json({ error: "Could not create Blabber." });
    }
  });

  router.post("/:id/join", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    const room = roomById(id);
    if (!room) return res.status(404).json({ error: "Blabber not found." });
    if (!visibleTo(room, req.user.userId)) return res.status(403).json({ error: "This private Blabber requires an invitation." });
    if (room.visibility === "private" && !room.owner_id === req.user.userId) return res.status(403).json({ error: "Invitation required." });
    if (room.visibility === "private" && !room.owner_id !== req.user.userId &&
        !db.prepare("SELECT 1 FROM blabber_invites WHERE blabber_id = ? AND user_id = ?").get(id, req.user.userId) &&
        !isMember(id, req.user.userId)) return res.status(403).json({ error: "Invitation required." });
    db.prepare("INSERT OR IGNORE INTO blabber_members (blabber_id, user_id) VALUES (?, ?)").run(id, req.user.userId);
    res.json({ blabber: serializeRoom(roomById(id), req.user.userId) });
  });

  router.delete("/:id/leave", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    const room = roomById(id);
    if (!room || !isMember(id, req.user.userId)) return res.status(404).json({ error: "You are not in this Blabber." });
    if (room.owner_id === req.user.userId) {
      db.prepare("DELETE FROM blabbers WHERE id = ?").run(id);
      return res.json({ deleted: true });
    }
    db.prepare("DELETE FROM blabber_members WHERE blabber_id = ? AND user_id = ?").run(id, req.user.userId);
    db.prepare("DELETE FROM blabber_signals WHERE blabber_id = ? AND (from_user_id = ? OR to_user_id = ?)").run(id, req.user.userId, req.user.userId);
    res.json({ deleted: false });
  });

  router.post("/:id/invites", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    const room = roomById(id);
    if (!room || !isMember(id, req.user.userId)) return res.status(404).json({ error: "Blabber not found." });
    if (room.visibility !== "private") return res.status(400).json({ error: "Invitations are only needed for private Blabbers." });
    const usernames = Array.isArray(req.body.usernames) ? req.body.usernames : [req.body.username];
    const added = [];
    for (const raw of usernames.slice(0, 50)) {
      const username = typeof raw === "string" ? raw.trim() : "";
      if (!username) continue;
      const user = db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(username);
      if (!user) continue;
      if (user.id === req.user.userId) continue;
      db.prepare("INSERT OR IGNORE INTO blabber_invites (blabber_id, user_id, invited_by) VALUES (?, ?, ?)").run(id, user.id, req.user.userId);
      added.push(user.username);
    }
    res.json({ invited: added });
  });

  router.get("/:id/members", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    const room = roomById(id);
    if (!room || !visibleTo(room, req.user.userId) || (room.visibility === "private" && !isMember(id, req.user.userId))) {
      return res.status(403).json({ error: "You cannot view this Blabber." });
    }
    res.json({ members: serializeRoom(room, req.user.userId).members });
  });

  // WebRTC signaling messages are short-lived, authenticated, and scoped to room members.
  router.post("/:id/signals", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    if (!isMember(id, req.user.userId)) return res.status(403).json({ error: "Join the Blabber before signaling." });
    const toUserId = Number(req.body.toUserId);
    const type = String(req.body.type || "");
    const payload = JSON.stringify(req.body.payload ?? {});
    if (!Number.isInteger(toUserId) || toUserId === req.user.userId || !["offer", "answer", "ice", "renegotiate"].includes(type)) {
      return res.status(400).json({ error: "Invalid voice signal." });
    }
    if (!isMember(id, toUserId)) return res.status(403).json({ error: "That user is not in this Blabber." });
    db.prepare("INSERT INTO blabber_signals (blabber_id, from_user_id, to_user_id, signal_type, payload) VALUES (?, ?, ?, ?, ?)").run(id, req.user.userId, toUserId, type, payload);
    res.status(201).json({ sent: true });
  });

  router.get("/:id/signals", authenticateToken, (req, res) => {
    const id = Number(req.params.id);
    if (!isMember(id, req.user.userId)) return res.status(403).json({ error: "Join the Blabber before receiving signals." });
    const messages = db.prepare("SELECT id, from_user_id AS fromUserId, signal_type AS type, payload FROM blabber_signals WHERE blabber_id = ? AND to_user_id = ? ORDER BY id LIMIT 100").all(id, req.user.userId);
    if (messages.length) {
      const remove = db.prepare("DELETE FROM blabber_signals WHERE id = ?");
      const transaction = db.transaction((items) => items.forEach((item) => remove.run(item.id)));
      transaction(messages);
    }
    res.json({ signals: messages.map((message) => ({ id: message.id, fromUserId: message.fromUserId, type: message.type, payload: JSON.parse(message.payload) })) });
  });

  return router;
};
