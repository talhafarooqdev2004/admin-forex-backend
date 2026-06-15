import { ENV } from '../config/env.js';
import { AppConfigRepository } from '../repositories/appConfig.repository.js';
import { pipSize } from '../services/livePrice.service.js';
import { logger } from '../utils/logger.util.js';

const appConfigRepository = new AppConfigRepository();

const TELEGRAM_CHAT_ID_KEY = 'telegram_chat_id';
const TRADE_ALERT_SETTINGS_KEY = 'trade_alert_settings';
const ACTIVE_TRADES_SETTINGS_KEY = 'active_trades_settings';

type Channels = { telegram: boolean; discord: boolean };

async function readJsonConfig(key: string): Promise<Record<string, unknown> | null> {
    try {
        const config = (await appConfigRepository.findByKey(key)) as { value?: string | null } | null;
        const value = config?.value;
        if (!value) return null;
        return JSON.parse(value);
    } catch {
        return null;
    }
}

async function resolveChatId(): Promise<string> {
    if (ENV.TELEGRAM_CHAT_ID) return ENV.TELEGRAM_CHAT_ID;
    const config = (await appConfigRepository.findByKey(TELEGRAM_CHAT_ID_KEY)) as { value?: string | null } | null;
    return config?.value ?? '';
}

export async function sendTelegram(text: string): Promise<boolean> {
    const token = ENV.TELEGRAM_BOT_TOKEN;
    const chatId = await resolveChatId();
    if (!token || !chatId) {
        logger.warn('Telegram alert skipped: missing bot token or chat id');
        return false;
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        });
        if (!res.ok) {
            logger.error(`Telegram send failed: ${res.status} ${await res.text()}`);
            return false;
        }
        return true;
    } catch (error) {
        logger.error(`Telegram send error: ${error}`);
        return false;
    }
}

export async function sendDiscord(text: string): Promise<boolean> {
    const webhook = ENV.DISCORD_WEBHOOK_URL;
    if (!webhook) {
        logger.warn('Discord alert skipped: missing webhook url');
        return false;
    }
    try {
        const res = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: text.slice(0, 1900) }),
        });
        if (!res.ok && res.status !== 204) {
            logger.error(`Discord send failed: ${res.status} ${await res.text()}`);
            return false;
        }
        return true;
    } catch (error) {
        logger.error(`Discord send error: ${error}`);
        return false;
    }
}

async function deliver(text: string, channels: Channels): Promise<void> {
    const tasks: Promise<boolean>[] = [];
    if (channels.telegram) tasks.push(sendTelegram(text));
    if (channels.discord) tasks.push(sendDiscord(text));
    await Promise.allSettled(tasks);
}

function channelsFromSettings(settings: Record<string, unknown> | null): Channels {
    const ac = (settings?.alertChannels ?? {}) as Record<string, boolean>;
    return { telegram: ac.telegram !== false, discord: ac.discord !== false };
}

function num(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function fmt(v: unknown): string {
    const n = num(v);
    return n !== null ? String(n) : '—';
}

function isPendingType(directionType: unknown): boolean {
    return /limit|stop/i.test(String(directionType ?? ''));
}

function isLimitType(directionType: unknown): boolean {
    return /limit/i.test(String(directionType ?? ''));
}

function resolveCurrentPrice(trade: any): number | null {
    return num(trade.current_price) ?? num(trade.currentPrice);
}

function directionLabel(trade: any): string {
    return trade.direction_type || (trade.direction === 'sell' ? 'Sell' : 'Buy');
}

function directionShort(trade: any): string {
    return isBuyTrade(trade) ? 'BUY' : 'SELL';
}

function isBuyTrade(trade: any): boolean {
    const label = directionLabel(trade);
    if (/sell/i.test(label)) return false;
    if (/buy/i.test(label)) return true;
    return (trade.direction ?? 'buy') !== 'sell';
}

/** Green up-arrow for all buy types; red down-arrow for all sell types. */
function directionArrow(trade: any): string {
    return isBuyTrade(trade) ? '🟢 ↑' : '🔴 ↓';
}

function directionWithArrow(trade: any): string {
    return `${directionArrow(trade)} ${directionShort(trade)}`;
}

function tradeStyle(trade: any): string {
    return trade.type ?? '—';
}

function rrr(trade: any): string {
    const entry = num(trade.entry_level);
    const sl = num(trade.stop_loss);
    const tp3 = num(trade.tp3);
    if (entry === null || sl === null || tp3 === null) return '—';
    const risk = Math.abs(entry - sl);
    if (risk === 0) return '—';
    return `1:${Math.round((Math.abs(tp3 - entry) / risk) * 10) / 10}`;
}

function formatRisk(risk: unknown): string {
    const s = String(risk ?? '').trim();
    if (!s) return '—';
    return s.endsWith('%') ? s : `${s}%`;
}

function formatTradeTime(trade: any): string {
    const d = new Date(trade.date ?? trade.created_at ?? Date.now());
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
}

function calcPips(trade: any, price: number | null): number | null {
    const entry = num(trade.entry_level);
    if (entry === null || price === null) return null;
    const pip = pipSize(trade.pair ?? '');
    const isBuy = (trade.direction ?? 'buy') !== 'sell';
    return Number((((price - entry) / pip) * (isBuy ? 1 : -1)).toFixed(1));
}

function formatPipsCell(pips: number | null): string {
    if (pips === null) return '—';
    return `${pips >= 0 ? '+' : ''}${pips.toFixed(1)}`;
}

/** Initial trade alert — full detail card. */
function buildInitialMessage(trade: any): string {
    const lines = [
        directionWithArrow(trade),
        '',
        `Trade ID: ${trade.trade_id ?? '—'}`,
        `Type: ${directionLabel(trade)}`,
        `Symbol: ${trade.pair ?? '—'}`,
        `Style: ${tradeStyle(trade)}`,
        `Entry: ${fmt(trade.entry_level)}`,
        `SL: ${fmt(trade.stop_loss)}`,
        `TP1: ${fmt(trade.tp1)}`,
        `TP2: ${fmt(trade.tp2)}`,
        `TP3: ${fmt(trade.tp3)}`,
        `Risk: ${formatRisk(trade.risk)}`,
        `RRR: ${rrr(trade)}`,
        `Session: ${trade.session ?? '—'}`,
        `Time: ${formatTradeTime(trade)}`,
    ];
    if (trade.comment) lines.push(`Notes: ${trade.comment}`);
    return lines.join('\n');
}

/** Buy Limit / Sell Limit — full initial card with current market price + pending entry level. */
function buildLimitInitialMessage(trade: any): string {
    const current = resolveCurrentPrice(trade);
    const lines = [
        directionWithArrow(trade),
        '',
        `Trade ID: ${trade.trade_id ?? '—'}`,
        `Type: ${directionLabel(trade)}`,
        `Symbol: ${trade.pair ?? '—'}`,
        `Style: ${tradeStyle(trade)}`,
        `Current Price: ${current !== null ? fmt(current) : '—'}`,
        `Entry Level: ${fmt(trade.entry_level)}`,
        `SL: ${fmt(trade.stop_loss)}`,
        `TP1: ${fmt(trade.tp1)}`,
        `TP2: ${fmt(trade.tp2)}`,
        `TP3: ${fmt(trade.tp3)}`,
        `Risk: ${formatRisk(trade.risk)}`,
        `RRR: ${rrr(trade)}`,
        `Session: ${trade.session ?? '—'}`,
        `Time: ${formatTradeTime(trade)}`,
    ];
    if (trade.comment) lines.push(`Notes: ${trade.comment}`);
    return lines.join('\n');
}

/** Pending order — same identity row + waiting note (not a full initial card). */
function buildPendingMessage(trade: any): string {
    const row = buildFollowUpRow(trade, 'pending', null);
    return [
        directionWithArrow(trade),
        '',
        row,
        '',
        `Waiting for price to hit entry ${fmt(trade.entry_level)}`,
        `SL: ${fmt(trade.stop_loss)}`,
        `TP1: ${fmt(trade.tp1)} | TP2: ${fmt(trade.tp2)} | TP3: ${fmt(trade.tp3)}`,
    ].join('\n');
}

function eventStatus(event: string, trade: any, newSl?: number | null): string {
    switch (event) {
        case 'opened':
            return 'ACTIVATED';
        case 'pending':
            return 'ORDER SET';
        case 'tp1':
            return 'TP1 HIT';
        case 'tp2':
            return 'TP2 HIT';
        case 'tp3':
            return 'CLOSED WIN';
        case 'slHit':
            return 'STOP LOSS HIT';
        case 'be':
            return 'TSL TO ENTRY / BE';
        case 'tsl':
            return `TSL MOVED / TSL TO ${fmt(newSl ?? trade.stop_loss)}`;
        case 'closed':
            return trade.outcome === 'Loss' ? 'CLOSED LOSS' : 'CLOSED WIN';
        default:
            return event.toUpperCase();
    }
}

function eventPips(event: string, trade: any, newSl?: number | null): number | null {
    switch (event) {
        case 'opened':
        case 'pending':
            return 0;
        case 'tp1':
            return calcPips(trade, num(trade.tp1));
        case 'tp2':
            return calcPips(trade, num(trade.tp2));
        case 'tp3':
            return num(trade.pips) ?? calcPips(trade, num(trade.tp3));
        case 'slHit':
            return num(trade.pips) ?? calcPips(trade, num(trade.stop_loss));
        case 'be':
            return calcPips(trade, num(trade.entry_level));
        case 'tsl':
            return calcPips(trade, newSl ?? num(trade.stop_loss));
        case 'closed':
            return num(trade.pips);
        default:
            return null;
    }
}

/** Follow-up update — compact row only (right side of client mockup). */
function buildFollowUpRow(trade: any, event: string, newSl?: number | null): string {
    const id = trade.trade_id ?? '—';
    const pair = trade.pair ?? '—';
    const style = tradeStyle(trade);
    const dir = directionWithArrow(trade);
    const status = eventStatus(event, trade, newSl);
    const pips = formatPipsCell(eventPips(event, trade, newSl));
    return `${id} | ${pair} | ${style} | ${dir} | ${status} | ${pips}`;
}

function buildFollowUpMessage(trade: any, event: string, newSl?: number | null): string {
    return [directionWithArrow(trade), '', buildFollowUpRow(trade, event, newSl)].join('\n');
}

/** Sends the creation alert if any channel is enabled. */
export async function notifyTradeCreated(trade: any): Promise<void> {
    const settings = await readJsonConfig(TRADE_ALERT_SETTINGS_KEY);
    const channels = channelsFromSettings(settings);
    if (!channels.telegram && !channels.discord) return;

    const text = isLimitType(trade.direction_type)
        ? buildLimitInitialMessage(trade)
        : isPendingType(trade.direction_type)
            ? buildPendingMessage(trade)
            : buildInitialMessage(trade);

    await deliver(text, channels);
}

/**
 * Sends a status-event follow-up if the event is enabled in Active-Trades settings.
 * Returns true if a message was dispatched.
 */
export async function notifyTradeEvent(
    trade: any,
    event: string,
    opts: { newSl?: number | null; force?: boolean } = {},
): Promise<boolean> {
    const tradeSettings = await readJsonConfig(TRADE_ALERT_SETTINGS_KEY);
    const activeSettings = await readJsonConfig(ACTIVE_TRADES_SETTINGS_KEY);
    const clientAlerts = (activeSettings?.clientAlerts ?? {}) as Record<string, boolean>;
    if (!opts.force && clientAlerts[event] === false) return false;

    const channels = channelsFromSettings(tradeSettings);
    if (!channels.telegram && !channels.discord) return false;

    await deliver(buildFollowUpMessage(trade, event, opts.newSl), channels);
    return true;
}

type TelegramChat = { id: number; type: string; title?: string; username?: string };

export async function getTelegramChats(): Promise<TelegramChat[]> {
    const token = ENV.TELEGRAM_BOT_TOKEN;
    if (!token) return [];
    let res: Response;
    try {
        res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
    } catch {
        throw new Error('TELEGRAM_UNREACHABLE');
    }
    if (!res.ok) return [];
    const data = await res.json();
    const chats = new Map<number, TelegramChat>();
    for (const update of data.result ?? []) {
        const chat = update.message?.chat ?? update.channel_post?.chat ?? update.my_chat_member?.chat;
        if (chat?.id) chats.set(chat.id, { id: chat.id, type: chat.type, title: chat.title, username: chat.username });
    }
    return [...chats.values()];
}

export async function saveTelegramChatId(chatId: string): Promise<void> {
    const repo = appConfigRepository as unknown as {
        updateOrCreate: (k: string, v: string, d: string) => Promise<unknown>;
    };
    await repo.updateOrCreate(TELEGRAM_CHAT_ID_KEY, chatId, 'Telegram chat id for trade alerts');
}
