# Global Conflict Risk Matrix — Live Dashboard

Real-time geopolitical risk dashboard tracking the 2026 Iran war, South Asia nuclear flashpoint probability, and global conflict escalation. Built by [Subha Imtiaz](https://substack.com/@subhaimtiaz).

## Live Data Sources
- **GDELT Project** — conflict event data, news alerts (free, no key)
- **OilPriceAPI** — real-time Brent crude price (free tier)
- **NewsData.io** — live news feed (free tier)

## Features
- 5 outcome probabilities recalculating in real-time
- 15 adjustable escalation variables
- 8 leader risk profiles
- 8 conflict theatre escalation bars
- Interdependency network map
- Auto-rotating intelligence feed (new item every 8 seconds)
- Share button
- 5-minute auto-refresh from live APIs

## Deploy

### Backend (Railway)
1. Fork this repo
2. Connect to Railway
3. Add environment variables: `OIL_API_KEY`, `NEWS_API_KEY`
4. Deploy — Railway auto-detects Node.js

### Frontend (Netlify)
1. Edit `public/index.html` — set `API_BASE` to your Railway URL
2. Drag to [Netlify Drop](https://app.netlify.com/drop)

## Environment Variables
```
OIL_API_KEY=    # from oilpriceapi.com (free)
NEWS_API_KEY=   # from newsdata.io (free)
PORT=3000       # set automatically by Railway
```

---
Analysis by [Subha Imtiaz](https://substack.com/@subhaimtiaz) · People & Culture Director, APAC
