import * as chrono from "chrono-node";

export interface DateRange {
  start: string;
  end: string;
  expression: string;
}

function startOfUTCDay(date: Date): Date {
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
      0,
      0,
      0,
      0
    )
  );
}

function addDaysUTC(date: Date, days: number): Date {
  const result = new Date(date);

  result.setUTCDate(
    result.getUTCDate() + days
  );

  return result;
}

function toRange(
  date: Date,
  expression: string
): DateRange {
  const start = startOfUTCDay(date);
  const end = addDaysUTC(start, 1);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
    expression
  };
}

export function resolveDateExpression(
  expression: string,
  referenceDate = new Date()
): DateRange | null {
  const normalized = expression
    .trim()
    .toLowerCase();

  if (normalized === "today") {
    return toRange(
      referenceDate,
      expression
    );
  }

  if (normalized === "yesterday") {
    return toRange(
      addDaysUTC(referenceDate, -1),
      expression
    );
  }

  const parsed = chrono.parseDate(
    expression,
    referenceDate,
    {
      forwardDate: false
    }
  );

  if (!parsed) {
    return null;
  }

  return toRange(
    parsed,
    expression
  );
}

export function resolveDateFromQuery(
  query: string,
  referenceDate = new Date()
): DateRange | null {
  const results = chrono.parse(
    query,
    referenceDate,
    {
      forwardDate: false
    }
  );

  if (results.length === 0) {
    return null;
  }

  const result = results[0];

  return toRange(
    result.start.date(),
    result.text
  );
}