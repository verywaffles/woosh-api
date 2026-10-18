const express = require("express");

module.exports = function createExploreRouter(db) {
  const router = express.Router();

  function getTrendingHashtags(limit = 10) {
    const recentPosts = db.prepare(`
      SELECT text
      FROM wooshes
      WHERE text IS NOT NULL AND text <> ''
      ORDER BY id DESC
      LIMIT 500
    `).all();

    const counts = new Map();
    const hashtagPattern = /#([a-zA-Z0-9_]{2,30})/g;

    for (const post of recentPosts) {
      const seenInPost = new Set();
      for (const match of post.text.matchAll(hashtagPattern)) {
        const tag = match[1].toLowerCase();
        if (seenInPost.has(tag)) continue;
        seenInPost.add(tag);
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }

    return [...counts.entries()]
      .map(([tag, postCount]) => ({ tag, postCount }))
      .sort((a, b) => b.postCount - a.postCount || a.tag.localeCompare(b.tag))
      .slice(0, limit);
  }

  function getPopularWooshes(limit = 10) {
    return db.prepare(`
      SELECT
        w.id,
        w.user_id AS userId,
        w.text,
        w.image,
        w.created_at AS createdAt,
        u.username,
        u.display_name AS displayName,
        u.profile_picture AS profilePicture,
        (SELECT COUNT(*) FROM likes l WHERE l.woosh_id = w.id) AS likeCount,
        (SELECT COUNT(*) FROM comments c WHERE c.woosh_id = w.id) AS commentCount
      FROM wooshes w
      JOIN users u ON u.id = w.user_id
      ORDER BY likeCount DESC, w.id DESC
      LIMIT ?
    `).all(limit);
  }

  function getRecentUsers(limit = 8) {
    return db.prepare(`
      SELECT
        u.id,
        u.username,
        u.display_name AS displayName,
        u.bio,
        u.profile_picture AS profilePicture,
        u.created_at AS createdAt,
        (SELECT COUNT(*) FROM wooshes w WHERE w.user_id = u.id) AS postCount
      FROM users u
      ORDER BY u.id DESC
      LIMIT ?
    `).all(limit);
  }

  router.get("/explore", (req, res) => {
    try {
      res.json({
        hashtags: getTrendingHashtags(12),
        popularWooshes: getPopularWooshes(10),
        recentUsers: getRecentUsers(8),
      });
    } catch (error) {
      console.error("Explore error:", error);
      res.status(500).json({ error: "Could not load Explore." });
    }
  });

  router.get("/search", (req, res) => {
    try {
      const rawQuery =
        typeof req.query.q === "string" ? req.query.q.trim() : "";

      if (!rawQuery) {
        return res.json({
          query: "",
          users: [],
          wooshes: [],
          hashtags: [],
        });
      }

      if (rawQuery.length > 100) {
        return res.status(400).json({
          error: "Search must be 100 characters or less.",
        });
      }

      const cleaned = rawQuery.replace(/^[@#]/, "").trim();
      if (!cleaned) {
        return res.json({
          query: rawQuery,
          users: [],
          wooshes: [],
          hashtags: [],
        });
      }

      // Escape SQL LIKE wildcards so user input is treated as literal text.
      const escaped = cleaned.replace(/[\\%_]/g, "\\$&");
      const likeQuery = `%${escaped}%`;

      const users = db.prepare(`
        SELECT
          u.id,
          u.username,
          u.display_name AS displayName,
          u.bio,
          u.profile_picture AS profilePicture,
          u.created_at AS createdAt,
          (SELECT COUNT(*) FROM wooshes w WHERE w.user_id = u.id) AS postCount
        FROM users u
        WHERE u.username LIKE ? ESCAPE '\\' COLLATE NOCASE
           OR u.display_name LIKE ? ESCAPE '\\' COLLATE NOCASE
        ORDER BY u.username COLLATE NOCASE
        LIMIT 20
      `).all(likeQuery, likeQuery);

      const wooshes = db.prepare(`
        SELECT
          w.id,
          w.user_id AS userId,
          w.text,
          w.image,
          w.created_at AS createdAt,
          u.username,
          u.display_name AS displayName,
          u.profile_picture AS profilePicture,
          (SELECT COUNT(*) FROM likes l WHERE l.woosh_id = w.id) AS likeCount,
          (SELECT COUNT(*) FROM comments c WHERE c.woosh_id = w.id) AS commentCount
        FROM wooshes w
        JOIN users u ON u.id = w.user_id
        WHERE w.text LIKE ? ESCAPE '\\' COLLATE NOCASE
        ORDER BY w.id DESC
        LIMIT 30
      `).all(likeQuery);

      const hashtags = getTrendingHashtags(100)
        .filter(({ tag }) => tag.includes(cleaned.replace(/^#/, "").toLowerCase()))
        .slice(0, 15);

      res.json({ query: rawQuery, users, wooshes, hashtags });
    } catch (error) {
      console.error("Search error:", error);
      res.status(500).json({ error: "Search failed. Please try again." });
    }
  });

  return router;
};
