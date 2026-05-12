import { prisma } from '../lib/prisma.js';
import { serializePrisma } from '../utils/prisma.util.js';
const mapColumn = (column) => ({
    ...column,
    column_name: column.header,
});
const mapCell = (cell) => ({
    ...cell,
    column: cell.column ? mapColumn(cell.column) : cell.column,
});
const mapRow = (row) => ({
    ...row,
    cells: row.cells ? row.cells.map(mapCell) : row.cells,
});
const mapTable = (table) => {
    const serialized = serializePrisma(table);
    if (!serialized) {
        return serialized;
    }
    return {
        ...serialized,
        columns: serialized.columns ? serialized.columns.map(mapColumn) : serialized.columns,
        rows: serialized.rows ? serialized.rows.map(mapRow) : serialized.rows,
    };
};
const baseTableInclude = {
    rows: {
        include: {
            currencyPair: true,
            cells: {
                orderBy: {
                    table_column_id: 'asc',
                },
            },
        },
        orderBy: {
            row_index: 'asc',
        },
    },
    columns: {
        orderBy: {
            column_index: 'asc',
        },
    },
};
const detailedTableInclude = {
    rows: {
        include: {
            currencyPair: true,
            cells: {
                include: {
                    column: true,
                },
                orderBy: {
                    table_column_id: 'asc',
                },
            },
        },
        orderBy: {
            row_index: 'asc',
        },
    },
    columns: {
        orderBy: {
            column_index: 'asc',
        },
    },
};
const userScopedInclude = (userId) => {
    const include = {
        columns: {
            orderBy: {
                column_index: 'asc',
            },
        },
    };
    if (userId !== null) {
        include.rows = {
            where: {
                user_id: BigInt(userId),
            },
            include: {
                currencyPair: true,
                cells: {
                    where: {
                        user_id: BigInt(userId),
                    },
                    include: {
                        column: true,
                    },
                    orderBy: {
                        table_column_id: 'asc',
                    },
                },
            },
            orderBy: {
                row_index: 'asc',
            },
        };
    }
    return include;
};
function isRowEmpty(row) {
    if (!row.cells || !Array.isArray(row.cells) || row.cells.length === 0) {
        return true;
    }
    const hasAnyData = row.cells.some((cell) => {
        if (!cell)
            return false;
        const hasValue = cell.value != null &&
            String(cell.value).trim() !== '' &&
            String(cell.value).trim() !== 'null';
        const hasFormula = cell.formula != null &&
            String(cell.formula).trim() !== '' &&
            String(cell.formula).trim() !== 'null';
        return hasValue || hasFormula;
    });
    return !hasAnyData;
}
function filterEmptyRows(table) {
    if (!table || !table.rows) {
        return table;
    }
    return {
        ...table,
        rows: table.rows.filter((row) => !isRowEmpty(row)),
    };
}
export class DynamicTableRepository {
    async findAll() {
        const tables = await prisma.dynamicTable.findMany({
            include: baseTableInclude,
            orderBy: {
                created_at: 'desc',
            },
        });
        return tables.map((table) => filterEmptyRows(mapTable(table)));
    }
    async findById(id) {
        const table = await prisma.dynamicTable.findUnique({
            where: {
                id: BigInt(id),
            },
            include: detailedTableInclude,
        });
        return filterEmptyRows(mapTable(table));
    }
    async findByIdAndUserId(id, userId) {
        const table = await prisma.dynamicTable.findUnique({
            where: {
                id: BigInt(id),
            },
            include: userScopedInclude(userId),
        });
        const filteredTable = filterEmptyRows(mapTable(table));
        return filteredTable;
    }
    async findByIdentifier(identifier) {
        const table = await prisma.dynamicTable.findUnique({
            where: { identifier },
            include: detailedTableInclude,
        });
        return filterEmptyRows(mapTable(table));
    }
    async findByIdentifierAndUserId(identifier, userId) {
        const table = await prisma.dynamicTable.findUnique({
            where: { identifier },
            include: userScopedInclude(userId),
        });
        const filteredTable = filterEmptyRows(mapTable(table));
        return filteredTable;
    }
    async create(tableData) {
        const table = await prisma.dynamicTable.create({
            data: tableData,
        });
        return serializePrisma(table);
    }
    async update(id, tableData) {
        const existingTable = await prisma.dynamicTable.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingTable)
            return null;
        await prisma.dynamicTable.update({
            where: {
                id: BigInt(id),
            },
            data: tableData,
        });
        return this.findById(id);
    }
    async delete(id) {
        const existingTable = await prisma.dynamicTable.findUnique({
            where: {
                id: BigInt(id),
            },
            select: {
                id: true,
            },
        });
        if (!existingTable)
            return false;
        await prisma.dynamicTable.delete({
            where: {
                id: BigInt(id),
            },
        });
        return true;
    }
}
