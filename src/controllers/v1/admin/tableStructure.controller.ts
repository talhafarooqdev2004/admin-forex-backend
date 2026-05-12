import { Prisma } from '@prisma/client';
import { DynamicTableRepository } from '../../../repositories/dynamicTable.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { prisma } from '../../../lib/prisma.js';
import { googleSheetsService } from '../../../services/googleSheets.service.js';
const tableRepository = new DynamicTableRepository();
const toBigIntId = (value) => {
    if (value === null || value === undefined || value === '') {
        return null;
    }
    return BigInt(value);
};
const normalizeColumnPayload = (columnData, tableId) => {
    const { id, ...columnFields } = columnData;
    return {
        ...columnFields,
        dynamic_table_id: BigInt(tableId),
        column_index: Number(columnData.column_index),
    };
};
const normalizeRowPayload = (rowData, tableId, userId) => {
    const { id, ...rowFields } = rowData;
    const payload: any = {
        ...rowFields,
        dynamic_table_id: BigInt(tableId),
        currency_pair_id: toBigIntId(rowFields.currency_pair_id),
        row_index: Number(rowData.row_index),
    };

    if (userId !== null && userId !== undefined) {
        payload.user_id = BigInt(userId);
    }

    return payload;
};
const buildSheetData = (columns, rows, cells) => {
    const orderedColumns = [...(columns || [])].sort((a, b) => Number(a.column_index) - Number(b.column_index));
    const orderedRows = [...(rows || [])].sort((a, b) => Number(a.row_index) - Number(b.row_index));
    const cellMap = new Map();
    for (const cell of cells || []) {
        cellMap.set(`${Number(cell.row_index)}:${Number(cell.column_index)}`, cell);
    }
    const headerRow = orderedColumns.map((column) => {
        const header = column.header ?? column.column_name ?? column.key ?? '';
        return header == null ? '' : String(header);
    });
    const dataRows = orderedRows.map((row) => orderedColumns.map((column) => {
        const cell = cellMap.get(`${Number(row.row_index)}:${Number(column.column_index)}`);
        const rawValue = cell?.formula ?? cell?.value ?? '';
        return rawValue == null ? '' : String(rawValue);
    }));
    return [headerRow, ...dataRows];
};
export const saveTableStructure = async (req, res, next) => {
    try {
        const userId = req.user?.id || req.user?.user_id || null;
        const userRole = req.user?.role || 'user';
        const isAdmin = userRole === 'admin';
        let dynamic_table_id = req.body.dynamic_table_id || req.body.dynamicTableId || req.body.table_id;
        const { rows, columns, cells } = req.body;
        if (!dynamic_table_id && rows && Array.isArray(rows) && rows.length > 0) {
            const firstRowWithTableId = rows.find((row) => row.dynamic_table_id);
            if (firstRowWithTableId) {
                dynamic_table_id = firstRowWithTableId.dynamic_table_id;
            }
        }
        if (!dynamic_table_id && columns && Array.isArray(columns) && columns.length > 0) {
            const firstColumnWithTableId = columns.find((column) => column.dynamic_table_id);
            if (firstColumnWithTableId) {
                dynamic_table_id = firstColumnWithTableId.dynamic_table_id;
            }
        }
        if (!dynamic_table_id) {
            if (rows && Array.isArray(rows) && rows.length > 0) {
                const rowWithId = rows.find((row) => row.id && row.id < 10000);
                if (rowWithId) {
                    const existingRow = await prisma.tableRow.findUnique({
                        where: {
                            id: BigInt(rowWithId.id),
                        },
                        select: {
                            dynamic_table_id: true,
                        },
                    });
                    if (existingRow) {
                        dynamic_table_id = Number(existingRow.dynamic_table_id);
                    }
                }
            }
            if (!dynamic_table_id && columns && Array.isArray(columns) && columns.length > 0) {
                const columnWithId = columns.find((column) => column.id && column.id < 20000);
                if (columnWithId) {
                    const existingColumn = await prisma.tableColumn.findUnique({
                        where: {
                            id: BigInt(columnWithId.id),
                        },
                        select: {
                            dynamic_table_id: true,
                        },
                    });
                    if (existingColumn) {
                        dynamic_table_id = Number(existingColumn.dynamic_table_id);
                    }
                }
            }
        }
        if (!dynamic_table_id) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, 'dynamic_table_id is required.');
        }
        const tableId = Number(dynamic_table_id);
        const table = await tableRepository.findById(tableId);
        if (!table) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Table not found');
        }
        const isUserScopedTable = table.identifier === 'trading_journal_table';
        await prisma.$transaction(async (tx) => {
            if (columns && Array.isArray(columns) && columns.length > 0) {
                const existingColumns = await tx.tableColumn.findMany({
                    where: {
                        dynamic_table_id: BigInt(tableId),
                    },
                });
                if (existingColumns.length === 0 || isAdmin || !isUserScopedTable) {
                    if (existingColumns.length > 0) {
                        await tx.tableColumn.deleteMany({
                            where: {
                                dynamic_table_id: BigInt(tableId),
                            },
                        });
                    }
                    if (columns.length > 0) {
                        await tx.tableColumn.createMany({
                            data: columns.map((columnData) => normalizeColumnPayload(columnData, tableId)),
                        });
                    }
                }
            }
            const allColumns = await tx.tableColumn.findMany({
                where: {
                    dynamic_table_id: BigInt(tableId),
                },
                orderBy: {
                    column_index: 'asc',
                },
            });
            if (isUserScopedTable && userId !== null && rows && Array.isArray(rows) && rows.length > 0) {
                await tx.$executeRaw `
                    DELETE FROM table_rows
                    WHERE dynamic_table_id = ${BigInt(tableId)}
                    AND (
                        id NOT IN (
                            SELECT DISTINCT table_row_id
                            FROM table_cells
                            WHERE table_row_id IS NOT NULL
                        )
                        OR id IN (
                            SELECT tr.id
                            FROM table_rows tr
                            WHERE tr.dynamic_table_id = ${BigInt(tableId)}
                            AND NOT EXISTS (
                                SELECT 1
                                FROM table_cells tc
                                WHERE tc.table_row_id = tr.id
                                AND (
                                    (tc.value IS NOT NULL AND LENGTH(TRIM(COALESCE(tc.value::text, ''))) > 0)
                                    OR (tc.formula IS NOT NULL AND LENGTH(TRIM(COALESCE(tc.formula::text, ''))) > 0)
                                )
                            )
                        )
                    )
                `;
                await tx.$executeRaw `
                    DELETE FROM table_cells
                    WHERE user_id = ${BigInt(userId)}
                    AND table_row_id IN (
                        SELECT id
                        FROM table_rows
                        WHERE dynamic_table_id = ${BigInt(tableId)}
                        AND user_id = ${BigInt(userId)}
                    )
                `;
                await tx.tableRow.deleteMany({
                    where: {
                        dynamic_table_id: BigInt(tableId),
                        user_id: BigInt(userId),
                    },
                });
                const rowIndexesWithData = new Set();
                if (cells && Array.isArray(cells)) {
                    for (const cell of cells) {
                        const hasValue = cell.value && cell.value.toString().trim() !== '';
                        const hasFormula = cell.formula && cell.formula.toString().trim() !== '';
                        if (hasValue || hasFormula) {
                            rowIndexesWithData.add(cell.row_index);
                        }
                    }
                }
                const rowsToCreate = rows.filter((rowData) => rowIndexesWithData.has(rowData.row_index));
                for (const rowData of rowsToCreate) {
                    await tx.tableRow.create({
                        data: normalizeRowPayload(rowData, tableId, userId),
                    });
                }
                const userRows = await tx.tableRow.findMany({
                    where: {
                        dynamic_table_id: BigInt(tableId),
                        user_id: BigInt(userId),
                    },
                    orderBy: {
                        row_index: 'asc',
                    },
                });
                for (const row of userRows) {
                    for (const column of allColumns) {
                        const cellFromRequest = cells?.find((cell) => (cell.row_index === row.row_index && cell.column_index === column.column_index));
                        await tx.tableCell.create({
                            data: {
                                table_row_id: row.id,
                                table_column_id: column.id,
                                user_id: BigInt(userId),
                                value: cellFromRequest?.value || null,
                                formula: cellFromRequest?.formula || null,
                                data_type: cellFromRequest?.data_type || 'text',
                                cell_metadata: cellFromRequest?.cell_metadata || null,
                            },
                        });
                    }
                }
            }
            else if (!isUserScopedTable) {
                await tx.tableRow.deleteMany({
                    where: {
                        dynamic_table_id: BigInt(tableId),
                    },
                });

                const rowIndexesWithData = new Set();
                if (cells && Array.isArray(cells)) {
                    for (const cell of cells) {
                        const hasValue = cell.value && cell.value.toString().trim() !== '';
                        const hasFormula = cell.formula && cell.formula.toString().trim() !== '';
                        if (hasValue || hasFormula) {
                            rowIndexesWithData.add(cell.row_index);
                        }
                    }
                }

                const rowsToCreate = rows && Array.isArray(rows)
                    ? rows.filter((rowData) => rowIndexesWithData.has(rowData.row_index))
                    : [];

                for (const rowData of rowsToCreate) {
                    await tx.tableRow.create({
                        data: normalizeRowPayload(rowData, tableId, null),
                    });
                }

                const publicRows = await tx.tableRow.findMany({
                    where: {
                        dynamic_table_id: BigInt(tableId),
                    },
                    orderBy: {
                        row_index: 'asc',
                    },
                });

                for (const row of publicRows) {
                    for (const column of allColumns) {
                        const cellFromRequest = cells?.find((cell) => (cell.row_index === row.row_index && cell.column_index === column.column_index));
                        await tx.tableCell.create({
                            data: {
                                table_row_id: row.id,
                                table_column_id: column.id,
                                value: cellFromRequest?.value || null,
                                formula: cellFromRequest?.formula || null,
                                data_type: cellFromRequest?.data_type || 'text',
                                cell_metadata: cellFromRequest?.cell_metadata || null,
                            },
                        });
                    }
                }
            }
            else {
                // No-op for user-scoped tables when there is nothing to write.
            }
        });
        if (columns && Array.isArray(columns) && rows && Array.isArray(rows)) {
            const sheetData = buildSheetData(columns, rows, cells);
            await googleSheetsService.clearAndSync(table.identifier, sheetData);
        }
        const updatedTable = (isUserScopedTable && userId !== null)
            ? await tableRepository.findByIdAndUserId(tableId, userId)
            : await tableRepository.findById(tableId);
        res.status(HTTP_STATUS.OK).json(successResponse('Table structure saved successfully', updatedTable));
    }
    catch (error) {
        console.error('saveTableStructure - Controller error:', error);
        next(error);
    }
};
