import { Server } from 'socket.io';
import { logger } from '../utils/logger.util.js';

/**
 * WebSocket service for real-time communication
 */
export class WebSocketService {
    constructor() {
        this.io = null;
        this.clients = new Set();
    }

    /**
     * Initialize WebSocket server with HTTP server
     * @param {http.Server} httpServer - HTTP server instance
     * @param {Object} corsOptions - CORS options for Socket.IO
     */
    initialize(httpServer, corsOptions = {}) {
        this.io = new Server(httpServer, {
            cors: {
                origin: corsOptions.origin || ['http://localhost:3000', 'http://localhost:3001'],
                methods: ['GET', 'POST'],
                credentials: true,
            },
            transports: ['websocket', 'polling'],
            pingTimeout: 60000, // 60 seconds - time to wait for pong before considering connection dead
            pingInterval: 25000, // 25 seconds - interval to send ping to clients
            allowEIO3: true, // Allow Engine.IO v3 clients
            connectTimeout: 45000, // 45 seconds - time to wait for connection
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

            // Handle client events if needed
            socket.on('ping', () => {
                socket.emit('pong', { timestamp: new Date().toISOString() });
            });
        });

        // Handle server-level errors
        this.io.engine.on('connection_error', (err) => {
            logger.error('Socket.IO connection error:', err);
        });

        logger.info('WebSocket server initialized');
        return this.io;
    }

    /**
     * Emit risk mode score update to all connected clients
     * @param {number} score - The updated score value
     */
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

    /**
     * Emit retail sentiment update to all connected clients
     * @param {Array<{pair: string, long: number, short: number}>} updatedPairs - Array of updated pairs
     */
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

    /**
     * Emit table update event for a specific table identifier
     * @param {string} identifier - The table identifier
     */
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

    /**
     * Broadcast table editor cell updates to all connected clients
     * @param {Object} updateData - Update data containing tableId and cell updates
     */
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

    /**
     * Broadcast full table sync to all connected clients
     * @param {Object} syncData - Sync data containing tableId and full table data
     */
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

    /**
     * Get the Socket.IO instance
     * @returns {Server|null}
     */
    getIO() {
        return this.io;
    }

    /**
     * Get number of connected clients
     * @returns {number}
     */
    getClientCount() {
        return this.clients.size;
    }
}

// Export singleton instance
export const websocketService = new WebSocketService();
