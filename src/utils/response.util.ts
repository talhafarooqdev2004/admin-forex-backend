type SuccessResponse<TData = unknown, TMeta = unknown> = {
    success: true;
    message: string;
    data?: TData;
    meta?: TMeta;
};

type ErrorResponse<TErrors = unknown> = {
    success: false;
    message: string;
    errors?: TErrors;
};

export const successResponse = <TData = unknown, TMeta = unknown>(
    message: string,
    data: TData | null = null,
    meta: TMeta | null = null,
): SuccessResponse<TData, TMeta> => {
    const response: SuccessResponse<TData, TMeta> = {
        success: true,
        message,
    };

    if (data !== null) {
        response.data = data;
    }

    if (meta !== null) {
        response.meta = meta;
    }

    return response;
};

export const errorResponse = <TErrors = unknown>(
    message: string,
    errors: TErrors | null = null,
): ErrorResponse<TErrors> => {
    const response: ErrorResponse<TErrors> = {
        success: false,
        message,
    };

    if (errors !== null) {
        response.errors = errors;
    }

    return response;
};
