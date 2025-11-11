-- Database schema for D1
-- Run: wrangler d1 execute database --local --file=schema.sql

-- Documents table for storing legal documents
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create index on source for faster lookups
CREATE INDEX IF NOT EXISTS idx_documents_source ON documents(source);
