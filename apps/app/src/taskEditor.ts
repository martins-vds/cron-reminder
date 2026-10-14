import {
  validateTaskReminderPolicy,
  type Schedule,
  type TaskReminderPolicy,
} from "@cron-reminder/domain";

export function buildTaskReminderPolicy({
  primary,
  overdue,
  dueAt,
  timezone,
  from,
}: {
  primary: Schedule;
  overdue?: Schedule;
  dueAt: string;
  timezone: string;
  from: string;
}): TaskReminderPolicy {
  const policy: TaskReminderPolicy =
    primary.kind === "once"
      ? {
          primary,
          overdue: requireRecurringSchedule(overdue),
        }
      : {
          primary: withoutEnding(primary),
        };
  validateTaskReminderPolicy(policy, timezone, dueAt, from);
  return policy;
}

function requireRecurringSchedule(
  schedule: Schedule | undefined,
): Exclude<Schedule, { kind: "once" }> {
  if (!schedule || schedule.kind === "once") {
    throw new Error(
      "A one-time task reminder requires a recurring overdue schedule.",
    );
  }
  const recurring = withoutEnding(schedule);
  delete recurring.startAt;
  return recurring;
}

function withoutEnding<T extends Exclude<Schedule, { kind: "once" }>>(
  schedule: T,
): T {
  const recurring = { ...schedule };
  delete recurring.endAt;
  delete recurring.occurrenceLimit;
  return recurring;
}
