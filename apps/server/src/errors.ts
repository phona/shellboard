export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function httpError(statusCode: number, message: string): HttpError {
  return new HttpError(statusCode, message);
}
