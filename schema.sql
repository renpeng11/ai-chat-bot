CREATE TABLE IF NOT EXISTS inbound_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,
  chat_id TEXT,
  sender_id TEXT,
  sender_name TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  content TEXT NOT NULL,
  raw_payload TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_inbound_messages_received_at
  ON inbound_messages(received_at DESC);

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_date TEXT NOT NULL UNIQUE,
  content TEXT NOT NULL,
  source_message_count INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL,
  raw_response TEXT,
  sent_status TEXT NOT NULL DEFAULT 'pending',
  sent_error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_summaries_created_at
  ON summaries(created_at DESC);

CREATE TABLE IF NOT EXISTS outgoing_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary_id INTEGER,
  channel TEXT NOT NULL DEFAULT 'feishu_bot',
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY(summary_id) REFERENCES summaries(id)
);

CREATE INDEX IF NOT EXISTS idx_outgoing_messages_created_at
  ON outgoing_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS ai_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'openai_compatible',
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL,
  model TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_models_active
  ON ai_models(is_active) WHERE is_active = 1;
