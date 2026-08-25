import { nextRunAt } from './schedule-calculator';

describe('nextRunAt', () => {
  it('calculates a Malta-local daily occurrence', () => {
    const result = nextRunAt(
      {
        schedule_type: 'DAILY',
        timezone: 'Europe/Malta',
        time_of_day: '09:00:00',
        day_of_week: null,
        day_of_month: null,
        scheduled_for: null,
      },
      new Date('2026-08-21T06:00:00.000Z'),
    );

    expect(result?.toISOString()).toBe('2026-08-21T07:00:00.000Z');
  });

  it('uses the final available day for a 31st-of-month schedule', () => {
    const result = nextRunAt(
      {
        schedule_type: 'MONTHLY',
        timezone: 'UTC',
        time_of_day: '09:00:00',
        day_of_week: null,
        day_of_month: 31,
        scheduled_for: null,
      },
      new Date('2026-04-10T00:00:00.000Z'),
    );

    expect(result?.toISOString()).toBe('2026-04-30T09:00:00.000Z');
  });
});
