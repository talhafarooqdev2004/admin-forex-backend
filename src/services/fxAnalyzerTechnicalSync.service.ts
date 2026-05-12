import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { googleSheetsService } from './googleSheets.service.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { logger } from '../utils/logger.util.js';
import { ENV } from '../config/env.js';

const normalizeCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
};

/** 0-based index of column W (column A = 0). */
const COL_W = 22;

const TRENDS_IDENTIFIER = 'fx_technical_trends';
const TRENDS_TABLE_NAME = 'FX Technical Trends';
const LEVELS_IDENTIFIER = 'fx_technical_levels';
const LEVELS_TABLE_NAME = 'FX Technical Levels';

const TRENDS_COLUMNS = [
    { header: 'Currency Pair', key: 'currency_pair', column_index: 0 },
    { header: '1H Trend', key: 'h1_trend', column_index: 1 },
    { header: '1H Momentum', key: 'h1_momentum', column_index: 2 },
    { header: '1H Volatility', key: 'h1_volatility', column_index: 3 },
    { header: '4H Trend', key: 'h4_trend', column_index: 4 },
    { header: '4H Momentum', key: 'h4_momentum', column_index: 5 },
    { header: '4H Volatility', key: 'h4_volatility', column_index: 6 },
    { header: 'Daily Trend', key: 'd_trend', column_index: 7 },
    { header: 'Daily Momentum', key: 'd_momentum', column_index: 8 },
    { header: 'Daily Volatility', key: 'd_volatility', column_index: 9 },
] as const;

const LEVELS_COLUMNS = [
    { header: 'Currency Pair', key: 'currency_pair', column_index: 0 },
    { header: 'Current Price', key: 'current_price', column_index: 1 },
    { header: 'Pivot', key: 'pivot', column_index: 2 },
    { header: 'S1', key: 's1', column_index: 3 },
    { header: 'S2', key: 's2', column_index: 4 },
    { header: 'S3', key: 's3', column_index: 5 },
    { header: 'R1', key: 'r1', column_index: 6 },
    { header: 'R2', key: 'r2', column_index: 7 },
    { header: 'R3', key: 'r3', column_index: 8 },
] as const;

function rowToTrendCells(row: unknown[]): Array<{ column_index: number; value: string; data_type: string }> {
    const c = (offset: number) => normalizeCell(row[COL_W + offset]);
    return [
        { column_index: 0, value: normalizeCell(row[0]), data_type: 'text' },
        { column_index: 1, value: c(0), data_type: 'text' },
        { column_index: 2, value: c(1), data_type: 'text' },
        { column_index: 3, value: c(2), data_type: 'text' },
        { column_index: 4, value: c(3), data_type: 'text' },
        { column_index: 5, value: c(4), data_type: 'text' },
        { column_index: 6, value: c(5), data_type: 'text' },
        { column_index: 7, value: c(6), data_type: 'text' },
        { column_index: 8, value: c(7), data_type: 'text' },
        { column_index: 9, value: c(8), data_type: 'text' },
    ];
}

function rowToLevelsCells(row: unknown[]): Array<{ column_index: number; value: string; data_type: string }> {
    const cells: Array<{ column_index: number; value: string; data_type: string }> = [];
    for (let i = 0; i < 9; i++) {
        cells.push({ column_index: i, value: normalizeCell(row[i]), data_type: 'text' });
    }
    return cells;
}

type ColumnDef = { header: string; key: string; column_index: number };

async function replaceDynamicTableFromRows(
    identifier: string,
    tableName: string,
    sheetName: string,
    range: string,
    columns: readonly ColumnDef[],
    tableRows: Array<{
        row_index: number;
        row_metadata: Record<string, unknown>;
        cells: Array<{ column_index: number; value: string; data_type: string }>;
    }>,
) {
    const tableMetadata = {
        source: 'google_sheets',
        sourceSheetName: sheetName,
        sourceRange: range,
        borderStyle: 'simple',
        borderColor: 'rgb(var(--charcoal))',
        syncedAt: new Date().toISOString(),
    };

    await prisma.$transaction(async (tx) => {
        const existingTable = await tx.dynamicTable.findUnique({
            where: { identifier },
            select: { id: true },
        });

        const table = existingTable
            ? await tx.dynamicTable.update({
                where: { identifier },
                data: {
                    name: tableName,
                    description: `Auto-synced from Google Sheets tab ${sheetName}`,
                    table_metadata: tableMetadata,
                    is_active: true,
                },
            })
            : await tx.dynamicTable.create({
                data: {
                    name: tableName,
                    identifier,
                    description: `Auto-synced from Google Sheets tab ${sheetName}`,
                    table_metadata: tableMetadata,
                    is_active: true,
                },
            });

        await tx.tableRow.deleteMany({
            where: { dynamic_table_id: table.id },
        });

        await tx.tableColumn.deleteMany({
            where: { dynamic_table_id: table.id },
        });

        const createdColumns: { id: bigint; column_index: number }[] = [];
        for (const column of columns) {
            const createdColumn = await tx.tableColumn.create({
                data: {
                    dynamic_table_id: table.id,
                    header: column.header,
                    key: column.key,
                    column_index: column.column_index,
                    column_metadata: {
                        source: 'google_sheets',
                        sourceSheetName: sheetName,
                    },
                },
            });
            createdColumns.push(createdColumn);
        }

        for (const rowData of tableRows) {
            const createdRow = await tx.tableRow.create({
                data: {
                    dynamic_table_id: table.id,
                    row_index: rowData.row_index,
                    row_metadata: rowData.row_metadata as Prisma.InputJsonValue,
                },
            });

            for (const cellData of rowData.cells) {
                const relatedColumn = createdColumns.find((column) => column.column_index === cellData.column_index);
                if (!relatedColumn) {
                    continue;
                }

                await tx.tableCell.create({
                    data: {
                        table_row_id: createdRow.id,
                        table_column_id: relatedColumn.id,
                        value: cellData.value || null,
                        formula: null,
                        data_type: cellData.data_type,
                        cell_metadata: {
                            source: 'google_sheets',
                        },
                    },
                });
            }
        }
    });

    const tableRepository = new DynamicTableRepository();
    const syncedTable = await tableRepository.findByIdentifier(identifier);
    if (!syncedTable) {
        throw new Error(`Table ${identifier} could not be loaded after sync`);
    }
    return syncedTable;
}

export class FxAnalyzerTechnicalSyncService {
    async syncTechnicalTrendsFromSheet(
        sheetName = ENV.FX_ANALYZER_TECHNICAL_TRENDS_SHEET_NAME,
        range = ENV.FX_ANALYZER_TECHNICAL_TRENDS_RANGE,
    ) {
        logger.info(`[FxAnalyzerTechnicalSync] Reading trends ${sheetName}!${range}`);
        const sheetValues = await googleSheetsService.getRangeBySheetName(sheetName, range);
        if (!sheetValues || sheetValues.length < 2) {
            throw new Error(`No data rows returned from ${sheetName}!${range}`);
        }

        const tableRows: Array<{
            row_index: number;
            row_metadata: Record<string, unknown>;
            cells: Array<{ column_index: number; value: string; data_type: string }>;
        }> = [];

        for (let r = 1; r < sheetValues.length; r++) {
            const row = sheetValues[r];
            if (!Array.isArray(row) || row.length < 1) continue;
            const pair = normalizeCell(row[0]);
            if (!pair) continue;

            tableRows.push({
                row_index: tableRows.length,
                row_metadata: {
                    source: 'google_sheets',
                    source_sheet_name: sheetName,
                    source_range: range,
                    source_row_index: r,
                },
                cells: rowToTrendCells(row),
            });
        }

        const table = await replaceDynamicTableFromRows(
            TRENDS_IDENTIFIER,
            TRENDS_TABLE_NAME,
            sheetName,
            range,
            TRENDS_COLUMNS,
            tableRows,
        );

        logger.info(`[FxAnalyzerTechnicalSync] Synced ${table.rows?.length || 0} trend rows`);
        return { identifier: TRENDS_IDENTIFIER, table, rowsSynced: table.rows?.length || 0 };
    }

    async syncTechnicalLevelsFromSheet(
        sheetName = ENV.FX_ANALYZER_TECHNICAL_LEVELS_SHEET_NAME,
        range = ENV.FX_ANALYZER_TECHNICAL_LEVELS_RANGE,
    ) {
        logger.info(`[FxAnalyzerTechnicalSync] Reading levels ${sheetName}!${range}`);
        const sheetValues = await googleSheetsService.getRangeBySheetName(sheetName, range);
        if (!sheetValues || sheetValues.length < 2) {
            throw new Error(`No data rows returned from ${sheetName}!${range}`);
        }

        const tableRows: Array<{
            row_index: number;
            row_metadata: Record<string, unknown>;
            cells: Array<{ column_index: number; value: string; data_type: string }>;
        }> = [];

        for (let r = 1; r < sheetValues.length; r++) {
            const row = sheetValues[r];
            if (!Array.isArray(row) || row.length < 1) continue;
            const pair = normalizeCell(row[0]);
            if (!pair) continue;

            tableRows.push({
                row_index: tableRows.length,
                row_metadata: {
                    source: 'google_sheets',
                    source_sheet_name: sheetName,
                    source_range: range,
                    source_row_index: r,
                },
                cells: rowToLevelsCells(row),
            });
        }

        const table = await replaceDynamicTableFromRows(
            LEVELS_IDENTIFIER,
            LEVELS_TABLE_NAME,
            sheetName,
            range,
            LEVELS_COLUMNS,
            tableRows,
        );

        logger.info(`[FxAnalyzerTechnicalSync] Synced ${table.rows?.length || 0} level rows`);
        return { identifier: LEVELS_IDENTIFIER, table, rowsSynced: table.rows?.length || 0 };
    }

    async syncBothFromSheets() {
        const trends = await this.syncTechnicalTrendsFromSheet();
        const levels = await this.syncTechnicalLevelsFromSheet();
        return { trends, levels };
    }
}

export const fxAnalyzerTechnicalSyncService = new FxAnalyzerTechnicalSyncService();
