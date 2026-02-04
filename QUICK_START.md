# Quick Start Guide

## Prerequisites Check

Before starting, ensure you have:

- ✅ Node.js 18+ installed (`node --version`)
- ✅ PostgreSQL 14+ installed and running
- ✅ Redis installed and running
- ✅ npm or yarn installed

## 5-Minute Setup

### Step 1: Install Dependencies (1 min)

```bash
cd forex-admin-backend
npm install
```

### Step 2: Configure Environment (1 min)

```bash
cp .env.example .env
```

Edit `.env` file:

```env
# Required - Update these
DB_HOST=localhost
DB_PORT=5432
DB_NAME=forex_admin
DB_USER=your_postgres_user
DB_PASSWORD=your_postgres_password

# Required - Generate a secure secret
JWT_SECRET=your_super_secret_jwt_key_here

# Optional - Defaults work for local development
REDIS_HOST=localhost
REDIS_PORT=6379
PORT=5001
```

### Step 3: Create Database (1 min)

```bash
# Connect to PostgreSQL
psql -U postgres

# Create database
CREATE DATABASE forex_admin;

# Exit psql
\q
```

### Step 4: Start Redis (30 seconds)

```bash
# Ubuntu/Debian
sudo service redis-server start

# macOS
brew services start redis

# Or using Docker
docker run -d -p 6379:6379 redis
```

### Step 5: Start the Server (30 seconds)

```bash
npm run dev
```

You should see:

```
🚀 Forex Admin Backend running on port 5001 in development mode
📡 API available at http://localhost:5001/api/v1
✅ PostgreSQL connected successfully
✅ Redis connected successfully
```

## Test the API

```bash
# Test endpoint
curl http://localhost:5001/api/v1/admin/test

# Should return:
# {"message":"CORS OK"}
```

## Common Issues & Solutions

### Issue: Database Connection Failed

**Solution:**
- Check PostgreSQL is running: `sudo service postgresql status`
- Verify credentials in `.env` file
- Ensure database `forex_admin` exists

### Issue: Redis Connection Failed

**Solution:**
- Check Redis is running: `redis-cli ping` (should return `PONG`)
- Start Redis: `sudo service redis-server start`
- Check Redis port in `.env` (default: 6379)

### Issue: Port Already in Use

**Solution:**
- Change `PORT` in `.env` file to a different port
- Or kill the process using port 5001:
  ```bash
  lsof -ti:5001 | xargs kill -9
  ```

### Issue: Module Not Found

**Solution:**
- Reinstall dependencies: `rm -rf node_modules && npm install`
- Clear npm cache: `npm cache clean --force`

## Next Steps

1. **Import Existing Data**
   - Your existing PostgreSQL database schema is compatible
   - Point to your existing database in `.env`

2. **Configure CORS**
   - Update `FRONTEND_URL` in `.env`
   - Add allowed origins in `src/app.js`

3. **Test Endpoints**
   - Use Postman or curl to test API endpoints
   - See README.md for full API documentation

4. **Enable Authentication** (Optional)
   - Uncomment auth middleware in routes
   - Generate JWT tokens for testing

5. **Setup Production**
   - Use PM2: `pm2 start npm --name "forex-admin" -- start`
   - Setup Nginx as reverse proxy
   - Use environment-specific `.env` files

## Development Workflow

```bash
# Start development server (auto-reload)
npm run dev

# Start production server
npm start

# Run tests (when implemented)
npm test
```

## API Testing Examples

### Get All Users

```bash
curl http://localhost:5001/api/v1/admin/users
```

### Get User Statistics

```bash
curl http://localhost:5001/api/v1/admin/users/stats
```

### Get Forum Topics

```bash
curl http://localhost:5001/api/v1/admin/forum/topics?locale=en
```

### Create Forum Topic

```bash
curl -X POST http://localhost:5001/api/v1/admin/forum/topics \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test Topic",
    "locale": "en"
  }'
```

## File Structure Quick Reference

```
forex-admin-backend/
├── src/
│   ├── app.js              # Express app setup
│   ├── config/             # Configuration files
│   ├── controllers/        # Request handlers
│   ├── middlewares/        # Express middlewares
│   ├── models/             # Database models
│   ├── repositories/       # Data access layer
│   ├── routes/             # API routes
│   └── utils/              # Helper functions
├── server.js               # Entry point
├── .env                    # Environment variables
└── package.json            # Dependencies
```

## Getting Help

- Check `README.md` for detailed documentation
- Review `MIGRATION_SUMMARY.md` for migration details
- Check logs in `logs/` directory
- Ensure all environment variables are set correctly

## Production Deployment

```bash
# Build and prepare for production
npm install --production

# Start with PM2
pm2 start server.js --name forex-admin-backend

# Check status
pm2 status

# View logs
pm2 logs forex-admin-backend

# Restart
pm2 restart forex-admin-backend
```

## Success Checklist

- ✅ Dependencies installed
- ✅ `.env` file configured
- ✅ Database created
- ✅ Redis running
- ✅ Server starts without errors
- ✅ Test endpoint returns 200 OK
- ✅ Logs show successful database connection

---

**You're all set! 🎉**

The Forex Admin Backend is now running on Express.js!
