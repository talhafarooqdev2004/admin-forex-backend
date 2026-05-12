import { Server } from 'socket.io';
import { logger } from '../utils/logger.util.js';

export class WebSocketService {
    constructor() {
        this.io = null;
        this.clients = new Set();
    }

    initialize(httpServer, corsOptions = {}) {
        this.io = new Server(httpServer, {
            cors: {
                origin: corsOptions.origin || ['http://localhost:3000', 'http://localhost:3001'],
                methods: ['GET', 'POST'],
                credentials: true,
            },
            transports: ['websocket', 'polling'],
            pingTimeout: 60000,
            pingInterval: 25000,
            allowEIO3: true,
            connectTimeout: 45000,
        });

        this.io.on('connection', (socket) => {
            this.clients.add(socket.id);

            logger.info(`WebSocket client connected: ${socket.id} (Total clients: ${this.clients.size})`);

            socket.on('disconnect', (reason) => {
                this.clients.delete(socket.id);
                logger.info(`WebSocket client disconnected: ${socket.id}, reason: ${reason} (Total clients: ${this.clients.size})`);
            });

            socket.on('error', (error) => {
                logger.error(`WebSocket error for client ${socket.id}:`, error);
            });

            socket.on('ping', () => {
                socket.emit('pong', { timestamp: new Date().toISOString() });
            });
        });

        this.io.engine.on('connection_error', (err) => {
            logger.error('Socket.IO connection error:', err);
        });

        logger.info('WebSocket server initialized');

        return this.io;
    }

    emitScoreUpdate(score) {
        if (!this.io) {
            logger.warn('WebSocket server not initialized, cannot emit score update');
            return;
        }

        const payload = {
            type: 'RISK_MODE_SCORE_UPDATE',
            data: {
                score: score,
                timestamp: new Date().toISOString(),
            },
        };

        this.io.emit('riskModeScoreUpdate', payload);

        logger.info(`Emitted risk mode score update: ${score} to ${this.clients.size} client(s)`);
    }

    emitRetailSentimentUpdate(updatedPairs) {
        if (!this.io) {
            logger.warn('WebSocket server not initialized, cannot emit retail sentiment update');
            return;
        }

        const payload = {
            type: 'RETAIL_SENTIMENT_UPDATE',
            data: {
                pairs: updatedPairs,
                timestamp: new Date().toISOString(),
            },
        };

        this.io.emit('retailSentimentUpdate', payload);

        logger.info(`Emitted retail sentiment update for ${updatedPairs.length} pairs to ${this.clients.size} client(s)`);
    }

    emitRetailSentimentSnapshot(table) {
        if (!this.io) {
            logger.warn('WebSocket server not initialized, cannot emit retail sentiment snapshot');
            return;
        }

        const payload = {
            type: 'RETAIL_SENTIMENT_SNAPSHOT',
            data: {
                table,
                timestamp: new Date().toISOString(),
            },
        };

        this.io.emit('retailSentimentSnapshot', payload);

        logger.info(`Emitted retail sentiment snapshot to ${this.clients.size} client(s)`);
    }

    emitScoreDashboardSnapshot(table) {
        if (!this.io) {
            logger.warn('WebSocket server not initialized, cannot emit score dashboard snapshot');
            return;
        }

        const payload = {
            type: 'SCORE_DASHBOARD_SNAPSHOT',
            data: {
                table,
                timestamp: new Date().toISOString(),
            },
        };

        this.io.emit('scoreDashboardSnapshot', payload);

        logger.info(`Emitted score dashboard snapshot to ${this.clients.size} client(s)`);
    }

    emitTableUpdate(identifier) {
        if (!this.io) {
            logger.warn(`WebSocket server not initialized, cannot emit update for table ${identifier}`);
            return;
        }

        const payload = {
            type: 'TABLE_UPDATE',
            data: {
                identifier: identifier,
                timestamp: new Date().toISOString(),
            },
        };

        this.io.emit('tableUpdate', payload);

        logger.info(`Emitted table update for ${identifier} to ${this.clients.size} client(s)`);
    }

    broadcastTableUpdate(updateData) {
        if (!this.io) {
            logger.warn('WebSocket server not initialized, cannot broadcast table update');
            return;
        }

        const payload = {
            type: 'TABLE_EDITOR_UPDATE',
            data: {
                ...updateData,
                timestamp: new Date().toISOString(),
            },
        };

        this.io.emit('tableEditorUpdate', payload);

        logger.info(`Broadcast table editor update for ${updateData.tableId} to ${this.clients.size} client(s)`);
    }

    broadcastTableSync(syncData) {
        if (!this.io) {
            logger.warn('WebSocket server not initialized, cannot broadcast table sync');
            return;
        }

        const payload = {
            type: 'TABLE_EDITOR_SYNC',
            data: {
                ...syncData,
                timestamp: new Date().toISOString(),
            },
        };

        this.io.emit('tableEditorSync', payload);

        logger.info(`Broadcast table editor sync for ${syncData.tableId} to ${this.clients.size} client(s)`);
    }

    getIO() {
        return this.io;
    }

    getClientCount() {
        return this.clients.size;
    }
}

export const websocketService = new WebSocketService();
