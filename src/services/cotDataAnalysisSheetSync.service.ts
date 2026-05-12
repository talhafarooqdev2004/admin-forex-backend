import { googleSheetsService } from './googleSheets.service.js';
import { logger } from '../utils/logger.util.js';
import { ENV } from '../config/env.js';
import {
    buildColumnDefsFromHeaderRow,
    buildSyntheticColumnDefs,
    buildTableRowsAllDataNoHeader,
    buildTableRowsFromSheetValues,
    replaceDynamicTableFromSheetGrid,
} from './sheetGridDynamicTable.util.js';

const COT_CURRENCY_PAIR_SENTIMENT_ID = 'currency_pair_sentiment';
const COT_SENTIMENT_NET_SCORE_ID = 'cot_sentiment_net_score';
const COT_RAW_DATA_ID = 'cot_raw_data';

/** A:C block has no header row in the sheet — three positional columns (pair, score, bias). */
const COT_SENTIMENT_NET_SCORE_COLUMN_COUNT = 3;

export class CotDataAnalysisSheetSyncService {
    async syncCurrencyPairSentimentFromSheet(
        sheetName = ENV.COT_DATA_ANALYSIS_SHEET_NAME,
        range = ENV.COT_CURRENCY_PAIR_SENTIMENT_RANGE,
    ) {
        logger.info(`[CotDataAnalysisSync] Currency Pair Sentiment ${sheetName}!${range}`);
        const sheetValues = await googleSheetsService.getRangeBySheetName(sheetName, range);
        if (!sheetValues?.length) {
            throw new Error(`Empty range ${sheetName}!${range}`);
        }
        const columnDefs = buildColumnDefsFromHeaderRow(sheetValues[0]!);
        const tableRows = buildTableRowsFromSheetValues(sheetValues, sheetName, range, columnDefs);
        return replaceDynamicTableFromSheetGrid(
            COT_CURRENCY_PAIR_SENTIMENT_ID,
            'Currency Pair Sentiment',
            sheetName,
            range,
            columnDefs,
            tableRows,
        );
    }

    async syncCotSentimentNetScoreFromSheet(
        sheetName = ENV.COT_DATA_ANALYSIS_SHEET_NAME,
        range = ENV.COT_SENTIMENT_NET_SCORE_RANGE,
    ) {
        logger.info(`[CotDataAnalysisSync] COT Sentiment & Net Score ${sheetName}!${range} (no header)`);
        const sheetValues = await googleSheetsService.getRangeBySheetName(sheetName, range);
        if (!sheetValues?.length) {
            throw new Error(`Empty range ${sheetName}!${range}`);
        }
        const columnDefs = buildSyntheticColumnDefs(COT_SENTIMENT_NET_SCORE_COLUMN_COUNT);
        const tableRows = buildTableRowsAllDataNoHeader(sheetValues, sheetName, range, columnDefs);
        return replaceDynamicTableFromSheetGrid(
            COT_SENTIMENT_NET_SCORE_ID,
            'COT Sentiment & Net Score',
            sheetName,
            range,
            columnDefs,
            tableRows,
        );
    }

    async syncCotRawDataFromSheet(
        sheetName = ENV.COT_DATA_ANALYSIS_SHEET_NAME,
        range = ENV.COT_RAW_DATA_RANGE,
    ) {
        logger.info(`[CotDataAnalysisSync] COT Raw Data ${sheetName}!${range}`);
        const sheetValues = await googleSheetsService.getRangeBySheetName(sheetName, range);
        if (!sheetValues?.length) {
            throw new Error(`Empty range ${sheetName}!${range}`);
        }
        const columnDefs = buildColumnDefsFromHeaderRow(sheetValues[0]!);
        const tableRows = buildTableRowsFromSheetValues(sheetValues, sheetName, range, columnDefs);
        return replaceDynamicTableFromSheetGrid(
            COT_RAW_DATA_ID,
            'COT Raw Data',
            sheetName,
            range,
            columnDefs,
            tableRows,
        );
    }

    async syncAllFromSheets(): Promise<{
        currencyPairSentiment: { identifier: string; rowsSynced: number; error?: string };
        cotSentimentNetScore: { identifier: string; rowsSynced: number; error?: string };
        cotRawData: { identifier: string; rowsSynced: number; error?: string };
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
                logger.error(`[CotDataAnalysisSync] ${identifier} failed: ${message}`);
                return { identifier, rowsSynced: 0, error: message };
            }
        };

        const currencyPairSentiment = await run(COT_CURRENCY_PAIR_SENTIMENT_ID, () =>
            this.syncCurrencyPairSentimentFromSheet(),
        );
        const cotSentimentNetScore = await run(COT_SENTIMENT_NET_SCORE_ID, () => this.syncCotSentimentNetScoreFromSheet());
        const cotRawData = await run(COT_RAW_DATA_ID, () => this.syncCotRawDataFromSheet());

        return { currencyPairSentiment, cotSentimentNetScore, cotRawData };
    }
}

export const cotDataAnalysisSheetSyncService = new CotDataAnalysisSheetSyncService();
