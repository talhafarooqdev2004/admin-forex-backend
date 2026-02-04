# Translation Structure Fix

## Changes Made

Updated all repositories and models to return `translation` (singular) instead of `translations` (plural) when loading with a locale, matching Laravel's structure exactly.

## Models Updated

Added `translation` (hasOne) association to:
- ✅ SubscriptionPackage
- ✅ ForumTopic  
- ✅ ForumPost
- ✅ Education
- ✅ PageContent (keeps translations for multi-locale mapping)

## Repositories Updated

Changed from `as: 'translations'` to `as: 'translation'` when loading with locale:

- ✅ PackageRepository.findAll()
- ✅ ForumTopicRepository.findAll()
- ✅ ForumPostRepository.findAll()
- ✅ ForumPostRepository.findBySlug()
- ✅ ForumPostRepository.findByTopicId()
- ✅ EducationRepository.findAll()

## Response Structure

Now matches Laravel exactly:
- When loading with locale: Returns `translation` (single object)
- When loading all: Returns `translations` (array) - for findById without locale

## Example Response Structure

```json
{
  "success": true,
  "message": "Packages retrieved successfully",
  "data": [
    {
      "id": "4",
      "price": "120.00",
      "duration_hours": 700,
      "free_trial_hours": 45,
      "additional_discounts": [{"percent": 67}],
      "campaigns": [{"hours": 6}],
      "publish": true,
      "translation": {
        "id": "13",
        "subscription_package_id": "4",
        "locale": "en",
        "name": "Silver",
        "detail": "Silver is good!."
      },
      "created_at": "2025-11-25T15:26:23.000Z",
      "updated_at": "2025-11-25T15:26:28.000Z"
    }
  ]
}
```

Note: `translation` is now a single object (not an array) when loading with locale.
