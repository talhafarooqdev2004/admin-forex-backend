import express from 'express';
import publicRoutes from './public.routes.js';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import packageRoutes from './package.routes.js';
import educationRoutes from './education.routes.js';
import dynamicTableRoutes from './dynamicTable.routes.js';
import pageContentRoutes from './pageContent.routes.js';
import currencyPairRoutes from './currencyPair.routes.js';
import tradingAlertRoutes from './tradingAlert.routes.js';
import colorConfigurationRoutes from './colorConfiguration.routes.js';
import riskModeScoreRoutes from './riskModeScore.routes.js';
import appConfigRoutes from './appConfig.routes.js';
import scoreDashboardRoutes from './scoreDashboard.routes.js';
import paymentGatewayRoutes from './paymentGateway.routes.js';
import tableStructureRoutes from './tableStructure.routes.js';
import tableEditorRoutes from './tableEditor.routes.js';
import fxAnalyzerCacheRoutes from './fxAnalyzerCache.routes.js';
import fxAnalyzerTechnicalRoutes from './fxAnalyzerTechnical.routes.js';
import edgeToolsSyncRoutes from './edgeToolsSync.routes.js';
import cotDataAnalysisSyncRoutes from './cotDataAnalysisSync.routes.js';
import forumRulesRoutes from "./forumRules.routes.js";
import forumAnnouncementsRoutes from "./forumAnnouncements.routes.js";
import forumPostsRoutes from "./forumPosts.routes.js";
import webhookRoutes from './webhook.routes.js';

import visitorAnalyticsRoutes from './visitorAnalytics.routes.js';

const router = express.Router();

router.use('/public', publicRoutes);
router.use('/auth', authRoutes);
router.use('/packages', packageRoutes);
router.use('/admin/users', userRoutes);
router.use('/admin/subscription-packages', packageRoutes);
router.use('/admin/educations', educationRoutes);
router.use('/admin/dynamic-tables', dynamicTableRoutes);
router.use('/admin/page-contents', pageContentRoutes);
router.use('/admin/currency-pairs', currencyPairRoutes);
router.use('/admin/trading-alerts', tradingAlertRoutes);
router.use('/admin/score-configurations', colorConfigurationRoutes);
router.use('/admin/risk-mode-score', riskModeScoreRoutes);
router.use('/admin/app-configs', appConfigRoutes);
router.use('/admin/score-dashboard', scoreDashboardRoutes);
router.use('/admin/payment-gateways', paymentGatewayRoutes);
router.use('/admin/table-structure', tableStructureRoutes);
router.use('/admin/table-editor', tableEditorRoutes);
router.use('/admin/fx-analyzer-cache', fxAnalyzerCacheRoutes);
router.use('/admin/fx-analyzer-technical', fxAnalyzerTechnicalRoutes);
router.use('/admin/edge-tools', edgeToolsSyncRoutes);
router.use('/admin/cot-data-analysis', cotDataAnalysisSyncRoutes);
router.use('/admin/analytics', visitorAnalyticsRoutes);
router.use('/webhooks', webhookRoutes);

router.post('/admin/cache/flush/users', (req, res) => {
    const providedKey = req.headers['x-cache-key'];
    if (providedKey !== process.env.CACHE_API_KEY) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    res.json({ status: 'ok' });
});

router.use('/forum-rules', forumRulesRoutes);
router.use('/forum-announcements', forumAnnouncementsRoutes);
router.use('/forum-posts', forumPostsRoutes);

export default router;
