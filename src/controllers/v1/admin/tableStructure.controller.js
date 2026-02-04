import { DynamicTableRepository } from '../../../repositories/dynamicTable.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { DynamicTable, TableRow, TableColumn, TableCell, sequelize } from '../../../models/index.js';

const tableRepository = new DynamicTableRepository();

export const saveTableStructure = async (req, res, next) => {
    try {
        const userId = req.user?.id || req.user?.user_id || null;
        const userRole = req.user?.role || 'user';
        const isAdmin = userRole === 'admin';

        console.log('saveTableStructure - Request info:', {
            userId,
            userRole,
            isAdmin,
            hasUser: !!req.user,
            userObject: req.user,
            requestUrl: req.url,
            requestPath: req.path,
            requestMethod: req.method,
            hasAuthHeader: !!req.headers.authorization,
            authHeader: req.headers.authorization ? req.headers.authorization.substring(0, 20) + '...' : 'none'
        });

        let dynamic_table_id = req.body.dynamic_table_id || req.body.dynamicTableId || req.body.table_id;
        const { rows, columns, cells } = req.body;

        console.log('saveTableStructure - Payload info:', {
            dynamic_table_id,
            rowsCount: rows?.length || 0,
            columnsCount: columns?.length || 0,
            cellsCount: cells?.length || 0
        });

        if (!dynamic_table_id && rows && Array.isArray(rows) && rows.length > 0) {
            const firstRowWithTableId = rows.find(r => r.dynamic_table_id);
            if (firstRowWithTableId) {
                dynamic_table_id = firstRowWithTableId.dynamic_table_id;
            }
        }

        if (!dynamic_table_id && columns && Array.isArray(columns) && columns.length > 0) {
            const firstColumnWithTableId = columns.find(c => c.dynamic_table_id);
            if (firstColumnWithTableId) {
                dynamic_table_id = firstColumnWithTableId.dynamic_table_id;
            }
        }

        if (!dynamic_table_id) {
            if (rows && Array.isArray(rows) && rows.length > 0) {
                const rowWithId = rows.find(r => r.id && r.id < 10000);
                if (rowWithId) {
                    const existingRow = await TableRow.findByPk(rowWithId.id);
                    if (existingRow) {
                        dynamic_table_id = existingRow.dynamic_table_id;
                    }
                }
            }
            if (!dynamic_table_id && columns && Array.isArray(columns) && columns.length > 0) {
                const columnWithId = columns.find(c => c.id && c.id < 20000);
                if (columnWithId) {
                    const existingColumn = await TableColumn.findByPk(columnWithId.id);
                    if (existingColumn) {
                        dynamic_table_id = existingColumn.dynamic_table_id;
                    }
                }
            }
        }

        if (!dynamic_table_id) {
            throw new ApiError(HTTP_STATUS.BAD_REQUEST, `dynamic_table_id is required.`);
        }

        const tableId = parseInt(dynamic_table_id, 10);
        const table = await tableRepository.findById(tableId);
        if (!table) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Table not found');
        }

        const transaction = await sequelize.transaction();

        try {
            // 1. Handle Columns - Can be modified by admin or when creating initial structure
            if (columns && Array.isArray(columns) && columns.length > 0) {
                // Check if columns already exist
                const existingColumns = await TableColumn.findAll({
                    where: { dynamic_table_id: tableId },
                    transaction
                });

                // Only allow column modification if:
                // - No columns exist yet (initial creation), OR
                // - User is admin (can modify structure)
                if (existingColumns.length === 0 || isAdmin) {
                    // Delete existing columns if any
                    if (existingColumns.length > 0) {
                        await TableColumn.destroy({
                            where: { dynamic_table_id: tableId },
                            transaction
                        });
                    }

                    // Create new columns
                    for (const columnData of columns) {
                        const { id, column_index, ...columnFields } = columnData;
                        await TableColumn.create({
                            ...columnFields,
                            dynamic_table_id: tableId,
                            column_index: column_index
                        }, { transaction });
                    }
                }
            }

            // Get all current columns (either just created or existing)
            const allColumns = await TableColumn.findAll({
                where: { dynamic_table_id: tableId },
                order: [['column_index', 'ASC']],
                transaction
            });

            // 2. Handle Rows and Cells - Per User (including admin as a user)
            console.log('saveTableStructure - Checking row save conditions:', {
                userIdNotNull: userId !== null,
                rowsExist: !!rows,
                rowsIsArray: Array.isArray(rows),
                rowsLength: rows?.length || 0,
                willSaveRows: userId !== null && rows && Array.isArray(rows) && rows.length > 0
            });

            if (userId !== null && rows && Array.isArray(rows) && rows.length > 0) {
                console.log('saveTableStructure - Starting to save rows for user:', userId);
                
                // Cleanup: Delete all empty rows (rows with no non-empty cells) for this table
                // This deletes empty rows regardless of user_id (including admin-created empty rows)
                // Admin-created rows (user_id: null) with data are preserved
                // Empty rows are those that have no cells OR all cells are empty (no value and no formula)
                await sequelize.query(
                    `DELETE FROM table_rows 
                     WHERE dynamic_table_id = :tableId 
                     AND (
                         -- Rows with no cells at all
                         id NOT IN (SELECT DISTINCT table_row_id FROM table_cells WHERE table_row_id IS NOT NULL)
                         OR
                         -- Rows where all cells are empty (no value and no formula)
                         id IN (
                             SELECT tr.id 
                             FROM table_rows tr
                             WHERE tr.dynamic_table_id = :tableId
                             AND NOT EXISTS (
                                 SELECT 1 
                                 FROM table_cells tc 
                                 WHERE tc.table_row_id = tr.id 
                                 AND (
                                     (tc.value IS NOT NULL AND LENGTH(TRIM(COALESCE(tc.value::text, ''))) > 0)
                                     OR 
                                     (tc.formula IS NOT NULL AND LENGTH(TRIM(COALESCE(tc.formula::text, ''))) > 0)
                                 )
                             )
                         )
                     )`,
                    {
                        replacements: { tableId },
                        type: sequelize.QueryTypes.DELETE,
                        transaction
                    }
                );
                console.log('saveTableStructure - Cleaned up empty rows');

                // Delete all existing cells for this user in this table
                await sequelize.query(
                    `DELETE FROM table_cells 
                     WHERE user_id = :userId 
                     AND table_row_id IN (
                         SELECT id FROM table_rows 
                         WHERE dynamic_table_id = :tableId AND user_id = :userId
                     )`,
                    {
                        replacements: { userId, tableId },
                        type: sequelize.QueryTypes.DELETE,
                        transaction
                    }
                );

                // Delete existing rows for this user
                await TableRow.destroy({
                    where: {
                        dynamic_table_id: tableId,
                        user_id: userId
                    },
                    transaction
                });

                // First, identify which row_index values have at least one non-empty cell
                // This prevents creating empty rows
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

                console.log('saveTableStructure - Row indexes with data:', Array.from(rowIndexesWithData));

                // Only create rows that have at least one non-empty cell
                const rowsToCreate = rows.filter(rowData => {
                    return rowIndexesWithData.has(rowData.row_index);
                });

                console.log('saveTableStructure - Filtered rows (with data):', rowsToCreate.length, 'out of', rows.length);

                // Create new rows for this user (only rows with data)
                for (const rowData of rowsToCreate) {
                    const { id, row_index, ...rowFields } = rowData;
                    const newRow = await TableRow.create({
                        ...rowFields,
                        dynamic_table_id: tableId,
                        row_index: row_index,
                        user_id: userId
                    }, { transaction });
                    console.log('saveTableStructure - Created row:', newRow.id, 'for user:', userId, 'row_index:', row_index);
                }

                // Get the newly created rows to map their new database IDs
                const userRows = await TableRow.findAll({
                    where: {
                        dynamic_table_id: tableId,
                        user_id: userId
                    },
                    order: [['row_index', 'ASC']],
                    transaction
                });

                console.log('saveTableStructure - Found user rows after creation:', userRows.length);

                // Create cells only for rows that were created (rows with data)
                for (const row of userRows) {
                    for (const column of allColumns) {
                        // Find cell data in the request by matching row index and column index
                        const cellFromRequest = cells?.find(c => {
                            return c.row_index === row.row_index && c.column_index === column.column_index;
                        });

                        await TableCell.create({
                            table_row_id: row.id,
                            table_column_id: column.id,
                            user_id: userId,
                            value: cellFromRequest?.value || null,
                            formula: cellFromRequest?.formula || null,
                            data_type: cellFromRequest?.data_type || 'text',
                            cell_metadata: cellFromRequest?.cell_metadata || null
                        }, { transaction });
                    }
                }
                console.log('saveTableStructure - Finished creating cells');
            } else {
                console.log('saveTableStructure - Skipping row/cell creation. Reason:', {
                    userId,
                    hasRows: !!rows,
                    rowsLength: rows?.length || 0
                });
            }

            await transaction.commit();
            console.log('saveTableStructure - Transaction committed');

            // Fetch the updated table with columns and the user's specific rows/cells
            const updatedTable = await tableRepository.findByIdAndUserId(tableId, userId);

            res.status(HTTP_STATUS.OK).json(
                successResponse('Table structure saved successfully', updatedTable)
            );
        } catch (error) {
            await transaction.rollback();
            console.error('saveTableStructure - Transaction error:', error);
            throw error;
        }
    } catch (error) {
        console.error('saveTableStructure - Controller error:', error);
        next(error);
    }
};
