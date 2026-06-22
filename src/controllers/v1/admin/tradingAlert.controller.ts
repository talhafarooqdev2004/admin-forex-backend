import { TradingAlertRepository } from '../../../repositories/tradingAlert.repository.js';
import { AppConfigRepository } from '../../../repositories/appConfig.repository.js';
import { successResponse } from '../../../utils/response.util.js';
import { HTTP_STATUS, SUCCESS_MESSAGES } from '../../../config/constants.js';
import { ApiError } from '../../../exceptions/ApiError.js';
import { notifyTradeCreated, notifyTradeEvent, notifyTradeLevelUpdated, detectTradeLevelChanges } from '../../../services/tradeAlertNotification.service.js';
import { applyBreakeven } from '../../../services/tradeBreakeven.service.js';
import { applyTsl } from '../../../services/tradeTsl.service.js';
import { getCurrentPrice } from '../../../services/livePrice.service.js';
import {
    executeManualFullClose,
    executeManualPartialClose,
    listTradePartialCloses,
} from '../../../services/tradeManualClose.service.js';
import { serializePrisma } from '../../../utils/prisma.util.js';
const tradingAlertRepository = new TradingAlertRepository();
const appConfigRepository = new AppConfigRepository();

async function readActiveTradesSettings() {
    try {
        const cfg = (await appConfigRepository.findByKey('active_trades_settings')) as { value?: string | null } | null;
        return cfg?.value ? JSON.parse(cfg.value) : null;
    } catch {
        return null;
    }
}

async function readTradeAlertSettings() {
    try {
        const cfg = (await appConfigRepository.findByKey('trade_alert_settings')) as { value?: string | null } | null;
        return cfg?.value ? JSON.parse(cfg.value) : null;
    } catch {
        return null;
    }
}
const DECIMAL_FIELDS = ['entry_level', 'stop_loss', 'tp1', 'tp2', 'tp3', 'exit_price', 'pips', 'result', 'accumulated_pips'];

/** Fields persisted on TradingAlert — strips notification-only keys like current_price. */
const ALERT_CREATE_FIELDS = [
    'trade_id', 'pair', 'direction', 'entry_level', 'stop_loss', 'tp1', 'tp2', 'tp3',
    'image_path', 'trade_follow_up', 'type', 'direction_type', 'session', 'risk',
    'exit_price', 'outcome', 'pips', 'close_reason', 'tsl_enabled', 'breakeven_enabled',
    'activated', 'activation_side', 'max_tp_hit', 'breakeven_done', 'tsl_active',
    'accumulated_pips', 'manual_partial_closed',
    'last_tsl_sl', 'last_alert_event', 'result', 'status', 'comment', 'date',
] as const;

function pickAlertCreateData(body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...extra };
    for (const key of ALERT_CREATE_FIELDS) {
        if (body[key] !== undefined) data[key] = body[key];
    }
    return data;
}
const parseDecimalFields = (alert) => {
    if (!alert)
        return alert;
    const parsed = alert.toJSON ? alert.toJSON() : alert;
    for (const field of DECIMAL_FIELDS) {
        if (parsed[field] !== null && parsed[field] !== undefined) {
            parsed[field] = parseFloat(parsed[field]);
        }
    }
    return parsed;
};
export const getAllAlerts = async (req, res, next) => {
    try {
        const alerts = await tradingAlertRepository.findAll();
        const parsedAlerts = Array.isArray(alerts)
            ? alerts.map(parseDecimalFields)
            : parseDecimalFields(alerts);
        res.status(HTTP_STATUS.OK).json(successResponse('Trading alerts retrieved successfully', parsedAlerts));
    }
    catch (error) {
        next(error);
    }
};
export const getAlertById = async (req, res, next) => {
    try {
        const alert = await tradingAlertRepository.findById(req.params.id);
        if (!alert) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Trading alert not found');
        }
        res.status(HTTP_STATUS.OK).json(successResponse('Trading alert retrieved successfully', alert));
    }
    catch (error) {
        next(error);
    }
};
const isPendingType = (directionType) => /limit|stop/i.test(String(directionType ?? ''));

/**
 * Pending orders wait until the live price reaches the entry from the side it started on:
 *  - entry below current at creation  -> wait for a fall  (activate when price <= entry) -> side 'down'
 *  - entry above current at creation  -> wait for a rise  (activate when price >= entry) -> side 'up'
 *  - entry == current (or price unknown) -> open immediately
 */
const resolvePendingActivation = async (body) => {
    if (!isPendingType(body?.direction_type)) return { activated: true, activation_side: null };
    const entry = Number(body?.entry_level);
    const current = await getCurrentPrice(body?.pair).catch(() => null);
    if (Number.isFinite(entry) && current !== null) {
        if (entry < current) return { activated: false, activation_side: 'down' };
        if (entry > current) return { activated: false, activation_side: 'up' };
        return { activated: true, activation_side: null }; // already at entry
    }
    // Fallback when the live price isn't known: infer the side from the order type.
    const t = String(body?.direction_type).toLowerCase();
    const side = t.includes('limit')
        ? (t.startsWith('buy') ? 'down' : 'up')
        : (t.startsWith('buy') ? 'up' : 'down');
    return { activated: false, activation_side: side };
};

export const createAlert = async (req, res, next) => {
    try {
        // Pending orders (Buy/Sell Limit/Stop) start inactive until price reaches entry from the creation side.
        const { activated, activation_side } = await resolvePendingActivation(req.body);
        const createData = pickAlertCreateData(req.body, { activated, activation_side });
        const alert = await tradingAlertRepository.create(createData);
        const parsedAlert = parseDecimalFields(alert);
        // Attach live/current price for limit-order alert copy (not stored on the row).
        const currentFromBody = req.body?.current_price;
        const currentPrice = currentFromBody !== null && currentFromBody !== undefined && currentFromBody !== ''
            ? Number(currentFromBody)
            : await getCurrentPrice(createData?.pair as string).catch(() => null);
        const notifyPayload = {
            ...parsedAlert,
            current_price: Number.isFinite(currentPrice) ? currentPrice : null,
        };
        // Fire the "new trade" alert to the configured channels (non-blocking).
        notifyTradeCreated(notifyPayload).catch(() => undefined);
        res.status(HTTP_STATUS.CREATED).json(successResponse(SUCCESS_MESSAGES.CREATED, parsedAlert));
    }
    catch (error) {
        next(error);
    }
};
export const updateAlert = async (req, res, next) => {
    try {
        const existing = await tradingAlertRepository.findById(req.params.id);
        if (!existing) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Trading alert not found');
        }

        const enablingBe = req.body?.breakeven_enabled === true && !existing.breakeven_enabled;
        const enablingTsl = req.body?.tsl_enabled === true && !existing.tsl_enabled;
        const parsedExisting = parseDecimalFields(existing);
        const updateData = pickAlertCreateData(req.body);
        const levelChanges = detectTradeLevelChanges(parsedExisting, updateData);
        const alert = await tradingAlertRepository.update(req.params.id, updateData);
        if (!alert) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Trading alert not found');
        }

        const parsedAlert = parseDecimalFields(alert);
        for (const field of levelChanges) {
            const previous = parsedExisting[field] as number | null | undefined;
            const prevNum =
                previous !== null && previous !== undefined && Number.isFinite(Number(previous))
                    ? Number(previous)
                    : null;
            notifyTradeLevelUpdated(parsedAlert, field, prevNum).catch(() => undefined);
        }

        if (enablingBe && alert.status === 'open' && !alert.breakeven_done) {
            const activeSettings = await readActiveTradesSettings();
            await applyBreakeven(parsedAlert, activeSettings).catch(() => undefined);
        }

        if (enablingTsl && alert.status === 'open') {
            const tradeSettings = await readTradeAlertSettings();
            await applyTsl(parsedAlert, tradeSettings).catch(() => undefined);
        }

        res.status(HTTP_STATUS.NO_CONTENT).send();
    }
    catch (error) {
        next(error);
    }
};
export const deleteAlert = async (req, res, next) => {
    try {
        const deleted = await tradingAlertRepository.delete(req.params.id);
        if (!deleted) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Trading alert not found');
        }
        res.status(HTTP_STATUS.NO_CONTENT).send();
    }
    catch (error) {
        next(error);
    }
};

function mapManualCloseError(error: unknown): ApiError {
    if (error instanceof ApiError) return error;
    const code = error instanceof Error ? error.message : '';
    if (code === 'TRADE_NOT_FOUND') return new ApiError(HTTP_STATUS.NOT_FOUND, 'Trading alert not found');
    if (code === 'TRADE_NOT_OPEN') return new ApiError(HTTP_STATUS.CONFLICT, 'Trade is not open');
    if (code === 'PARTIAL_ALREADY_DONE') return new ApiError(HTTP_STATUS.CONFLICT, 'A partial close was already recorded for this TP level');
    if (code === 'PRICE_UNAVAILABLE') return new ApiError(HTTP_STATUS.SERVICE_UNAVAILABLE, 'Live price is unavailable for this pair');
    return error instanceof ApiError ? error : new ApiError(HTTP_STATUS.INTERNAL_SERVER_ERROR, 'Close action failed');
}

export const listPartialCloses = async (req, res, next) => {
    try {
        const rows = await listTradePartialCloses();
        res.status(HTTP_STATUS.OK).json(successResponse('Partial closes retrieved successfully', serializePrisma(rows)));
    } catch (error) {
        next(error);
    }
};

export const partialCloseAlert = async (req, res, next) => {
    try {
        const level = Number(req.body?.level);
        if (![1, 2, 3].includes(level)) {
            throw new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, 'level must be 1, 2, or 3');
        }
        const result = await executeManualPartialClose(req.params.id, level as 1 | 2 | 3);
        res.status(HTTP_STATUS.OK).json(
            successResponse('Partial close recorded', serializePrisma({ trade: result.trade, partial: result.partial })),
        );
    } catch (error) {
        next(mapManualCloseError(error));
    }
};

export const fullCloseAlert = async (req, res, next) => {
    try {
        const trade = await executeManualFullClose(req.params.id);
        res.status(HTTP_STATUS.OK).json(successResponse('Trade fully closed', serializePrisma(trade)));
    } catch (error) {
        next(mapManualCloseError(error));
    }
};

const VALID_EVENTS = ['tp1', 'tp2', 'tp3', 'slHit', 'be', 'tsl', 'closed'];
export const notifyAlertEvent = async (req, res, next) => {
    try {
        const event = (req.body?.event ?? '').toString();
        if (!VALID_EVENTS.includes(event)) {
            throw new ApiError(HTTP_STATUS.UNPROCESSABLE_ENTITY, 'Invalid alert event');
        }
        const alert = await tradingAlertRepository.findById(req.params.id);
        if (!alert) {
            throw new ApiError(HTTP_STATUS.NOT_FOUND, 'Trading alert not found');
        }
        // Atomic claim so the same event is delivered only once across clients.
        const claimed = await tradingAlertRepository.claimAlertEvent(req.params.id, event);
        let sent = false;
        if (claimed) {
            sent = await notifyTradeEvent(parseDecimalFields(alert), event);
        }
        res.status(HTTP_STATUS.OK).json(successResponse('Alert event processed', { claimed, sent }));
    }
    catch (error) {
        next(error);
    }
};
