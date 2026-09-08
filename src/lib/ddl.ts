import type { Provider } from "./config";

export function ddlFor(provider: Provider): readonly string[] {
  const idCol = provider === "sqlite" ? "id INTEGER PRIMARY KEY AUTOINCREMENT" : "id serial PRIMARY KEY";
  const int = provider === "sqlite" ? "INTEGER" : "bigint";
  return [
    `CREATE TABLE IF NOT EXISTS messages (
      ${idCol}, client_id text NOT NULL, nick text NOT NULL, text text NOT NULL,
      created_at ${int} NOT NULL, deleted_at ${int}, deleted_by text)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages (created_at)`,
    `CREATE TABLE IF NOT EXISTS events (
      ${idCol}, type text NOT NULL, payload text NOT NULL, created_at ${int} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS presence (client_id text PRIMARY KEY, last_seen ${int} NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON presence (last_seen)`,
    `CREATE TABLE IF NOT EXISTS bans (
      ip text PRIMARY KEY, reason text NOT NULL, banned_by text NOT NULL, created_at ${int} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS rate_limits (
      bucket text NOT NULL, scope text NOT NULL, window_start ${int} NOT NULL,
      count integer NOT NULL, PRIMARY KEY (bucket, scope, window_start))`,
  ];
}
