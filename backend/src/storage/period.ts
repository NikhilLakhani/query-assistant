import { Temporal } from '@js-temporal/polyfill';

export function dailyPeriod(now: Date, timezone: string) {
  const day = Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO(timezone)
    .startOfDay();
  return {
    start: new Date(day.epochMilliseconds),
    end: new Date(day.add({ days: 1 }).epochMilliseconds),
  };
}
