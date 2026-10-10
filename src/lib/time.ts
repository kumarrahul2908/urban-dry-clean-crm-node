/** MySQL DATETIME strings in UTC, as the PHP app stores them. */
export function utcDatetime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export function parseUtcDatetime(value: string): number {
  return Date.parse(value.replace(' ', 'T') + 'Z');
}
