import { describe, expect, it } from 'vitest';
import {
  describeSchedule,
  nextOccurrences,
  parseCronSchedule,
  validateCronExpression,
} from '../src/index';

describe('cron schedule', () => {
  it('accepts standard five-field cron and rejects seconds', () => {
    expect(validateCronExpression('*/5 * * * *')).toEqual({ valid: true });
    expect(validateCronExpression('* * * * * *').valid).toBe(false);
  });

  it('enforces a minimum one-minute interval', () => {
    expect(validateCronExpression('* * * * *')).toEqual({ valid: true });
  });

  it('previews five timezone-aware occurrences', () => {
    const occurrences = nextOccurrences(
      parseCronSchedule('0 9 * * 1-5'),
      'America/Sao_Paulo',
      new Date('2026-09-23T12:01:00.000Z'),
      5,
    );
    expect(occurrences).toHaveLength(5);
    expect(occurrences[0]?.toISOString()).toBe('2026-09-24T12:00:00.000Z');
  });

  it('describes common schedules in English and Brazilian Portuguese', () => {
    expect(describeSchedule({ kind: 'cron', expression: '0 9 * * *' }, 'en')).toBe(
      'Every day at 09:00',
    );
    expect(describeSchedule({ kind: 'cron', expression: '0 9 * * *' }, 'pt-BR')).toBe(
      'Todos os dias às 09:00',
    );
  });
});
