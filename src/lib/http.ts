/** Same JSON envelope as mobile_json_success / mobile_json_error in the PHP app. */
export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number) {
    super(message);
  }
}

export const ok = <T>(data: T) => ({ success: true as const, data });
