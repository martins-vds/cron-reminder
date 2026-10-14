import {
  validateTaskReminderPolicy,
  type TaskReminderPolicy,
} from "@cron-reminder/domain";

export type TaskPolicyKind = "once" | "recurring";

export function buildTaskReminderPolicy({
  kind,
  firstReminderAt,
  dueAt,
  cadenceMinutes,
  timezone,
  from,
}: {
  kind: TaskPolicyKind;
  firstReminderAt: string;
  dueAt: string;
  cadenceMinutes: number;
  timezone: string;
  from: string;
}): TaskReminderPolicy {
  if (
    !Number.isSafeInteger(cadenceMinutes) ||
    cadenceMinutes < 1 ||
    cadenceMinutes > 59
  ) {
    throw new Error("Reminder cadence must be from 1 to 59 minutes.");
  }
  if (Date.parse(firstReminderAt) > Date.parse(dueAt)) {
    throw new Error(
      "The first task reminder must be on or before its due date.",
    );
  }

  const recurring = {
    kind: "cron" as const,
    expression: `*/${cadenceMinutes} * * * *`,
  };
  const policy: TaskReminderPolicy =
    kind === "once"
      ? {
          primary: { kind: "once", at: firstReminderAt },
          overdue: { ...recurring, startAt: dueAt },
        }
      : {
          primary: { ...recurring, startAt: firstReminderAt },
        };
  validateTaskReminderPolicy(policy, timezone, dueAt, from);
  return policy;
}

export function taskCadenceMinutes(policy: TaskReminderPolicy): string | null {
  const schedule =
    policy.primary.kind === "once" ? policy.overdue : policy.primary;
  if (!schedule || schedule.kind !== "cron") return null;
  return schedule.expression.match(/^\*\/(\d+) \* \* \* \*$/)?.[1] ?? null;
}
