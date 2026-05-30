const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { isAdmin } = require('../middleware/auth');

async function fetchTiers() {
  const r = await pool.query('SELECT max_hours, rate FROM rate_tiers ORDER BY max_hours ASC NULLS LAST');
  return r.rows;
}

function calcRateFromTiers(hours, tiers) {
  for (const tier of tiers) {
    if (tier.max_hours === null || hours < parseFloat(tier.max_hours)) return parseFloat(tier.rate);
  }
  return tiers.length ? parseFloat(tiers[tiers.length - 1].rate) : 0;
}

function round2(n) { return Math.round(n * 100) / 100; }

// מחשב weekly_slot_minutes ו-slot_cost_estimate לכל מטפל
async function buildTherapistSlotData(tiers) {
  const slotsRes = await pool.query(
    'SELECT therapist_id, start_time, end_time FROM therapist_slots WHERE active = true'
  );
  const weeklyMinutes = {};
  for (const s of slotsRes.rows) {
    const [sh, sm] = s.start_time.split(':').map(Number);
    const [eh, em] = s.end_time.split(':').map(Number);
    weeklyMinutes[s.therapist_id] = (weeklyMinutes[s.therapist_id] || 0) + (eh * 60 + em) - (sh * 60 + sm);
  }
  return weeklyMinutes;
}

function computeMonthlyRate(weeklyMinutes, slotRate, tiers) {
  const monthlyHours = round2((weeklyMinutes / 60) * 4);
  if (slotRate) return { monthlyHours, monthlyRate: round2(parseFloat(slotRate)), auto: false };
  if (monthlyHours <= 0 || !tiers.length) return { monthlyHours, monthlyRate: 0, auto: true };
  const rate = calcRateFromTiers(monthlyHours, tiers);
  return { monthlyHours, monthlyRate: round2(monthlyHours * rate), auto: true };
}

// GET /api/contracts
router.get('/', isAdmin, async (req, res) => {
  try {
    const [contractsRes, tiers] = await Promise.all([
      pool.query(`
        SELECT c.*, t.name AS therapist_name
        FROM slot_contracts c
        LEFT JOIN therapists t ON c.therapist_id = t.id
        ORDER BY c.start_date DESC, t.name
      `),
      fetchTiers(),
    ]);
    const weeklyMinutes = await buildTherapistSlotData(tiers);

    const rows = contractsRes.rows.map(c => {
      const wMin = weeklyMinutes[c.therapist_id] || 0;
      const { monthlyHours, monthlyRate, auto } = computeMonthlyRate(wMin, c.slot_rate, tiers);
      return {
        ...c,
        weekly_slot_minutes: wMin,
        monthly_hours: monthlyHours,
        monthly_rate: monthlyRate,
        total_amount: round2(monthlyRate * c.duration_months),
        auto_rate: auto,
      };
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contracts
router.post('/', isAdmin, async (req, res) => {
  const { therapist_id, start_date, duration_months, slot_rate, auto_renew, notes } = req.body;
  if (!therapist_id || !start_date || !duration_months) {
    return res.status(400).json({ error: 'therapist_id, start_date ו-duration_months הם חובה' });
  }
  if (![6, 12].includes(parseInt(duration_months))) {
    return res.status(400).json({ error: 'duration_months חייב להיות 6 או 12' });
  }
  try {
    const end_date = await pool.query(
      'SELECT ($1::date + ($2 * interval \'1 month\'))::date AS end_date',
      [start_date, duration_months]
    ).then(r => r.rows[0].end_date);

    const result = await pool.query(
      `INSERT INTO slot_contracts (therapist_id, start_date, duration_months, end_date, slot_rate, auto_renew, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [therapist_id, start_date, duration_months, end_date,
       slot_rate || null, auto_renew !== false, notes || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/contracts/:id
router.put('/:id', isAdmin, async (req, res) => {
  const { start_date, duration_months, slot_rate, auto_renew, notes } = req.body;
  try {
    const existing = await pool.query('SELECT * FROM slot_contracts WHERE id = $1', [req.params.id]);
    if (!existing.rows[0]) return res.status(404).json({ error: 'לא נמצא' });

    const newStart = start_date || existing.rows[0].start_date;
    const newDuration = duration_months ? parseInt(duration_months) : existing.rows[0].duration_months;
    if (![6, 12].includes(newDuration)) return res.status(400).json({ error: 'duration_months חייב להיות 6 או 12' });

    const end_date = await pool.query(
      'SELECT ($1::date + ($2 * interval \'1 month\'))::date AS end_date',
      [newStart, newDuration]
    ).then(r => r.rows[0].end_date);

    const result = await pool.query(
      `UPDATE slot_contracts
       SET start_date = $1, duration_months = $2, end_date = $3,
           slot_rate = $4, auto_renew = $5, notes = $6
       WHERE id = $7 RETURNING *`,
      [newStart, newDuration, end_date,
       slot_rate !== undefined ? (slot_rate || null) : existing.rows[0].slot_rate,
       auto_renew !== undefined ? auto_renew : existing.rows[0].auto_renew,
       notes !== undefined ? (notes || null) : existing.rows[0].notes,
       req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/contracts/:id
router.delete('/:id', isAdmin, async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM slot_contracts WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'לא נמצא' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/contracts/renew-due — חידוש חוזים שפגו עם auto_renew=true
router.post('/renew-due', isAdmin, async (req, res) => {
  try {
    const due = await pool.query(`
      SELECT * FROM slot_contracts
      WHERE auto_renew = true AND end_date <= CURRENT_DATE
    `);
    let renewed = 0;
    for (const c of due.rows) {
      const newStart = await pool.query(
        'SELECT ($1::date + interval \'1 day\')::date AS d', [c.end_date]
      ).then(r => r.rows[0].d);
      const newEnd = await pool.query(
        'SELECT ($1::date + ($2 * interval \'1 month\'))::date AS d', [newStart, c.duration_months]
      ).then(r => r.rows[0].d);

      await pool.query(
        `INSERT INTO slot_contracts (therapist_id, start_date, duration_months, end_date, slot_rate, auto_renew, notes)
         VALUES ($1, $2, $3, $4, $5, true, $6)`,
        [c.therapist_id, newStart, c.duration_months, newEnd, c.slot_rate, c.notes]
      );
      await pool.query('UPDATE slot_contracts SET auto_renew = false WHERE id = $1', [c.id]);
      renewed++;
    }
    res.json({ success: true, renewed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
