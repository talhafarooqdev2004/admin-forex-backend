import { DynamicTable, TableRow, TableColumn, TableCell, CurrencyPair } from '../models/index.js';
import { Op } from 'sequelize';

// Helper function to check if a row is empty (has no non-empty cells)
function isRowEmpty(row) {
    // If row has no cells at all, it's empty
    if (!row.cells || !Array.isArray(row.cells) || row.cells.length === 0) {
        return true;
    }
    
    // Check if all cells are empty (no value and no formula)
    const hasAnyData = row.cells.some(cell => {
        if (!cell) return false;
        
        // Check if cell has a non-empty value
        const hasValue = cell.value != null && 
                        String(cell.value).trim() !== '' && 
                        String(cell.value).trim() !== 'null';
        
        // Check if cell has a non-empty formula
        const hasFormula = cell.formula != null && 
                          String(cell.formula).trim() !== '' && 
                          String(cell.formula).trim() !== 'null';
        
        return hasValue || hasFormula;
    });
    
    // Row is empty if no cells have data
    return !hasAnyData;
}

// Helper function to filter out empty rows from table data
function filterEmptyRows(table) {
    if (!table || !table.rows) {
        return table;
    }
    
    // Filter out empty rows
    table.rows = table.rows.filter(row => !isRowEmpty(row));
    
    return table;
}

export class DynamicTableRepository {
    async findAll() {
        return await DynamicTable.findAll({
            include: [
                {
                    model: TableRow,
                    as: 'rows',
                    include: [
                        {
                            model: CurrencyPair,
                            as: 'currencyPair',
                        },
                        {
                            model: TableCell,
                            as: 'cells',
                        }
                    ]
                },
                {
                    model: TableColumn,
                    as: 'columns',
                }
            ],
            order: [['created_at', 'DESC']],
        });
    }

    async findById(id) {
        const table = await DynamicTable.findByPk(id, {
            include: [
                {
                    model: TableRow,
                    as: 'rows',
                    include: [
                        {
                            model: CurrencyPair,
                            as: 'currencyPair',
                        },
                        {
                            model: TableCell,
                            as: 'cells',
                            include: [
                                {
                                    model: TableColumn,
                                    as: 'column',
                                }
                            ]
                        }
                    ]
                },
                {
                    model: TableColumn,
                    as: 'columns',
                }
            ],
        });
        
        // Filter out empty rows before returning (admin-created rows with user_id: null are included if they have data)
        return filterEmptyRows(table);
    }

    async findByIdAndUserId(id, userId) {
        // If userId is null, only return columns (no user-specific rows)
        // If userId is provided, return columns + user's rows
        const includes = [
            {
                model: TableColumn,
                as: 'columns',
            }
        ];
        
        // Only include rows if userId is provided
        if (userId !== null) {
            includes.push({
                model: TableRow,
                as: 'rows',
                where: { user_id: userId },
                required: false, // LEFT JOIN - include table even if no rows
                include: [
                    {
                        model: CurrencyPair,
                        as: 'currencyPair',
                        required: false,
                    },
                    {
                        model: TableCell,
                        as: 'cells',
                        where: { user_id: userId },
                        required: false, // LEFT JOIN - include row even if no cells
                        include: [
                            {
                                model: TableColumn,
                                as: 'column',
                                required: false,
                            }
                        ]
                    }
                ]
            });
        }
        
        const table = await DynamicTable.findByPk(id, {
            include: includes,
        });
        
        // Filter out empty rows before returning
        const filteredTable = filterEmptyRows(table);
        
        // Debug logging
        if (filteredTable) {
            console.log('findByIdAndUserId - Result:', {
                tableId: filteredTable.id,
                userId: userId,
                columnsCount: filteredTable.columns?.length || 0,
                rowsCount: filteredTable.rows?.length || 0,
                firstRow: filteredTable.rows?.[0] ? {
                    id: filteredTable.rows[0].id,
                    row_index: filteredTable.rows[0].row_index,
                    user_id: filteredTable.rows[0].user_id,
                    cellsCount: filteredTable.rows[0].cells?.length || 0
                } : null
            });
        }
        
        return filteredTable;
    }

    async findByIdentifier(identifier) {
        const table = await DynamicTable.findOne({
            where: { identifier },
            include: [
                {
                    model: TableRow,
                    as: 'rows',
                    include: [
                        {
                            model: CurrencyPair,
                            as: 'currencyPair',
                        },
                        {
                            model: TableCell,
                            as: 'cells',
                            include: [
                                {
                                    model: TableColumn,
                                    as: 'column',
                                }
                            ]
                        }
                    ]
                },
                {
                    model: TableColumn,
                    as: 'columns',
                }
            ],
        });
        
        // Filter out empty rows before returning (admin-created rows with user_id: null are included if they have data)
        return filterEmptyRows(table);
    }

    async findByIdentifierAndUserId(identifier, userId) {
        // If userId is null, only return columns (no user-specific rows)
        // If userId is provided, return columns + user's rows
        const includes = [
            {
                model: TableColumn,
                as: 'columns',
            }
        ];
        
        // Only include rows if userId is provided
        if (userId !== null) {
            includes.push({
                model: TableRow,
                as: 'rows',
                where: { user_id: userId },
                required: false, // LEFT JOIN - include table even if no rows
                include: [
                    {
                        model: CurrencyPair,
                        as: 'currencyPair',
                        required: false,
                    },
                    {
                        model: TableCell,
                        as: 'cells',
                        where: { user_id: userId },
                        required: false, // LEFT JOIN - include row even if no cells
                        include: [
                            {
                                model: TableColumn,
                                as: 'column',
                                required: false,
                            }
                        ]
                    }
                ]
            });
        }
        
        const table = await DynamicTable.findOne({
            where: { identifier },
            include: includes,
        });
        
        // Filter out empty rows before returning
        const filteredTable = filterEmptyRows(table);
        
        // Debug logging
        if (filteredTable) {
            console.log('findByIdentifierAndUserId - Result:', {
                identifier: identifier,
                userId: userId,
                columnsCount: filteredTable.columns?.length || 0,
                rowsCount: filteredTable.rows?.length || 0,
                firstRow: filteredTable.rows?.[0] ? {
                    id: filteredTable.rows[0].id,
                    row_index: filteredTable.rows[0].row_index,
                    user_id: filteredTable.rows[0].user_id,
                    cellsCount: filteredTable.rows[0].cells?.length || 0
                } : null
            });
        }
        
        return filteredTable;
    }

    async create(tableData) {
        return await DynamicTable.create(tableData);
    }

    async update(id, tableData) {
        const table = await DynamicTable.findByPk(id);
        if (!table) return null;
        
        await table.update(tableData);
        return await this.findById(id);
    }

    async delete(id) {
        const table = await DynamicTable.findByPk(id);
        if (!table) return false;
        
        await table.destroy();
        return true;
    }
}
