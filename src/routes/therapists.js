const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { isAdmin } = require('../middleware/auth');

// GET /api/therapists — כל המטפלים
router.get('/', isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, email, phone, type, active, calendar_name, slot_rate, monthly_discount, is_admin, created_at FROM therapists ORDER BY name'
    );
    res.json(result.rows);
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

// PUT /api/therapists/:id — עדכון מטפל
router.put('/:id', isAdmin, async (req, res) => {
  const { name, email, phone, type, active, calendar_name, slot_rate, monthly_discount, is_admin } = req.body;
  try {
    const result = await pool.query(
      `UPDATE therapists
       SET name = COALESCE($1, name),
           email = COALESCE($2, email),
           phone = COALESCE($3, phone),
           type = COALESCE($4, type),
           active = COALESCE($5, active),
           calendar_name = $6,
           slot_rate = $7,
           monthly_discount = $8,
           is_admin = COALESCE($9, is_admin)
       WHERE id = $10
       RETURNING id, name, email, phone, type, calendar_name, slot_rate, monthly_discount, is_admin, active`,
      [name, email, phone, type, active, calendar_name || null, slot_rate || null, monthly_discount || null, is_admin ?? null, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'לא נמצא' });
    res.json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'אימייל כבר קיים במערכת' });
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/therapists/:id — מחיקה רכה (active = false)
router.delete('/:id', isAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE therapists SET active = false WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/therapists/:id/slots
router.get('/:id/slots', isAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, day_of_week, start_time, end_time, active FROM therapist_slots WHERE therapist_id = $1 ORDER BY day_of_week, start_time',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/therapists/:id/slots
router.post('/:id/slots', isAdmin, async (req, res) => {
  const { day_of_week, start_time, end_time } = req.body;
  if (day_of_week === undefined || !start_time || !end_time) {
    return res.status(400).json({ error: 'יום, שעת התחלה ושעת סיום הם שדות חובה' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO therapist_slots (therapist_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4)
       RETURNING id, day_of_week, start_time, end_time, active`,
      [req.params.id, day_of_week, start_time, end_time]
    );
    res.status(201).json(result.rows[0]);
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
