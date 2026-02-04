import { Sequelize } from 'sequelize';
import { ENV } from '../config/env.js';
import { logger } from '../utils/logger.util.js';

// Import all models
import User from './User.js';
import ForumTopic from './ForumTopic.js';
import ForumTopicTranslation from './ForumTopicTranslation.js';
import ForumPost from './ForumPost.js';
import ForumPostTranslation from './ForumPostTranslation.js';
import SubscriptionPackage from './SubscriptionPackage.js';
import SubscriptionPackageTranslation from './SubscriptionPackageTranslation.js';
import Education from './Education.js';
import EducationTranslation from './EducationTranslation.js';
import PageContent from './PageContent.js';
import PageContentTranslation from './PageContentTranslation.js';
import PaymentGateway from './PaymentGateway.js';
import PaymentTransaction from './PaymentTransaction.js';
import UserSubscription from './UserSubscription.js';
import CurrencyPair from './CurrencyPair.js';
import DynamicTable from './DynamicTable.js';
import TableRow from './TableRow.js';
import TableColumn from './TableColumn.js';
import TableCell from './TableCell.js';
import TradingAlert from './TradingAlert.js';
import ColorConfiguration from './ColorConfiguration.js';
import RiskModeScore from './RiskModeScore.js';
import ScoreDashboard from './ScoreDashboard.js';
import AppConfig from './AppConfig.js';
import FxAnalyzerCache from './FxAnalyzerCache.js';

// Initialize Sequelize
export const sequelize = new Sequelize(
    ENV.DB_NAME,
    ENV.DB_USER,
    ENV.DB_PASSWORD,
    {
        host: ENV.DB_HOST,
        port: ENV.DB_PORT,
        dialect: 'postgres',
        logging: ENV.NODE_ENV === 'development' ? (msg) => logger.debug(msg) : false,
        pool: {
            max: 10,
            min: 0,
            acquire: 30000,
            idle: 10000
        }
    }
);

// Initialize all models
const models = {
    User: User.init(sequelize),
    ForumTopic: ForumTopic.init(sequelize),
    ForumTopicTranslation: ForumTopicTranslation.init(sequelize),
    ForumPost: ForumPost.init(sequelize),
    ForumPostTranslation: ForumPostTranslation.init(sequelize),
    SubscriptionPackage: SubscriptionPackage.init(sequelize),
    SubscriptionPackageTranslation: SubscriptionPackageTranslation.init(sequelize),
    Education: Education.init(sequelize),
    EducationTranslation: EducationTranslation.init(sequelize),
    PageContent: PageContent.init(sequelize),
    PageContentTranslation: PageContentTranslation.init(sequelize),
    PaymentGateway: PaymentGateway.init(sequelize),
    PaymentTransaction: PaymentTransaction.init(sequelize),
    UserSubscription: UserSubscription.init(sequelize),
    CurrencyPair: CurrencyPair.init(sequelize),
    DynamicTable: DynamicTable.init(sequelize),
    TableRow: TableRow.init(sequelize),
    TableColumn: TableColumn.init(sequelize),
    TableCell: TableCell.init(sequelize),
    TradingAlert: TradingAlert.init(sequelize),
    ColorConfiguration: ColorConfiguration.init(sequelize),
    RiskModeScore: RiskModeScore.init(sequelize),
    ScoreDashboard: ScoreDashboard.init(sequelize),
    AppConfig: AppConfig.init(sequelize),
    FxAnalyzerCache: FxAnalyzerCache.init(sequelize),
};

// Setup associations
Object.values(models).forEach(model => {
    if (model.associate) {
        model.associate(models);
    }
});

// Database connection
export const connectDB = async () => {
    try {
        await sequelize.authenticate();
        logger.info('✅ PostgreSQL connected successfully');

        // Sync models (in development only)
        if (ENV.NODE_ENV === 'development') {
            // await sequelize.sync({ alter: true });
            // logger.info('✅ Database tables synchronized');
        }

    } catch (error) {
        logger.error('❌ Database connection failed:', error);
        process.exit(1);
    }
};

// Initialize connection
connectDB();

export {
    User,
    ForumTopic,
    ForumTopicTranslation,
    ForumPost,
    ForumPostTranslation,
    SubscriptionPackage,
    SubscriptionPackageTranslation,
    Education,
    EducationTranslation,
    PageContent,
    PageContentTranslation,
    PaymentGateway,
    PaymentTransaction,
    UserSubscription,
    CurrencyPair,
    DynamicTable,
    TableRow,
    TableColumn,
    TableCell,
    TradingAlert,
    ColorConfiguration,
    RiskModeScore,
    ScoreDashboard,
    AppConfig,
    FxAnalyzerCache,
};

export default models;
