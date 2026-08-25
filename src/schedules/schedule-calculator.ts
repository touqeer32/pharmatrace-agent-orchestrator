import { BadRequestException } from '@nestjs/common';
import { DateTime, IANAZone } from 'luxon';

export interface ScheduleShape {
  schedule_type: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'ONCE';
  timezone: string;
  time_of_day: string | null;
  day_of_week: number | null;
  day_of_month: number | null;
  scheduled_for: string | Date | null;
}

export function nextRunAt(shape: ScheduleShape, after = new Date()): Date | null {
  if (!IANAZone.isValidZone(shape.timezone)) {
    throw new BadRequestException(`Invalid IANA timezone: ${shape.timezone}`);
  }

  if (shape.schedule_type === 'ONCE') {
    if (!shape.scheduled_for) {
      throw new BadRequestException('ONCE schedules require scheduledFor');
    }

    const instant =
      shape.scheduled_for instanceof Date
        ? DateTime.fromJSDate(shape.scheduled_for)
        : DateTime.fromISO(shape.scheduled_for, { setZone: true });

    if (!instant.isValid) {
      throw new BadRequestException('scheduledFor must contain a valid date and time');
    }

    return instant.toJSDate();
  }

  if (!shape.time_of_day) {
    throw new BadRequestException(`${shape.schedule_type} schedules require timeOfDay`);
  }

  const [hour, minute, second = 0] = shape.time_of_day.split(':').map(Number);
  const reference = DateTime.fromJSDate(after).setZone(shape.timezone);
  const atConfiguredTime = (date: DateTime) =>
    date.set({ hour, minute, second, millisecond: 0 });

  if (shape.schedule_type === 'DAILY') {
    let candidate = atConfiguredTime(reference);

    if (candidate.toMillis() <= reference.toMillis()) {
      candidate = atConfiguredTime(reference.plus({ days: 1 }));
    }

    return candidate.toUTC().toJSDate();
  }

  if (shape.schedule_type === 'WEEKLY') {
    if (shape.day_of_week === null || shape.day_of_week === undefined) {
      throw new BadRequestException('WEEKLY schedules require dayOfWeek (0=Sunday)');
    }

    for (let offset = 0; offset <= 7; offset += 1) {
      const candidate = atConfiguredTime(reference.plus({ days: offset }));
      const sundayBasedWeekday = candidate.weekday % 7;

      if (
        sundayBasedWeekday === shape.day_of_week &&
        candidate.toMillis() > reference.toMillis()
      ) {
        return candidate.toUTC().toJSDate();
      }
    }
  }

  if (shape.schedule_type === 'MONTHLY') {
    if (!shape.day_of_month) {
      throw new BadRequestException('MONTHLY schedules require dayOfMonth');
    }

    for (let offset = 0; offset <= 1; offset += 1) {
      const month = reference.plus({ months: offset }).startOf('month');
      // A schedule for the 31st runs on the final day of shorter months.
      const day = Math.min(shape.day_of_month, month.daysInMonth ?? 28);
      const candidate = atConfiguredTime(month.set({ day }));

      if (candidate.toMillis() > reference.toMillis()) {
        return candidate.toUTC().toJSDate();
      }
    }
  }

  throw new BadRequestException('Could not calculate the next schedule occurrence');
}
