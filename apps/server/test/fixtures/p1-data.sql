-- The rows of a Dialwarden database as phase P1 left it (migrations 0001 and
-- 0002), for the upgrade test (db/upgrade.test.ts). Synthetic: written by
-- Theriark, no customer data. P1 named the acting user by e-mail address;
-- migration 0008 turns those into user ids. The test replaces the owner's
-- password hash marker with the argon2id hash of a password it makes up.
INSERT INTO users (
  id, email, name, role, password_hash, totp_secret_enc, totp_pending_enc,
  totp_last_step, created_at, updated_at, recovery_key_enc
) VALUES (
  '4f3c2a10-0d8e-4c51-9a7b-2f6e1d0c9b8a', 'owner@p1.dialwarden.test',
  'P1 owner', 'owner', '@OWNER_HASH@', NULL, NULL, NULL,
  '2026-11-21T09:00:00.000Z', '2026-11-21T09:00:00.000Z', NULL
);

INSERT INTO sessions (
  id, user_id, csrf_token, created_at, last_seen_at, expires_at, ip,
  user_agent
) VALUES (
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  '4f3c2a10-0d8e-4c51-9a7b-2f6e1d0c9b8a', 'p1-synthetic-csrf-value',
  '2026-11-21T09:00:00.000Z', '2026-11-21T09:05:00.000Z',
  '2026-11-28T09:05:00.000Z', '192.0.2.10', 'synthetic test agent'
);

INSERT INTO settings (key, value) VALUES
  ('app.secretBackupAcknowledged', 'true'),
  ('licence.environmentIgnored', 'false');

INSERT INTO activity_events (type, server_id, at, actor, data) VALUES
  ('user.changed', NULL, '2026-11-21T09:00:00.000Z',
   'owner@p1.dialwarden.test',
   '{"action":"created","userId":"4f3c2a10-0d8e-4c51-9a7b-2f6e1d0c9b8a","role":"owner","cause":"setup"}'),
  ('backup.done', NULL, '2026-11-21T09:30:00.000Z', 'system',
   '{"file":"20261121-093000.dwbackup"}'),
  ('user.changed', NULL, '2026-11-21T10:00:00.000Z',
   'gone@p1.dialwarden.test',
   '{"action":"password_changed"}');
