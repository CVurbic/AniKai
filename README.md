# AniKai Userscripts

Three Tampermonkey scripts for [anikai.to](https://anikai.to) that add cross-device continue-watching sync and new episode detection.

---

## Scripts

### 1. New Episode Checker
Shows the latest aired episode number on every continue-watching card via AniList API.
- Green badge `L 11` = new episodes available since you last watched
- Muted badge `L 6` = you're up to date

### 2. Continue Watching Sync (Supabase)
Syncs your continue-watching list to Supabase so it's the same on every device.
- Pulls on page load, pushes on every watch-progress update
- Latest timestamp wins when merging conflicts

### 3. AniKai Inspector Overlay
DOM inspector overlay for the site (developer tool). Toggle with `Ctrl+Shift+I`.

---

## Installation

### Step 1 — Install Tampermonkey
Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension for Chrome, Edge, or Firefox.

### Step 2 — Install scripts
Click each link below. Tampermonkey will detect the script and show an install prompt.

| Script | Install |
|--------|---------|
| New Episode Checker | [Install](../../raw/main/NewEpisodeChecker.js) |
| Continue Watching Sync | [Install](../../raw/main/ContinueWatchingSync.js) |
| Inspector Overlay | [Install](../../raw/main/AnimeInspectorOverlay.js) |

### Step 3 — Set up Supabase (for sync only)

Create a free project at [supabase.com](https://supabase.com), then run this in the SQL editor:

```sql
CREATE TABLE IF NOT EXISTS continue_watching (
  user_id      TEXT        NOT NULL,
  anime_id     TEXT        NOT NULL,
  watch_url    TEXT,
  thumbnail    TEXT,
  title        TEXT,
  alt_title    TEXT,
  episode_id   TEXT,
  episode_num  INTEGER     DEFAULT 0,
  sub_dub      TEXT        DEFAULT 'sub',
  current_secs INTEGER     DEFAULT 0,
  total_secs   INTEGER     DEFAULT 0,
  updated_at   TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, anime_id)
);

ALTER TABLE continue_watching ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon full access" ON continue_watching
  FOR ALL USING (true) WITH CHECK (true);
```

Then open `ContinueWatchingSync.js` in Tampermonkey's editor and replace the two config values at the top:

```js
const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_KEY = 'your-anon-key';
```

### Step 4 — Sync user ID across devices

The sync script generates a random ID per device stored in `localStorage`. To share data across devices, copy the ID from device A and set it on device B:

**Device A** — open browser console on anikai.to:
```js
localStorage.getItem('cws_user_id')
```

**Device B** — paste the value:
```js
localStorage.setItem('cws_user_id', 'u_xxxxxxxx-...')
```

---

## How the episode checker works

On first load it has no AniList IDs cached. It fetches the watch page for each anime in your continue-watching list in the background, extracts the AniList ID from the embedded `#syncData` JSON, and caches it. Subsequent page loads use the cache — no extra requests.

AniList data: for airing shows it reads `nextAiringEpisode.episode - 1` (last released), for finished shows it reads the total episode count.
