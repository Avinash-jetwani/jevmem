/** Every error code the API answers with, and its status. `api/openapi.yaml` lists the same codes. */
export const ERROR_CODES = {
  station_not_found: 404,
  alert_not_found: 404,
  invalid_station_id: 400,
  invalid_email: 400,
  limit_too_large: 400,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/** Thrown by a route; the app's error handler turns it into `{ error: { code, message } }` with the code's status. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message?: string,
  ) {
    super(message ?? code.replace(/_/g, " "));
  }
  get status(): number {
    return ERROR_CODES[this.code];
  }
}
