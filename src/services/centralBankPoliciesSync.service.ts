import { prisma } from '../lib/prisma.js';
import { googleSheetsService } from './googleSheets.service.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';
import { logger } from '../utils/logger.util.js';

const DEFAULT_IDENTIFIER = 'central_bank_policies';
const DEFAULT_TABLE_NAME = 'Central Bank Policies';
const DEFAULT_SHEET_NAME = 'Fundamentals New';
const DEFAULT_RANGE = 'A179:E187';

const TABLE_COLUMNS = [
    { header: 'Central Bank', key: 'central_bank', column_index: 0 },
    { header: 'Current Rate', key: 'current_rate', column_index: 1 },
    { header: 'Next Meeting', key: 'next_meeting', column_index: 2 },
    { header: 'Last Change', key: 'last_change', column_index: 3 },
    { header: 'Stance', key: 'stance', column_index: 4 },
];

const normalizeCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
};

export class CentralBankPoliciesSyncService {
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
        logger.info(`[CentralBankPoliciesSync] Reading ${sheetName}!${range}`);

        const sheetValues = await googleSheetsService.getRangeBySheetName(sheetName, range);
        if (!sheetValues || sheetValues.length < 2) {
            throw new Error(`No header + data rows returned from ${sheetName}!${range}`);
        }

        const rawHeaderRow = sheetValues[0] || [];
        const headers = TABLE_COLUMNS.map((column, index) => normalizeCell(rawHeaderRow[index]) || column.header);

        const bodyRows = sheetValues.slice(1);
        const dataRows = bodyRows
            .map((row, index) => ({ row: Array.isArray(row) ? row : [], rowIndex: index }))
            .filter(({ row }) => normalizeCell(row[0]) !== '');

        const tableRows = dataRows.map(({ row, rowIndex }) => {
            return {
                row_index: rowIndex,
                row_metadata: {
                    source: 'google_sheets',
                    source_sheet_name: sheetName,
                    source_range: range,
                    source_row_index: rowIndex,
                },
                cells: TABLE_COLUMNS.map((column, column_index) => ({
                    column_index,
                    value: normalizeCell(row[column_index]),
                    data_type: 'text' as const,
                })),
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
            key: TABLE_COLUMNS[column_index]?.key || `col_${column_index}`,
            column_index,
        }));

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
        });

        const syncedTable = await this.tableRepository.findByIdentifier(identifier);
        if (!syncedTable) {
            throw new Error(`Table ${identifier} could not be loaded after sync`);
        }

        logger.info(`[CentralBankPoliciesSync] Synced ${syncedTable.rows?.length || 0} rows from ${sheetName}`);

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

export const centralBankPoliciesSyncService = new CentralBankPoliciesSyncService();
