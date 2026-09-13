-- Team Chat App - PostgreSQL schema
-- Every statement is idempotent, so this file can be run more than once
-- safely (Docker's init-db mount and `npm run migrate` both use it).

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
    id UUID PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    type VARCHAR(20) NOT NULL DEFAULT 'public' CHECK (type IN ('public', 'private', 'dm')),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channel_members (
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY,
    channel_id UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
    content TEXT,
    type VARCHAR(20) NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'file', 'system')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_messages_channel_created ON messages (channel_id, created_at DESC);

-- Canonical key for DM channels: the two member ids, sorted and joined, so
-- the pair (A,B) and (B,A) collide to the same key. NULL for non-DM
-- channels, where the partial index below doesn't apply at all.
ALTER TABLE channels ADD COLUMN IF NOT EXISTS dm_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_dm_key ON channels (dm_key) WHERE type = 'dm';

CREATE TABLE IF NOT EXISTS attachments (
    id UUID PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_url TEXT NOT NULL,
    mime_type VARCHAR(100),
    file_size INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One attachment row per message - guards against a bug ever silently
-- creating two, which the message-history LEFT JOIN assumes can't happen.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attachments_message_id ON attachments (message_id);

-- Ownership record for every successful upload, written at upload time.
-- message:send must claim one of these rows (owned by the sender, not yet
-- used) rather than trusting a client-supplied file_name/file_url/mime_type
-- directly - otherwise any authenticated user could fabricate an attachment
-- pointing at an arbitrary path or someone else's uploaded file.
CREATE TABLE IF NOT EXISTS uploads (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    file_name VARCHAR(255) NOT NULL,
    file_url TEXT NOT NULL,
    mime_type VARCHAR(100),
    file_size INTEGER,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads (owner_id);

CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Guarded with a duplicate_object catch so this file stays safely
-- re-runnable, the same way every other statement here is.
DO $$ BEGIN
    ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
        CHECK (type IN ('new_message'));
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
