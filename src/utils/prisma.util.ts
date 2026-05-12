import { Prisma } from '@prisma/client';
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER);
const normalizeBigInt = (value: bigint): number | string => {
    if (value <= MAX_SAFE_BIGINT && value >= MIN_SAFE_BIGINT) {
        return Number(value);
    }
    return value.toString();
};

export const serializePrisma = (value: unknown): unknown => {
    if (typeof value === 'bigint') {
        return normalizeBigInt(value);
    }
    if (value instanceof Prisma.Decimal) {
        return Number(value);
    }
    if (Array.isArray(value)) {
        return value.map((item) => serializePrisma(item));
    }
    if (value instanceof Date) {
        return value;
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, nestedValue]) => [key, serializePrisma(nestedValue)]),
        );
    }
    return value;
};

export const parseJsonText = (value: unknown): unknown => {
    if (!value) {
        return null;
    }
    if (typeof value !== 'string') {
        return value;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
};

export const stringifyJsonText = (value: unknown): string => {
    if (value === null || value === undefined) {
        return JSON.stringify(null);
    }
    return JSON.stringify(value);
};
