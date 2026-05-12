export type ApiErrorDetails = unknown;

export class ApiError extends Error {
    readonly statusCode: number;
    readonly errors: ApiErrorDetails | null;

    constructor(statusCode: number, message: string, errors: ApiErrorDetails | null = null) {
        super(message);
        this.statusCode = statusCode;
        this.errors = errors;
        this.name = 'ApiError';
        Error.captureStackTrace(this, ApiError);
    }
}
