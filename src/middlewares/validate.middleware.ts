import type { NextFunction, RequestHandler } from "express";
import type { ZodIssue, ZodTypeAny } from "zod";
import { ApiError, type ApiErrorDetails } from '../exceptions/ApiError.js';

type ValidationTarget = "body" | "query" | "params";

type ValidationErrorItem = {
    field: string;
    message: string;
};

type ValidationResult<T> =
    | { value: T; error?: never }
    | { error: ApiError; value?: never };

const isZodSchema = (schema: unknown): schema is ZodTypeAny => {
    return Boolean(schema) && typeof (schema as ZodTypeAny).safeParse === "function";
};

const formatZodErrors = (issues: ZodIssue[]): ValidationErrorItem[] => {
    return issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
    }));
};

const validateValue = <T = unknown>(
    schema: unknown,
    value: unknown,
    sourceLabel: string,
): ValidationResult<T> => {
    if (isZodSchema(schema)) {
        const result = schema.safeParse(value);

        if (!result.success) {
            const errors: ApiErrorDetails = formatZodErrors(result.error.issues);
            return { error: new ApiError(422, `${sourceLabel} failed`, errors) };
        }

        return { value: result.data as T };
    }

    throw new Error("Unsupported validation schema. Use Zod.");
};

const createValidator = (
    schema: unknown,
    target: ValidationTarget,
    label: string,
): RequestHandler => {
    return (req, res, next: NextFunction): void => {
        try {
            const result = validateValue(schema, req[target], label);

            if ("error" in result) {
                next(result.error);
                return;
            }

            req[target] = result.value as never;
            next();
        } catch (error) {
            next(error);
        }
    };
};

export const validate = (schema: unknown): RequestHandler => createValidator(schema, "body", "Validation");
export const validateQuery = (schema: unknown): RequestHandler => createValidator(schema, "query", "Query");
export const validateParams = (schema: unknown): RequestHandler => createValidator(schema, "params", "Params");
