import { googleSheetsService } from '../../../services/googleSheets.service.js';
import { websocketService } from '../../../services/websocket.service.js';
import { cacheUpdateTrigger } from '../../../services/cacheUpdateTrigger.service.js';
import { logger } from '../../../utils/logger.util.js';

/**
 * Update a single cell in the table editor
 * POST /api/v1/admin/table-editor/update-cell
 * Body: { tableId: string, cell: string, value: string|number }
 */
export const updateCell = async (req, res, next) => {
    try {
        console.log('📥 Received updateCell request:', {
            body: req.body,
            tableId: req.body.tableId,
            cell: req.body.cell,
            value: req.body.value
        });

        const { tableId, cell, value } = req.body;

        // Validate input
        if (!tableId || !cell || value === undefined) {
            console.error('❌ Validation failed:', { tableId, cell, value });
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: tableId, cell, value',
            });
        }

        // Update cell in Google Sheets
        await googleSheetsService.updateCell(tableId, cell, value);

        // Get the calculated value after update
        // Wait a brief moment for Google Sheets to calculate
        await new Promise(resolve => setTimeout(resolve, 100));

        const calculatedValue = await googleSheetsService.getCell(tableId, cell);

        // Broadcast update via WebSocket
        websocketService.broadcastTableUpdate({
            tableId,
            updates: [{
                cell,
                value: calculatedValue,
            }],
        });

        // Trigger cache update for fx_analyzer_pro table
        // Note: You'll need to pass the table identifier if you have it
        // For now, we trigger for fx_analyzer_pro if this is that table
        const tableIdentifier = req.body.tableIdentifier; // Pass this from frontend if available
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
    } catch (error) {
        logger.error('Error updating cell:', error);
        res.status(500).json({
            success: false,
            message: error.message || 'Error updating cell in Google Sheets',
            error: process.env.NODE_ENV === 'development' ? error : undefined
        });
    }
};

/**
 * Batch update multiple cells
 * POST /api/v1/admin/table-editor/batch-update
 * Body: { tableId: string, updates: Array<{cell: string, value: string|number}> }
 */
export const batchUpdateCells = async (req, res, next) => {
    try {
        const { tableId, updates } = req.body;

        // Validate input
        if (!tableId || !Array.isArray(updates) || updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: tableId, updates (array)',
            });
        }

        // Update cells in Google Sheets
        await googleSheetsService.batchUpdateCells(tableId, updates);

        // Wait for calculations
        await new Promise(resolve => setTimeout(resolve, 200));

        // Get calculated values for all updated cells
        const calculatedUpdates = await Promise.all(
            updates.map(async update => ({
                cell: update.cell,
                value: await googleSheetsService.getCell(tableId, update.cell),
            }))
        );

        // Broadcast updates via WebSocket
        websocketService.broadcastTableUpdate({
            tableId,
            updates: calculatedUpdates,
        });

        // Trigger cache update for fx_analyzer_pro table
        const tableIdentifier = req.body.tableIdentifier; // Pass this from frontend if available
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
    } catch (error) {
        logger.error('Error batch updating cells:', error);
        next(error);
    }
};

/**
 * Get values from a range
 * GET /api/v1/admin/table-editor/range?tableId=xxx&range=A1:C10
 */
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
    } catch (error) {
        logger.error('Error getting range:', error);
        next(error);
    }
};

/**
 * Get a single cell value
 * GET /api/v1/admin/table-editor/cell?tableId=xxx&cell=C3
 */
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
    } catch (error) {
        logger.error('Error getting cell:', error);
        next(error);
    }
};

/**
 * Sync entire table data to Google Sheets
 * POST /api/v1/admin/table-editor/sync-table
 * Body: { tableId: string, data: Array<Array<any>>, startCell?: string }
 */
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

        // Wait for calculations
        await new Promise(resolve => setTimeout(resolve, 300));

        // Get all calculated values
        const calculatedValues = await googleSheetsService.getAllValues(tableId);

        // Broadcast full table update
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
    } catch (error) {
        logger.error('Error syncing table:', error);
        next(error);
    }
};

/**
 * Get all values from a table
 * GET /api/v1/admin/table-editor/table?tableId=xxx
 */
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
    } catch (error) {
        logger.error('Error getting table:', error);
        next(error);
    }
};

/**
 * Clear a range in the table
 * POST /api/v1/admin/table-editor/clear-range
 * Body: { tableId: string, range: string }
 */
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

        // Broadcast clear event
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
    } catch (error) {
        logger.error('Error clearing range:', error);
        next(error);
    }
};

/**
 * Initialize Google Sheets service
 * POST /api/v1/admin/table-editor/initialize
 */
export const initialize = async (req, res, next) => {
    try {
        await googleSheetsService.initialize();

        res.json({
            success: true,
            message: 'Google Sheets service initialized successfully',
        });
    } catch (error) {
        logger.error('Error initializing Google Sheets:', error);
        next(error);
    }
};
