# Cron Reminder

Cross-platform reminder application for Android, iOS, and web. It uses a guided schedule builder backed by standard five-field cron expressions and sends best-effort notifications even when clients are backgrounded.

## Architecture

The npm workspace enforces a dependency direction toward the isolated domain:

- `packages/domain` — reminder entities, lifecycle rules, cron validation, timezone-aware occurrence calculation, snoozing, and history retention.
- `packages/application` — use cases and ports for repositories, authentication, notifications, time, timezone, and synchronization.
- `packages/infrastructure` — local JSON persistence, Supabase adapters, offline synchronization, manual conflict detection, and versioned JSON backup.
- `packages/localization` — English and Brazilian Portuguese messages.
- `apps/app` — responsive Expo React Native presentation shared by Android, iOS, and web.
- `supabase` — database schema, Row Level Security, account deletion, occurrence actions, and one-minute notification dispatch.

The domain package has no React, Expo, storage, or Supabase dependencies.

## Prerequisites

- Node.js 22 or newer
- npm 10 or newer
- A Supabase project
- Expo application credentials for Android and iOS push delivery
- VAPID keys for web push

## Setup

```sh
npm install
cp apps/app/.env.example apps/app/.env
npx supabase link
npx supabase db push
npx supabase functions deploy delete-account
npx supabase functions deploy deregister-device --no-verify-jwt
npx supabase functions deploy occurrence-action
npx supabase functions deploy dispatch-reminders --no-verify-jwt
npm start --workspace @cron-reminder/app
```

Enable Google, Apple, Azure (Microsoft), and GitHub in Supabase Authentication. Add the web URL and `cron-reminder://auth/callback` to the allowed redirect URLs.

Schedule `dispatch-reminders` once per minute from Supabase Cron or another trusted scheduler. Send the configured `CRON_SECRET` as the `x-cron-secret` header. Configure these Edge Function secrets:

- `CRON_SECRET`
- `VAPID_SUBJECT`
- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`

Supabase supplies its URL, anonymous key, and service-role key to deployed functions.

## Free-tier deployment

The initial hosted setup uses Cloudflare Pages Free for the web application and
Supabase Free for Postgres, Authentication, Edge Functions, and Cron.

### 1. Create and deploy the Supabase project

Create a free Supabase project, then authenticate and link the CLI:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
npx supabase functions deploy delete-account
npx supabase functions deploy deregister-device --no-verify-jwt
npx supabase functions deploy occurrence-action
npx supabase functions deploy dispatch-reminders --no-verify-jwt
```

Generate a strong dispatcher secret and VAPID key pair. Store the private values
only as Edge Function secrets:

```sh
CRON_SECRET="$(openssl rand -hex 32)"
npx web-push generate-vapid-keys
npx supabase secrets set \
  CRON_SECRET="$CRON_SECRET" \
  VAPID_SUBJECT="mailto:YOUR_EMAIL" \
  VAPID_PUBLIC_KEY="YOUR_VAPID_PUBLIC_KEY" \
  VAPID_PRIVATE_KEY="YOUR_VAPID_PRIVATE_KEY"
```

In the Supabase dashboard, enable the Cron, `pg_net`, and Vault integrations.
Replace the placeholders in `supabase/configure-dispatch-cron.sql`, run it in
the SQL Editor, and verify that `dispatch-cron-reminders` succeeds once per
minute. The script also removes Cron run history older than seven days.

### 2. Deploy the web app to Cloudflare Pages

Create a Pages project using Git integration and select this repository. Use:

```text
Production branch: main
Root directory: /
Build command: npm ci && npm run build
Build output directory: apps/app/dist
Node version: 22
```

Set these Pages build variables for both production and preview:

```text
EXPO_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
EXPO_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLIC_KEY
EXPO_PUBLIC_VAPID_PUBLIC_KEY=YOUR_VAPID_PUBLIC_KEY
EXPO_PUBLIC_EAS_PROJECT_ID=YOUR_EAS_PROJECT_ID
```

`EXPO_PUBLIC_EAS_PROJECT_ID` is needed for native Expo push registration but
does not block the web-only deployment. Never add `CRON_SECRET`, the VAPID
private key, or the Supabase service-role key to Cloudflare.

After the first Pages deployment, set the Supabase Authentication site URL to
the generated `https://PROJECT.pages.dev` origin and add these redirect URLs:

```text
https://PROJECT.pages.dev/**
cron-reminder://**
```

Redeploy Pages after changing any `EXPO_PUBLIC_*` value because Expo embeds
those values in the static JavaScript bundle.

The Supabase Free plan can pause low-activity projects and does not provide
downloadable database backups. Treat this setup as a hobby or evaluation
deployment rather than a reliable production service.

## Commands

```sh
npm test             # Domain, application, adapter, and localization tests
npm run typecheck    # TypeScript project references
npm run lint         # ESLint architecture and correctness checks
npm run format:check # Prettier verification
npm run build        # Type check and export the web application
npm run test:integration # Dockerized PostgreSQL/PostgREST/Edge Function tests
```

The integration command builds the stack in `compose.integration.yml`, applies
the real Supabase migrations to PostgreSQL, starts PostgREST and the Deno Edge
Functions, runs the state-transition suite, and removes the containers. Set
`INTEGRATION_KEEP_RUNNING=1` to leave the stack running for inspection.

## Scheduling behavior

- Cron uses exactly five fields: minute, hour, day, month, and weekday.
- The shortest interval is one minute.
- New reminders capture the device timezone at creation; existing reminders keep that timezone when the device travels.
- A nonexistent daylight-saving time moves to the next valid local time.
- A repeated daylight-saving time fires once.
- Recurring dismissal affects only the selected occurrence.
- Snooze presets are 5, 10, 15, 30, and 60 minutes.
- Missed occurrences are recorded individually in the 30-day history.

## Data and security

- Sign-in is required; there is no guest account mode.
- Reminders are private and Supabase RLS restricts every row to its owner.
- Offline changes are stored locally and synchronized after reconnection.
- Concurrent revisions are preserved for manual resolution.
- History is removed after 30 days.
- JSON backup excludes credentials, sessions, and device push tokens.
- Account deletion uses a verified Edge Function and database cascades.

Mobile and browser delivery remains subject to operating-system throttling, user permissions, battery policies, and browser Web Push support.
