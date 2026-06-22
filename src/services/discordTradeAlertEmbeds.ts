import { ENV } from '../config/env.js';
import { resolveDiscordLogoUrl } from './discordBrandLogo.js';
import { pipSize } from './livePrice.service.js';
import { slHitDisplayPips } from './tradePips.service.js';

export type DiscordEmbed = {
    author?: { name: string; icon_url?: string };
    title?: string;
    description?: string;
    color?: number;
    thumbnail?: { url: string };
    footer?: { text: string; icon_url?: string };
    timestamp?: string;
};

const COLOR_BUY = 0x05df72;
const COLOR_SELL = 0xfa003f;

const DEFAULT_PARTIAL_CLOSE = { tp1Pct: '50%', tp2Pct: '25%', tp3Pct: '25%' };

function num(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function fmt(v: unknown): string {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string' && v.trim() === '') return '—';
    const n = num(v);
    if (n !== null && (typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(String(v).trim()))) {
        return String(n);
    }
    return String(v).trim();
}

function code(v: unknown): string {
    return `\`${fmt(v)}\``;
}

function tradeId(trade: Record<string, unknown>): string {
    const id = trade.trade_id ?? trade.tradeId;
    if (id === null || id === undefined || String(id).trim() === '') return '—';
    return String(id).trim();
}

function isBuyTrade(trade: Record<string, unknown>): boolean {
    const label = String(trade.direction_type ?? trade.direction ?? 'buy');
    if (/sell/i.test(label)) return false;
    if (/buy/i.test(label)) return true;
    return trade.direction !== 'sell';
}

function directionShort(trade: Record<string, unknown>): string {
    return isBuyTrade(trade) ? 'BUY' : 'SELL';
}

function pairLabel(trade: Record<string, unknown>): string {
    return String(trade.pair ?? '—');
}

function pairDir(trade: Record<string, unknown>): string {
    return `${pairLabel(trade)} ${directionShort(trade)}`;
}

/** Non-breaking space — keeps pair + direction on one line in narrow Discord layouts. */
const NBSP = '\u00A0';

/** Braille blank — invisible line that pushes content below the right-side thumbnail on mobile. */
const BRAILLE_BLANK = '\u2800';
const MOBILE_THUMB_PAD_LINES = 2;

function joinEmDash(left: string, right: string): string {
    return `${left}${NBSP}—${NBSP}${right}`;
}

function pairDirectionHeader(trade: Record<string, unknown>): string {
    return `${directionEmoji(trade)} **${joinEmDash(pairLabel(trade), directionShort(trade))}**`;
}

function pairDirEventHeader(emoji: string, trade: Record<string, unknown>, suffix: string): string {
    return `${emoji} **${joinEmDash(pairDir(trade), suffix)}**`;
}

/** Push embed body below the thumbnail so the first row gets full width on mobile Discord. */
function embedDescription(body: string): string {
    const pad = Array.from({ length: MOBILE_THUMB_PAD_LINES }, () => BRAILLE_BLANK).join('\n');
    return `${pad}\n\n${body}`;
}

function embedColor(trade: Record<string, unknown>): number {
    return isBuyTrade(trade) ? COLOR_BUY : COLOR_SELL;
}

function directionEmoji(trade: Record<string, unknown>): string {
    return isBuyTrade(trade) ? '🟢' : '🔴';
}

function tradeStyle(trade: Record<string, unknown>): string {
    return String(trade.type ?? '—');
}

function formatRisk(risk: unknown): string {
    const s = String(risk ?? '').trim();
    if (!s) return '—';
    return s.endsWith('%') ? s : `${s}%`;
}

function rrr(trade: Record<string, unknown>): string {
    const entry = num(trade.entry_level);
    const sl = num(trade.stop_loss);
    const tp3 = num(trade.tp3);
    if (entry === null || sl === null || tp3 === null) return '—';
    const risk = Math.abs(entry - sl);
    if (risk === 0) return '—';
    return `1:${Math.round((Math.abs(tp3 - entry) / risk) * 10) / 10}`;
}

function formatTradeDateLong(trade: Record<string, unknown>): string {
    const d = new Date(String(trade.date ?? trade.created_at ?? Date.now()));
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTradeTimeShort(trade: Record<string, unknown>): string {
    const d = new Date(String(trade.date ?? trade.created_at ?? Date.now()));
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${min}`;
}

function formatNowTime(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function calcPips(trade: Record<string, unknown>, price: number | null): number | null {
    const entry = num(trade.entry_level);
    if (entry === null || price === null) return null;
    const pip = pipSize(String(trade.pair ?? ''));
    const isBuy = isBuyTrade(trade);
    return Number((((price - entry) / pip) * (isBuy ? 1 : -1)).toFixed(1));
}

function formatPipsCell(pips: number | null): string {
    if (pips === null) return '—';
    const sign = pips >= 0 ? '+' : '-';
    const abs = Math.abs(pips);
    const formatted = abs % 1 === 0 ? String(abs) : abs.toFixed(1);
    return `${sign}${formatted} pips`;
}

function isTrailingStopLossTrade(trade: Record<string, unknown>): boolean {
    return Boolean(trade.tsl_active || trade.tsl_enabled);
}

function resolveCurrentPrice(trade: Record<string, unknown>): number | null {
    return num(trade.current_price) ?? num(trade.currentPrice);
}

function isPendingType(directionType: unknown): boolean {
    return /limit|stop/i.test(String(directionType ?? ''));
}

function isLimitType(directionType: unknown): boolean {
    return /limit/i.test(String(directionType ?? ''));
}

function partialClosePct(settings: Record<string, unknown> | null, level: 1 | 2 | 3): string {
    const key = level === 1 ? 'tp1Pct' : level === 2 ? 'tp2Pct' : 'tp3Pct';
    const fallback = DEFAULT_PARTIAL_CLOSE[key];
    const fromSettings = settings?.[key];
    const raw = String(
        fromSettings !== undefined && fromSettings !== null && String(fromSettings).trim() !== ''
            ? fromSettings
            : fallback,
    ).trim();
    if (!raw || raw === '—') return fallback;
    return raw.endsWith('%') ? raw : `${raw}%`;
}

function remainingPct(settings: Record<string, unknown> | null, level: 1 | 2 | 3): string {
    const closed = partialClosePct(settings, level);
    const n = parseFloat(closed);
    if (!Number.isFinite(n)) return '—';
    return `${Math.max(0, 100 - n)}%`;
}

function partialCloseOrdinal(level: 1 | 2 | 3): string {
    if (level === 1) return '1st';
    if (level === 2) return '2nd';
    return '3rd';
}

export function partialClosePctFromSettings(settings: Record<string, unknown> | null, level: 1 | 2 | 3): string {
    return partialClosePct(settings, level);
}

export function isAutoPartialCloseConfigured(settings: Record<string, unknown> | null, level: 1 | 2 | 3): boolean {
    const pct = parseFloat(partialClosePct(settings, level));
    return Number.isFinite(pct) && pct > 0;
}

export function partialSecuredPips(
    trade: Record<string, unknown>,
    level: 1 | 2 | 3,
    settings: Record<string, unknown> | null,
): number | null {
    const full = eventPips(`tp${level}`, trade, null);
    if (full === null) return null;
    const pct = parseFloat(partialClosePct(settings, level));
    if (!Number.isFinite(pct) || pct <= 0) return null;
    return Number((full * (pct / 100)).toFixed(1));
}

export function resolveDiscordBranding(): { name: string; logoUrl: string } {
    const name = ENV.DISCORD_BRAND_NAME || 'Forex Fundamental Edge';
    return { name, logoUrl: resolveDiscordLogoUrl() };
}

function brandedEmbed(trade: Record<string, unknown>, title: string | undefined, description: string): DiscordEmbed {
    const { name, logoUrl } = resolveDiscordBranding();
    const embed: DiscordEmbed = {
        author: { name, icon_url: logoUrl },
        description: embedDescription(description),
        color: embedColor(trade),
        thumbnail: { url: logoUrl },
        footer: { text: name, icon_url: logoUrl },
        timestamp: new Date().toISOString(),
    };
    if (title) embed.title = title;
    return embed;
}

/** Join embed rows with a blank line between each for Discord readability. */
function spaced(rows: Array<string | null | undefined | false>): string {
    return rows.filter((row): row is string => Boolean(row)).join('\n\n');
}

function idTimeFooterLines(
    trade: Record<string, unknown>,
    timeLabel = 'Time',
    timeValue?: string,
): string[] {
    return [
        `🆔 ID: ${code(tradeId(trade))}`,
        `🕒 ${timeLabel}: ${code(timeValue ?? formatNowTime())}`,
    ];
}

function eventPips(event: string, trade: Record<string, unknown>, newSl?: number | null): number | null {
    switch (event) {
        case 'tp1':
            return calcPips(trade, num(trade.tp1));
        case 'tp2':
            return calcPips(trade, num(trade.tp2));
        case 'tp3':
            return num(trade.pips) ?? calcPips(trade, num(trade.tp3));
        case 'slHit':
            return slHitDisplayPips(trade);
        case 'be':
            return calcPips(trade, newSl ?? num(trade.stop_loss));
        case 'tsl':
            return calcPips(trade, newSl ?? num(trade.stop_loss));
        case 'closed':
            return num(trade.pips);
        default:
            return num(trade.pips);
    }
}

/** Initial market trade alert. */
export function buildDiscordInitialEmbed(trade: Record<string, unknown>): DiscordEmbed {
    const arrow = isBuyTrade(trade) ? '↗️' : '↘️';
    const lines = [
        pairDirectionHeader(trade),
        `${arrow} Entry: ${code(trade.entry_level)}`,
        `🛡️ SL: ${code(trade.stop_loss)}`,
        `🎯 TP1: ${code(trade.tp1)}`,
        `🎯 TP2: ${code(trade.tp2)}`,
        `🎯 TP3: ${code(trade.tp3)}`,
        `Risk: ${code(formatRisk(trade.risk))}   RRR: ${code(rrr(trade))}`,
        `⚡ Style: ${code(tradeStyle(trade))}`,
        `🌍 Session: ${code(trade.session ?? '—')}`,
        `🆔 ID: ${code(tradeId(trade))}`,
        `📅 Date: ${code(formatTradeDateLong(trade))}`,
        `🕒 Entry Time: ${code(formatTradeTimeShort(trade))}`,
    ];
    if (trade.comment) lines.push(`📝 Notes: ${code(trade.comment)}`);
    return brandedEmbed(trade, undefined, spaced(lines));
}

/** Buy/Sell Limit initial alert with current price. */
export function buildDiscordLimitInitialEmbed(trade: Record<string, unknown>): DiscordEmbed {
    const current = resolveCurrentPrice(trade);
    const arrow = isBuyTrade(trade) ? '↗️' : '↘️';
    const lines = [
        pairDirectionHeader(trade),
        `📊 Current Price: ${code(current)}`,
        `${arrow} Entry Level: ${code(trade.entry_level)}`,
        `🛡️ SL: ${code(trade.stop_loss)}`,
        `🎯 TP1: ${code(trade.tp1)}`,
        `🎯 TP2: ${code(trade.tp2)}`,
        `🎯 TP3: ${code(trade.tp3)}`,
        `Risk: ${code(formatRisk(trade.risk))}   RRR: ${code(rrr(trade))}`,
        `⚡ Style: ${code(tradeStyle(trade))}`,
        `🌍 Session: ${code(trade.session ?? '—')}`,
        `🆔 ID: ${code(tradeId(trade))}`,
        `📅 Date: ${code(formatTradeDateLong(trade))}`,
        `🕒 Entry Time: ${code(formatTradeTimeShort(trade))}`,
    ];
    if (trade.comment) lines.push(`📝 Notes: ${code(trade.comment)}`);
    return brandedEmbed(trade, undefined, spaced(lines));
}

/** Pending order waiting for entry. */
export function buildDiscordPendingEmbed(trade: Record<string, unknown>): DiscordEmbed {
    const lines = [
        `${directionEmoji(trade)} **${joinEmDash(pairLabel(trade), String(trade.direction_type ?? 'Pending'))}**`,
        `⏳ Waiting for price to hit entry ${code(trade.entry_level)}`,
        `🛡️ SL: ${code(trade.stop_loss)}`,
        `🎯 TP1: ${code(trade.tp1)} | TP2: ${code(trade.tp2)} | TP3: ${code(trade.tp3)}`,
        ...idTimeFooterLines(trade, 'Entry Time', formatTradeTimeShort(trade)),
    ];
    return brandedEmbed(trade, undefined, spaced(lines));
}

function tpHitLines(
    trade: Record<string, unknown>,
    level: 1 | 2 | 3,
    settings: Record<string, unknown> | null = null,
): string[] {
    const tpKey = level === 1 ? 'tp1' : level === 2 ? 'tp2' : 'tp3';
    const pips = eventPips(`tp${level}`, trade, null);
    const lines = [
        `🎯 TP${level}: ${code(trade[tpKey])}`,
    ];

    if (trade.breakeven_done) {
        lines.push(`🛡️ SL moved to breakeven: ${code(trade.stop_loss)}`);
    } else if (trade.tsl_active) {
        lines.push('🔄 Trailing SL: `Active`');
        lines.push(`🛡️ Current SL: ${code(trade.stop_loss)}`);
    }

    const securedLabel = level >= 2 ? 'Profit locked' : 'Secured';
    const pipEmoji = (pips ?? 0) >= 0 ? '🟢' : '🔴';
    lines.push(`${pipEmoji} ${securedLabel}: ${code(formatPipsCell(pips))}`);

    if (level < 3 && isAutoPartialCloseConfigured(settings, level)) {
        const pct = partialClosePct(settings, level);
        lines.push(`📤 Partial close: ${code(`${pct} of position`)}`);
    }

    lines.push(...idTimeFooterLines(trade));
    return lines;
}

export function buildDiscordEventEmbed(
    trade: Record<string, unknown>,
    event: string,
    opts: { newSl?: number | null; tradeSettings?: Record<string, unknown> | null } = {},
): DiscordEmbed {
    const settings = opts.tradeSettings ?? null;

    if (event === 'tp1') {
        const lines = [pairDirEventHeader('✅', trade, 'TP1 HIT'), ...tpHitLines(trade, 1, settings)];
        return brandedEmbed(trade, undefined, spaced(lines));
    }

    if (event === 'tp2') {
        const lines = [pairDirEventHeader('✅', trade, 'TP2 HIT'), ...tpHitLines(trade, 2, settings)];
        return brandedEmbed(trade, undefined, spaced(lines));
    }

    if (event === 'tp3') {
        const pips = eventPips('tp3', trade, null);
        const lines = [
            pairDirEventHeader('🏆', trade, 'TP3 HIT'),
            `🎯 TP3: ${code(trade.tp3)}`,
            `🟢 Final result: ${code(formatPipsCell(pips))}`,
            'Status: `Trade Closed`',
            ...idTimeFooterLines(trade, 'Closing Time'),
        ];
        return brandedEmbed(trade, undefined, spaced(lines));
    }

    if (event === 'slHit') {
        const trailing = isTrailingStopLossTrade(trade);
        const pips = eventPips('slHit', trade, null);
        const header = trailing
            ? pairDirEventHeader('❌', trade, 'TRAILING STOP LOSS HIT')
            : pairDirEventHeader('❌', trade, 'SL HIT');
        const lines = [
            header,
            `🛡️ SL: ${code(trade.stop_loss)}`,
            `🔴 Final result: ${code(formatPipsCell(pips))}`,
            'Status: `Trade Closed`',
            ...idTimeFooterLines(trade, 'Closing Time'),
        ];
        return brandedEmbed(trade, undefined, spaced(lines));
    }

    if (event === 'be') {
        const sl = num(opts.newSl ?? trade.stop_loss);
        const lines = [
            pairDirEventHeader('✅', trade, 'BREAKEVEN'),
            `🛡️ SL moved to breakeven: ${code(sl)}`,
            `🟢 Secured: ${code(formatPipsCell(eventPips('be', trade, sl)))}`,
            ...idTimeFooterLines(trade),
        ];
        return brandedEmbed(trade, undefined, spaced(lines));
    }

    if (event === 'tsl') {
        const sl = num(opts.newSl ?? trade.stop_loss);
        const lines = [
            pairDirEventHeader('🔄', trade, 'TRAILING SL UPDATED'),
            '🔄 Trailing SL: `Active`',
            `🛡️ New SL: ${code(sl)}`,
            `🟢 Secured: ${code(formatPipsCell(eventPips('tsl', trade, sl)))}`,
            ...idTimeFooterLines(trade),
        ];
        return brandedEmbed(trade, undefined, spaced(lines));
    }

    if (event === 'opened') {
        const lines = [
            pairDirEventHeader('✅', trade, 'ACTIVATED'),
            `${isBuyTrade(trade) ? '↗️' : '↘️'} Entry: ${code(trade.entry_level)}`,
            `🛡️ SL: ${code(trade.stop_loss)}`,
            ...idTimeFooterLines(trade),
        ];
        return brandedEmbed(trade, undefined, spaced(lines));
    }

    if (event === 'closed') {
        const pips = eventPips('closed', trade, null);
        const win = (pips ?? 0) >= 0;
        const lines = [
            pairDirEventHeader(win ? '🏆' : '❌', trade, 'TRADE CLOSED'),
            `${win ? '🟢' : '🔴'} Final result: ${code(formatPipsCell(pips))}`,
            'Status: `Trade Closed`',
            ...idTimeFooterLines(trade, 'Closing Time'),
        ];
        return brandedEmbed(trade, undefined, spaced(lines));
    }

    if (/^partialTp[123]$/.test(event)) {
        const level = Number(event.replace('partialTp', '')) as 1 | 2 | 3;
        const pips = eventPips(event, trade, null);
        const pct = partialClosePct(settings, level);
        const lines = [
            pairDirEventHeader('🟠', trade, 'PARTIAL CLOSE'),
            `📤 Close: ${code(`${pct} of position`)}`,
            `🟢 Secured: ${code(formatPipsCell(pips))}`,
            ...idTimeFooterLines(trade),
        ];
        return brandedEmbed(trade, undefined, spaced(lines));
    }

    // Fallback for unknown events
    const lines = [`**${joinEmDash(pairDir(trade), event.toUpperCase())}**`, ...idTimeFooterLines(trade)];
    return brandedEmbed(trade, undefined, spaced(lines));
}

export function buildDiscordLevelUpdatedEmbed(
    trade: Record<string, unknown>,
    field: 'stop_loss' | 'tp1' | 'tp2' | 'tp3',
    previous: number | null,
): DiscordEmbed {
    const labels: Record<string, string> = {
        stop_loss: 'Stop Loss',
        tp1: 'TP1',
        tp2: 'TP2',
        tp3: 'TP3',
    };
    const lines = [
        pairDirEventHeader('✏️', trade, `${labels[field].toUpperCase()} UPDATED`),
        `${labels[field]}: ${code(previous)} → ${code(trade[field])}`,
        `↗️ Entry: ${code(trade.entry_level)}`,
        `🛡️ SL: ${code(trade.stop_loss)}`,
        `🎯 TP1: ${code(trade.tp1)} | TP2: ${code(trade.tp2)} | TP3: ${code(trade.tp3)}`,
        ...idTimeFooterLines(trade),
    ];
    return brandedEmbed(trade, undefined, spaced(lines));
}

/** Auto partial close after a TP level is reached (separate from the TP hit alert). */
export function buildDiscordAutoPartialCloseEmbed(
    trade: Record<string, unknown>,
    level: 1 | 2 | 3,
    settings: Record<string, unknown> | null,
): DiscordEmbed | null {
    if (!isAutoPartialCloseConfigured(settings, level)) return null;
    const pct = partialClosePct(settings, level);
    const secured = partialSecuredPips(trade, level, settings);

    const remaining = remainingPct(settings, level);
    const ordinal = partialCloseOrdinal(level);
    const lines = [
        pairDirEventHeader('🟠', trade, 'PARTIAL CLOSE'),
        `📋 ${ordinal} partial close executed at TP${level}`,
        `📤 Close: ${code(`${pct} of position`)}`,
        `🟢 Secured: ${code(formatPipsCell(secured))}`,
    ];
    if (trade.breakeven_done) {
        lines.push(`🛡️ SL moved to breakeven: ${code(trade.stop_loss)}`);
    }
    lines.push(`📌 Remaining position: ${code(remaining)}`, ...idTimeFooterLines(trade));
    return brandedEmbed(trade, undefined, spaced(lines));
}

export function buildDiscordManualPartialEmbed(
    trade: Record<string, unknown>,
    level: 1 | 2 | 3,
    pips: number,
    settings: Record<string, unknown> | null,
): DiscordEmbed {
    const pct = partialClosePct(settings, level);
    const remaining = remainingPct(settings, level);
    const lines = [
        pairDirEventHeader('🟠', trade, 'PARTIAL CLOSE'),
        `📤 Close: ${code(`${pct} of position`)}`,
        `🟢 Secured: ${code(formatPipsCell(pips))}`,
    ];
    if (trade.breakeven_done) {
        lines.push(`🛡️ SL moved to breakeven: ${code(trade.stop_loss)}`);
    }
    lines.push(
        `📌 Remaining position: ${code(remaining)}`,
        'Trade remains active for further management.',
        ...idTimeFooterLines(trade),
    );
    return brandedEmbed(trade, undefined, spaced(lines));
}

export function buildDiscordManualFullCloseEmbed(
    trade: Record<string, unknown>,
    accumulated: number,
    remaining: number,
    total: number,
): DiscordEmbed {
    const win = total >= 0;
    const lines = [
        pairDirEventHeader(win ? '🏆' : '❌', trade, 'CLOSE'),
    ];
    if (accumulated > 0) {
        lines.push(
            `Partial profit: ${code(formatPipsCell(accumulated))}`,
            `Remaining: ${code(formatPipsCell(remaining))}`,
            `Total: ${code(formatPipsCell(total))}`,
        );
    } else {
        lines.push(`Total pips: ${code(formatPipsCell(total))}`);
    }
    lines.push('Status: `Trade Closed`', ...idTimeFooterLines(trade, 'Closing Time'));
    return brandedEmbed(trade, undefined, spaced(lines));
}

export function buildDiscordCreatedEmbed(trade: Record<string, unknown>): DiscordEmbed {
    if (isLimitType(trade.direction_type)) return buildDiscordLimitInitialEmbed(trade);
    if (isPendingType(trade.direction_type)) return buildDiscordPendingEmbed(trade);
    return buildDiscordInitialEmbed(trade);
}

export function buildDiscordTestEmbed(): DiscordEmbed {
    const trade = { pair: 'EURUSD', direction: 'buy' };
    const { name, logoUrl } = resolveDiscordBranding();
    return {
        author: { name, icon_url: logoUrl },
        title: 'Integration Test',
        description: '🔔 Test alert from **Forex Fundamental Edge** — Discord embeds are working.',
        color: COLOR_BUY,
        thumbnail: { url: logoUrl },
        footer: { text: name, icon_url: logoUrl },
        timestamp: new Date().toISOString(),
    };
}
