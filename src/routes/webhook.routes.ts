import express from 'express';
import * as retailSentimentWebhookController from '../controllers/v1/webhooks/retailSentimentWebhook.controller.js';
import * as centralBankPoliciesWebhookController from '../controllers/v1/webhooks/centralBankPoliciesWebhook.controller.js';
import * as scoreDashboardWebhookController from '../controllers/v1/webhooks/scoreDashboardWebhook.controller.js';
import * as fxAnalyzerTechnicalWebhookController from '../controllers/v1/webhooks/fxAnalyzerTechnicalWebhook.controller.js';
import * as edgeToolsWebhookController from '../controllers/v1/webhooks/edgeToolsWebhook.controller.js';
import * as cotDataAnalysisWebhookController from '../controllers/v1/webhooks/cotDataAnalysisWebhook.controller.js';
import * as marketDriverWebhookController from '../controllers/v1/webhooks/marketDriverWebhook.controller.js';
import * as economicCalendarWebhookController from '../controllers/v1/webhooks/economicCalendarWebhook.controller.js';

const router = express.Router();

router.post('/retail-sentiment/sync', retailSentimentWebhookController.syncRetailSentiment);
router.post('/central-banks/sync', centralBankPoliciesWebhookController.syncCentralBankPoliciesFromSheet);
router.post('/score-dashboard/sync', scoreDashboardWebhookController.syncScoreDashboardFromSheet);
router.post('/fx-analyzer-technical/sync', fxAnalyzerTechnicalWebhookController.syncFxAnalyzerTechnicalFromSheets);
router.post('/edge-tools/sync-from-sheets', edgeToolsWebhookController.syncEdgeToolsFromSheetsWebhook);
router.post('/cot-data-analysis/sync-from-sheets', cotDataAnalysisWebhookController.syncCotDataAnalysisFromSheetsWebhook);
router.post('/market-driver/ingest-rss', marketDriverWebhookController.ingestMarketDriverRss);
router.post('/economic-calendar/ingest', economicCalendarWebhookController.ingestEconomicCalendar);

export default router;
