export const EXIT = { ok: 0, failure: 1, usage: 2 } as const;

/** An expected failure: main prints the message to stderr and exits with exitCode. */
export class TarsError extends Error {
  constructor(
    message: string,
    readonly exitCode: typeof EXIT.failure | typeof EXIT.usage = EXIT.failure,
  ) {
    super(message);
    this.name = "TarsError";
  }
}
