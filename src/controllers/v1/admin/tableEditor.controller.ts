import { googleSheetsService } from '../../../services/googleSheets.service.js';
import { websocketService } from '../../../services/websocket.service.js';
import { cacheUpdateTrigger } from '../../../services/cacheUpdateTrigger.service.js';
import { logger } from '../../../utils/logger.util.js';
export const updateCell = async (req, res, next) => {
    try {
        const { tableId, cell, value } = req.body;
        if (!tableId || !cell || value === undefined) {
            console.error('❌ Validation failed:', { tableId, cell, value });
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: tableId, cell, value',
            });
        }
        await googleSheetsService.updateCell(tableId, cell, value);
        await new Promise(resolve => setTimeout(resolve, 100));
        const calculatedValue = await googleSheetsService.getCell(tableId, cell);
        websocketService.broadcastTableUpdate({
            tableId,
            updates: [{
                    cell,
                    value: calculatedValue,
                }],
        });
        const tableIdentifier = req.body.tableIdentifier;
        if (tableIdentifier) {
            await cacheUpdateTrigger.triggerTableEditorUpdate(tableId, cell, tableIdentifier);
        }
        res.json({
            success: true,
            data: {
                cell,
                value: calculatedValue,
            },
        });
    }
    catch (error) {
        logger.error('Error updating cell:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error updating cell in Google Sheets',
            error: process.env.NODE_ENV === 'development' ? error : undefined
        });
    }
};
export const batchUpdateCells = async (req, res, next) => {
    try {
        const { tableId, updates } = req.body;
        if (!tableId || !Array.isArray(updates) || updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: tableId, updates (array)',
            });
        }
        await googleSheetsService.batchUpdateCells(tableId, updates);
        await new Promise(resolve => setTimeout(resolve, 200));
        const calculatedUpdates = await Promise.all(updates.map(async (update) => ({
            cell: update.cell,
            value: await googleSheetsService.getCell(tableId, update.cell),
        })));
        websocketService.broadcastTableUpdate({
            tableId,
            updates: calculatedUpdates,
        });
        const tableIdentifier = req.body.tableIdentifier;
        if (tableIdentifier) {
            await cacheUpdateTrigger.triggerTableEditorUpdate(tableId, calculatedUpdates[0]?.cell, tableIdentifier);
        }
        res.json({
            success: true,
            data: {
                updatedCells: calculatedUpdates.length,
                updates: calculatedUpdates,
            },
        });
    }
    catch (error) {
        logger.error('Error batch updating cells:', error);
        next(error);
    }
};
export const getRange = async (req, res, next) => {
    try {
        const { tableId, range } = req.query;
        if (!tableId || !range) {
            return res.status(400).json({
                success: false,
                message: 'Missing required query parameters: tableId, range',
            });
        }
        const values = await googleSheetsService.getRange(tableId, range);
        res.json({
            success: true,
            data: {
                tableId,
                range,
                values,
            },
        });
    }
    catch (error) {
        logger.error('Error getting range:', error);
        next(error);
    }
};
export const getCell = async (req, res, next) => {
    try {
        const { tableId, cell } = req.query;
        if (!tableId || !cell) {
            return res.status(400).json({
                success: false,
                message: 'Missing required query parameters: tableId, cell',
            });
        }
        const value = await googleSheetsService.getCell(tableId, cell);
        res.json({
            success: true,
            data: {
                tableId,
                cell,
                value,
            },
        });
    }
    catch (error) {
        logger.error('Error getting cell:', error);
        next(error);
    }
};
export const syncTable = async (req, res, next) => {
    try {
        const { tableId, data, startCell = 'A1' } = req.body;
        if (!tableId || !Array.isArray(data)) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: tableId, data (2D array)',
            });
        }
        await googleSheetsService.syncTable(tableId, data, startCell);
        await new Promise(resolve => setTimeout(resolve, 300));
        const calculatedValues = await googleSheetsService.getAllValues(tableId);
        websocketService.broadcastTableSync({
            tableId,
            data: calculatedValues,
        });
        res.json({
            success: true,
            data: {
                tableId,
                rowsSynced: data.length,
                calculatedData: calculatedValues,
            },
        });
    }
    catch (error) {
        logger.error('Error syncing table:', error);
        next(error);
    }
};
export const getTable = async (req, res, next) => {
    try {
        const { tableId } = req.query;
        if (!tableId) {
            return res.status(400).json({
                success: false,
                message: 'Missing required query parameter: tableId',
            });
        }
        const values = await googleSheetsService.getAllValues(tableId);
        res.json({
            success: true,
            data: {
                tableId,
                values,
            },
        });
    }
    catch (error) {
        logger.error('Error getting table:', error);
        next(error);
    }
};
export const clearRange = async (req, res, next) => {
    try {
        const { tableId, range } = req.body;
        if (!tableId || !range) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: tableId, range',
            });
        }
        await googleSheetsService.clearRange(tableId, range);
        websocketService.broadcastTableUpdate({
            tableId,
            action: 'clear',
            range,
        });
        res.json({
            success: true,
            data: {
                tableId,
                range,
                cleared: true,
            },
        });
    }
    catch (error) {
        logger.error('Error clearing range:', error);
        next(error);
    }
};
export const initialize = async (req, res, next) => {
    try {
        await googleSheetsService.initialize();
        res.json({
            success: true,
            message: 'Google Sheets service initialized successfully',
        });
    }
    catch (error) {
        logger.error('Error initializing Google Sheets:', error);
        next(error);
    }
};
