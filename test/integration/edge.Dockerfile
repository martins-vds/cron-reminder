FROM denoland/deno:2.5.2

WORKDIR /app
COPY supabase/functions ./supabase/functions

RUN deno cache \
  --config /app/supabase/functions/deno.json \
  /app/supabase/functions/delete-account/index.ts \
  /app/supabase/functions/deregister-device/index.ts \
  /app/supabase/functions/dispatch-reminders/index.ts \
  /app/supabase/functions/occurrence-action/index.ts
