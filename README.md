# Forex Admin Backend - Express.js

This is the Express.js backend for the Forex Admin Dashboard, migrated from Laravel. It follows the same project structure as `forex-site-backend` and provides RESTful APIs for managing the admin dashboard.

## Features

- ✅ Express.js REST API
- ✅ PostgreSQL with Sequelize ORM
- ✅ Redis caching
- ✅ JWT authentication
- ✅ Rate limiting
- ✅ Error handling
- ✅ Request validation
- ✅ Logging with Winston
- ✅ File uploads with Multer
- ✅ Payment gateway integration (Stripe, PayPal)

## Project Structure

```
forex-admin-backend/
├── src/
│   ├── config/          # Configuration files
│   ├── controllers/     # Route controllers
│   │   └── v1/         # API version 1 controllers
│   ├── dtos/           # Data Transfer Objects
│   ├── exceptions/     # Custom exception classes
│   ├── middlewares/    # Express middlewares
│   ├── models/         # Sequelize models
│   ├── repositories/   # Data access layer
│   ├── routes/         # Route definitions
│   ├── services/       # Business logic
│   ├── utils/          # Utility functions
│   ├── validators/     # Request validators
│   └── app.js          # Express app setup
├── logs/               # Application logs
├── migrations/         # Database migrations
├── uploads/            # Uploaded files
├── server.js           # Application entry point
├── package.json        # Dependencies
└── .env.example        # Environment variables template
```

## Prerequisites

- Node.js >= 18.x
- PostgreSQL >= 14.x
- Redis >= 6.x
- npm or yarn

## Installation

1. **Clone the repository**

```bash
cd forex-admin-backend
```

2. **Install dependencies**

```bash
npm install
```

3. **Setup environment variables**

```bash
cp .env.example .env
```

Edit `.env` file and configure your database, Redis, and other settings.

4. **Create uploads directory**

```bash
mkdir -p uploads
```

5. **Setup database**

Make sure PostgreSQL is running and create the database:

```sql
CREATE DATABASE forex_admin;
```

6. **Run migrations** (if you have them)

```bash
npm run migrate
```

7. **Start Redis**

```bash
# On Ubuntu/Debian
sudo service redis-server start

# On macOS with Homebrew
brew services start redis

# Using Docker
docker run -d -p 6379:6379 redis
```

## Running the Application

### Development

```bash
npm run dev
```

The server will start on `http://localhost:5001` (or the PORT specified in .env)

### Production

```bash
npm start
```

## API Documentation

### Base URL

```
http://localhost:5001/api/v1
```

### Admin Endpoints

#### Users

- `GET /admin/users` - Get all users
- `GET /admin/users/stats` - Get user statistics
- `GET /admin/users/:id` - Get user by ID
- `DELETE /admin/users/:id` - Delete user

#### Forum Topics

- `GET /admin/forum/topics` - Get all topics
- `POST /admin/forum/topics` - Create topic
- `GET /admin/forum/topics/:id` - Get topic by ID
- `PUT /admin/forum/topics/:id` - Update topic
- `DELETE /admin/forum/topics/:id` - Delete topic

#### Forum Posts

- `GET /admin/forum/posts` - Get all posts
- `POST /admin/forum/posts` - Create post
- `GET /admin/forum/posts/:id` - Get post by ID
- `PUT /admin/forum/posts/:id` - Update post
- `DELETE /admin/forum/posts/:id` - Delete post

#### Subscription Packages

- `GET /admin/subscription-packages` - Get all packages
- `POST /admin/subscription-packages` - Create package
- `GET /admin/subscription-packages/:id` - Get package by ID
- `PUT /admin/subscription-packages/:id` - Update package
- `DELETE /admin/subscription-packages/:id` - Delete package
- `PATCH /admin/subscription-packages/:id/publish` - Publish package

#### Educations

- `GET /admin/educations` - Get all educations
- `POST /admin/educations` - Create education
- `GET /admin/educations/:id` - Get education by ID
- `PUT /admin/educations/:id` - Update education
- `DELETE /admin/educations/:id` - Delete education
- `POST /admin/educations/:id/publish` - Publish education
- `POST /admin/educations/:id/unpublish` - Unpublish education

#### Dynamic Tables

- `GET /admin/dynamic-tables` - Get all tables
- `POST /admin/dynamic-tables` - Create table
- `GET /admin/dynamic-tables/identifier/:identifier` - Get table by identifier
- `GET /admin/dynamic-tables/:id` - Get table by ID
- `PUT /admin/dynamic-tables/:id` - Update table
- `DELETE /admin/dynamic-tables/:id` - Delete table

### Query Parameters

Most GET endpoints support the following query parameters:

- `locale` - Language locale (default: 'en')

Example:

```
GET /admin/forum/topics?locale=es
```

## Environment Variables

See `.env.example` for all available environment variables.

Key variables:

- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 5001)
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` - Database credentials
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` - Redis configuration
- `JWT_SECRET` - Secret for JWT tokens
- `CACHE_API_KEY` - API key for cache operations

## Database Models

The application includes the following Sequelize models:

- User
- ForumTopic, ForumTopicTranslation
- ForumPost, ForumPostTranslation
- SubscriptionPackage, SubscriptionPackageTranslation
- Education, EducationTranslation
- PageContent, PageContentTranslation
- PaymentGateway, PaymentTransaction
- UserSubscription
- CurrencyPair
- DynamicTable, TableRow, TableColumn, TableCell
- TradingAlert
- ColorConfiguration
- RiskModeScore
- ScoreDashboard
- AppConfig

## Caching

The application uses Redis for caching. Key cache patterns:

- User data
- Forum topics and posts
- Subscription packages
- Educational content

Cache is automatically invalidated when data is updated.

## Error Handling

The application uses centralized error handling with custom error classes:

- `ApiError` - General API errors
- `ValidationError` - Request validation errors

All errors are logged and returned in a consistent format:

```json
{
  "success": false,
  "message": "Error message",
  "errors": []
}
```

## Rate Limiting

The API implements rate limiting:

- General endpoints: 100 requests per 15 minutes
- Auth endpoints: 5 requests per 15 minutes
- Read endpoints: 100 requests per minute

## Testing

```bash
npm test
```

## Logging

Logs are stored in the `logs/` directory:

- `combined.log` - All logs
- `error.log` - Error logs only

## Contributing

1. Create a feature branch
2. Make your changes
3. Write/update tests
4. Submit a pull request

## Migration Notes

This backend was migrated from Laravel to Express.js. Key differences:

- Eloquent ORM → Sequelize ORM
- Laravel's routing → Express routing
- Laravel's validation → Joi validation
- Laravel's events/listeners → Can be implemented as needed

## License

MIT

## Support

For support, contact the development team.
