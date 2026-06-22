/**
 * Manual integration test: dispatches trade-alert samples to Discord/Telegram.
 *
 *   npm run test:alerts
 */
import 'dotenv/config';
import { notifyTradeCreated, notifyTradeEvent } from './src/services/tradeAlertNotification.service.js';

const sampleTrade = {
    trade_id: '61926-12',
    pair: 'NZDUSD',
    direction: 'buy',
    direction_type: 'Buy',
    type: 'Scalping',
    session: 'New York',
    entry_level: 0.57306,
    stop_loss: 0.57106,
    tp1: 0.57506,
    tp2: 0.57706,
    tp3: 0.57906,
    risk: '0.5%',
    comment: 'integration test',
    exit_price: null,
    pips: null,
    outcome: null,
    breakeven_done: false,
    tsl_active: false,
};

const tp1Trade = {
    ...sampleTrade,
    breakeven_done: true,
    stop_loss: 0.57306,
};

const tp1TslTrade = {
    ...sampleTrade,
    tsl_active: true,
    stop_loss: 0.5735,
};

async function main() {
    console.log('Dispatching sample alerts to configured channels...\n');

    console.log('created   -> initial alert (no partial close)');
    await notifyTradeCreated(sampleTrade);

    console.log('tp1       -> TP1 hit, then separate partial close');
    await notifyTradeEvent(tp1Trade, 'tp1', { force: true });

    console.log('tp1+tsl   -> TP1 hit with TSL active');
    await notifyTradeEvent(tp1TslTrade, 'tp1', { force: true });

    console.log('tp2       -> TP2 hit + partial close');
    await notifyTradeEvent({ ...tp1TslTrade, stop_loss: 0.57506 }, 'tp2', { force: true });

    console.log('tp3       -> TP3 hit (trade closed)');
    await notifyTradeEvent(
        { ...sampleTrade, exit_price: 0.57906, pips: 60, outcome: 'Profit' },
        'tp3',
        { force: true },
    );

    console.log('slHit     -> stop loss hit');
    await notifyTradeEvent(
        { ...sampleTrade, exit_price: 0.57106, pips: -20, outcome: 'Loss' },
        'slHit',
        { force: true },
    );

    console.log('be        -> breakeven');
    await notifyTradeEvent(tp1Trade, 'be', { force: true });

    console.log('tsl       -> trailing SL update');
    await notifyTradeEvent(tp1TslTrade, 'tsl', { newSl: 0.574, force: true });

    console.log('\nDone. Check Discord for: initial, TP1, PARTIAL CLOSE (separate), TP2, etc.');
    process.exit(0);
}

main().catch((err) => {
    console.error('test:alerts failed:', err);
    process.exit(1);
});
