-- Shared physical schema for Node and Rust. Values are opaque to the backend.
CREATE TABLE IF NOT EXISTS records (
    namespace TEXT NOT NULL,
    id TEXT NOT NULL,
    value BLOB NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    modified_ms INTEGER NOT NULL CHECK (modified_ms >= 0),
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
    PRIMARY KEY (namespace, id)
) WITHOUT ROWID, STRICT;
PRAGMA user_version = 1;
