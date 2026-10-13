// One error type for the whole store: an HTTP status, a plain-English message and optional extra fields
// (errors per field for 422, usedIn for 409). The API turns it into a JSON reply.
export class HttpError extends Error {
  status: number;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export const fail = (status: number, message: string, extra?: Record<string, unknown>): never => {
  throw new HttpError(status, message, extra);
};
