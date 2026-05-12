export const HTTP_STATUS = {
    OK: 200,
    CREATED: 201,
    ACCEPTED: 202,
    NO_CONTENT: 204,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    CONFLICT: 409,
    UNPROCESSABLE_ENTITY: 422,
    INTERNAL_SERVER_ERROR: 500,
};
export const ERROR_MESSAGES = {
    INTERNAL_SERVER_ERROR: 'Internal server error',
    UNAUTHORIZED: 'Unauthorized access',
    FORBIDDEN: 'Forbidden access',
    NOT_FOUND: 'Resource not found',
    VALIDATION_ERROR: 'Validation error',
    ALREADY_EXISTS: 'Resource already exists',
    INVALID_CREDENTIALS: 'Invalid credentials',
};
export const SUCCESS_MESSAGES = {
    CREATED: 'Resource created successfully',
    UPDATED: 'Resource updated successfully',
    DELETED: 'Resource deleted successfully',
    PUBLISHED: 'Resource published successfully',
    UNPUBLISHED: 'Resource unpublished successfully',
};
export const PAGINATION = {
    DEFAULT_PAGE: 1,
    DEFAULT_LIMIT: 10,
    MAX_LIMIT: 100,
};
export const CACHE_KEYS = {
    USERS: 'users:all',
    USER: 'user:',
    PACKAGES: 'packages:all',
    EDUCATIONS: 'educations:all',
    DYNAMIC_TABLES: 'dynamic_tables:all',
    CURRENCY_PAIRS: 'currency_pairs:all',
    PAYMENT_GATEWAYS: 'payment_gateways:all',
    COLOR_CONFIGURATIONS: 'color_configurations:all',
    TRADING_ALERTS: 'trading_alerts:all',
};
export const CACHE_TTL = {
    SHORT: 300,
    MEDIUM: 1800,
    LONG: 3600,
    VERY_LONG: 86400,
};
export const USER_GENDER = {
    MALE: 'male',
    FEMALE: 'female',
    OTHER: 'other',
};
export const TRADING_ALERT_STATUS = {
    ACTIVE: 'active',
    CLOSED: 'closed',
    PENDING: 'pending',
};
export const TRADING_ALERT_TYPE = {
    BUY: 'buy',
    SELL: 'sell',
};
export const TRADING_ALERT_DIRECTION = {
    LONG: 'long',
    SHORT: 'short',
};
export const PAYMENT_GATEWAY_STATUS = {
    ACTIVE: 'active',
    INACTIVE: 'inactive',
};
export const TRANSACTION_STATUS = {
    PENDING: 'pending',
    COMPLETED: 'completed',
    FAILED: 'failed',
    REFUNDED: 'refunded',
};
export const LOCALES = ['en', 'es', 'fr', 'de', 'it', 'pt', 'ar', 'zh', 'ja', 'ko'];
export const DEFAULT_LOCALE = 'en';
