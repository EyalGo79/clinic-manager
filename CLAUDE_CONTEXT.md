# Clinic Manager — Claude Context Handoff
*Give this file to Claude at the start of a new session to restore full project context.*

---

## Project Overview

**Name:** Clinic Manager (קליניקת גולן)  
**Purpose:** Clinic scheduling and billing system for therapists. Admins manage therapists, sessions, billing, and Google Calendar sync. Therapists view their own schedule and manage sessions.  
**Git repo:** `https://github.com/EyalGo79/clinic-manager.git`  
**Language/UI:** Hebrew (RTL), Node.js + Express + PostgreSQL + Vanilla JS frontend  
**Deployed:** via Docker container (Render or similar), `npm start` → `node index.js`

---

## Tech Stack

- **Backend:** Node.js, Express 5.x
- **Database:** PostgreSQL (pg driver), UTC timestamps throughout
- **Auth:** Passport.js + Google OAuth 2.0 (two strategies: admin with calendar scope, therapist without)
- **Calendar:** Google Calendar API (googleapis 144.x) — "קליניקה" calendar
- **Frontend:** Vanilla JS, FullCalendar 6.1.11, no framework
- **Dev:** Nodemon

---

## Project Structure

```
clinic-manager/
├── index.js                    # App entry, routes mount, session config, auto-renew scheduler
├── db/schema.sql               # Full PostgreSQL schema
├── src/
│   ├── config/db.js            # pg connection pool
│   ├── config/passport.js      # OAuth strategies (google-admin, google-therapist)
│   ├── middleware/auth.js      # isAdmin, isTherapist, isAdminOrTherapist, isAuthenticated
│   └── routes/
│       ├── auth.js             # /auth/* — OAuth login/logout/refresh/me
│       ├── therapists.js       # /api/therapists — CRUD, slots, contracts
│       ├── sessions.js         # /api/sessions — CRUD, conflict detection, recurring, cancel
│       ├── calendar.js         # /api/calendar — Google sync/push, upsertGoogleEvent helpers
│       ├── billing.js          # /api/billing — invoice generation, tiered rates
│       ├── contracts.js        # /api/contracts — slot contracts, auto-renew
│       └── settings.js         # /api/settings — rate tiers, admin management
└── src/public/
    ├── login.html
    ├── style.css
    ├── admin/                  # index.html, schedule.html, therapists.html,
    │                           # contracts.html, billing.html, settings.html
    └── therapist/              # index.html, billing.html
```

---

## Database Schema (key tables)

### sessions
```sql
id SERIAL PRIMARY KEY
therapist_id INT → therapists
start_time TIMESTAMP   -- UTC
end_time TIMESTAMP     -- UTC
google_event_id VARCHAR(255) UNIQUE
status VARCHAR(20)     -- 'confirmed' | 'cancelled' | 'cancelled_charged'
cancelled_at TIMESTAMP
cancellation_waived BOOLEAN
notes TEXT
series_id UUID         -- recurring series grouping
original_end_time TIMESTAMP  -- for shortened sessions (billing)
created_at TIMESTAMP
```

### therapists
```sql
id, name, email (UNIQUE), google_id, phone
type VARCHAR(20)       -- 'fixed' | 'flexible'
calendar_name VARCHAR  -- matched to Google Calendar event summary
active BOOLEAN
slot_rate DECIMAL      -- hourly rate for fixed slots
monthly_discount DECIMAL
is_admin BOOLEAN       -- dual role support
```

### admins
```sql
id, email (UNIQUE), google_id (UNIQUE)
refresh_token TEXT     -- for offline Google Calendar access
is_calendar_primary BOOLEAN  -- which admin's token is used for sync
```

### Other tables: `invoices`, `therapist_slots`, `billing_adjustments`, `rate_tiers`, `slot_contracts`

---

## Key Business Logic

### Conflict Detection (`sessions.js` top of file)
- `BUFFER_MINUTES = 15` — minimum gap between different therapists
- `SAME_THERAPIST_MIN_GAP_MINUTES = 90` — same therapist same day: either adjacent (0 gap) or ≥90 min
- `LATE_CANCEL_HOURS = 24`
- Conflict check pulls candidates in window, then calculates **actual gap in JS** (not SQL expansion)
- Timezone for day boundaries: `Asia/Jerusalem`

### Recurring Sessions
- `series_id` UUID groups all occurrences
- `google_event_id` stored **only on first occurrence**; others look up series ID on cancel/update
- Edit series: updates times on all future confirmed occurrences + ends old Google series + creates new
- Cancel series: cancels all future confirmed occurrences
- `repeat_until` can be passed on series update to delete future sessions beyond a date

### Google Calendar Sync
- Sync pulls from "קליניקה" calendar, matches event summary → therapist by `calendar_name`
- **Cancelled sessions never get their start/end time updated** (prevents duplicate key bug when event was rescheduled in Google)
- `rows` deduped by `event_id` in JS before any DB work
- INSERT uses `ON CONFLICT (google_event_id) DO NOTHING`
- Phase 1 uses `DISTINCT ON (event_id)` to match at most one DB session per Google event
- Sync window: past 365d, future 180d

### Billing
- Tiered hourly rates from `rate_tiers` table
- Fixed slot contracts (6 or 12 months, auto-renew daily at 06:00 UTC)
- Late cancel (<24h): `cancelled_charged` status, admin can waive
- `original_end_time` preserved if session shortened on same day (billed at original duration)

---

## Environment Variables

```
DATABASE_URL
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GOOGLE_CALLBACK_URL                 # /auth/google/callback
GOOGLE_CALLBACK_URL_ADMIN           # /auth/google/callback/admin
GOOGLE_CALLBACK_URL_ADMIN_REFRESH   # /auth/google/callback/admin/refresh
SESSION_SECRET
PORT                                # default 3000
NODE_ENV                            # production | development
CLIENT_ORIGIN
```

---

## API Endpoints Summary

### Auth (`/auth`)
- `GET /google` — therapist login
- `GET /google/admin` — admin login (calendar scope)
- `GET /google/callback[/admin[/refresh]]` — OAuth callbacks
- `POST /logout`, `GET /me`

### Sessions (`/api/sessions`)
- `GET /` — list (params: from, to, therapist_id)
- `POST /` — create single session
- `POST /recurring` — create recurring weekly series (body: therapist_id, start_time, end_time, notes, repeat_until)
- `PUT /:id` — update (body: start_time, end_time, notes, update_series, repeat_until)
- `POST /:id/cancel` — cancel (body: waive_charge, cancel_series)
- `POST /:id/waive` — waive cancelled_charged fee

### Calendar (`/api/calendar`) — admin only
- `POST /sync` — pull from Google → DB
- `POST /push` — push unsynced DB sessions → Google
- `POST /event` — create single event in Google
- `POST /deduplicate` — remove duplicate sessions

### Therapists (`/api/therapists`) — admin only
- `GET|POST /`
- `GET|PUT|DELETE /:id`
- `GET|POST /:id/slots`, `PATCH|DELETE /:id/slots/:slotId`

### Billing (`/api/billing`)
- `GET /summary/:year/:month` — admin summary
- `GET /:therapistId/:year/:month` — get/generate invoice
- `POST /generate/:therapistId/:year/:month`
- `GET /:therapistId/current-rate`

### Contracts (`/api/contracts`) — admin only
- `GET|POST /`, `PUT|DELETE /:id`, `POST /renew-due`

### Settings (`/api/settings`) — admin only
- `GET|PUT /rate-tiers`
- `GET|POST /admins`, `DELETE /admins/:id`, `PUT /admins/:id/calendar-primary`

---

## Known Bugs Fixed (recent history)

1. **Duplicate google_event_id on sync** — root cause: cancelled session had its start_time updated to match a rescheduled Google event, then collided with a separate DB row on next sync. Fix: don't update start/end of cancelled sessions during sync.

2. **Phase 1 matching multiple sessions to same event** — fix: use `DISTINCT ON (event_id) ORDER BY event_id, session.id`

3. **Buffer check false positive** — old code expanded the query window by ±15min and flagged everything in window as conflict. Fix: fetch candidates in window, calculate actual gap in JS, only flag if gap < 15min.

4. **Series edit not deleting future sessions when repeat_until changed** — fix: added `repeat_until` field to edit-series flow in both UIs and backend; backend deletes confirmed sessions beyond new date.

---

## User Preferences & Notes

- Developer: Eyal Golan (git config)
- Hebrew UI throughout; error messages in Hebrew
- Sessions stored in UTC; displayed in Asia/Jerusalem timezone
- Admin dashboard at `/admin`, therapist at `/therapist`
- Google Calendar name for clinic: "קליניקה" (hard-coded)
