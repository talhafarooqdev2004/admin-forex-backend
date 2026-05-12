import { prisma } from '../lib/prisma.js';
import { googleSheetsService } from './googleSheets.service.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { logger } from '../utils/logger.util.js';

const DEFAULT_IDENTIFIER = 'retail_sentiment_currency_pairs';
const DEFAULT_TABLE_NAME = 'Retail Sentiment Currency Pairs';
const DEFAULT_SHEET_NAME = 'RETAIL SENTIMENTS 7';
const DEFAULT_RANGE = 'A4:D31';

const TABLE_COLUMNS = [
    { header: 'Currency Pair', key: 'currency_pair', column_index: 0 },
    { header: 'LONG %', key: 'long_pct', column_index: 1 },
    { header: 'SHORT %', key: 'short_pct', column_index: 2 },
    { header: 'Score', key: 'score', column_index: 3 },
];

const normalizeCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
};

export class RetailSentimentSyncService {
    tableRepository: DynamicTableRepository;

    constructor() {
        this.tableRepository = new DynamicTableRepository();
    }

    async syncFromSheet({
        sheetName = DEFAULT_SHEET_NAME,
        range = DEFAULT_RANGE,
        identifier = DEFAULT_IDENTIFIER,
        tableName = DEFAULT_TABLE_NAME,
    } = {}) {
        logger.info(`[RetailSentimentSync] Reading ${sheetName}!${range}`);

        const sheetValues = await googleSheetsService.getRangeBySheetName(sheetName, range);
        if (!sheetValues || sheetValues.length === 0) {
            throw new Error(`No values returned from ${sheetName}!${range}`);
        }

        const dataRows = sheetValues
            .map((row, index) => ({
                row,
                rowIndex: index,
            }))
            .filter(({ row }) => Array.isArray(row) && row.some((value) => normalizeCell(value) !== ''));

        const tableRows = dataRows.map(({ row, rowIndex }) => {
            const pair = normalizeCell(row[0]);

            return {
                row_index: rowIndex,
                row_metadata: {
                    source: 'google_sheets',
                    source_sheet_name: sheetName,
                    source_range: range,
                    source_row_index: rowIndex,
                },
                cells: [
                    { column_index: 0, value: pair, data_type: 'text' },
                    { column_index: 1, value: normalizeCell(row[1]), data_type: 'text' },
                    { column_index: 2, value: normalizeCell(row[2]), data_type: 'text' },
                    { column_index: 3, value: normalizeCell(row[3]), data_type: 'text' },
                ],
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
                where: {
                    dynamic_table_id: table.id,
                },
            });

            await tx.tableColumn.deleteMany({
                where: {
                    dynamic_table_id: table.id,
                },
            });

            const createdColumns = [];
            for (const column of TABLE_COLUMNS) {
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
        });

        const syncedTable = await this.tableRepository.findByIdentifier(identifier);
        if (!syncedTable) {
            throw new Error(`Table ${identifier} could not be loaded after sync`);
        }

        logger.info(`[RetailSentimentSync] Synced ${syncedTable.rows?.length || 0} rows from ${sheetName}`);

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

export const retailSentimentSyncService = new RetailSentimentSyncService();
