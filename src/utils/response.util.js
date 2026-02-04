export const successResponse = (message, data = null, meta = null) => {
    const response = {
        success: true,
        message,
    };

    if (data !== null) response.data = data;
    if (meta !== null) response.meta = meta;

    return response;
};

export const errorResponse = (message, errors = null) => {
    const response = {
        success: false,
        message,
    };

    if (errors) response.errors = errors;

    return response;
};
