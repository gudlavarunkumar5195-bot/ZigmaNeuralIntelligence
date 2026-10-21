import { z } from "zod";

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export class PaginationValidationError extends Error {
  statusCode = 400
  code = "INVALID_PAGINATION"

  constructor() {
    super("Pagination page must be 1-10000 and pageSize must be 1-100")
    this.name = "PaginationValidationError"
  }
}

export function parsePagination(query: unknown): { page: number; pageSize: number; offset: number } {
  const result = paginationSchema.safeParse(query ?? {})
  if (!result.success) throw new PaginationValidationError()
  const parsed = result.data
  return { ...parsed, offset: (parsed.page - 1) * parsed.pageSize };
}

// ─── Cursor (keyset) pagination ──────────────────────────────────────────────

const cursorPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(1_024).optional(),
});

export class CursorValidationError extends Error {
  statusCode = 400
  code = "INVALID_CURSOR"

  constructor() {
    super("Cursor is malformed or does not belong to this listing")
    this.name = "CursorValidationError"
  }
}

/** `?limit=1-100&cursor=<opaque>`; the cursor is decoded by the listing that issued it. */
export function parseCursorPagination(query: unknown): { limit: number; cursor?: string } {
  const result = cursorPaginationSchema.safeParse(query ?? {})
  if (!result.success) throw new PaginationValidationError()
  return result.data
}

/** Opaque cursor: base64url JSON of the last row's sort key. */
export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url")
}

/** Decodes and validates a cursor; anything unexpected is a 400, never a SQL error. */
export function decodeCursor<T extends Record<string, unknown>>(cursor: string, valid: (value: T) => boolean): T {
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    throw new CursorValidationError()
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || !valid(value as T)) throw new CursorValidationError()
  return value as T
}
