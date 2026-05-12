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
    normalizeSheetName(tableId) {
        const sheetId = String(tableId || '').trim();
        if (!sheetId) {
            throw new Error('Sheet name is required');
        }
        return sheetId.startsWith('forex_site_') ? sheetId : `forex_site_${sheetId}`;
    }
    async initialize() {
        if (this.initialized) {
            return;
        }
        try {
            const credentialsPath = path.resolve(ENV.GOOGLE_SHEETS_CREDENTIALS_PATH);
            if (!fs.existsSync(credentialsPath)) {
                throw new Error(`Google Sheets credentials file not found at: ${credentialsPath}`);
            }
            const credentials = JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
            const auth = new google.auth.GoogleAuth({
                credentials,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            const authClient = await auth.getClient();
            this.sheets = google.sheets({ version: 'v4', auth: authClient });
            this.initialized = true;
            logger.info('✅ Google Sheets API initialized successfully');
        }
        catch (error) {
            logger.error('Failed to initialize Google Sheets API:', error);
            throw error;
        }
    }
    async ensureInitialized() {
        if (!this.initialized) {
            await this.initialize();
        }
    }
    /**
     * Wrap tab title for A1 notation. Names with spaces, `/`, `&`, etc. must be quoted (Google Sheets API).
     */
    quoteSheetTitleForRange(title) {
        return `'${String(title || '').replace(/'/g, "''")}'`;
    }
    a1Range(sheetTitle, cellOrRange) {
        return `${this.quoteSheetTitleForRange(sheetTitle)}!${cellOrRange}`;
    }
    async getOrCreateSheet(tableId) {
        await this.ensureInitialized();
        try {
            const preferredSheetName = this.normalizeSheetName(tableId);
            const response = await this.sheets.spreadsheets.get({
                spreadsheetId: this.spreadsheetId,
            });
            const sheets = response.data.sheets || [];
            const existingSheet = sheets.find((sheet) => sheet.properties.title === preferredSheetName)
                || sheets.find((sheet) => sheet.properties.title === tableId);
            if (existingSheet) {
                return existingSheet.properties.title;
            }
            const addSheetResponse = await this.sheets.spreadsheets.batchUpdate({
                spreadsheetId: this.spreadsheetId,
                resource: {
                    requests: [{
                            addSheet: {
                                properties: {
                                    title: preferredSheetName,
                                    gridProperties: {
                                        rowCount: 100,
                                        columnCount: 26,
                                    },
                                },
                            },
                        }],
                },
            });
            const newSheetName = addSheetResponse.data.replies[0].addSheet.properties.title;
            logger.info(`Created new sheet tab: ${newSheetName}`);
            return newSheetName;
        }
        catch (error) {
            logger.error(`Error getting or creating sheet for ${tableId}:`, error);
            throw error;
        }
    }
    async updateCell(tableId, cell, value) {
        await this.ensureInitialized();
        try {
            const sheetName = await this.getOrCreateSheet(tableId);
            const range = this.a1Range(sheetName, cell);
            await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [[value]],
                },
            });
            logger.debug(`Updated cell ${range} with value: ${value}`);
        }
        catch (error) {
            logger.error(`Error updating cell ${cell} in ${tableId}:`, error);
            throw error;
        }
    }
    async batchUpdateCells(tableId, updates) {
        await this.ensureInitialized();
        try {
            const sheetName = await this.getOrCreateSheet(tableId);
            const data = updates.map(update => ({
                range: this.a1Range(sheetName, update.cell),
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
        }
        catch (error) {
            logger.error(`Error batch updating cells in ${tableId}:`, error);
            throw error;
        }
    }
    async getRange(tableId, range) {
        await this.ensureInitialized();
        try {
            const sheetName = await this.getOrCreateSheet(tableId);
            const fullRange = this.a1Range(sheetName, range);
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: fullRange,
                valueRenderOption: 'FORMATTED_VALUE',
            });
            return response.data.values || [];
        }
        catch (error) {
            logger.error(`Error getting range ${range} from ${tableId}:`, error);
            throw error;
        }
    }
    async getRangeBySheetName(sheetName, range) {
        await this.ensureInitialized();
        try {
            const fullRange = this.a1Range(sheetName, range);
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: fullRange,
                valueRenderOption: 'FORMATTED_VALUE',
            });
            return response.data.values || [];
        }
        catch (error) {
            logger.error(`Error getting range ${range} from sheet ${sheetName}:`, error);
            throw error;
        }
    }
    async getCell(tableId, cell) {
        const values = await this.getRange(tableId, cell);
        return values[0]?.[0] || null;
    }
    async syncTable(tableId, data, startCell = 'A1') {
        await this.ensureInitialized();
        try {
            const sheetName = await this.getOrCreateSheet(tableId);
            const range = this.a1Range(sheetName, startCell);
            await this.sheets.spreadsheets.values.update({
                spreadsheetId: this.spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: data,
                },
            });
            logger.info(`Synced table ${sheetName} with ${data.length} rows`);
        }
        catch (error) {
            logger.error(`Error syncing table ${tableId}:`, error);
            throw error;
        }
    }
    async clearRange(tableId, range) {
        await this.ensureInitialized();
        try {
            const sheetName = await this.getOrCreateSheet(tableId);
            const fullRange = this.a1Range(sheetName, range);
            await this.sheets.spreadsheets.values.clear({
                spreadsheetId: this.spreadsheetId,
                range: fullRange,
            });
            logger.info(`Cleared range ${fullRange}`);
        }
        catch (error) {
            logger.error(`Error clearing range ${range} in ${tableId}:`, error);
            throw error;
        }
    }
    async clearAndSync(tableId, data) {
        await this.ensureInitialized();
        try {
            const sheetName = await this.getOrCreateSheet(tableId);
            const numCols = data?.[0]?.length || 1;
            const existingValues = await this.getAllValues(sheetName);
            const existingMaxCols = existingValues.reduce((max, row) => Math.max(max, row?.length || 0), 0);
            const clearCols = Math.max(numCols, existingMaxCols, 1);
            const endCol = this.indexToColumn(clearCols - 1);
            const maxRows = Math.max(existingValues.length || 0, data.length || 0, 1000);
            const clearRange = this.a1Range(sheetName, `A1:${endCol}${maxRows}`);
            await this.sheets.spreadsheets.values.clear({
                spreadsheetId: this.spreadsheetId,
                range: clearRange,
            });
            await this.syncTable(sheetName, data);
            logger.info(`Cleared and synced table ${sheetName} with ${data.length} rows`);
        }
        catch (error) {
            logger.error(`Error clearing and syncing table ${tableId}:`, error);
            throw error;
        }
    }
    async getAllValues(tableId) {
        await this.ensureInitialized();
        try {
            const sheetName = await this.getOrCreateSheet(tableId);
            const response = await this.sheets.spreadsheets.values.get({
                spreadsheetId: this.spreadsheetId,
                range: this.quoteSheetTitleForRange(sheetName),
                valueRenderOption: 'FORMATTED_VALUE',
            });
            return response.data.values || [];
        }
        catch (error) {
            logger.error(`Error getting all values from ${tableId}:`, error);
            throw error;
        }
    }
    columnToIndex(column) {
        let index = 0;
        for (let i = 0; i < column.length; i++) {
            index = index * 26 + (column.charCodeAt(i) - 64);
        }
        return index - 1;
    }
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
export const googleSheetsService = new GoogleSheetsService();
