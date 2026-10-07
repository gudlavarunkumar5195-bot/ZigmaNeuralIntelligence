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
