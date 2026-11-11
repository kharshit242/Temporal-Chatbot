import {
  describe,
  expect,
  it
} from "vitest";

import {
  resolveDateExpression
} from "../src/temporal/resolver.js";

describe("Temporal resolver", () => {
  const referenceDate =
    new Date("2026-11-10T12:00:00.000Z");

  it("resolves today", () => {
    const result =
      resolveDateExpression(
        "today",
        referenceDate
      );

    expect(result).not.toBeNull();

    expect(result?.start)
      .toBe("2026-11-10T00:00:00.000Z");
  });

  it("resolves yesterday", () => {
    const result =
      resolveDateExpression(
        "yesterday",
        referenceDate
      );

    expect(result).not.toBeNull();

    expect(result?.start)
      .toBe("2026-11-09T00:00:00.000Z");
  });

  it("resolves an absolute date", () => {
    const result =
      resolveDateExpression(
        "November 3, 2026",
        referenceDate
      );

    expect(result).not.toBeNull();

    expect(result?.start)
      .toBe("2026-11-03T00:00:00.000Z");
  });
});