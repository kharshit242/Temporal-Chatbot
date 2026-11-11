PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    title TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK (
        role IN ('user', 'assistant', 'system')
    ),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,

    FOREIGN KEY (conversation_id)
        REFERENCES conversations(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    claim TEXT NOT NULL,
    valid_at TEXT NOT NULL,
    entity TEXT,
    topic TEXT,

    FOREIGN KEY (message_id)
        REFERENCES messages(id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    url TEXT NOT NULL,
    title TEXT,
    domain TEXT,
    retrieved_at TEXT NOT NULL,
    published_at TEXT,

    FOREIGN KEY (message_id)
        REFERENCES messages(id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
ON messages(conversation_id);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
ON messages(created_at);

CREATE INDEX IF NOT EXISTS idx_claims_message
ON claims(message_id);

CREATE INDEX IF NOT EXISTS idx_claims_valid_at
ON claims(valid_at);

CREATE INDEX IF NOT EXISTS idx_claims_entity
ON claims(entity);

CREATE INDEX IF NOT EXISTS idx_sources_message
ON sources(message_id);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
USING fts5(
    message_id UNINDEXED,
    content,
    tokenize='unicode61'
);