import { googleSheetsService } from './googleSheets.service.js';
import { logger } from '../utils/logger.util.js';
import { ENV } from '../config/env.js';
import {
    buildColumnDefsFromHeaderRow,
    buildTableRowsFromSheetValues,
    replaceDynamicTableFromSheetGrid,
} from './sheetGridDynamicTable.util.js';
import { edgeToolsTmvHistoryService } from './edgeToolsTmvHistory.service.js';

const SHEET_ERROR_PATTERN = /^#(?:N\/A|VALUE!|REF!|DIV\/0!|NAME\?|NUM!|NULL!|ERROR!)$/i;

function hasSpreadsheetErrorCell(sheetValues: unknown[][]): boolean {
    return sheetValues.some((row) =>
        row.some((cell) => SHEET_ERROR_PATTERN.test(String(cell ?? '').trim())),
    );
}

export class EdgeToolsSheetSyncService {
    async syncCurrencyStrengthIndexFromSheet(
        sheetName = ENV.EDGE_SENTIMENT_INDEX_SHEET_NAME,
        range = ENV.EDGE_CURRENCY_STRENGTH_INDEX_RANGE,
    ) {
        logger.info(`[EdgeToolsSync] Currency Strength Index ${sheetName}!${range}`);
        const sheetValues = await googleSheetsService.getRangeBySheetName(sheetName, range);
        if (!sheetValues?.length) {
            throw new Error(`Empty range ${sheetName}!${range}`);
        }
        const columnDefs = buildColumnDefsFromHeaderRow(sheetValues[0]!);
        const tableRows = buildTableRowsFromSheetValues(sheetValues, sheetName, range, columnDefs);
        return replaceDynamicTableFromSheetGrid(
            'edge_currency_strength_index',
            'Currency Strength Index',
            sheetName,
            range,
            columnDefs,
            tableRows,
        );
    }

    async syncForexPairAnalysisFromSheet(
        sheetName = ENV.EDGE_SENTIMENT_INDEX_SHEET_NAME,
        range = ENV.EDGE_FOREX_PAIR_ANALYSIS_RANGE,
    ) {
        logger.info(`[EdgeToolsSync] Forex Pair Analysis ${sheetName}!${range}`);
        const sheetValues = await googleSheetsService.getRangeBySheetName(sheetName, range);
        if (!sheetValues?.length) {
            throw new Error(`Empty range ${sheetName}!${range}`);
        }
        const columnDefs = buildColumnDefsFromHeaderRow(sheetValues[0]!);
        const tableRows = buildTableRowsFromSheetValues(sheetValues, sheetName, range, columnDefs);
        return replaceDynamicTableFromSheetGrid(
            'edge_forex_pair_analysis',
            'Forex Pair Analysis',
            sheetName,
            range,
            columnDefs,
            tableRows,
        );
    }

    async syncTechnicalDashboardFromSheet(
        sheetName = ENV.EDGE_TECHNICAL_DASHBOARD_SHEET_NAME,
        range = ENV.EDGE_TECHNICAL_DASHBOARD_RANGE,
    ) {
        logger.info(`[EdgeToolsSync] Technical Dashboard ${sheetName}!${range}`);
        const sheetValues = await googleSheetsService.getRangeBySheetName(sheetName, range);
        if (!sheetValues?.length) {
            throw new Error(`Empty range ${sheetName}!${range}`);
        }
        if (hasSpreadsheetErrorCell(sheetValues)) {
            throw new Error(`Spreadsheet errors are still present in ${sheetName}!${range}; skipping DB sync until formulas settle`);
        }
        const columnDefs = buildColumnDefsFromHeaderRow(sheetValues[0]!);
        const tableRows = buildTableRowsFromSheetValues(sheetValues, sheetName, range, columnDefs);
        const result = await replaceDynamicTableFromSheetGrid(
            'edge_technical_dashboard',
            'Technical Dashboard',
            sheetName,
            range,
            columnDefs,
            tableRows,
        );
        await edgeToolsTmvHistoryService.appendSnapshotFromTechnicalDashboard(result.table);
        return result;
    }

    async syncAllFromSheets(): Promise<{
        currencyStrength: { identifier: string; rowsSynced: number; error?: string };
        forexPairAnalysis: { identifier: string; rowsSynced: number; error?: string };
        technicalDashboard: { identifier: string; rowsSynced: number; error?: string };
    }> {
        const run = async (
            identifier: string,
            fn: () => Promise<{ identifier: string; rowsSynced: number }>,
        ): Promise<{ identifier: string; rowsSynced: number; error?: string }> => {
            try {
                return await fn();
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger.error(`[EdgeToolsSync] ${identifier} failed: ${message}`);
                return { identifier, rowsSynced: 0, error: message };
            }
        };

        const currencyStrength = await run('edge_currency_strength_index', () =>
            this.syncCurrencyStrengthIndexFromSheet(),
        );
        const forexPairAnalysis = await run('edge_forex_pair_analysis', () => this.syncForexPairAnalysisFromSheet());
        const technicalDashboard = await run('edge_technical_dashboard', () => this.syncTechnicalDashboardFromSheet());

        return { currencyStrength, forexPairAnalysis, technicalDashboard };
    }
}

export const edgeToolsSheetSyncService = new EdgeToolsSheetSyncService();
