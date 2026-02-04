import { google } from 'googleapis';
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class GoogleSheetsService {
    constructor() {
        this.sheets = null;
        this.spreadsheetId = ENV.GOOGLE_SHEETS_ID;
        this.initialized = false;
    }

    /**
     * Initialize Google Sheets API client
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        try {
            // Load service account credentials
            const credentialsPath = path.resolve(ENV.GOOGLE_SHEETS_CREDENTIALS_PATH);

            if (!fs.existsSync(credentialsPath)) {
                throw new Error(`Google Sheets credentials file not found at: ${credentialsPath}`);
            }

            const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));

            // Create JWT client
            const auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });

            const authClient = await auth.getClient();

            // Initialize Sheets API
            this.sheets = google.sheets({ version: 'v4', auth: authClient });
            this.initialized = true;

            logger.info('✅ Google Sheets API initialized successfully');
        } catch (error) {
            logger.error('Failed to initialize Google Sheets API:', error);
            throw error;
        }
    }

    /**
     * Ensure the service is initialized before any operation
     */
    async ensureInitialized() {
        if (!this.initialized) {
            await this.initialize();
        }
    }

    /**
     * Get or create a sheet tab for a specific table
     * @param {string} tableId - The table identifier (e.g., "risk-mode", "bias-score")
     * @returns {Promise<number>} - The sheet ID
     */
    async getOrCreateSheet(tableId) {
        await this.ensureInitialized();

        try {
            // Get spreadsheet metadata
            const response = await this.sheets.spreadsheets.get({
                spreadsheetId: this.spreadsheetId,
            });

            const sheets = response.data.sheets;
            const existingSheet = sheets.find(s => s.properties.title === tableId);

            if (existingSheet) {
                return existingSheet.properties.sheetId;
            }

            // Create new sheet
            const addSheetResponse = await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId: this.spreadsheetId,
                resource: {
                    requests: [{
                        addSheet: {
                            properties: {
                                title: tableId,
                                gridProperties: {
                                    rowCount: 100,
                                    columnCount: 26,
                                },
                            },
                        },
                    }],
                },
            });

            const newSheetId = addSheetResponse.data.replies[0].addSheet.properties.sheetId;
            logger.info(`Created new sheet tab: ${tableId} (ID: ${newSheetId})`);

            return newSheetId;
        } catch (error) {
            logger.error(`Error getting or creating sheet for ${tableId}:`, error);
            throw error;
        }
    }

    /**
     * Update a single cell in Google Sheets
     * @param {string} tableId - The table identifier
     * @param {string} cell - Cell reference (e.g., "C3")
     * @param {string|number} value - Value or formula to set
     * @returns {Promise<void>}
     */
    async updateCell(tableId, cell, value) {
        await this.ensureInitialized();

        try {
            // Ensure sheet tab exists
            await this.getOrCreateSheet(tableId);

            const range = `${tableId}!${cell}`;

            await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED', // This allows formulas to be processed
                resource: {
                    values: [[value]],
                },
            });

            logger.debug(`Updated cell ${range} with value: ${value}`);
        } catch (error) {
            logger.error(`Error updating cell ${cell} in ${tableId}:`, error);
            throw error;
        }
    }

    /**
     * Update multiple cells in a batch
     * @param {string} tableId - The table identifier
     * @param {Array<{cell: string, value: string|number}>} updates - Array of cell updates
     * @returns {Promise<void>}
     */
    async batchUpdateCells(tableId, updates) {
        await this.ensureInitialized();

        try {
            // Ensure sheet tab exists
            await this.getOrCreateSheet(tableId);

            const data = updates.map(update => ({
                range: `${tableId}!${update.cell}`,
                values: [[update.value]],
            }));

            await this.sheets.spreadsheets.values.batchUpdate({
                spreadsheetId: this.spreadsheetId,
                resource: {
                    valueInputOption: 'USER_ENTERED',
                    data,
                },
            });

            logger.debug(`Batch updated ${updates.length} cells in ${tableId}`);
        } catch (error) {
            logger.error(`Error batch updating cells in ${tableId}:`, error);
            throw error;
        }
    }

    /**
     * Get calculated values from a range
     * @param {string} tableId - The table identifier
     * @param {string} range - Range in A1 notation (e.g., "C1:C9")
     * @returns {Promise<Array<Array<any>>>} - 2D array of values
     */
    async getRange(tableId, range) {
        await this.ensureInitialized();

        try {
            const fullRange = `${tableId}!${range}`;

            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: fullRange,
                valueRenderOption: 'FORMATTED_VALUE', // Get calculated values
            });

            return response.data.values || [];
        } catch (error) {
            logger.error(`Error getting range ${range} from ${tableId}:`, error);
            throw error;
        }
    }

    /**
     * Get a single cell value
     * @param {string} tableId - The table identifier
     * @param {string} cell - Cell reference (e.g., "C3")
     * @returns {Promise<any>} - Cell value
     */
    async getCell(tableId, cell) {
        const values = await this.getRange(tableId, cell);
        return values[0]?.[0] || null;
    }

    /**
     * Sync entire table data to Google Sheets
     * @param {string} tableId - The table identifier
     * @param {Array<Array<any>>} data - 2D array of table data
     * @param {string} startCell - Starting cell (default "A1")
     * @returns {Promise<void>}
     */
    async syncTable(tableId, data, startCell = 'A1') {
        await this.ensureInitialized();

        try {
            // Ensure sheet exists
            await this.getOrCreateSheet(tableId);

            const range = `${tableId}!${startCell}`;

            await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: data,
                },
            });

            logger.info(`Synced table ${tableId} with ${data.length} rows`);
        } catch (error) {
            logger.error(`Error syncing table ${tableId}:`, error);
            throw error;
        }
    }

    /**
     * Clear a range in Google Sheets
     * @param {string} tableId - The table identifier
     * @param {string} range - Range to clear (e.g., "A1:Z100")
     * @returns {Promise<void>}
     */
    async clearRange(tableId, range) {
        await this.ensureInitialized();

        try {
            const fullRange = `${tableId}!${range}`;

            await this.sheets.spreadsheets.values.clear({
                spreadsheetId: this.spreadsheetId,
                range: fullRange,
            });

            logger.info(`Cleared range ${fullRange}`);
        } catch (error) {
            logger.error(`Error clearing range ${range} in ${tableId}:`, error);
            throw error;
        }
    }

    /**
     * Get all values from a sheet tab
     * @param {string} tableId - The table identifier
     * @returns {Promise<Array<Array<any>>>} - All values from the sheet
     */
    async getAllValues(tableId) {
        await this.ensureInitialized();

        try {
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: tableId,
                valueRenderOption: 'FORMATTED_VALUE',
            });

            return response.data.values || [];
        } catch (error) {
            logger.error(`Error getting all values from ${tableId}:`, error);
            throw error;
        }
    }

    /**
     * Convert column letter to index (A=0, B=1, etc.)
     * @param {string} column - Column letter (e.g., "A", "AA")
     * @returns {number} - Column index
     */
    columnToIndex(column) {
        let index = 0;
        for (let i = 0; i < column.length; i++) {
            index = index * 26 + (column.charCodeAt(i) - 64);
        }
        return index - 1;
    }

    /**
     * Convert column index to letter (0=A, 1=B, etc.)
     * @param {number} index - Column index
     * @returns {string} - Column letter
     */
    indexToColumn(index) {
        let column = '';
        index++;
        while (index > 0) {
            const remainder = (index - 1) % 26;
            column = String.fromCharCode(65 + remainder) + column;
            index = Math.floor((index - 1) / 26);
        }
        return column;
    }

    /**
     * Parse cell reference (e.g., "C3" -> {column: "C", row: 3})
     * @param {string} cell - Cell reference
     * @returns {{column: string, row: number, columnIndex: number}}
     */
    parseCell(cell) {
        const match = cell.match(/^([A-Z]+)(\d+)$/);
        if (!match) {
            throw new Error(`Invalid cell reference: ${cell}`);
        }

        const column = match[1];
        const row = parseInt(match[2]);
        const columnIndex = this.columnToIndex(column);

        return { column, row, columnIndex };
    }
}

// Export singleton instance
export const googleSheetsService = new GoogleSheetsService();
