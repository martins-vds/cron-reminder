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

## Commands

```sh
npm test             # Domain, application, adapter, and localization tests
npm run typecheck    # TypeScript project references
npm run lint         # ESLint architecture and correctness checks
npm run format:check # Prettier verification
npm run build        # Type check and export the web application
```

## Scheduling behavior

- Cron uses exactly five fields: minute, hour, day, month, and weekday.
- The shortest interval is one minute.
- New reminders capture the device timezone at creation; existing reminders keep that timezone when the device travels.
- A nonexistent daylight-saving time moves to the next valid local time.
- A repeated daylight-saving time fires once.
- Recurring dismissal affects only the selected occurrence.
- Snooze presets are 5, 10, 15, 30, and 60 minutes.
- Missed occurrences are presented as a summary rather than a notification storm.

## Data and security

- Sign-in is required; there is no guest account mode.
- Reminders are private and Supabase RLS restricts every row to its owner.
- Offline changes are stored locally and synchronized after reconnection.
- Concurrent revisions are preserved for manual resolution.
- History is removed after 30 days.
- JSON backup excludes credentials, sessions, and device push tokens.
- Account deletion uses a verified Edge Function and database cascades.

Mobile and browser delivery remains subject to operating-system throttling, user permissions, battery policies, and browser Web Push support.
