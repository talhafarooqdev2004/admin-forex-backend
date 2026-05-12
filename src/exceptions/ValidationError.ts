export class ValidationError extends Error {
    constructor(message, errors = null) {
        super(message);
        this.statusCode = 422;
        this.errors = errors;
        this.name = 'ValidationError';
        Error.captureStackTrace(this, this.constructor);
    }
}
