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

// טוען refresh_token מה-DB ומחזיר OAuth client מוכן — מעדיף אדמין ראשי
async function getStoredOAuthClient() {
  const result = await pool.query(
    'SELECT refresh_token FROM admins WHERE refresh_token IS NOT NULL ORDER BY is_calendar_primary DESC LIMIT 1'
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
        showDeleted: true,
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
    const cancelledEventIds = []; // אירועים שנמחקו בגוגל ללא start/end
    for (const event of events) {
      // אירוע מחוק ללא זמנים — סמן לביטול לפי google_event_id
      if (event.status === 'cancelled' && !event.start?.dateTime && !event.start?.date) {
        cancelledEventIds.push(event.id);
        continue;
      }
      const startRaw = event.start?.dateTime || (event.start?.date ? event.start.date + 'T08:00:00+03:00' : null);
      const endRaw   = event.end?.dateTime   || (event.end?.date   ? event.end.date   + 'T08:00:00+03:00' : null);
      if (!startRaw || !endRaw) { results.skipped++; continue; }

      const startTime = new Date(startRaw).toISOString();
      const endTime   = new Date(endRaw).toISOString();

      const summaryKey = (event.summary || '').trim().toLowerCase();
      const therapistId = therapistMap.get(summaryKey) || null;
      const status = event.status === 'cancelled' ? 'cancelled' : 'confirmed';

      if (therapistId === 13) {
        console.log('DEBUG therapist 13 event:', event.id, startTime, status, event.recurringEventId || '');
      }
      rows.push([therapistId, startTime, endTime, event.id, status, event.summary || null]);
    }

    // סמן כ-cancelled פגישות שנמחקו בגוגל (אין להן start/end באירוע המחוק)
    if (cancelledEventIds.length > 0) {
      await pool.query(
        `UPDATE sessions SET status = 'cancelled', cancelled_at = NOW()
         WHERE google_event_id = ANY($1) AND status = 'confirmed'`,
        [cancelledEventIds]
      );
    }

    // deduplicate rows by event_id — Google can return the same event_id more than once
    // (e.g. overlapping pagination windows), and the INSERT can't handle two rows with the same id
    const seenEventIds = new Set();
    const uniqueRows = rows.filter(r => {
      if (seenEventIds.has(r[3])) return false;
      seenEventIds.add(r[3]);
      return true;
    });
    const deduped = uniqueRows;

    if (deduped.length > 0) {
      // שלב 1: חבר אירועי גוגל לפגישות קיימות ב-DB שחסר להן google_event_id — query אחד
      const matchIds      = deduped.filter(r => r[0]).map(r => r[3]);
      const matchTherapists = deduped.filter(r => r[0]).map(r => r[0]);
      const matchStarts   = deduped.filter(r => r[0]).map(r => r[1]);
      const matchEnds     = deduped.filter(r => r[0]).map(r => r[2]);

      if (matchIds.length > 0) {
        await pool.query(
          `UPDATE sessions s
           SET google_event_id = m.event_id
           FROM (
             -- pick only the lowest-id session per event to avoid assigning the same
             -- google_event_id to multiple rows (which would violate the unique constraint)
             SELECT DISTINCT ON (m.event_id) s.id AS session_id, m.event_id
             FROM unnest(
               $1::text[], $2::int[], $3::timestamptz[], $4::timestamptz[]
             ) AS m(event_id, therapist_id, start_time, end_time)
             JOIN sessions s ON s.google_event_id IS NULL
               AND s.therapist_id = m.therapist_id
               AND s.start_time BETWEEN m.start_time - interval '1 minute' AND m.start_time + interval '1 minute'
               AND s.end_time   BETWEEN m.end_time   - interval '1 minute' AND m.end_time   + interval '1 minute'
             ORDER BY m.event_id, s.id
           ) m
           WHERE s.id = m.session_id`,
          [matchIds, matchTherapists, matchStarts, matchEnds]
        );
      }

      // שלב 2: upsert בשני שלבים — עדכון קיימים לפי google_event_id, הכנסת חדשים
      const therapistIds = deduped.map(r => r[0]);
      const startTimes   = deduped.map(r => r[1]);
      const endTimes     = deduped.map(r => r[2]);
      const eventIds     = deduped.map(r => r[3]);
      const statuses     = deduped.map(r => r[4]);
      const notes        = deduped.map(r => r[5]);

      // 2a: עדכן שורות קיימות לפי google_event_id
      // — אם גוגל מחזיר confirmed ו-DB הוא cancelled → החזר ל-confirmed
      // — לא לגעת ב-cancelled_charged לעולם
      await pool.query(
        `UPDATE sessions s
         SET start_time   = m.start_time,
             end_time     = m.end_time,
             status       = CASE
               WHEN s.status = 'cancelled_charged' THEN s.status
               ELSE m.status
             END,
             therapist_id = COALESCE(m.therapist_id, s.therapist_id)
         FROM (
           SELECT * FROM unnest($1::int[], $2::timestamptz[], $3::timestamptz[], $4::text[], $5::text[])
             AS t(therapist_id, start_time, end_time, event_id, status)
         ) m
         WHERE s.google_event_id = m.event_id`,
        [therapistIds, startTimes, endTimes, eventIds, statuses]
      );

      // 2b: הכנס רק אירועים שאין להם שורה קיימת כלל (לא לפי event_id ולא לפי therapist+זמן)
      await pool.query(
        `INSERT INTO sessions (therapist_id, start_time, end_time, google_event_id, status, notes)
         SELECT m.therapist_id, m.start_time, m.end_time, m.event_id, m.status, m.notes
         FROM unnest($1::int[], $2::timestamptz[], $3::timestamptz[], $4::text[], $5::text[], $6::text[])
           AS m(therapist_id, start_time, end_time, event_id, status, notes)
         WHERE NOT EXISTS (
           SELECT 1 FROM sessions s WHERE s.google_event_id = m.event_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM sessions s
           WHERE s.therapist_id = m.therapist_id
             AND s.therapist_id IS NOT NULL
             AND s.start_time = m.start_time
             AND s.end_time   = m.end_time
             AND s.status = 'confirmed'
         )
         ON CONFLICT (google_event_id) DO NOTHING`,
        [therapistIds, startTimes, endTimes, eventIds, statuses, notes]
      );

      // 2c: מחק כפילויות שנותרו (therapist_id+start+end זהים, שומר את ה-ID הנמוך)
      await pool.query(`
        DELETE FROM sessions
        WHERE id IN (
          SELECT unnest(array_agg(id ORDER BY id DESC))
          FROM sessions
          WHERE status = 'confirmed' AND therapist_id IS NOT NULL
          GROUP BY therapist_id, start_time, end_time
          HAVING count(*) > 1
        )
      `);

      results.imported = deduped.length;
    }

    res.json({ success: true, ...results, total: events.length });
  } catch (err) {
    console.error('Sync error:', err.message, err.detail || '');
    res.status(500).json({ error: err.message, detail: err.detail });
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

// ניקוי כפילויות: פגישות עם אותו therapist_id + start_time + end_time — שמור את זו עם google_event_id, מחק השאר
router.post('/deduplicate', isAdmin, async (req, res) => {
  try {
    const dupes = await pool.query(`
      SELECT array_agg(id ORDER BY google_event_id NULLS LAST, id) AS ids
      FROM sessions
      WHERE status = 'confirmed'
      GROUP BY therapist_id, start_time, end_time
      HAVING count(*) > 1
    `);

    if (dupes.rows.length === 0) {
      return res.json({ success: true, removed: 0, message: 'לא נמצאו כפילויות' });
    }

    let removed = 0;
    for (const group of dupes.rows) {
      // ids ממוינים: עם google_event_id ראשון — שמור את הראשון, מחק את השאר
      const [keep, ...toDelete] = group.ids;
      if (toDelete.length > 0) {
        await pool.query('DELETE FROM sessions WHERE id = ANY($1)', [toDelete]);
        removed += toDelete.length;
      }
    }

    res.json({ success: true, removed, groups: dupes.rows.length });
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

// יצירת אירוע חוזר שבועי בגוגל — מחזיר את ה-google_event_id של האירוע הראשי
async function createRecurringGoogleEvent({ therapist_name, start_time, end_time, repeat_until }) {
  try {
    const oauth2Client = await getStoredOAuthClient();
    if (!oauth2Client) return null;
    const cal = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = await getClinicCalendarId(cal);
    if (!calendarId) return null;

    // UNTIL בפורמט UTC YYYYMMDDTHHMMSSZ
    const untilDate = new Date(repeat_until);
    untilDate.setHours(23, 59, 59, 0);
    const until = untilDate.toISOString().replace(/[-:]/g, '').replace('.000', '');

    const eventBody = {
      summary: therapist_name || 'פגישה',
      start: { dateTime: new Date(start_time).toISOString(), timeZone: 'Asia/Jerusalem' },
      end:   { dateTime: new Date(end_time).toISOString(),   timeZone: 'Asia/Jerusalem' },
      recurrence: [`RRULE:FREQ=WEEKLY;UNTIL=${until}`],
    };

    const created = await cal.events.insert({ calendarId, resource: eventBody });
    return created.data.id;
  } catch (e) {
    console.error('google calendar recurring create error:', e.message);
    return null;
  }
}

// ביטול occurrence בודד מתוך אירוע חוזר בגוגל
async function cancelGoogleOccurrence(googleEventId, start_time) {
  try {
    const oauth2Client = await getStoredOAuthClient();
    if (!oauth2Client) return;
    const cal = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = await getClinicCalendarId(cal);
    if (!calendarId) return;

    // originalStartTime = שעת ההתחלה של ה-occurrence הזה
    const originalStart = new Date(start_time).toISOString();
    await cal.events.patch({
      calendarId,
      eventId: googleEventId,
      resource: { status: 'cancelled' },
      // Google מזהה את ה-occurrence לפי eventId_originalStartTime
    });
    // Google API: כדי לבטל occurrence בודד, יש לעדכן את ה-instance
    const instanceId = `${googleEventId}_${originalStart.replace(/[-:]/g, '').replace('.000Z', 'Z')}`;
    await cal.events.patch({
      calendarId,
      eventId: instanceId,
      resource: { status: 'cancelled' },
    });
  } catch (e) {
    console.error('google calendar cancel occurrence error:', e.message);
  }
}

// עדכון סדרה חוזרת מתאריך מסוים: מסיים את הישנה ויוצר חדשה עם השעות החדשות
async function updateRecurringGoogleSeries({ oldGoogleEventId, newStartTime, newEndTime, repeatUntil, therapistName }) {
  try {
    const oauth2Client = await getStoredOAuthClient();
    if (!oauth2Client) return null;
    const cal = google.calendar({ version: 'v3', auth: oauth2Client });
    const calendarId = await getClinicCalendarId(cal);
    if (!calendarId) return null;

    // סיים את הסדרה הישנה יום לפני תאריך השינוי
    if (oldGoogleEventId) {
      try {
        const existing = await cal.events.get({ calendarId, eventId: oldGoogleEventId });
        const rrule = (existing.data.recurrence || []).find(r => r.startsWith('RRULE:'));
        if (rrule) {
          const dayBefore = new Date(new Date(newStartTime).getTime() - 24 * 60 * 60 * 1000);
          const untilStr = dayBefore.toISOString().replace(/[-:]/g, '').replace('.000', '');
          const newRrule = rrule.replace(/;?UNTIL=[^;]*/i, '') + `;UNTIL=${untilStr}`;
          await cal.events.patch({ calendarId, eventId: oldGoogleEventId, resource: { recurrence: [newRrule] } });
        }
      } catch (e) {
        console.error('google calendar end old series error:', e.message);
      }
    }

    // צור סדרה חדשה
    return await createRecurringGoogleEvent({ therapist_name: therapistName, start_time: newStartTime, end_time: newEndTime, repeat_until: repeatUntil });
  } catch (e) {
    console.error('google calendar update recurring series error:', e.message);
    return null;
  }
}

module.exports = { router, upsertGoogleEvent, deleteGoogleEvent, createRecurringGoogleEvent, cancelGoogleOccurrence, updateRecurringGoogleSeries };
