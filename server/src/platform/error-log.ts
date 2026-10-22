/**
 * Recent server errors (5xx) of THIS process, for admin diagnostics. Kept in
 * memory only (lost on restart; other instances keep their own): route
 * pattern, error class and request id, never the URL query, body, headers,
 * message or stack, which can carry personal data or secrets. The request id
 * finds the full entry in the platform logs.
 */
export interface RecordedError {
  at: string;
  requestId: string;
  method: string;
  route: string;
  statusCode: number;
  errorClass: string;
}

const MAX = 100;
const buffer: RecordedError[] = [];
let total = 0;

export function recordServerError(e: Omit<RecordedError, "at">): void {
  total++;
  buffer.push({ ...e, at: new Date().toISOString() });
  if (buffer.length > MAX) buffer.shift();
}

export function recentServerErrors(): { errors: RecordedError[]; totalSinceStart: number; capacity: number } {
  return { errors: [...buffer].reverse(), totalSinceStart: total, capacity: MAX };
}
