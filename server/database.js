const Database = require("better-sqlite3");

const db = new Database("woosh.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    bio TEXT DEFAULT '',
    profile_picture TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS wooshes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    text TEXT DEFAULT '',
    image TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL,
    woosh_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, woosh_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (woosh_id) REFERENCES wooshes(id)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    woosh_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (woosh_id) REFERENCES wooshes(id)
  );

  CREATE TABLE IF NOT EXISTS rewooshes (
    user_id INTEGER NOT NULL,
    woosh_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, woosh_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (woosh_id) REFERENCES wooshes(id)
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user1_id INTEGER NOT NULL,
    user2_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user1_id) REFERENCES users(id),
    FOREIGN KEY (user2_id) REFERENCES users(id),

    UNIQUE(user1_id, user2_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
  );
`);

const wooshColumns = db.prepare("PRAGMA table_info(wooshes)").all();
if (!wooshColumns.some((column) => column.name === "rewooshed_from_id")) {
  db.exec(
    "ALTER TABLE wooshes ADD COLUMN rewooshed_from_id INTEGER REFERENCES wooshes(id)"
  );
}


// Wooshies: short-form video posts and likes.
db.exec(`
  CREATE TABLE IF NOT EXISTS wooshies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    video_url TEXT NOT NULL,
    caption TEXT NOT NULL DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS wooshie_likes (
    user_id INTEGER NOT NULL,
    wooshie_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, wooshie_id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (wooshie_id) REFERENCES wooshies(id)
  );
);

module.exports = db;
