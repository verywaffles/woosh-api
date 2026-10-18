const express = require("express");
const path = require("path");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("./database");

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required.");
}

app.use(
  cors({
    origin: [
      "https://wooshio.web.app",
      "https://wooshio.firebaseapp.com",
      "http://localhost:5173",
    ],
  })
);

app.use(express.json({ limit: "15mb" }));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// ============================================================
// AUTHENTICATION
// ============================================================

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentication required.",
    });
  }

  const token = authHeader.substring(7);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);

    const user = db
      .prepare(`
        SELECT
          id,
          username,
          display_name,
          bio,
          profile_picture
        FROM users
        WHERE id = ?
      `)
      .get(decoded.userId);

    if (!user) {
      return res.status(401).json({
        error: "Account no longer exists. Please log in again.",
      });
    }

    req.user = {
      userId: user.id,
      username: user.username,
      displayName: user.display_name,
      bio: user.bio || "",
      profilePicture: user.profile_picture || null,
    };

    next();
  } catch (error) {
    console.error("Authentication error:", error);

    return res.status(401).json({
      error: "Invalid or expired token.",
    });
  }
}

// ============================================================
// BASIC ROUTES
// ============================================================

app.get("/", (req, res) => {
  res.json({
    name: "WOOSH API",
    status: "online",
  });
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    database: "connected",
  });
});

// ============================================================
// AUTH - REGISTER
// ============================================================

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, displayName, password } = req.body;

    const cleanUsername = username?.trim();
    const cleanDisplayName =
      displayName?.trim() || cleanUsername;

    if (!cleanUsername || !password) {
      return res.status(400).json({
        error: "Username and password are required.",
      });
    }

    if (cleanUsername.length < 3) {
      return res.status(400).json({
        error: "Username must be at least 3 characters.",
      });
    }

    if (cleanUsername.length > 20) {
      return res.status(400).json({
        error: "Username must be 20 characters or less.",
      });
    }

    if (!/^[a-zA-Z0-9_]+$/.test(cleanUsername)) {
      return res.status(400).json({
        error:
          "Username can only contain letters, numbers, and underscores.",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: "Password must be at least 6 characters.",
      });
    }

    const existingUser = db
      .prepare(
        "SELECT id FROM users WHERE username = ? COLLATE NOCASE"
      )
      .get(cleanUsername);

    if (existingUser) {
      return res.status(409).json({
        error: "That username is already taken.",
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    // Create the account and join the default community server atomically.
    // Registration fails cleanly if the configured default server is missing.
    const createAccount = db.transaction(() => {
      const result = db
        .prepare(`
          INSERT INTO users
          (
            username,
            display_name,
            password_hash,
            bio,
            profile_picture
          )
          VALUES (?, ?, ?, '', NULL)
        `)
        .run(cleanUsername, cleanDisplayName, passwordHash);

      const userId = Number(result.lastInsertRowid);
      const defaultServer = db
        .prepare("SELECT id FROM servers WHERE invite_code = ?")
        .get("EsUag76idfSx");

      if (!defaultServer) {
        throw new Error("Default Woosh server invite code EsUag76idfSx was not found.");
      }

      db.prepare(
        "INSERT OR IGNORE INTO server_members (server_id, user_id, role) VALUES (?, ?, 'member')"
      ).run(defaultServer.id, userId);

      return { userId };
    });

    const { userId } = createAccount();

    const token = jwt.sign(
      {
        userId,
        username: cleanUsername,
      },
      JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    res.status(201).json({
      message: "Account created.",
      token,
      user: {
        id: userId,
        username: cleanUsername,
        displayName: cleanDisplayName,
        bio: "",
        profilePicture: null,
      },
    });
  } catch (error) {
    console.error("Registration error:", error);

    res.status(500).json({
      error: "Something went wrong.",
    });
  }
});

// ============================================================
// AUTH - LOGIN
// ============================================================

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const cleanUsername = username?.trim();

    if (!cleanUsername || !password) {
      return res.status(400).json({
        error: "Username and password are required.",
      });
    }

    const user = db
      .prepare(`
        SELECT
          id,
          username,
          display_name,
          password_hash,
          bio,
          profile_picture
        FROM users
        WHERE username = ? COLLATE NOCASE
      `)
      .get(cleanUsername);

    if (!user) {
      return res.status(401).json({
        error: "Incorrect username or password.",
      });
    }

    const passwordCorrect = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!passwordCorrect) {
      return res.status(401).json({
        error: "Incorrect username or password.",
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        username: user.username,
      },
      JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    res.json({
      message: "Login successful.",
      token,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        bio: user.bio || "",
        profilePicture: user.profile_picture || null,
      },
    });
  } catch (error) {
    console.error("Login error:", error);

    res.status(500).json({
      error: "Something went wrong.",
    });
  }
});

// ============================================================
// CURRENT USER
// ============================================================

app.get("/api/auth/me", authenticateToken, (req, res) => {
  res.json({
    user: {
      id: req.user.userId,
      username: req.user.username,
      displayName: req.user.displayName,
      bio: req.user.bio,
      profilePicture: req.user.profilePicture,
    },
  });
});

// ============================================================
// PUBLIC PROFILE
// ============================================================

app.get("/api/users/:username", (req, res) => {
  try {
    const username = req.params.username;

    const user = db
      .prepare(`
        SELECT
          id,
          username,
          display_name,
          bio,
          profile_picture,
          created_at,
          (SELECT COUNT(*) FROM user_follows WHERE following_id = users.id) AS followers_count,
          (SELECT COUNT(*) FROM user_follows WHERE follower_id = users.id) AS following_count
        FROM users
        WHERE username = ? COLLATE NOCASE
      `)
      .get(username);

    if (!user) {
      return res.status(404).json({
        error: "User not found.",
      });
    }

    const posts = db
      .prepare(`
        SELECT
          w.id,
          w.user_id,
          w.text,
          w.image,
          w.created_at,
          u.username,
          u.display_name,
          u.profile_picture
        FROM wooshes w
        JOIN users u ON u.id = w.user_id
        WHERE w.user_id = ?
        ORDER BY w.id DESC
      `)
      .all(user.id);

    res.json({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.display_name,
        bio: user.bio || "",
        profilePicture: user.profile_picture || null,
        createdAt: user.created_at,
        followersCount: user.followers_count || 0,
        followingCount: user.following_count || 0,
      },
      wooshes: posts,
    });
  } catch (error) {
    console.error("Profile error:", error);

    res.status(500).json({
      error: "Could not load profile.",
    });
  }
});

// ============================================================
// UPDATE PROFILE
// ============================================================
// ============================================================
// UPDATE PROFILE — NO CUSTOM PROFILE PICTURES
// ============================================================

app.patch("/api/profile", authenticateToken, (req, res) => {
  try {
    const { displayName, bio } = req.body;

    const currentUser = db
      .prepare(`
        SELECT display_name, bio
        FROM users
        WHERE id = ?
      `)
      .get(req.user.userId);

    if (!currentUser) {
      return res.status(404).json({
        error: "User not found.",
      });
    }

    const newDisplayName =
      typeof displayName === "string"
        ? displayName.trim()
        : currentUser.display_name || "";

    const newBio =
      typeof bio === "string"
        ? bio.trim()
        : currentUser.bio || "";

    if (newDisplayName.length > 50) {
      return res.status(400).json({
        error: "Display name must be 50 characters or less.",
      });
    }

    if (newBio.length > 160) {
      return res.status(400).json({
        error: "Bio must be 160 characters or less.",
      });
    }

    db.prepare(`
      UPDATE users
      SET
        display_name = ?,
        bio = ?,
        profile_picture = NULL
      WHERE id = ?
    `).run(
      newDisplayName,
      newBio,
      req.user.userId
    );

    const updatedUser = db
      .prepare(`
        SELECT
          id,
          username,
          display_name,
          bio
        FROM users
        WHERE id = ?
      `)
      .get(req.user.userId);

    res.json({
      message: "Profile updated.",
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        displayName: updatedUser.display_name,
        bio: updatedUser.bio || "",
      },
    });
  } catch (error) {
    console.error("Profile update error:", error);

    res.status(500).json({
      error: "Could not update profile.",
    });
  }
});
// ============================================================
// HELPER - FORMAT WOOSH
// ============================================================

function getWooshById(wooshId) {
  const woosh = db
    .prepare(`
      SELECT
        w.id,
        w.user_id,
        w.text,
        w.image,
        w.created_at,
        w.rewooshed_from_id,
        u.username,
        u.display_name,
        u.profile_picture
      FROM wooshes w
      JOIN users u ON u.id = w.user_id
      WHERE w.id = ?
    `)
    .get(wooshId);

  if (!woosh) {
    return null;
  }

  const originalAuthor = woosh.rewooshed_from_id
    ? db
        .prepare(`
          SELECT u.username, u.display_name, u.profile_picture
          FROM wooshes w
          JOIN users u ON u.id = w.user_id
          WHERE w.id = ?
        `)
        .get(woosh.rewooshed_from_id)
    : null;

  const likes = db
    .prepare(`
      SELECT u.username
      FROM likes l
      JOIN users u ON u.id = l.user_id
      WHERE l.woosh_id = ?
      ORDER BY l.created_at ASC
    `)
    .all(wooshId)
    .map((row) => row.username);

  const comments = db
    .prepare(`
      SELECT
        c.id,
        c.text,
        c.created_at,
        u.username,
        u.display_name,
        u.profile_picture
      FROM comments c
      JOIN users u ON u.id = c.user_id
      WHERE c.woosh_id = ?
      ORDER BY c.id ASC
    `)
    .all(wooshId)
    .map((comment) => ({
      id: comment.id,
      username: comment.username,
      displayName: comment.display_name,
      profilePicture: comment.profile_picture,
      text: comment.text,
      createdAt: comment.created_at,
    }));

  const rewooshes = db
    .prepare(`
      SELECT u.username
      FROM rewooshes r
      JOIN users u ON u.id = r.user_id
      WHERE r.woosh_id = ?
      ORDER BY r.created_at ASC
    `)
    .all(wooshId)
    .map((row) => row.username);

  return {
    id: woosh.id,
    userId: woosh.user_id,
    username: woosh.username,
    displayName: woosh.display_name,
    profilePicture: woosh.profile_picture,
    text: woosh.text,
    image: woosh.image,
    createdAt: woosh.created_at,
    rewooshedFromId: woosh.rewooshed_from_id || null,
    rewooshedFromUsername: originalAuthor?.username || null,
    rewooshedFromDisplayName: originalAuthor?.display_name || null,
    rewooshedFromProfilePicture: originalAuthor?.profile_picture || null,
    likes,
    comments,
    rewooshes,
  };
}

// Blocks apply in both directions to prevent unwanted contact.
function usersHaveBlockedEachOther(userA, userB) {
  return Boolean(db.prepare(`
    SELECT 1 FROM user_blocks
    WHERE (blocker_id = ? AND blocked_id = ?)
       OR (blocker_id = ? AND blocked_id = ?)
  `).get(userA, userB, userB, userA));
}

// ============================================================
// FEED
// ============================================================

app.get("/api/wooshes", (req, res) => {
  try {
    const rows = db
      .prepare(`
        SELECT id
        FROM wooshes
        ORDER BY id DESC
        LIMIT 100
      `)
      .all();

    const wooshes = rows
      .map((row) => getWooshById(row.id))
      .filter(Boolean);

    res.json({
      wooshes,
    });
  } catch (error) {
    console.error("Feed error:", error);

    res.status(500).json({
      error: "Could not load Wooshes.",
    });
  }
});


app.get("/api/wooshes/following", authenticateToken, (req, res) => {
  try {
    const rows = db.prepare("SELECT w.id FROM wooshes w INNER JOIN user_follows f ON f.following_id = w.user_id WHERE f.follower_id = ? ORDER BY w.id DESC LIMIT 100").all(req.user.userId);
    const wooshes = rows.map((row) => getWooshById(row.id)).filter(Boolean);
    res.json({ wooshes });
  } catch (error) {
    console.error("Following feed error:", error);
    res.status(500).json({ error: "Could not load Following feed." });
  }
});

// ============================================================
// CREATE WOOSH
// ============================================================

app.post("/api/wooshes", authenticateToken, (req, res) => {
  try {
    const { text, image } = req.body;

    const cleanText =
      typeof text === "string" ? text.trim() : "";

    const cleanImage =
      typeof image === "string" ? image : null;

    if (!cleanText && !cleanImage) {
      return res.status(400).json({
        error: "Your Woosh needs some content.",
      });
    }

    if (cleanText.length > 5000) {
      return res.status(400).json({
        error: "Woosh is too long.",
      });
    }

    const result = db
      .prepare(`
        INSERT INTO wooshes
        (user_id, text, image)
        VALUES (?, ?, ?)
      `)
      .run(
        req.user.userId,
        cleanText,
        cleanImage
      );

    const woosh = getWooshById(
      Number(result.lastInsertRowid)
    );

    res.status(201).json({
      message: "Woosh created.",
      woosh,
    });
  } catch (error) {
    console.error("Create Woosh error:", error);

    res.status(500).json({
      error: "Could not create Woosh.",
    });
  }
});

// Delete a Woosh owned by the authenticated user.
app.delete("/api/wooshes/:id", authenticateToken, (req, res) => {
  const wooshId = Number(req.params.id);
  if (!Number.isInteger(wooshId) || wooshId < 1) {
    return res.status(400).json({ error: "Invalid Woosh ID." });
  }

  try {
    const woosh = db.prepare("SELECT id, user_id FROM wooshes WHERE id = ?").get(wooshId);
    if (!woosh) return res.status(404).json({ error: "Woosh not found." });
    if (woosh.user_id !== req.user.userId) {
      return res.status(403).json({ error: "You can only delete your own Wooshes." });
    }

    const deleteWoosh = db.transaction(() => {
      const reposts = db.prepare("SELECT id FROM wooshes WHERE rewooshed_from_id = ?").all(wooshId);
      for (const repost of reposts) {
        db.prepare("DELETE FROM likes WHERE woosh_id = ?").run(repost.id);
        db.prepare("DELETE FROM comments WHERE woosh_id = ?").run(repost.id);
        db.prepare("DELETE FROM rewooshes WHERE woosh_id = ?").run(repost.id);
      }
      db.prepare("DELETE FROM wooshes WHERE rewooshed_from_id = ?").run(wooshId);
      db.prepare("DELETE FROM likes WHERE woosh_id = ?").run(wooshId);
      db.prepare("DELETE FROM comments WHERE woosh_id = ?").run(wooshId);
      db.prepare("DELETE FROM rewooshes WHERE woosh_id = ?").run(wooshId);
      db.prepare("DELETE FROM wooshes WHERE id = ?").run(wooshId);
    });
    deleteWoosh();
    return res.json({ message: "Woosh deleted.", id: wooshId });
  } catch (error) {
    console.error("Delete Woosh error:", error);
    return res.status(500).json({ error: "Could not delete Woosh." });
  }
});

// ============================================================
// LIKE / UNLIKE
// ============================================================

app.post(
  "/api/wooshes/:id/like",
  authenticateToken,
  (req, res) => {
    try {
      const wooshId = Number(req.params.id);

      if (!Number.isInteger(wooshId)) {
        return res.status(400).json({
          error: "Invalid Woosh ID.",
        });
      }

      const woosh = db
        .prepare("SELECT id, user_id FROM wooshes WHERE id = ?")
        .get(wooshId);

      if (!woosh) {
        return res.status(404).json({
          error: "Woosh not found.",
        });
      }

      const existingLike = db
        .prepare(`
          SELECT 1
          FROM likes
          WHERE user_id = ? AND woosh_id = ?
        `)
        .get(req.user.userId, wooshId);

      if (existingLike) {
        db.prepare(`
          DELETE FROM likes
          WHERE user_id = ? AND woosh_id = ?
        `).run(req.user.userId, wooshId);
      } else {
        db.prepare(`
          INSERT INTO likes
          (user_id, woosh_id)
          VALUES (?, ?)
        `).run(req.user.userId, wooshId);
        if (woosh.user_id !== req.user.userId) {
          db.prepare("INSERT INTO notifications (recipient_id, actor_id, type, woosh_id) VALUES (?, ?, 'like', ?)").run(woosh.user_id, req.user.userId, wooshId);
        }
      }

      res.json({
        liked: !existingLike,
        woosh: getWooshById(wooshId),
      });
    } catch (error) {
      console.error("Like error:", error);

      res.status(500).json({
        error: "Could not update like.",
      });
    }
  }
);

// ============================================================
// COMMENTS
// ============================================================

app.post(
  "/api/wooshes/:id/comments",
  authenticateToken,
  (req, res) => {
    try {
      const wooshId = Number(req.params.id);

      const text =
        typeof req.body.text === "string"
          ? req.body.text.trim()
          : "";

      if (!Number.isInteger(wooshId)) {
        return res.status(400).json({
          error: "Invalid Woosh ID.",
        });
      }

      if (!text) {
        return res.status(400).json({
          error: "Comment cannot be empty.",
        });
      }

      if (text.length > 1000) {
        return res.status(400).json({
          error: "Comment is too long.",
        });
      }

      const woosh = db
        .prepare("SELECT id, user_id FROM wooshes WHERE id = ?")
        .get(wooshId);

      if (!woosh) {
        return res.status(404).json({
          error: "Woosh not found.",
        });
      }

      const result = db
        .prepare(`
          INSERT INTO comments
          (user_id, woosh_id, text)
          VALUES (?, ?, ?)
        `)
        .run(
          req.user.userId,
          wooshId,
          text
        );

      if (woosh.user_id !== req.user.userId) {
        db.prepare("INSERT INTO notifications (recipient_id, actor_id, type, woosh_id, comment_id) VALUES (?, ?, 'comment', ?, ?)").run(woosh.user_id, req.user.userId, wooshId, Number(result.lastInsertRowid));
      }

      const comment = db
        .prepare(`
          SELECT
            c.id,
            c.text,
            c.created_at,
            u.username,
            u.display_name,
            u.profile_picture
          FROM comments c
          JOIN users u ON u.id = c.user_id
          WHERE c.id = ?
        `)
        .get(Number(result.lastInsertRowid));

      res.status(201).json({
        comment: {
          id: comment.id,
          username: comment.username,
          displayName: comment.display_name,
          profilePicture: comment.profile_picture,
          text: comment.text,
          createdAt: comment.created_at,
        },
      });
    } catch (error) {
      console.error("Comment error:", error);

      res.status(500).json({
        error: "Could not add comment.",
      });
    }
  }
);

// ============================================================
// REWOOSH
// ============================================================

app.post(
  "/api/wooshes/:id/rewoosh",
  authenticateToken,
  (req, res) => {
    try {
      const requestedId = Number(req.params.id);

      if (!Number.isInteger(requestedId)) {
        return res.status(400).json({
          error: "Invalid Woosh ID.",
        });
      }

      const requestedWoosh = db
        .prepare(`
          SELECT id, rewooshed_from_id
          FROM wooshes
          WHERE id = ?
        `)
        .get(requestedId);

      if (!requestedWoosh) {
        return res.status(404).json({
          error: "Woosh not found.",
        });
      }

      const originalId =
        requestedWoosh.rewooshed_from_id || requestedWoosh.id;

      const original = db
        .prepare(`
          SELECT id, text, image, user_id
          FROM wooshes
          WHERE id = ?
        `)
        .get(originalId);

      const alreadyRewooshed = db
        .prepare(`
          SELECT 1
          FROM rewooshes
          WHERE user_id = ? AND woosh_id = ?
        `)
        .get(
          req.user.userId,
          originalId
        );

      if (alreadyRewooshed) {
        return res.status(409).json({
          error: "You already Rewooshed this.",
        });
      }

      db.prepare(`
        INSERT INTO rewooshes
        (user_id, woosh_id)
        VALUES (?, ?)
      `).run(
        req.user.userId,
        originalId
      );

      const result = db
        .prepare(`
          INSERT INTO wooshes
          (user_id, text, image, rewooshed_from_id)
          VALUES (?, ?, ?, ?)
        `)
        .run(
          req.user.userId,
          original.text,
          original.image,
          original.id
        );

      const newWoosh = getWooshById(
        Number(result.lastInsertRowid)
      );

      res.status(201).json({
        message: "Rewooshed.",
        woosh: newWoosh,
      });
    } catch (error) {
      console.error("Rewoosh error:", error);

      res.status(500).json({
        error: "Could not Rewoosh.",
      });
    }
  }
);

// ============================================================
// DIRECT MESSAGES
// ============================================================

// Get all DM conversations for the logged-in user
app.get(
  "/api/dms",
  authenticateToken,
  (req, res) => {
    try {
      const conversations = db
        .prepare(`
          SELECT
            c.id,
            c.user1_id,
            c.user2_id,
            c.created_at,

            CASE
              WHEN c.user1_id = ? THEN u2.id
              ELSE u1.id
            END AS other_user_id,

            CASE
              WHEN c.user1_id = ? THEN u2.username
              ELSE u1.username
            END AS other_username,

            CASE
              WHEN c.user1_id = ? THEN u2.display_name
              ELSE u1.display_name
            END AS other_display_name,

            CASE
              WHEN c.user1_id = ? THEN u2.profile_picture
              ELSE u1.profile_picture
            END AS other_profile_picture

          FROM conversations c
          JOIN users u1 ON u1.id = c.user1_id
          JOIN users u2 ON u2.id = c.user2_id

          WHERE c.user1_id = ?
             OR c.user2_id = ?

          ORDER BY c.id DESC
        `)
        .all(
          req.user.userId,
          req.user.userId,
          req.user.userId,
          req.user.userId,
          req.user.userId,
          req.user.userId
        );

      const result = conversations.filter((conversation) => {
        const otherId = conversation.user1_id === req.user.userId ? conversation.user2_id : conversation.user1_id;
        return !usersHaveBlockedEachOther(req.user.userId, otherId);
      }).map((conversation) => {
        const lastMessage = db
          .prepare(`
            SELECT
              id,
              sender_id,
              text,
              created_at
            FROM messages
            WHERE conversation_id = ?
            ORDER BY id DESC
            LIMIT 1
          `)
          .get(conversation.id);

        return {
          id: conversation.id,
          otherUser: {
            id: conversation.other_user_id,
            username: conversation.other_username,
            displayName:
              conversation.other_display_name,
            profilePicture:
              conversation.other_profile_picture || null,
          },
          lastMessage: lastMessage
            ? {
                id: lastMessage.id,
                senderId: lastMessage.sender_id,
                text: lastMessage.text,
                createdAt: lastMessage.created_at,
              }
            : null,
          createdAt: conversation.created_at,
        };
      });

      res.json({
        conversations: result,
      });
    } catch (error) {
      console.error("DM list error:", error);

      res.status(500).json({
        error: "Could not load conversations.",
      });
    }
  }
);

// Start or get a DM conversation with a username
app.post(
  "/api/dms",
  authenticateToken,
  (req, res) => {
    try {
      const username =
        typeof req.body.username === "string"
          ? req.body.username.trim()
          : "";

      if (!username) {
        return res.status(400).json({
          error: "Username is required.",
        });
      }

      const otherUser = db
        .prepare(`
          SELECT
            id,
            username,
            display_name,
            profile_picture
          FROM users
          WHERE username = ? COLLATE NOCASE
        `)
        .get(username);

      if (!otherUser) {
        return res.status(404).json({
          error: "User not found.",
        });
      }

      if (otherUser.id === req.user.userId) {
        return res.status(400).json({
          error: "You cannot message yourself.",
        });
      }

      if (usersHaveBlockedEachOther(req.user.userId, otherUser.id)) {
        return res.status(403).json({ error: "Messaging is unavailable because one of these accounts has blocked the other." });
      }

      const user1Id = Math.min(
        req.user.userId,
        otherUser.id
      );

      const user2Id = Math.max(
        req.user.userId,
        otherUser.id
      );

      let conversation = db
        .prepare(`
          SELECT id
          FROM conversations
          WHERE user1_id = ? AND user2_id = ?
        `)
        .get(user1Id, user2Id);

      if (!conversation) {
        const result = db
          .prepare(`
            INSERT INTO conversations
            (user1_id, user2_id)
            VALUES (?, ?)
          `)
          .run(user1Id, user2Id);

        conversation = {
          id: Number(result.lastInsertRowid),
        };
      }

      res.status(201).json({
        conversation: {
          id: conversation.id,
          otherUser: {
            id: otherUser.id,
            username: otherUser.username,
            displayName: otherUser.display_name,
            profilePicture:
              otherUser.profile_picture || null,
          },
        },
      });
    } catch (error) {
      console.error("Create DM error:", error);

      res.status(500).json({
        error: "Could not create conversation.",
      });
    }
  }
);

// Get messages in a conversation
app.get(
  "/api/dms/:conversationId/messages",
  authenticateToken,
  (req, res) => {
    try {
      const conversationId =
        Number(req.params.conversationId);

      if (!Number.isInteger(conversationId)) {
        return res.status(400).json({
          error: "Invalid conversation ID.",
        });
      }

      const conversation = db
        .prepare(`
          SELECT id
          FROM conversations
          WHERE id = ?
            AND (user1_id = ? OR user2_id = ?)
        `)
        .get(
          conversationId,
          req.user.userId,
          req.user.userId
        );

      if (!conversation) {
        return res.status(404).json({
          error: "Conversation not found.",
        });
      }

      const participants = db.prepare("SELECT user1_id, user2_id FROM conversations WHERE id = ?").get(conversationId);
      const otherUserId = participants.user1_id === req.user.userId ? participants.user2_id : participants.user1_id;
      if (usersHaveBlockedEachOther(req.user.userId, otherUserId)) {
        return res.status(403).json({ error: "Messages are unavailable because one of these accounts has blocked the other." });
      }

      const messages = db
        .prepare(`
          SELECT
            m.id,
            m.conversation_id,
            m.sender_id,
            m.text,
            m.created_at,
            u.username,
            u.display_name,
            u.profile_picture
          FROM messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.conversation_id = ?
          ORDER BY m.id ASC
        `)
        .all(conversationId);

      res.json({
        messages: messages.map((message) => ({
          id: message.id,
          conversationId:
            message.conversation_id,
          senderId: message.sender_id,
          username: message.username,
          displayName: message.display_name,
          profilePicture:
            message.profile_picture || null,
          text: message.text,
          createdAt: message.created_at,
        })),
      });
    } catch (error) {
      console.error("Load messages error:", error);

      res.status(500).json({
        error: "Could not load messages.",
      });
    }
  }
);

// Send a message
app.post(
  "/api/dms/:conversationId/messages",
  authenticateToken,
  (req, res) => {
    try {
      const conversationId =
        Number(req.params.conversationId);

      const text =
        typeof req.body.text === "string"
          ? req.body.text.trim()
          : "";

      if (!Number.isInteger(conversationId)) {
        return res.status(400).json({
          error: "Invalid conversation ID.",
        });
      }

      if (!text) {
        return res.status(400).json({
          error: "Message cannot be empty.",
        });
      }

      if (text.length > 5000) {
        return res.status(400).json({
          error: "Message is too long.",
        });
      }

      const conversation = db
        .prepare(`
          SELECT id
          FROM conversations
          WHERE id = ?
            AND (user1_id = ? OR user2_id = ?)
        `)
        .get(
          conversationId,
          req.user.userId,
          req.user.userId
        );

      if (!conversation) {
        return res.status(404).json({
          error: "Conversation not found.",
        });
      }

      const participants = db.prepare("SELECT user1_id, user2_id FROM conversations WHERE id = ?").get(conversationId);
      const otherUserId = participants.user1_id === req.user.userId ? participants.user2_id : participants.user1_id;
      if (usersHaveBlockedEachOther(req.user.userId, otherUserId)) {
        return res.status(403).json({ error: "You cannot send messages because one of these accounts has blocked the other." });
      }

      const result = db
        .prepare(`
          INSERT INTO messages
          (conversation_id, sender_id, text)
          VALUES (?, ?, ?)
        `)
        .run(
          conversationId,
          req.user.userId,
          text
        );

      const message = db
        .prepare(`
          SELECT
            m.id,
            m.conversation_id,
            m.sender_id,
            m.text,
            m.created_at,
            u.username,
            u.display_name,
            u.profile_picture
          FROM messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.id = ?
        `)
        .get(
          Number(result.lastInsertRowid)
        );

      res.status(201).json({
        message: {
          id: message.id,
          conversationId:
            message.conversation_id,
          senderId: message.sender_id,
          username: message.username,
          displayName: message.display_name,
          profilePicture:
            message.profile_picture || null,
          text: message.text,
          createdAt: message.created_at,
        },
      });
    } catch (error) {
      console.error("Send message error:", error);

      res.status(500).json({
        error: "Could not send message.",
      });
    }
  }
);
// ============================================================
// GROUP CHATS
// ============================================================

// Get all group chats for the logged-in user
app.get(
  "/api/groups",
  authenticateToken,
  (req, res) => {
    try {
      const groups = db
        .prepare(`
          SELECT
            g.id,
            g.name,
            g.created_by,
            g.created_at
          FROM group_conversations g
          JOIN group_conversation_members gm
            ON gm.group_id = g.id
          WHERE gm.user_id = ?
          ORDER BY g.id DESC
        `)
        .all(req.user.userId);

      const result = groups.map((group) => {
        const members = db
          .prepare(`
            SELECT
              u.id,
              u.username,
              u.display_name,
              u.profile_picture,
              gm.joined_at
            FROM group_conversation_members gm
            JOIN users u ON u.id = gm.user_id
            WHERE gm.group_id = ?
            ORDER BY gm.id ASC
          `)
          .all(group.id);

        const lastMessage = db
          .prepare(`
            SELECT
              id,
              sender_id,
              text,
              created_at
            FROM group_messages
            WHERE group_id = ?
            ORDER BY id DESC
            LIMIT 1
          `)
          .get(group.id);

        return {
          id: group.id,
          name: group.name,
          createdBy: group.created_by,
          createdAt: group.created_at,
          members: members.map((member) => ({
            id: member.id,
            username: member.username,
            displayName: member.display_name,
            profilePicture:
              member.profile_picture || null,
            joinedAt: member.joined_at,
          })),
          lastMessage: lastMessage
            ? {
                id: lastMessage.id,
                senderId: lastMessage.sender_id,
                text: lastMessage.text,
                createdAt: lastMessage.created_at,
              }
            : null,
        };
      });

      res.json({
        groups: result,
      });
    } catch (error) {
      console.error("Group list error:", error);

      res.status(500).json({
        error: "Could not load group chats.",
      });
    }
  }
);

// Create a group chat
app.post(
  "/api/groups",
  authenticateToken,
  (req, res) => {
    try {
      const name =
        typeof req.body.name === "string"
          ? req.body.name.trim()
          : "";

      const usernames = Array.isArray(req.body.usernames)
        ? req.body.usernames
        : [];

      if (!name) {
        return res.status(400).json({
          error: "Group name is required.",
        });
      }

      if (name.length > 50) {
        return res.status(400).json({
          error: "Group name must be 50 characters or less.",
        });
      }

      const cleanUsernames = [
        ...new Set(
          usernames
            .filter(
              (username) =>
                typeof username === "string"
            )
            .map((username) => username.trim())
            .filter(Boolean)
        ),
      ];

      const requestedUsers = [];

      for (const username of cleanUsernames) {
        const user = db
          .prepare(`
            SELECT
              id,
              username,
              display_name,
              profile_picture
            FROM users
            WHERE username = ? COLLATE NOCASE
          `)
          .get(username);

        if (!user) {
          return res.status(404).json({
            error: `User @${username} was not found.`,
          });
        }

        requestedUsers.push(user);
      }

      const createGroup = db.transaction(() => {
        const groupResult = db
          .prepare(`
            INSERT INTO group_conversations
            (name, created_by)
            VALUES (?, ?)
          `)
          .run(
            name,
            req.user.userId
          );

        const groupId =
          Number(groupResult.lastInsertRowid);

        const addMember = db
          .prepare(`
            INSERT INTO group_conversation_members
            (group_id, user_id)
            VALUES (?, ?)
          `);

        // Creator is always a member.
        addMember.run(
          groupId,
          req.user.userId
        );

        for (const user of requestedUsers) {
          if (user.id !== req.user.userId) {
            addMember.run(
              groupId,
              user.id
            );
          }
        }

        return groupId;
      });

      const groupId = createGroup();

      const group = db
        .prepare(`
          SELECT
            id,
            name,
            created_by,
            created_at
          FROM group_conversations
          WHERE id = ?
        `)
        .get(groupId);

      const members = db
        .prepare(`
          SELECT
            u.id,
            u.username,
            u.display_name,
            u.profile_picture,
            gm.joined_at
          FROM group_conversation_members gm
          JOIN users u ON u.id = gm.user_id
          WHERE gm.group_id = ?
          ORDER BY gm.id ASC
        `)
        .all(groupId);

      res.status(201).json({
        group: {
          id: group.id,
          name: group.name,
          createdBy: group.created_by,
          createdAt: group.created_at,
          members: members.map((member) => ({
            id: member.id,
            username: member.username,
            displayName: member.display_name,
            profilePicture:
              member.profile_picture || null,
            joinedAt: member.joined_at,
          })),
          lastMessage: null,
        },
      });
    } catch (error) {
      console.error("Create group error:", error);

      res.status(500).json({
        error: "Could not create group chat.",
      });
    }
  }
);

// Get messages in a group chat
app.get(
  "/api/groups/:groupId/messages",
  authenticateToken,
  (req, res) => {
    try {
      const groupId =
        Number(req.params.groupId);

      if (!Number.isInteger(groupId)) {
        return res.status(400).json({
          error: "Invalid group ID.",
        });
      }

      const membership = db
        .prepare(`
          SELECT 1
          FROM group_conversation_members
          WHERE group_id = ?
            AND user_id = ?
        `)
        .get(
          groupId,
          req.user.userId
        );

      if (!membership) {
        return res.status(404).json({
          error: "Group not found.",
        });
      }

      const messages = db
        .prepare(`
          SELECT
            m.id,
            m.group_id,
            m.sender_id,
            m.text,
            m.created_at,
            u.username,
            u.display_name,
            u.profile_picture
          FROM group_messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.group_id = ?
          ORDER BY m.id ASC
        `)
        .all(groupId);

      res.json({
        messages: messages.map((message) => ({
          id: message.id,
          groupId: message.group_id,
          senderId: message.sender_id,
          username: message.username,
          displayName: message.display_name,
          profilePicture:
            message.profile_picture || null,
          text: message.text,
          createdAt: message.created_at,
        })),
      });
    } catch (error) {
      console.error("Load group messages error:", error);

      res.status(500).json({
        error: "Could not load group messages.",
      });
    }
  }
);

// Send a group message
app.post(
  "/api/groups/:groupId/messages",
  authenticateToken,
  (req, res) => {
    try {
      const groupId =
        Number(req.params.groupId);

      const text =
        typeof req.body.text === "string"
          ? req.body.text.trim()
          : "";

      if (!Number.isInteger(groupId)) {
        return res.status(400).json({
          error: "Invalid group ID.",
        });
      }

      if (!text) {
        return res.status(400).json({
          error: "Message cannot be empty.",
        });
      }

      if (text.length > 5000) {
        return res.status(400).json({
          error: "Message is too long.",
        });
      }

      const membership = db
        .prepare(`
          SELECT 1
          FROM group_conversation_members
          WHERE group_id = ?
            AND user_id = ?
        `)
        .get(
          groupId,
          req.user.userId
        );

      if (!membership) {
        return res.status(404).json({
          error: "Group not found.",
        });
      }

      const result = db
        .prepare(`
          INSERT INTO group_messages
          (group_id, sender_id, text)
          VALUES (?, ?, ?)
        `)
        .run(
          groupId,
          req.user.userId,
          text
        );

      const message = db
        .prepare(`
          SELECT
            m.id,
            m.group_id,
            m.sender_id,
            m.text,
            m.created_at,
            u.username,
            u.display_name,
            u.profile_picture
          FROM group_messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.id = ?
        `)
        .get(
          Number(result.lastInsertRowid)
        );

      res.status(201).json({
        message: {
          id: message.id,
          groupId: message.group_id,
          senderId: message.sender_id,
          username: message.username,
          displayName: message.display_name,
          profilePicture:
            message.profile_picture || null,
          text: message.text,
          createdAt: message.created_at,
        },
      });
    } catch (error) {
      console.error("Send group message error:", error);

      res.status(500).json({
        error: "Could not send group message.",
      });
    }
  }
);

// Rename a group
app.patch(
  "/api/groups/:groupId",
  authenticateToken,
  (req, res) => {
    try {
      const groupId =
        Number(req.params.groupId);

      const name =
        typeof req.body.name === "string"
          ? req.body.name.trim()
          : "";

      if (!Number.isInteger(groupId)) {
        return res.status(400).json({
          error: "Invalid group ID.",
        });
      }

      if (!name) {
        return res.status(400).json({
          error: "Group name is required.",
        });
      }

      if (name.length > 50) {
        return res.status(400).json({
          error: "Group name must be 50 characters or less.",
        });
      }

      const group = db
        .prepare(`
          SELECT
            id,
            created_by
          FROM group_conversations
          WHERE id = ?
        `)
        .get(groupId);

      if (!group) {
        return res.status(404).json({
          error: "Group not found.",
        });
      }

      if (group.created_by !== req.user.userId) {
        return res.status(403).json({
          error: "Only the group owner can rename the group.",
        });
      }

      db.prepare(`
        UPDATE group_conversations
        SET name = ?
        WHERE id = ?
      `).run(
        name,
        groupId
      );

      res.json({
        message: "Group renamed.",
        name,
      });
    } catch (error) {
      console.error("Rename group error:", error);

      res.status(500).json({
        error: "Could not rename group.",
      });
    }
  }
);

// Add a member to a group
app.post(
  "/api/groups/:groupId/members",
  authenticateToken,
  (req, res) => {
    try {
      const groupId =
        Number(req.params.groupId);

      const username =
        typeof req.body.username === "string"
          ? req.body.username.trim()
          : "";

      if (!Number.isInteger(groupId)) {
        return res.status(400).json({
          error: "Invalid group ID.",
        });
      }

      if (!username) {
        return res.status(400).json({
          error: "Username is required.",
        });
      }

      const membership = db
        .prepare(`
          SELECT 1
          FROM group_conversation_members
          WHERE group_id = ?
            AND user_id = ?
        `)
        .get(
          groupId,
          req.user.userId
        );

      if (!membership) {
        return res.status(404).json({
          error: "Group not found.",
        });
      }

      const user = db
        .prepare(`
          SELECT
            id,
            username,
            display_name,
            profile_picture
          FROM users
          WHERE username = ? COLLATE NOCASE
        `)
        .get(username);

      if (!user) {
        return res.status(404).json({
          error: `User @${username} was not found.`,
        });
      }

      const alreadyMember = db
        .prepare(`
          SELECT 1
          FROM group_conversation_members
          WHERE group_id = ?
            AND user_id = ?
        `)
        .get(
          groupId,
          user.id
        );

      if (alreadyMember) {
        return res.status(409).json({
          error: "That user is already in the group.",
        });
      }

      db.prepare(`
        INSERT INTO group_conversation_members
        (group_id, user_id)
        VALUES (?, ?)
      `).run(
        groupId,
        user.id
      );

      res.status(201).json({
        message: "Member added.",
        member: {
          id: user.id,
          username: user.username,
          displayName: user.display_name,
          profilePicture:
            user.profile_picture || null,
        },
      });
    } catch (error) {
      console.error("Add group member error:", error);

      res.status(500).json({
        error: "Could not add member.",
      });
    }
  }
);

// Remove a member from a group
app.delete(
  "/api/groups/:groupId/members/:userId",
  authenticateToken,
  (req, res) => {
    try {
      const groupId =
        Number(req.params.groupId);

      const userId =
        Number(req.params.userId);

      if (
        !Number.isInteger(groupId) ||
        !Number.isInteger(userId)
      ) {
        return res.status(400).json({
          error: "Invalid group or user ID.",
        });
      }

      const group = db
        .prepare(`
          SELECT
            id,
            created_by
          FROM group_conversations
          WHERE id = ?
        `)
        .get(groupId);

      if (!group) {
        return res.status(404).json({
          error: "Group not found.",
        });
      }

      if (group.created_by !== req.user.userId) {
        return res.status(403).json({
          error: "Only the group owner can remove members.",
        });
      }

      if (userId === group.created_by) {
        return res.status(400).json({
          error: "The group owner cannot be removed.",
        });
      }

      const member = db
        .prepare(`
          SELECT 1
          FROM group_conversation_members
          WHERE group_id = ?
            AND user_id = ?
        `)
        .get(
          groupId,
          userId
        );

      if (!member) {
        return res.status(404).json({
          error: "That user is not in the group.",
        });
      }

      db.prepare(`
        DELETE FROM group_conversation_members
        WHERE group_id = ?
          AND user_id = ?
      `).run(
        groupId,
        userId
      );

      res.json({
        message: "Member removed.",
      });
    } catch (error) {
      console.error("Remove group member error:", error);

      res.status(500).json({
        error: "Could not remove member.",
      });
    }
  }
);

// Leave a group
app.delete(
  "/api/groups/:groupId/leave",
  authenticateToken,
  (req, res) => {
    try {
      const groupId =
        Number(req.params.groupId);

      if (!Number.isInteger(groupId)) {
        return res.status(400).json({
          error: "Invalid group ID.",
        });
      }

      const group = db
        .prepare(`
          SELECT
            id,
            created_by
          FROM group_conversations
          WHERE id = ?
        `)
        .get(groupId);

      if (!group) {
        return res.status(404).json({
          error: "Group not found.",
        });
      }

      const membership = db
        .prepare(`
          SELECT id
          FROM group_conversation_members
          WHERE group_id = ?
            AND user_id = ?
        `)
        .get(
          groupId,
          req.user.userId
        );

      if (!membership) {
        return res.status(404).json({
          error: "You are not in this group.",
        });
      }

      // If the owner leaves, transfer ownership
      // to the member who joined earliest.
      if (group.created_by === req.user.userId) {
        const nextOwner = db
          .prepare(`
            SELECT
              user_id
            FROM group_conversation_members
            WHERE group_id = ?
              AND user_id != ?
            ORDER BY id ASC
            LIMIT 1
          `)
          .get(
            groupId,
            req.user.userId
          );

        if (!nextOwner) {
          // No members remain, so delete the group.
          db.prepare(`
            DELETE FROM group_messages
            WHERE group_id = ?
          `).run(groupId);

          db.prepare(`
            DELETE FROM group_conversation_members
            WHERE group_id = ?
          `).run(groupId);

          db.prepare(`
            DELETE FROM group_conversations
            WHERE id = ?
          `).run(groupId);

          return res.json({
            message: "Group left and deleted.",
            deleted: true,
          });
        }

        db.prepare(`
          UPDATE group_conversations
          SET created_by = ?
          WHERE id = ?
        `).run(
          nextOwner.user_id,
          groupId
        );
      }

      db.prepare(`
        DELETE FROM group_conversation_members
        WHERE group_id = ?
          AND user_id = ?
      `).run(
        groupId,
        req.user.userId
      );

      res.json({
        message: "You left the group.",
        deleted: false,
      });
    } catch (error) {
      console.error("Leave group error:", error);

      res.status(500).json({
        error: "Could not leave group.",
      });
    }
  }
);
// Messaging privacy, account blocking, and server channels.
app.use("/api", require("./messaging")(db, authenticateToken));
app.use("/api", require("./follows")(db, authenticateToken));
app.use("/api", require("./notifications")(db, authenticateToken));

// WOOSHIES API ROUTES
app.use("/api/wooshies", require("./wooshies")(db, authenticateToken));
app.use("/api/blabbers", require("./blabbers")(db, authenticateToken));

// Explore and Search API routes.
app.use("/api", require("./explore")(db));

// ============================================================
// START SERVER
// ============================================================

app.listen(PORT, () => {
  console.log(
    `WOOSH backend running on port ${PORT}`
  );
});
