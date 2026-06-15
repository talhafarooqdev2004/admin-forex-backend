/**
 * Manual integration test: dispatches a sample of EVERY trade-alert event to the
 * configured Discord/Telegram channels so you can confirm delivery + formatting.
 *
 *   npm run test:alerts
 *
 * Uses force=true so it ignores the per-event "Alert Generation" toggles, but still
 * respects the channel toggles (Telegram/Discord) and your .env credentials.
 */
import 'dotenv/config';
import { notifyTradeCreated, notifyTradeEvent } from './src/services/tradeAlertNotification.service.js';

const sampleTrade = {
    trade_id: 'TEST-1',
    pair: 'EURUSD',
    direction: 'buy',
    direction_type: 'Buy',
    type: 'Swing',
    session: 'London',
    entry_level: 1.0892,
    stop_loss: 1.0872,
    tp1: 1.0912,
    tp2: 1.0932,
    tp3: 1.0952,
    risk: '1.0%',
    comment: 'integration test',
    exit_price: null,
    pips: null,
    outcome: null,
};

const events: { event: string; newSl?: number; trade?: Record<string, unknown> }[] = [
    { event: 'tp1' },
    { event: 'tp2' },
    { event: 'be' },
    { event: 'tsl', newSl: 1.0902 },
    { event: 'tp3', trade: { ...sampleTrade, exit_price: 1.0952, pips: 60, outcome: 'Profit' } },
    { event: 'slHit', trade: { ...sampleTrade, exit_price: 1.0872, pips: -20, outcome: 'Loss' } },
    { event: 'closed', trade: { ...sampleTrade, exit_price: 1.0912, pips: 20, outcome: 'Profit' } },
];

async function main() {
    console.log('Dispatching sample alerts to configured channels...\n');

    console.log('created   -> sending creation alert');
    await notifyTradeCreated(sampleTrade);

    for (const e of events) {
        const sent = await notifyTradeEvent(e.trade ?? sampleTrade, e.event, { newSl: e.newSl, force: true });
        console.log(`${e.event.padEnd(9)} -> ${sent ? 'dispatched' : 'skipped (no channel enabled / no credentials)'}`);
    }

    console.log('\nDone. Check your Discord trade-alerts channel (and Telegram once a chat id is set).');
    process.exit(0);
}

main().catch((err) => {
    console.error('test:alerts failed:', err);
    process.exit(1);
});
