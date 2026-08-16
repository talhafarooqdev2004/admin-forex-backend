/**
 * One source of truth for the Daily Market operational day.
 *
 * A market day is labelled with the Dubai civil date on which it starts and runs from
 * 01:00 Asia/Dubai until 00:59:59.999 the following civil day. Dubai currently has no DST,
 * but the conversion deliberately uses Intl rather than assuming a fixed UTC offset.
 */
export const MARKET_BUSINESS_TIMEZONE = 'Asia/Dubai';
export const MARKET_BUSINESS_DAY_START_HOUR = 1;

function localParts(date: Date, timeZone = MARKET_BUSINESS_TIMEZONE) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) =>
        Number(parts.find((part) => part.type === type)?.value ?? NaN);
    return {
        year: value('year'),
        month: value('month'),
        day: value('day'),
        hour: value('hour'),
        minute: value('minute'),
        second: value('second'),
    };
}

export function addMarketCivilDays(dayKey: string, amount: number): string {
    const [year, month, day] = dayKey.split('-').map(Number);
    const civil = new Date(Date.UTC(year!, month! - 1, day!));
    civil.setUTCDate(civil.getUTCDate() + amount);
    return civil.toISOString().slice(0, 10);
}

export function marketBusinessDayKey(date: Date = new Date()): string {
    const parts = localParts(date);
    if (![parts.year, parts.month, parts.day, parts.hour].every(Number.isFinite)) {
        throw new Error(`Unable to resolve ${MARKET_BUSINESS_TIMEZONE} business day`);
    }
    const civilKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
    return parts.hour < MARKET_BUSINESS_DAY_START_HOUR
        ? addMarketCivilDays(civilKey, -1)
        : civilKey;
}

export function previousMarketBusinessDayKey(date: Date = new Date()): string {
    return addMarketCivilDays(marketBusinessDayKey(date), -1);
}

/** Convert a local wall-clock instant in the business timezone to UTC. */
function zonedDateTimeToUtc(
    dayKey: string,
    hour: number,
    timeZone = MARKET_BUSINESS_TIMEZONE,
): Date {
    const [year, month, day] = dayKey.split('-').map(Number);
    const guess = Date.UTC(year!, month! - 1, day!, hour);
    const observed = localParts(new Date(guess), timeZone);
    const observedAsUtc = Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        observed.second,
    );
    return new Date(guess - (observedAsUtc - guess));
}

export function marketBusinessDayStartUtc(dayKey: string): Date {
    return zonedDateTimeToUtc(dayKey, MARKET_BUSINESS_DAY_START_HOUR);
}

export function marketBusinessDayRange(fromDayKey: string, toDayKey: string) {
    return {
        from: marketBusinessDayStartUtc(fromDayKey),
        to: marketBusinessDayStartUtc(addMarketCivilDays(toDayKey, 1)),
    };
}
