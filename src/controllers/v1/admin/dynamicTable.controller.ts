import { DynamicTableRepository } from '../../../repositories/dynamicTable.repository.js';
import { FxAnalyzerCacheRepository } from '../../../repositories/fxAnalyzerCache.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { logger } from '../../../utils/logger.util.js';
const tableRepository = new DynamicTableRepository();
const cacheRepository = new FxAnalyzerCacheRepository();
export const getAllTables = async (req, res, next) => {
    try {
        const tables = await tableRepository.findAll();
        res.status(HTTP_STATUS.OK).json(successResponse('Dynamic tables retrieved successfully', tables));
    }
    catch (error) {
        next(error);
    }
};
export const getTableById = async (req, res, next) => {
    try {
        const userId = req.user?.id || req.user?.user_id || null;
        const tableId = req.params.id;
        const tableWithoutRows = await tableRepository.findById(tableId);
        if (!tableWithoutRows) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Table not found');
        }
        const isUserFilteringEnabled = tableWithoutRows.identifier === 'trading_journal_table';
        const table = (userId !== null && isUserFilteringEnabled)
            ? await tableRepository.findByIdAndUserId(tableId, userId)
            : await tableRepository.findById(tableId);
        res.status(HTTP_STATUS.OK).json(successResponse('Table retrieved successfully', table));
    }
    catch (error) {
        next(error);
    }
};
export const getTableByIdentifier = async (req, res, next) => {
    try {
        const startTime = Date.now();
        const userId = req.user?.id || req.user?.user_id || null;
        const tableIdentifier = req.params.identifier;
        if (tableIdentifier === 'fx_analyzer_pro') {
            const requestedPair = req.query.pair;
            if (requestedPair) {
                logger.info(`FX Analyzer: Fetching cached data for pair: ${requestedPair}`);
                const cachedData = await cacheRepository.findByPair(requestedPair);
                if (!cachedData) {
                    logger.warn(`Cache miss for pair: ${requestedPair}, falling back to database`);
                    const table = await tableRepository.findByIdentifier(tableIdentifier);
                    if (!table) {
                        throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Table not found');
                    }
                    if (table.rows) {
                        table.rows = table.rows.filter(row => row.currencyPair?.pair === requestedPair);
                    }
                    const duration = Date.now() - startTime;
                    logger.info(`FX Analyzer: Retrieved from database in ${duration}ms (cache miss)`);
                    res.status(HTTP_STATUS.OK).json(successResponse('Table retrieved successfully', table));
                    return;
                }
                const table = await tableRepository.findByIdentifier(tableIdentifier);
                if (!table) {
                    throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Table not found');
                }
                if (cachedData.complete_data?.analyzerData) {
                    table.rows = [{
                            id: cachedData.complete_data.analyzerData.rowId,
                            row_index: cachedData.complete_data.analyzerData.rowIndex,
                            currencyPair: {
                                id: cachedData.currency_pair_id,
                                pair: cachedData.pair,
                            },
                            cells: cachedData.complete_data.analyzerData.cells,
                        }];
                }
                else {
                    table.rows = [];
                }
                const duration = Date.now() - startTime;
                logger.info(`FX Analyzer: Retrieved from cache in ${duration}ms ⚡`);
                res.status(HTTP_STATUS.OK).json(successResponse('Table retrieved successfully (cached)', table));
                return;
            }
            else {
                logger.info('FX Analyzer: Fetching all cached pairs');
                const allCachedData = await cacheRepository.findAll();
                if (allCachedData && allCachedData.length > 0) {
                    const table = await tableRepository.findByIdentifier(tableIdentifier);
                    if (!table) {
                        throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Table not found');
                    }
                    table.rows = allCachedData.map(cached => {
                        if (cached.complete_data?.analyzerData) {
                            return {
                                id: cached.complete_data.analyzerData.rowId,
                                row_index: cached.complete_data.analyzerData.rowIndex,
                                currencyPair: {
                                    id: cached.currency_pair_id,
                                    pair: cached.pair,
                                },
                                cells: cached.complete_data.analyzerData.cells || [],
                            };
                        }
                        return null;
                    }).filter(Boolean);
                    const duration = Date.now() - startTime;
                    logger.info(`FX Analyzer: Retrieved ${table.rows.length} pairs from cache in ${duration}ms ⚡`);
                    res.status(HTTP_STATUS.OK).json(successResponse('Table retrieved successfully (cached)', table));
                    return;
                }
                logger.warn('FX Analyzer: Cache empty, falling back to database');
            }
        }
        const isUserFilteringEnabled = tableIdentifier === 'trading_journal_table';
        const table = (userId !== null && isUserFilteringEnabled)
            ? await tableRepository.findByIdentifierAndUserId(tableIdentifier, userId)
            : await tableRepository.findByIdentifier(tableIdentifier);
        if (!table) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Table not found');
        }
        const duration = Date.now() - startTime;
        logger.info(`Table ${tableIdentifier}: Retrieved from database in ${duration}ms`);
        res.status(HTTP_STATUS.OK).json(successResponse('Table retrieved successfully', table));
    }
    catch (error) {
        next(error);
    }
};
export const createTable = async (req, res, next) => {
    try {
        const table = await tableRepository.create(req.body);
        res.status(HTTP_STATUS.CREATED).json(successResponse(SUCCESS_MESSAGES.CREATED, table));
    }
    catch (error) {
        next(error);
    }
};
export const updateTable = async (req, res, next) => {
    try {
        const table = await tableRepository.update(req.params.id, req.body);
        if (!table) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Table not found');
        }
        res.status(HTTP_STATUS.NO_CONTENT).send();
    }
    catch (error) {
        next(error);
    }
};
export const deleteTable = async (req, res, next) => {
    try {
        const deleted = await tableRepository.delete(req.params.id);
        if (!deleted) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Table not found');
        }
        res.status(HTTP_STATUS.NO_CONTENT).send();
    }
    catch (error) {
        next(error);
    }
};
export const recalculateTable = async (req, res, next) => {
    try {
        const table = await tableRepository.findById(req.params.id);
        if (!table) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Table not found');
        }
        res.status(HTTP_STATUS.OK).json(successResponse('Table formulas recalculated successfully', table));
    }
    catch (error) {
        next(error);
    }
};
