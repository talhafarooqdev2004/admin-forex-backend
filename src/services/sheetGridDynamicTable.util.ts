import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { DynamicTableRepository } from '../repositories/dynamicTable.repository.js';

export const normalizeSheetCell = (value: unknown): string => {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value).trim();
};

export type SheetGridColumnDef = { header: string; key: string; column_index: number };

export type SheetGridRowInput = {
    row_index: number;
    row_metadata: Record<string, unknown>;
    cells: Array<{ column_index: number; value: string; data_type: string }>;
};

/**
 * Sheet sync updates source/sync timestamps but must not wipe app-managed keys
 * (e.g. `currency_strength_notes` on `edge_technical_dashboard`).
 */
function mergeTableMetadataForSheetSync(
    existing: unknown,
    sheetMeta: Record<string, unknown>,
): Prisma.InputJsonValue {
    const prior =
        existing !== null &&
        existing !== undefined &&
        typeof existing === 'object' &&
        !Array.isArray(existing)
            ? { ...(existing as Record<string, unknown>) }
            : {};
    return { ...prior, ...sheetMeta } as Prisma.InputJsonValue;
}

export async function replaceDynamicTableFromSheetGrid(
    identifier: string,
    tableName: string,
    sheetName: string,
    range: string,
    columnDefs: SheetGridColumnDef[],
    tableRows: SheetGridRowInput[],
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
            select: { id: true, table_metadata: true },
        });

        const mergedMetadata = mergeTableMetadataForSheetSync(existingTable?.table_metadata, tableMetadata);

        const table = existingTable
            ? await tx.dynamicTable.update({
                where: { identifier },
                data: {
                    name: tableName,
                    description: `Auto-synced from Google Sheets tab ${sheetName}`,
                    table_metadata: mergedMetadata,
                    is_active: true,
                },
            })
            : await tx.dynamicTable.create({
                data: {
                    name: tableName,
                    identifier,
                    description: `Auto-synced from Google Sheets tab ${sheetName}`,
                    table_metadata: mergedMetadata,
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
    return { identifier, table: syncedTable, rowsSynced: syncedTable.rows?.length || 0 };
}

/** Concatenate sheet blocks left-to-right (same row index); used for non-contiguous column ranges. */
export function mergeSheetBlocksHorizontally(blocks: unknown[][][]): unknown[][] {
    if (blocks.length === 0) return [];
    const maxRows = Math.max(...blocks.map((b) => b.length));
    const merged: unknown[][] = [];

    for (let r = 0; r < maxRows; r++) {
        const row: unknown[] = [];
        for (const block of blocks) {
            const blockRow = block[r];
            if (blockRow === undefined || blockRow === null) {
                continue;
            }
            if (Array.isArray(blockRow)) {
                for (const cell of blockRow) {
                    row.push(cell);
                }
            } else {
                row.push(blockRow);
            }
        }
        merged.push(row);
    }

    return merged;
}

export function buildColumnDefsFromHeaderRow(headerRow: unknown[]): SheetGridColumnDef[] {
    const row = Array.isArray(headerRow) ? headerRow : [];
    let width = row.length;
    while (width > 0 && normalizeSheetCell(row[width - 1]) === '') {
        width -= 1;
    }
    if (width === 0) {
        width = 1;
    }
    return Array.from({ length: width }, (_, column_index) => ({
        header: normalizeSheetCell(row[column_index]) || "",
        key: `col_${column_index}`,
        column_index,
    }));
}

export function buildSyntheticColumnDefs(columnCount: number): SheetGridColumnDef[] {
    const n = Math.max(1, Math.floor(columnCount));
    return Array.from({ length: n }, (_, column_index) => ({
        header: "",
        key: `col_${column_index}`,
        column_index,
    }));
}

/** First sheet row is header; remaining rows are data. */
export function buildTableRowsFromSheetValues(
    sheetValues: unknown[][],
    sheetName: string,
    range: string,
    columnDefs: SheetGridColumnDef[],
): SheetGridRowInput[] {
    const dataRows = sheetValues.slice(1).filter((row) => {
        if (!Array.isArray(row)) return false;
        return row.some((c) => normalizeSheetCell(c) !== '');
    });

    return dataRows.map((row, row_index) => {
        const cells = columnDefs.map((col) => ({
            column_index: col.column_index,
            value: normalizeSheetCell(Array.isArray(row) ? row[col.column_index] : ''),
            data_type: 'text',
        }));
        return {
            row_index,
            row_metadata: {
                source: 'google_sheets',
                source_sheet_name: sheetName,
                source_range: range,
            },
            cells,
        };
    });
}

/** Every returned row is a data row (no header in range). */
export function buildTableRowsAllDataNoHeader(
    sheetValues: unknown[][],
    sheetName: string,
    range: string,
    columnDefs: SheetGridColumnDef[],
): SheetGridRowInput[] {
    const width = columnDefs.length;
    const dataRows = sheetValues.filter((row) => {
        if (!Array.isArray(row)) return false;
        return row.some((c, i) => i < width && normalizeSheetCell(c) !== '');
    });

    return dataRows.map((row, row_index) => ({
        row_index,
        row_metadata: {
            source: 'google_sheets',
            source_sheet_name: sheetName,
            source_range: range,
            header_row: false,
        },
        cells: columnDefs.map((col) => ({
            column_index: col.column_index,
            value: normalizeSheetCell(Array.isArray(row) ? row[col.column_index] : ''),
            data_type: 'text',
        })),
    }));
}
