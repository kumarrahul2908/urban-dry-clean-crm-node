/** A known, user-facing failure (PHP: RuntimeException with a message meant for the client). */
export class BusinessError extends Error {
}
/** Same client_request_id replayed with different details. */
export class IdempotencyConflictError extends Error {
}
