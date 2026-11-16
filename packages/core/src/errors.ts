export class HistosPublishError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "HistosPublishError";
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HistosPublishError("Operazione annullata.", "cancelled", 6);
  }
}
