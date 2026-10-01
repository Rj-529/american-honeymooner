export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 502,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Duffel and Nuitee 4xx become 400. Their 5xx become 502. */
export function upstreamClientError(status: number, detail: string): HttpError {
  const message = detail.trim() || `Upstream request failed with status ${status}.`;
  if (status >= 400 && status < 500) return new HttpError(message, 400);
  return new HttpError(message, 502);
}
