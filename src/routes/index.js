import express from 'express';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import packageRoutes from './package.routes.js';
import educationRoutes from './education.routes.js';
import dynamicTableRoutes from './dynamicTable.routes.js';
import forumTopicRoutes from './forum/topic.routes.js';
import forumPostRoutes from './forum/post.routes.js';
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

console.log('🔥 Registering FX Analyzer Cache routes...');

const router = express.Router();

// Test endpoint
router.get('/admin/test', (req, res) => {
    res.json({ message: 'CORS OK' });
});

// Auth routes
router.use('/auth', authRoutes);

// Public routes (accessible by both users and admins)
router.use('/packages', packageRoutes); // Public packages endpoint for dashboard

// Admin routes
router.use('/admin/users', userRoutes);
router.use('/admin/subscription-packages', packageRoutes);
router.use('/admin/educations', educationRoutes);
router.use('/admin/dynamic-tables', dynamicTableRoutes);
router.use('/admin/forum/topics', forumTopicRoutes);
router.use('/admin/forum/posts', forumPostRoutes);
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

// Cache flush endpoint
router.post('/admin/cache/flush/users', (req, res) => {
    const providedKey = req.headers['x-cache-key'];
    
    if (providedKey !== process.env.CACHE_API_KEY) {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    // Implement cache flush logic here
    res.json({ status: 'ok' });
});

export default router;
