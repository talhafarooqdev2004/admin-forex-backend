# FX Analyzer Cache Implementation Guide

## Overview

This document describes the implementation of the FX Analyzer caching system, which dramatically improves response times for the `fx_analyzer_pro` table by pre-computing and caching all analyzer data per currency pair.

### Performance Improvement
- **Before**: Several seconds (multiple database queries and joins)
- **After**: < 50ms (single cache query)

## Architecture

### Components

1. **fx_analyzer_cache Table** - Stores pre-computed analyzer data
2. **FxAnalyzerCache Model** - Sequelize model for cache table
3. **FxAnalyzerCacheRepository** - Data access layer for cache
4. **ScoreUpdateService** - Event-driven queue system for cache updates
5. **CacheUpdateTrigger** - Helper service for triggering updates
6. **Cache-aware Controller** - Modified dynamicTable controller

### Data Flow

```
Column-Specific Table Update
        ↓
CacheUpdateTrigger.triggerPairUpdate()
        ↓
ScoreUpdateService.queueUpdate()
        ↓
[Debounced Queue Processing]
        ↓
1. Update main score table
2. Build complete FX analyzer data
3. Update cache
        ↓
FX Analyzer Cache Updated ✨
```

## Migration Steps

### Step 1: Run Database Migration

```bash
cd forex-admin-backend
npm run migrate
```

This will create the `fx_analyzer_cache` table with the following structure:
- `id` (BIGINT, PRIMARY KEY)
- `pair` (STRING, UNIQUE) - Currency pair identifier
- `currency_pair_id` (BIGINT, FK to currency_pairs)
- `complete_data` (TEXT) - JSON string with all pre-calculated data
- `last_updated` (TIMESTAMP)

### Step 2: Populate Initial Cache

Before enabling the new system, populate the cache for all existing currency pairs:

```bash
node --experimental-loader ./alias-loader.js populate-fx-analyzer-cache.js
```

This script will:
- Fetch all currency pairs from the database
- Build complete analyzer data for each pair
- Store in the cache table
- Provide progress and error reporting

**Expected Output:**
```
=================================================
FX Analyzer Cache Population Script
=================================================
✅ Database connection established
Found 28 currency pairs to cache
Starting cache population...

[1/28] Processing EUR/USD...
[1/28] ✅ EUR/USD cached successfully in 245ms
[2/28] Processing GBP/USD...
[2/28] ✅ GBP/USD cached successfully in 198ms
...

=================================================
Cache Population Complete
=================================================
Total pairs: 28
✅ Succeeded: 28
❌ Failed: 0
```

### Step 3: Verify Cache

Check that the cache is populated:

```bash
# Using SQL
SELECT pair, last_updated FROM fx_analyzer_cache ORDER BY pair;

# Using API (requires authentication)
GET /api/v1/admin/fx-analyzer-cache/stats
```

### Step 4: Test the Integration

Test the optimized endpoint:

```bash
# Get all pairs from cache
GET /api/v1/admin/dynamic-tables/identifier/fx_analyzer_pro

# Get specific pair from cache
GET /api/v1/admin/dynamic-tables/identifier/fx_analyzer_pro?pair=EUR/USD
```

## Usage Guide

### For Frontend Developers

#### Fetching FX Analyzer Data

```typescript
// Old way (slow - multiple DB queries)
const response = await fetch('/api/v1/admin/dynamic-tables/identifier/fx_analyzer_pro');

// New way (fast - single cache query)
// 1. Get all pairs (automatically uses cache)
const response = await fetch('/api/v1/admin/dynamic-tables/identifier/fx_analyzer_pro');

// 2. Get specific pair (even faster)
const response = await fetch('/api/v1/admin/dynamic-tables/identifier/fx_analyzer_pro?pair=EUR/USD');
```

The response format remains the same, but the data is now served from cache.

### For Backend Developers

#### Triggering Cache Updates

When you update any data that affects the FX Analyzer, trigger a cache update:

```javascript
import { cacheUpdateTrigger } from '../services/cacheUpdateTrigger.service.js';

// Method 1: After updating a specific pair
await cacheUpdateTrigger.triggerPairUpdate('EUR/USD', 'fx_analyzer_pro', 'trend_score');

// Method 2: After updating a cell
await cacheUpdateTrigger.triggerCellUpdate(cellId, 'momentum_score');

// Method 3: After updating a row
await cacheUpdateTrigger.triggerRowUpdate(rowId, 'sentiment_score');

// Method 4: Bulk update multiple pairs
await cacheUpdateTrigger.triggerBulkUpdate([
  { pair: 'EUR/USD', changedColumn: 'trend_score' },
  { pair: 'GBP/USD', changedColumn: 'momentum_score' }
]);

// Method 5: Full refresh of all pairs
await cacheUpdateTrigger.triggerFullRefresh();
```

#### Integration Examples

**Example 1: In a Scraper Service**

```javascript
// File: src/services/trendScoreScraper.service.js
import { cacheUpdateTrigger } from './cacheUpdateTrigger.service.js';

async scrapeAndUpdate(pair) {
  try {
    // Scrape data
    const trendScore = await this.scrapeTrendScore(pair);
    
    // Update database
    await this.repository.updateTrendScore(pair, trendScore);
    
    // ✨ Trigger cache update
    await cacheUpdateTrigger.triggerPairUpdate(pair, 'trend_scores_table', 'trend_score');
    
  } catch (error) {
    logger.error(`Error scraping trend score for ${pair}:`, error);
  }
}
```

**Example 2: In a Controller**

```javascript
// File: src/controllers/v1/admin/scoreUpdate.controller.js
import { cacheUpdateTrigger } from '../../../services/cacheUpdateTrigger.service.js';

export const updateScore = async (req, res, next) => {
  try {
    const { pair, scoreType, value } = req.body;
    
    // Update database
    await scoreRepository.updateScore(pair, scoreType, value);
    
    // ✨ Trigger cache update
    await cacheUpdateTrigger.triggerPairUpdate(pair, 'score_dashboard', scoreType);
    
    res.json({ success: true, message: 'Score updated and cache refreshed' });
  } catch (error) {
    next(error);
  }
};
```

**Example 3: After Batch Updates**

```javascript
async function batchUpdateScores(updates) {
  // Update database
  await scoreRepository.batchUpdate(updates);
  
  // ✨ Trigger cache updates for affected pairs
  const cacheUpdates = updates.map(u => ({
    pair: u.pair,
    changedColumn: u.column
  }));
  
  await cacheUpdateTrigger.triggerBulkUpdate(cacheUpdates);
}
```

### Cache Management API

The system provides admin endpoints for managing the cache:

#### Get Cache Statistics
```bash
GET /api/v1/admin/fx-analyzer-cache/stats
```

Response:
```json
{
  "success": true,
  "data": {
    "cache": {
      "totalEntries": 28,
      "oldestUpdate": "2026-01-11T10:30:00.000Z",
      "newestUpdate": "2026-01-11T10:35:00.000Z"
    },
    "updateQueue": {
      "queueLength": 2,
      "isProcessing": false,
      "uniquePairs": 2
    }
  }
}
```

#### Force Update Specific Pair
```bash
POST /api/v1/admin/fx-analyzer-cache/update/EUR%2FUSD
```

#### Force Update All Pairs
```bash
# Synchronous (wait for completion)
POST /api/v1/admin/fx-analyzer-cache/update-all

# Asynchronous (run in background)
POST /api/v1/admin/fx-analyzer-cache/update-all?background=true
```

#### Get Queue Status
```bash
GET /api/v1/admin/fx-analyzer-cache/queue/status
```

#### Clear Cache for Specific Pair
```bash
DELETE /api/v1/admin/fx-analyzer-cache/EUR%2FUSD
```

#### Clear All Cache
```bash
DELETE /api/v1/admin/fx-analyzer-cache
```

## Queue System

The cache update system uses a smart queue with the following features:

### Debouncing
Updates are debounced for 500ms to batch multiple rapid updates together.

### Deduplication
If multiple updates are queued for the same pair, only the latest is processed.

### Batch Processing
Processes up to 10 pairs at once for efficiency.

### Automatic Retry
Failed updates can be retried automatically (configurable).

### Example Flow

```
Time 0ms:    Update queued for EUR/USD (trend_score)
Time 100ms:  Update queued for EUR/USD (momentum_score)
Time 200ms:  Update queued for GBP/USD (sentiment_score)
Time 500ms:  [Debounce timer fires]
             Processing 2 unique pairs: EUR/USD, GBP/USD
Time 750ms:  Cache updated for EUR/USD (both changes included)
Time 850ms:  Cache updated for GBP/USD
```

## Configuration

You can configure the queue behavior in `scoreUpdateService.js`:

```javascript
this.config = {
  batchSize: 10,        // Process up to 10 pairs at once
  debounceTime: 500,    // Wait 500ms before processing
  maxRetries: 3,        // Maximum retry attempts
};
```

## Troubleshooting

### Cache Not Updating

1. Check the queue status:
```bash
GET /api/v1/admin/fx-analyzer-cache/queue/status
```

2. Check application logs for errors:
```bash
grep "Cache update" logs/combined.log
```

3. Manually trigger update:
```bash
POST /api/v1/admin/fx-analyzer-cache/update/EUR%2FUSD
```

### Slow Performance Despite Cache

1. Verify cache is being used (check logs for "Retrieved from cache")
2. Check cache size:
```bash
SELECT pair, LENGTH(complete_data) as size_bytes 
FROM fx_analyzer_cache 
ORDER BY size_bytes DESC;
```

3. Verify indexes exist:
```sql
SHOW INDEX FROM fx_analyzer_cache;
```

### Stale Cache Data

1. Check last update time:
```bash
GET /api/v1/admin/fx-analyzer-cache/stats
```

2. Force refresh:
```bash
POST /api/v1/admin/fx-analyzer-cache/update-all
```

## Monitoring

### Key Metrics to Monitor

1. **Cache Hit Rate** - How often cache is used vs database
2. **Cache Age** - Time since last update per pair
3. **Queue Length** - Number of pending updates
4. **Update Duration** - Time to update cache per pair

### Sample Monitoring Query

```sql
-- Find stale cache entries (not updated in last hour)
SELECT pair, last_updated, 
       TIMESTAMPDIFF(MINUTE, last_updated, NOW()) as minutes_ago
FROM fx_analyzer_cache
WHERE last_updated < NOW() - INTERVAL 1 HOUR
ORDER BY last_updated ASC;
```

## Best Practices

1. **Always trigger cache updates** after modifying data that affects FX Analyzer
2. **Use bulk updates** when updating multiple pairs to improve efficiency
3. **Monitor cache age** to ensure data freshness
4. **Log cache operations** for debugging and auditing
5. **Test cache population** in staging before production deployment
6. **Set up alerts** for high queue lengths or update failures

## Migration Checklist

- [ ] Run database migration to create `fx_analyzer_cache` table
- [ ] Verify table creation and indexes
- [ ] Run initial cache population script
- [ ] Verify all pairs are cached successfully
- [ ] Update existing scrapers to trigger cache updates
- [ ] Test FX Analyzer endpoint performance
- [ ] Set up monitoring for cache statistics
- [ ] Document any custom integration points
- [ ] Train team on cache management API
- [ ] Deploy to production with monitoring

## Additional Resources

- Cache Repository: `src/repositories/fxAnalyzerCache.repository.js`
- Score Update Service: `src/services/scoreUpdateService.js`
- Cache Trigger Helper: `src/services/cacheUpdateTrigger.service.js`
- Population Script: `populate-fx-analyzer-cache.js`
- API Routes: `src/routes/fxAnalyzerCache.routes.js`

## Support

For questions or issues, check the application logs or contact the development team.
