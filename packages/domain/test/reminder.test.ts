import { describe, expect, it } from 'vitest';
import {
  archiveReminder,
  createReminder,
  dismissOccurrence,
  duplicateReminder,
  postponeOccurrence,
  restoreReminder,
  setReminderEnabled,
} from '../src/index';

const base = {
  id: 'reminder-1',
  ownerId: 'user-1',
  title: 'Take medicine',
  schedule: { kind: 'cron' as const, expression: '0 9 * * *' },
  timezone: 'America/Sao_Paulo',
  now: '2026-09-23T12:00:00.000Z',
};

describe('reminder lifecycle', () => {
  it('requires a title', () => {
    expect(() => createReminder({ ...base, title: ' ' })).toThrow('title');
  });

  it('disables, archives, and restores a reminder', () => {
    const reminder = createReminder(base);
    expect(setReminderEnabled(reminder, false).status).toBe('disabled');
    expect(archiveReminder(reminder).status).toBe('archived');
    expect(restoreReminder(archiveReminder(reminder)).status).toBe('active');
  });

  it('duplicates with stable user content and a new identity', () => {
    const copy = duplicateReminder(createReminder(base), 'reminder-2', base.now);
    expect(copy.id).toBe('reminder-2');
    expect(copy.title).toBe(base.title);
    expect(copy.revision).toBe(1);
  });

  it('dismisses and postpones only an occurrence', () => {
    const occurrence = {
      id: 'reminder-1:2026-09-24T12:00:00.000Z',
      reminderId: 'reminder-1',
      scheduledAt: '2026-09-24T12:00:00.000Z',
      status: 'scheduled' as const,
    };
    expect(dismissOccurrence(occurrence, base.now).status).toBe('dismissed');
    expect(postponeOccurrence(occurrence, 10, base.now).snoozedUntil).toBe(
      '2026-09-23T12:10:00.000Z',
    );
  });
});
