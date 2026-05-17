const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const pool = require('../config/db');
const { isAdmin, isAdminOrTherapist } = require('../middleware/auth');

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_CALLBACK_URL_ADMIN
  );
}

// טוען refresh_token מה-DB ומחזיר OAuth client מוכן
async function getStoredOAuthClient() {
  const result = await pool.query(
    'SELECT refresh_token FROM admins WHERE refresh_token IS NOT NULL LIMIT 1'
  );
  if (!result.rows[0]?.refresh_token) return null;
  const client = getOAuth2Client();
  client.setCredentials({ refresh_token: result.rows[0].refresh_token });
  return client;
}

async function getClinicCalendarId(calendar) {
  const calendarList = await calendar.calendarList.list();
  const found = calendarList.data.items.find(c => c.summary === 'קליניקה');
  return found?.id || null;
}
function buildTherapistMap(therapists) {
  const map = new Map();
  for (const t of therapists) {
    if (t.calendar_name) map.set(t.calendar_name.trim().toLowerCase(), t.id);
    map.set(t.name.trim().toLowerCase(), t.id);
    const firstName = t.name.split(' ')[0].trim().toLowerCase();
    if (firstName) map.set(firstName, t.id);
  }
  return map;
}

// סינק: שליפת אירועים מגוגל קאלנדר ושמירתם ב-DB
router.post('/sync', isAdmin, async (req, res) => {
  const { timeMin, timeMax } = req.body;

  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: req.user.access_token,
      refresh_token: req.user.refresh_token,
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const calendarId = await getClinicCalendarId(calendar);
    if (!calendarId) {
      return res.status(404).json({ error: 'לא נמצא קאלנדר בשם "קליניקה". ודא שהקאלנדר קיים ב-Google Calendar שלך.' });
    }

    // טען מטפלים פעם אחת
    const therapistsRes = await pool.query('SELECT id, name, calendar_name FROM therapists WHERE active = true');
    const therapistMap = buildTherapistMap(therapistsRes.rows);

    // שלוף את כל האירועים עם pagination
    let allEvents = [];
    let pageToken = undefined;
    do {
      const response = await calendar.events.list({
        calendarId,
        timeMin: timeMin || new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        timeMax: timeMax || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
        pageToken,
      });
      allEvents = allEvents.concat(response.data.items || []);
      pageToken = response.data.nextPageToken;
    } while (pageToken);

    const events = allEvents;
    const results = { imported: 0, updated: 0, skipped: 0 };

    // בנה את כל הנתונים בזיכרון
    const rows = [];
    for (const event of events) {
      const startRaw = event.start?.dateTime || (event.start?.date ? event.start.date + 'T08:00:00+03:00' : null);
      const endRaw   = event.end?.dateTime   || (event.end?.date   ? event.end.date   + 'T08:00:00+03:00' : null);
      if (!startRaw || !endRaw) { results.skipped++; continue; }

      // המר ל-UTC ISO string כדי שהכנסה ל-Postgres תהיה חד-משמעית
      const startTime = new Date(startRaw).toISOString();
      const endTime   = new Date(endRaw).toISOString();

      const summaryKey = (event.summary || '').trim().toLowerCase();
      const therapistId = therapistMap.get(summaryKey) || null;
      const status = event.status === 'cancelled' ? 'cancelled' : 'confirmed';

      rows.push([therapistId, startTime, endTime, event.id, status, event.summary || null]);
    }

    // bulk upsert — query אחד לכולם עם unnest
    if (rows.length > 0) {
      const therapistIds = rows.map(r => r[0]);
      const startTimes   = rows.map(r => r[1]);
      const endTimes     = rows.map(r => r[2]);
      const eventIds     = rows.map(r => r[3]);
      const statuses     = rows.map(r => r[4]);
      const notes        = rows.map(r => r[5]);

      await pool.query(
        `INSERT INTO sessions (therapist_id, start_time, end_time, google_event_id, status, notes)
         SELECT * FROM unnest(
           $1::int[], $2::timestamptz[], $3::timestamptz[],
           $4::text[], $5::text[], $6::text[]
         )
         ON CONFLICT (google_event_id) DO UPDATE
           SET start_time   = EXCLUDED.start_time,
               end_time     = EXCLUDED.end_time,
               status       = EXCLUDED.status,
               therapist_id = COALESCE(EXCLUDED.therapist_id, sessions.therapist_id)`,
        [therapistIds, startTimes, endTimes, eventIds, statuses, notes]
      );

      results.imported = rows.length;
    }

    res.json({ success: true, ...results, total: events.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// יצירת אירוע בגוגל קאלנדר ממסד הנתונים
router.post('/event', isAdmin, async (req, res) => {
  const { session_id } = req.body;
  try {
    const sessionResult = await pool.query(
      `SELECT s.*, t.email AS therapist_email, t.name AS therapist_name
       FROM sessions s
       LEFT JOIN therapists t ON s.therapist_id = t.id
       WHERE s.id = $1`,
      [session_id]
    );
    if (!sessionResult.rows[0]) return res.status(404).json({ error: 'פגישה לא נמצאה' });

    const session = sessionResult.rows[0];
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: req.user.access_token,
      refresh_token: req.user.refresh_token,
    });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = (await getClinicCalendarId(calendar)) || 'primary';

    const event = {
      summary: session.therapist_name || 'לא ידוע',
      start: { dateTime: session.start_time, timeZone: 'Asia/Jerusalem' },
      end: { dateTime: session.end_time, timeZone: 'Asia/Jerusalem' },
      attendees: session.therapist_email ? [{ email: session.therapist_email }] : [],
    };

    const created = await calendar.events.insert({
      calendarId,
      resource: event,
      sendUpdates: 'all',
    });

    await pool.query('UPDATE sessions SET google_event_id = $1 WHERE id = $2', [created.data.id, session_id]);
    res.json({ success: true, googleEventId: created.data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// דחיפת פגישות ללא google_event_id לגוגל קאלנדר
router.post('/push', isAdmin, async (req, res) => {
  try {
    const oauth2Client = getOAuth2Client();
    oauth2Client.setCredentials({
      access_token: req.user.access_token,
      refresh_token: req.user.refresh_token,
    });
    const cal = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = await getClinicCalendarId(cal);
    if (!calendarId) return res.status(404).json({ error: 'לא נמצא קאלנדר בשם "קליניקה"' });

    const pending = await pool.query(
      `SELECT s.*, t.name AS therapist_name
       FROM sessions s
       LEFT JOIN therapists t ON s.therapist_id = t.id
       WHERE s.status = 'confirmed' AND s.google_event_id IS NULL`
    );

    let pushed = 0;
    for (const session of pending.rows) {
      try {
        const created = await cal.events.insert({
          calendarId,
          resource: {
            summary: session.therapist_name || 'פגישה',
            start: { dateTime: new Date(session.start_time).toISOString(), timeZone: 'Asia/Jerusalem' },
            end:   { dateTime: new Date(session.end_time).toISOString(),   timeZone: 'Asia/Jerusalem' },
          },
        });
        await pool.query('UPDATE sessions SET google_event_id = $1 WHERE id = $2', [created.data.id, session.id]);
        pushed++;
      } catch (e) {
        console.error('push event error:', session.id, e.message);
      }
    }

    res.json({ success: true, pushed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// פונקציה פנימית — כתוב/עדכן פגישה בגוגל קאלנדר (משמשת את sessions route)
async function upsertGoogleEvent(session) {
  try {
    const oauth2Client = await getStoredOAuthClient();
    if (!oauth2Client) return;

    const cal = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = await getClinicCalendarId(cal);
    if (!calendarId) return;

    const eventBody = {
      summary: session.therapist_name || 'פגישה',
      start: { dateTime: new Date(session.start_time).toISOString(), timeZone: 'Asia/Jerusalem' },
      end:   { dateTime: new Date(session.end_time).toISOString(),   timeZone: 'Asia/Jerusalem' },
    };

    if (session.google_event_id) {
      await cal.events.update({ calendarId, eventId: session.google_event_id, resource: eventBody });
    } else {
      const created = await cal.events.insert({ calendarId, resource: eventBody });
      await pool.query('UPDATE sessions SET google_event_id = $1 WHERE id = $2', [created.data.id, session.id]);
    }
  } catch (e) {
    console.error('google calendar upsert error:', e.message);
  }
}

async function deleteGoogleEvent(googleEventId) {
  try {
    const oauth2Client = await getStoredOAuthClient();
    if (!oauth2Client) return;
    const cal = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = await getClinicCalendarId(cal);
    if (!calendarId) return;
    await cal.events.delete({ calendarId, eventId: googleEventId });
  } catch (e) {
    console.error('google calendar delete error:', e.message);
  }
}

module.exports = { router, upsertGoogleEvent, deleteGoogleEvent };
