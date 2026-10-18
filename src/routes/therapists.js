const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { isAdmin } = require('../middleware/auth');
const { calcRateFromTiers, weeklyMinutesByTherapist } = require('../lib/billing');

// GET /api/therapists — כל המטפלים, עם slot_cost_estimate לאלו ללא slot_rate ידני
router.get('/', isAdmin, async (req, res) => {
  try {
    const [therapistsRes, slotsRes, tiersRes] = await Promise.all([
      pool.query('SELECT id, name, email, phone, type, active, calendar_name, slot_rate, monthly_discount, is_admin, created_at FROM therapists ORDER BY name'),
      pool.query('SELECT therapist_id, start_time, end_time FROM therapist_slots WHERE active = true'),
      pool.query('SELECT max_hours, rate FROM rate_tiers ORDER BY max_hours ASC NULLS LAST'),
    ]);

    const tiers = tiersRes.rows;
    // קבץ ססיות לפי מטפל וחשב שעות שבועיות
    const weeklyMinutes = weeklyMinutesByTherapist(slotsRes.rows);

    const rows = therapistsRes.rows.map(t => {
      const wMin = weeklyMinutes[t.id] || 0;
      const monthlyHours = (wMin / 60) * 4;
      let slotCostEstimate = null;
      if (!t.slot_rate && monthlyHours > 0 && tiers.length > 0) {
        const rate = calcRateFromTiers(monthlyHours, tiers);
        slotCostEstimate = Math.round(monthlyHours * rate * 100) / 100;
      }
      return { ...t, weekly_slot_minutes: wMin, slot_cost_estimate: slotCostEstimate };
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/therapists/:id
router.get('/:id', isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, phone, type, active, calendar_name, slot_rate, monthly_discount, is_admin FROM therapists WHERE id = $1',
      [req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'לא נמצא' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/therapists — הוספת מטפל
router.post('/', isAdmin, async (req, res) => {
  const { name, email, phone, type, calendar_name, slot_rate, monthly_discount, is_admin } = req.body;
  if (!name || !email || !type) {
    return res.status(400).json({ error: 'שם, אימייל וסוג הם שדות חובה' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO therapists (name, email, phone, type, calendar_name, slot_rate, monthly_discount, is_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, email, phone, type, calendar_name, slot_rate, monthly_discount, is_admin, active`,
      [name, email, phone || null, type, calendar_name || null, slot_rate || null, monthly_discount || null, is_admin || false]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'אימייל כבר קיים במערכת' });
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/therapists/:id — עדכון מטפל.
// שדה שלא נשלח כלל (המפתח חסר מה-body) נשמר כפי שהוא.
// שדה שנשלח במפורש כ-null מאפס את הערך (רלוונטי ל-calendar_name/slot_rate/monthly_discount).
router.put('/:id', isAdmin, async (req, res) => {
  const b = req.body;
  const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
  try {
    const existing = await pool.query('SELECT * FROM therapists WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'לא נמצא' });
    const cur = existing.rows[0];

    // לכל שדה: אם נשלח ב-body — השתמש בערך שנשלח (כולל null); אחרת שמור את הקיים.
    const name             = has('name') ? b.name : cur.name;
    const email            = has('email') ? b.email : cur.email;
    const phone            = has('phone') ? (b.phone || null) : cur.phone;
    const type             = has('type') ? b.type : cur.type;
    const active           = has('active') ? b.active : cur.active;
    const calendar_name    = has('calendar_name') ? (b.calendar_name || null) : cur.calendar_name;
    const slot_rate        = has('slot_rate') ? (b.slot_rate ?? null) : cur.slot_rate;
    const monthly_discount = has('monthly_discount') ? (b.monthly_discount ?? null) : cur.monthly_discount;
    const is_admin         = has('is_admin') ? b.is_admin : cur.is_admin;

    const result = await pool.query(
      `UPDATE therapists
       SET name = $1, email = $2, phone = $3, type = $4, active = $5,
           calendar_name = $6, slot_rate = $7, monthly_discount = $8, is_admin = $9
       WHERE id = $10
       RETURNING id, name, email, phone, type, calendar_name, slot_rate, monthly_discount, is_admin, active`,
      [name, email, phone, type, active, calendar_name, slot_rate, monthly_discount, is_admin, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'לא נמצא' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'אימייל כבר קיים במערכת' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/therapists/:id — מחיקה רכה (toggle active)
router.delete('/:id', isAdmin, async (req, res) => {
  try {
    const current = await pool.query('SELECT active FROM therapists WHERE id = $1', [req.params.id]);
    if (!current.rows[0]) return res.status(404).json({ error: 'לא נמצא' });
    const newActive = !current.rows[0].active;
    await pool.query('UPDATE therapists SET active = $1 WHERE id = $2', [newActive, req.params.id]);
    res.json({ success: true, active: newActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/therapists/:id/permanent — מחיקה קשיחה
router.delete('/:id/permanent', isAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM therapists WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/therapists/:id/slots
router.get('/:id/slots', isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, day_of_week, start_time, end_time, active, end_date FROM therapist_slots WHERE therapist_id = $1 ORDER BY day_of_week, start_time',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/therapists/:id/slots
router.post('/:id/slots', isAdmin, async (req, res) => {
  const { day_of_week, start_time, end_time, end_date } = req.body;
  if (day_of_week === undefined || !start_time || !end_time) {
    return res.status(400).json({ error: 'יום, שעת התחלה ושעת סיום הם שדות חובה' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO therapist_slots (therapist_id, day_of_week, start_time, end_time, end_date)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, day_of_week, start_time, end_time, active, end_date`,
      [req.params.id, day_of_week, start_time, end_time, end_date || null]
    );

    let cancelledCount = 0;
    if (end_date) {
      // בטל את כל הפגישות הבאות של המטפל באותו יום בשבוע שנופלות אחרי end_date
      const cancelled = await pool.query(
        `UPDATE sessions
         SET status = 'cancelled', cancelled_at = NOW()
         WHERE therapist_id = $1
           AND status = 'confirmed'
           AND start_time > $2
           AND EXTRACT(DOW FROM start_time AT TIME ZONE 'Asia/Jerusalem') = $3
         RETURNING id, google_event_id`,
        [req.params.id, end_date, day_of_week]
      );
      cancelledCount = cancelled.rowCount;

      // מחק מגוגל קאלנדר ברקע
      const { deleteGoogleEvent } = require('./calendar');
      for (const s of cancelled.rows) {
        if (s.google_event_id) deleteGoogleEvent(s.google_event_id);
      }
    }

    res.status(201).json({ ...result.rows[0], cancelledSessions: cancelledCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/therapists/:id/slots/:slotId — עדכון תאריך סיום לשעה קיימת
router.patch('/:id/slots/:slotId', isAdmin, async (req, res) => {
  const { end_date } = req.body;
  try {
    const existing = await pool.query(
      'SELECT id, day_of_week FROM therapist_slots WHERE id = $1 AND therapist_id = $2 AND active = true',
      [req.params.slotId, req.params.id]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: 'לא נמצא' });

    const { day_of_week } = existing.rows[0];
    await pool.query(
      'UPDATE therapist_slots SET end_date = $1 WHERE id = $2',
      [end_date || null, req.params.slotId]
    );

    let cancelledCount = 0;
    if (end_date) {
      const cancelled = await pool.query(
        `UPDATE sessions
         SET status = 'cancelled', cancelled_at = NOW()
         WHERE therapist_id = $1
           AND status = 'confirmed'
           AND start_time > $2
           AND EXTRACT(DOW FROM start_time AT TIME ZONE 'Asia/Jerusalem') = $3
         RETURNING id, google_event_id`,
        [req.params.id, end_date, day_of_week]
      );
      cancelledCount = cancelled.rowCount;
      const { deleteGoogleEvent } = require('./calendar');
      for (const s of cancelled.rows) {
        if (s.google_event_id) deleteGoogleEvent(s.google_event_id);
      }
    }

    res.json({ success: true, cancelledSessions: cancelledCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/therapists/:id/slots/:slotId
router.delete('/:id/slots/:slotId', isAdmin, async (req, res) => {
  try {
    await pool.query(
      'UPDATE therapist_slots SET active = false WHERE id = $1 AND therapist_id = $2',
      [req.params.slotId, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
