/** Same JSON envelope as mobile_json_success / mobile_json_error in the PHP app. */
export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    /** Extra fields merged into the error object (e.g. billing_unit), like mobile_json_error's $extra. */
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const ok = <T>(data: T) => ({ success: true as const, data });

/** Numeric helpers: MySQL DECIMALs arrive as strings from mysql2; PHP cast them with (float). */
export const num = (v: unknown): number => Number(v);
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
