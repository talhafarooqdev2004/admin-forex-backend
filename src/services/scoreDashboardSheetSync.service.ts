import { prisma } from '../lib/prisma.js';
import { googleSheetsService } from './googleSheets.service.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { logger } from '../utils/logger.util.js';
import { ENV } from '../config/env.js';

const DEFAULT_IDENTIFIER = 'score_dashboard_sheet76';
const DEFAULT_TABLE_NAME = 'Score Dashboard (Sheet76)';
const DEFAULT_SHEET_NAME = 'Sheet76';
const DEFAULT_RANGE = 'A2:J30';

const FALLBACK_HEADERS = [
    'Currency Pair',
    'Net Score',
    'Net Bias',
    'Trend',
    'Momentum',
    'Sentiment',
    'Fundamental',
    'Cot Score',
    'Seasonal Score',
    'Risk Mode',
];

const FALLBACK_KEYS = [
    'currency_pair',
    'net_score',
    'net_bias',
    'trend',
    'momentum',
    'sentiment',
    'fundamental',
    'cot_score',
    'seasonal_score',
    'risk_mode',
];

const COL_COUNT = 10;

const normalizeCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
};

/** Remove emoji / pictographs so Net Bias shows plain text (e.g. Strong Bullish). */
const stripBiasDecorations = (value: string): string => {
    return value
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/\uFE0F/g, '')
        .replace(/\u200D/g, '')
        .replace(/[\u2190-\u21FF\u27A1\u2B05\u2B06\u2B07\u25B2\u25BC\u25B6\u25C0]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
};

const isNetBiasHeader = (header: string): boolean => normalizeCell(header).toLowerCase().includes('net bias');

export class ScoreDashboardSheetSyncService {
    tableRepository: DynamicTableRepository;

    constructor() {
        this.tableRepository = new DynamicTableRepository();
    }

    async syncFromSheet({
        sheetName = ENV.SCORE_DASHBOARD_SHEET_NAME || DEFAULT_SHEET_NAME,
        range = ENV.SCORE_DASHBOARD_SHEET_RANGE || DEFAULT_RANGE,
        identifier = DEFAULT_IDENTIFIER,
        tableName = DEFAULT_TABLE_NAME,
    } = {}) {
        logger.info(`[ScoreDashboardSheetSync] Reading ${sheetName}!${range}`);

        const sheetValues = await googleSheetsService.getRangeBySheetName(sheetName, range);
        if (!sheetValues || sheetValues.length < 2) {
            throw new Error(`No header + data rows returned from ${sheetName}!${range}`);
        }

        const rawHeaderRow = sheetValues[0] || [];
        const headers: string[] = [];
        const keys: string[] = [];
        for (let i = 0; i < COL_COUNT; i++) {
            const h = normalizeCell(rawHeaderRow[i]);
            headers.push(h || FALLBACK_HEADERS[i] || "");
            keys.push(FALLBACK_KEYS[i] || `col_${i}`);
        }

        const bodyRows = sheetValues.slice(1);
        const dataRows = bodyRows
            .map((row, index) => ({ row: Array.isArray(row) ? row : [], rowIndex: index }))
            .filter(({ row }) => row.some((value) => normalizeCell(value) !== ''));

        const netBiasColIndex = headers.findIndex((h) => isNetBiasHeader(h));
        const biasIdx = netBiasColIndex >= 0 ? netBiasColIndex : 2;

        const tableRows = dataRows.map(({ row, rowIndex }) => {
            const cells: Array<{ column_index: number; value: string; data_type: 'text' }> = [];
            for (let col = 0; col < COL_COUNT; col++) {
                let v = normalizeCell(row[col]);
                if (col === biasIdx) {
                    v = stripBiasDecorations(v);
                }
                cells.push({
                    column_index: col,
                    value: v,
                    data_type: 'text' as const,
                });
            }
            return {
                row_index: rowIndex,
                row_metadata: {
                    source: 'google_sheets',
                    source_sheet_name: sheetName,
                    source_range: range,
                    source_row_index: rowIndex,
                },
                cells,
            };
        });

        const tableMetadata = {
            source: 'google_sheets',
            sourceSheetName: sheetName,
            sourceRange: range,
            borderStyle: 'simple',
            borderColor: 'rgb(var(--charcoal))',
            syncedAt: new Date().toISOString(),
        };

        const columnDefs = headers.map((header, column_index) => ({
            header,
            key: keys[column_index],
            column_index,
        }));

        await prisma.$transaction(
            async (tx) => {
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

            const createdColumns: Array<{ id: bigint; column_index: number }> = [];
            for (const column of columnDefs) {
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
                        row_metadata: rowData.row_metadata,
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
        },
        {
            maxWait: 15000,
            timeout: 120000,
        },
        );

        const syncedTable = await this.tableRepository.findByIdentifier(identifier);
        if (!syncedTable) {
            throw new Error(`Table ${identifier} could not be loaded after sync`);
        }

        logger.info(`[ScoreDashboardSheetSync] Synced ${syncedTable.rows?.length || 0} rows from ${sheetName}`);

        return {
            identifier,
            tableName,
            sheetName,
            range,
            table: syncedTable,
            rowsSynced: syncedTable.rows?.length || 0,
        };
    }
}

export const scoreDashboardSheetSyncService = new ScoreDashboardSheetSyncService();
