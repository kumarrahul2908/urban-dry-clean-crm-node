/** Calendar helpers in a fixed IANA timezone (APP_TIMEZONE) — PHP's date()/strtotime() ran in it. */
export function todayIn(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** date('Y-m-d', strtotime("+N day")) */
export function datePlusDays(tz: string, days: number, now: Date = new Date()): string {
  const [y, m, d] = todayIn(tz, now).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export const yearIn = (tz: string, now: Date = new Date()) => todayIn(tz, now).slice(0, 4);
