export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 500,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
