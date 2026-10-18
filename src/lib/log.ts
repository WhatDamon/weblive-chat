/** Single-line JSON logs: platform log search works without a log library. */
export type LogFields = Record<
  string,
  string | number | boolean | null | undefined
>;

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function logError(
  scope: string,
  err: unknown,
  fields: LogFields = {},
): void {
  const base: Record<string, unknown> = {
    level: "error",
    scope,
    msg: err instanceof Error ? err.message : String(err),
  };
  if (err instanceof Error && err.stack) base.stack = err.stack;
  emit(base, fields);
}

export function logInfo(event: string, fields: LogFields = {}): void {
  emit({ level: "info", event }, fields);
}

function emit(base: Record<string, unknown>, fields: LogFields): void {
  const line: Record<string, unknown> = { ...base, at: Date.now() };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) line[k] = v;
  console.error(JSON.stringify(line));
}
