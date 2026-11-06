-- Better Auth owns sign-in and sessions (src/lib/better-auth.ts). Its user id is the users.id of the same person, so
-- orgs, members, projects and PATs keep pointing at users. Dates are ISO strings and booleans 0/1, as its SQLite
-- adapter writes them.
CREATE TABLE auth_user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  emailVerified INTEGER NOT NULL,
  image TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

CREATE TABLE auth_session (
  id TEXT PRIMARY KEY,
  expiresAt TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  ipAddress TEXT,
  userAgent TEXT,
  userId TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE
);
CREATE INDEX auth_session_user ON auth_session (userId);

CREATE TABLE auth_account (
  id TEXT PRIMARY KEY,
  accountId TEXT NOT NULL,
  providerId TEXT NOT NULL,
  userId TEXT NOT NULL REFERENCES auth_user (id) ON DELETE CASCADE,
  accessToken TEXT,
  refreshToken TEXT,
  idToken TEXT,
  accessTokenExpiresAt TEXT,
  refreshTokenExpiresAt TEXT,
  scope TEXT,
  password TEXT,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX auth_account_user ON auth_account (userId);

CREATE TABLE auth_verification (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
CREATE INDEX auth_verification_identifier ON auth_verification (identifier);

-- Everyone who already has an account keeps their id. They sign in once more; the old sessions end here.
INSERT INTO auth_user (id, name, email, emailVerified, createdAt, updatedAt)
SELECT id, COALESCE(name, ''), email, 1,
       strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch'),
       strftime('%Y-%m-%dT%H:%M:%fZ', created_at / 1000.0, 'unixepoch')
FROM users;

-- What the sign-up form collected, read once when the new account is provisioned.
CREATE TABLE signup_intents (email TEXT PRIMARY KEY, name TEXT NOT NULL, org TEXT NOT NULL, expires_at INTEGER NOT NULL);

DROP TABLE sessions;
DROP TABLE login_tokens;
