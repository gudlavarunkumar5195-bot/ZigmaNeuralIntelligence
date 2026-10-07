import { describe, expect, it } from "vitest"
import { PaginationValidationError, parsePagination } from "../http/pagination.js"

describe("bounded pagination", () => {
  it("uses bounded defaults and computes an offset", () => {
    expect(parsePagination({ page: "2", pageSize: "25" })).toEqual({ page: 2, pageSize: 25, offset: 25 })
  })

  it("rejects negative, enormous, and malformed values", () => {
    for (const value of [{ page: "0" }, { pageSize: "101" }, { page: "nope" }]) {
      expect(() => parsePagination(value)).toThrow(PaginationValidationError)
    }
  })
})