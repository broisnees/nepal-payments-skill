# Projects, environments and API keys

## Organizations and members

An organization is a business. It has members and projects. Each member has a role:

| Role | Can |
|---|---|
| `owner` | Everything, including deleting projects |
| `admin` | Everything but billing and deleting the organization: keys, alerts, members, settings |
| `viewer` | Read only |

Sign-up creates an organization named after the company I entered, with me as owner. Members are invited by email from Settings, Members; the invite link works for 7 days.

## Projects and environments

A project is one app or site. Every project has two environments, `test` and `live`, each with its own keys, payments, alerts and analytics. The toggle in the top bar switches between them, and a thin bar marks the test environment.

New projects come from the project switcher (New project) or from `paynp init`, which offers to create one named after the app.

## Ingest keys

Ingest keys are secret and belong on the server only:

```bash
PAYNP_KEY=pnp_test_<32 base62 characters>   # test environment
PAYNP_KEY=pnp_live_<32 base62 characters>   # live environment
```

The prefix sets the environment the events land in. A key is stored only as a SHA-256 hash and shown once, when it is created. Create and revoke keys in Settings, API keys, or with the CLI:

```bash
npx paynp keys create --env live --name prod
npx paynp keys revoke <id>
```

A revoked key gets `401` on the next request. Each key is rate limited to 50 requests per second.

## Personal access tokens

The CLI signs in with a device login and gets a personal access token (`pnp_pat_...`), also stored hashed. Settings, CLI tokens lists them with when each was last used; `paynp logout` or the dashboard revokes one.

## Sign-in and sessions

Sign-in is a magic link: one use, 15 minutes. The session cookie lasts 30 days and slides while in use. Settings, Sessions lists every signed-in device, with its IP and last activity, and signs any of them out.
