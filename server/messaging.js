// Messaging privacy, blocking, and Discord-style servers.
module.exports = function messagingRoutes(db, authenticateToken) {
  const express = require("express");
  const router = express.Router();

  db.exec(`
    CREATE TABLE IF NOT EXISTS user_blocks (
      blocker_id INTEGER NOT NULL,
      blocked_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (blocker_id, blocked_id),
      CHECK (blocker_id != blocked_id),
      FOREIGN KEY (blocker_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (blocked_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner_id INTEGER NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS server_members (
      server_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (server_id, user_id),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS server_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      server_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      topic TEXT NOT NULL DEFAULT '',
      created_by INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(server_id, name),
      FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS server_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (channel_id) REFERENCES server_channels(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_server_messages_channel_id
      ON server_messages(channel_id, id);
    CREATE INDEX IF NOT EXISTS idx_server_members_user_id
      ON server_members(user_id, server_id);
  `);

  const cleanName = (value, max = 60) =>
    typeof value === "string" ? value.trim().slice(0, max) : "";

  const isBlocked = (a, b) => Boolean(db.prepare(
    "SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)"
  ).get(a, b, b, a));

  const isMember = (serverId, userId) => db.prepare(
    "SELECT role FROM server_members WHERE server_id = ? AND user_id = ?"
  ).get(serverId, userId);

  const canManage = (role) => role === "owner" || role === "admin";

  router.get("/blocks", authenticateToken, (req, res) => {
    const blocked = db.prepare(`
      SELECT u.id, u.username, u.display_name AS displayName, b.created_at AS blockedAt
      FROM user_blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = ? ORDER BY b.created_at DESC
    `).all(req.user.userId);
    res.json({ blocked });
  });

  router.post("/blocks", authenticateToken, (req, res) => {
    const username = cleanName(req.body.username, 20).replace(/^@/, "");
    if (!username) return res.status(400).json({ error: "Username is required." });
    const target = db.prepare("SELECT id, username FROM users WHERE username = ? COLLATE NOCASE").get(username);
    if (!target) return res.status(404).json({ error: "User not found." });
    if (target.id === req.user.userId) return res.status(400).json({ error: "You cannot block yourself." });
    db.prepare("INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)").run(req.user.userId, target.id);
    res.status(201).json({ message: "Account blocked.", blocked: { id: target.id, username: target.username } });
  });

  router.delete("/blocks/:userId", authenticateToken, (req, res) => {
    const userId = Number(req.params.userId);
    if (!Number.isInteger(userId) || userId <= 0) return res.status(400).json({ error: "Invalid user ID." });
    db.prepare("DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?").run(req.user.userId, userId);
    res.json({ message: "Account unblocked." });
  });

  router.get("/servers", authenticateToken, (req, res) => {
    const servers = db.prepare(`
      SELECT s.id, s.name, s.description, s.owner_id AS ownerId, sm.role,
        (SELECT COUNT(*) FROM server_members sm2 WHERE sm2.server_id = s.id) AS memberCount,
        (SELECT COUNT(*) FROM server_channels sc WHERE sc.server_id = s.id) AS channelCount
      FROM servers s JOIN server_members sm ON sm.server_id = s.id
      WHERE sm.user_id = ? ORDER BY s.id DESC
    `).all(req.user.userId);
    res.json({ servers });
  });

  router.post("/servers", authenticateToken, (req, res) => {
    const name = cleanName(req.body.name, 60);
    const description = cleanName(req.body.description, 240);
    if (name.length < 2) return res.status(400).json({ error: "Server name must be at least 2 characters." });
    const crypto = require("crypto");
    const create = db.transaction(() => {
      const inviteCode = crypto.randomBytes(9).toString("base64url");
      const result = db.prepare("INSERT INTO servers (name, description, owner_id, invite_code) VALUES (?, ?, ?, ?)").run(name, description, req.user.userId, inviteCode);
      const serverId = Number(result.lastInsertRowid);
      db.prepare("INSERT INTO server_members (server_id, user_id, role) VALUES (?, ?, 'owner')").run(serverId, req.user.userId);
      db.prepare("INSERT INTO server_channels (server_id, name, created_by) VALUES (?, 'general', ?)").run(serverId, req.user.userId);
      return serverId;
    });
    const id = create();
    res.status(201).json({ server: db.prepare("SELECT id, name, description, owner_id AS ownerId, invite_code AS inviteCode FROM servers WHERE id = ?").get(id) });
  });

  router.post("/servers/join", authenticateToken, (req, res) => {
    const inviteCode = cleanName(req.body.inviteCode, 100);
    const server = db.prepare("SELECT id FROM servers WHERE invite_code = ?").get(inviteCode);
    if (!server) return res.status(404).json({ error: "Invite not found." });
    db.prepare("INSERT OR IGNORE INTO server_members (server_id, user_id) VALUES (?, ?)").run(server.id, req.user.userId);
    res.json({ message: "Joined server.", serverId: server.id });
  });

  router.get("/servers/:serverId", authenticateToken, (req, res) => {
    const serverId = Number(req.params.serverId);
    if (!Number.isInteger(serverId)) return res.status(400).json({ error: "Invalid server ID." });
    const membership = isMember(serverId, req.user.userId);
    if (!membership) return res.status(404).json({ error: "Server not found." });
    const server = db.prepare("SELECT id, name, description, owner_id AS ownerId, invite_code AS inviteCode FROM servers WHERE id = ?").get(serverId);
    const channels = db.prepare("SELECT id, name, topic FROM server_channels WHERE server_id = ? ORDER BY id").all(serverId);
    const members = db.prepare("SELECT u.id, u.username, u.display_name AS displayName, sm.role FROM server_members sm JOIN users u ON u.id = sm.user_id WHERE sm.server_id = ? ORDER BY sm.joined_at").all(serverId);
    res.json({ server, channels, members, myRole: membership.role });
  });

  router.post("/servers/:serverId/channels", authenticateToken, (req, res) => {
    const serverId = Number(req.params.serverId);
    const membership = isMember(serverId, req.user.userId);
    if (!membership) return res.status(404).json({ error: "Server not found." });
    if (!canManage(membership.role)) return res.status(403).json({ error: "Only server owners and admins can create channels." });
    const name = cleanName(req.body.name, 40).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    const topic = cleanName(req.body.topic, 160);
    if (!name) return res.status(400).json({ error: "Channel name is required." });
    try {
      const result = db.prepare("INSERT INTO server_channels (server_id, name, topic, created_by) VALUES (?, ?, ?, ?)").run(serverId, name, topic, req.user.userId);
      res.status(201).json({ channel: { id: Number(result.lastInsertRowid), name, topic } });
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") return res.status(409).json({ error: "That channel already exists." });
      throw error;
    }
  });

  router.get("/channels/:channelId/messages", authenticateToken, (req, res) => {
    const channelId = Number(req.params.channelId);
    if (!Number.isInteger(channelId)) return res.status(400).json({ error: "Invalid channel ID." });
    const channel = db.prepare("SELECT id, server_id FROM server_channels WHERE id = ?").get(channelId);
    if (!channel || !isMember(channel.server_id, req.user.userId)) return res.status(404).json({ error: "Channel not found." });
    const messages = db.prepare(`
      SELECT m.id, m.text, m.created_at AS createdAt, u.id AS senderId,
        u.username, u.display_name AS displayName
      FROM server_messages m JOIN users u ON u.id = m.sender_id
      WHERE m.channel_id = ? ORDER BY m.id ASC LIMIT 500
    `).all(channelId);
    res.json({ messages });
  });

  router.post("/channels/:channelId/messages", authenticateToken, (req, res) => {
    const channelId = Number(req.params.channelId);
    const text = typeof req.body.text === "string" ? req.body.text.trim() : "";
    if (!Number.isInteger(channelId)) return res.status(400).json({ error: "Invalid channel ID." });
    if (!text || text.length > 5000) return res.status(400).json({ error: "Message must be between 1 and 5000 characters." });
    const channel = db.prepare("SELECT id, server_id FROM server_channels WHERE id = ?").get(channelId);
    if (!channel || !isMember(channel.server_id, req.user.userId)) return res.status(404).json({ error: "Channel not found." });
    const result = db.prepare("INSERT INTO server_messages (channel_id, sender_id, text) VALUES (?, ?, ?)").run(channelId, req.user.userId, text);
    const message = db.prepare(`
      SELECT m.id, m.text, m.created_at AS createdAt, u.id AS senderId,
        u.username, u.display_name AS displayName
      FROM server_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?
    `).get(Number(result.lastInsertRowid));
    res.status(201).json({ message });
  });

  router.delete("/servers/:serverId/leave", authenticateToken, (req, res) => {
    const serverId = Number(req.params.serverId);
    const membership = isMember(serverId, req.user.userId);
    if (!membership) return res.status(404).json({ error: "Server not found." });
    if (membership.role === "owner") return res.status(400).json({ error: "Transfer ownership or delete the server before leaving." });
    db.prepare("DELETE FROM server_members WHERE server_id = ? AND user_id = ?").run(serverId, req.user.userId);
    res.json({ message: "Left server." });
  });

  return router;
};
