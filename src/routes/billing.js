const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { isAdmin, isAdminOrTherapist } = require('../middleware/auth');

// מדרגות חיוב — נטענות מה-DB
async function fetchTiers() {
  const result = await pool.query(
    'SELECT max_hours, rate FROM rate_tiers ORDER BY max_hours ASC NULLS LAST'
  );
  return result.rows;
}

function calculateRateFromTiers(totalHours, tiers) {
  for (const tier of tiers) {
    if (tier.max_hours === null || totalHours < parseFloat(tier.max_hours)) {
      return parseFloat(tier.rate);
    }
  }
  return parseFloat(tiers[tiers.length - 1].rate);
}

// המרת שעה מ-TIME string (HH:MM:SS) לדקות מתחילת היום
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// מחזיר כמה דקות מהפגישה חופפות לחלון slot (0 אם אין חפיפה)
function minutesInSlot(session, slots) {
  const start = new Date(session.start_time);
  const end   = new Date(session.end_time);
  const dow      = start.getDay();
  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin   = end.getHours()   * 60 + end.getMinutes();

  let overlap = 0;
  for (const slot of slots) {
    if (parseInt(slot.day_of_week) !== dow) continue;
    const slotStart = timeToMinutes(slot.start_time);
    const slotEnd   = timeToMinutes(slot.end_time);
    const overlapStart = Math.max(startMin, slotStart);
    const overlapEnd   = Math.min(endMin,   slotEnd);
    if (overlapEnd > overlapStart) overlap += overlapEnd - overlapStart;
  }
  return overlap;
}

// לצורך סימון בממשק — האם הפגישה כולה בתוך slot
function isInSlot(session, slots) {
  const mins = minutesInSlot(session, slots);
  const sessionMins = (new Date(session.end_time) - new Date(session.start_time)) / 60000;
  return mins >= sessionMins;
}

// חישוב חיוב עם ססיות קבועות
function calculateBilling(sessions, slots, slotRate, tiers) {
  const calcRate = (h) => calculateRateFromTiers(h, tiers);
  const actualHours = sessions.reduce((sum, s) => sum + parseFloat(s.hours), 0);

  if (!slots || slots.length === 0) {
    const rate = calcRate(actualHours);
    return {
      hasSlot: false,
      fixedSlotHours: 0,
      slotRate: null,
      basePrice: 0,
      extraHours: round2(actualHours),
      totalHours: round2(actualHours),
      ratePerHour: rate,
      extraRatePerHour: rate,
      totalAmount: round2(actualHours * rate),
    };
  }

  const slotMinutesPerWeek = slots.reduce((sum, s) => {
    return sum + (timeToMinutes(s.end_time) - timeToMinutes(s.start_time));
  }, 0);
  const fixedSlotHours = round2((slotMinutesPerWeek / 60) * 4);

  const basePrice = slotRate ? round2(parseFloat(slotRate)) : round2(fixedSlotHours * calcRate(fixedSlotHours));
  const effectiveHourlyRate = fixedSlotHours > 0 ? round2(basePrice / fixedSlotHours) : calcRate(0);

  const extraHours = round2(
    sessions.reduce((sum, s) => {
      const sessionMins = (new Date(s.end_time) - new Date(s.start_time)) / 60000;
      const inSlotMins  = minutesInSlot(s, slots);
      const extraMins   = Math.max(0, sessionMins - inSlotMins);
      return sum + extraMins / 60;
    }, 0)
  );

  const totalHours = round2(fixedSlotHours + extraHours);
  const rateOnTotal = calcRate(totalHours);
  const totalAtRate = round2(totalHours * rateOnTotal);
  const totalAmount = round2(Math.max(basePrice, totalAtRate));

  return {
    hasSlot: true,
    fixedSlotHours,
    slotRate: slotRate ? round2(parseFloat(slotRate)) : null,
    basePrice,
    extraHours,
    totalHours,
    ratePerHour: effectiveHourlyRate,
    extraRatePerHour: rateOnTotal,
    totalAmount,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// האם החודש כבר עבר (לפני החודש הנוכחי)
function isPastMonth(year, month) {
  const now = new Date();
  const y = parseInt(year);
  const m = parseInt(month);
  return y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1);
}

// הוסף הנחה חודשית קבועה כ-billing_adjustment אם עדיין לא קיימת
async function ensureMonthlyDiscount(therapistId, year, month, monthlyDiscount) {
  if (!monthlyDiscount || parseFloat(monthlyDiscount) <= 0) return;
  const existing = await pool.query(
    `SELECT id FROM billing_adjustments
     WHERE therapist_id = $1 AND year = $2 AND month = $3 AND type = 'monthly_discount'`,
    [therapistId, year, month]
  );
  if (existing.rows.length === 0) {
    await pool.query(
      `INSERT INTO billing_adjustments (therapist_id, year, month, type, value, note)
       VALUES ($1, $2, $3, 'monthly_discount', $4, 'הנחה חודשית קבועה')`,
      [therapistId, year, month, parseFloat(monthlyDiscount)]
    );
  }
}

// שלוף snapshot קיים מ-invoices
async function getSnapshot(therapistId, year, month) {
  const result = await pool.query(
    'SELECT * FROM invoices WHERE therapist_id = $1 AND year = $2 AND month = $3',
    [therapistId, year, month]
  );
  return result.rows[0] || null;
}

// צור snapshot ושמור ב-invoices (לא דורס קיים)
async function createSnapshot(therapistId, year, month) {
  const [sessionsRes, therapistRes, slotsRes, adjRes, tiers] = await Promise.all([
    pool.query(
      `SELECT start_time, end_time,
              EXTRACT(EPOCH FROM (end_time - start_time)) / 3600 AS hours
       FROM sessions
       WHERE therapist_id = $1
         AND EXTRACT(YEAR FROM start_time AT TIME ZONE 'Asia/Jerusalem') = $2
         AND EXTRACT(MONTH FROM start_time AT TIME ZONE 'Asia/Jerusalem') = $3
         AND status IN ('confirmed', 'cancelled_charged')
         AND cancellation_waived = false`,
      [therapistId, year, month]
    ),
    pool.query('SELECT slot_rate FROM therapists WHERE id = $1', [therapistId]),
    pool.query('SELECT day_of_week, start_time, end_time FROM therapist_slots WHERE therapist_id = $1 AND active = true', [therapistId]),
    pool.query('SELECT type, value FROM billing_adjustments WHERE therapist_id = $1 AND year = $2 AND month = $3', [therapistId, year, month]),
    fetchTiers(),
  ]);

  const { slot_rate } = therapistRes.rows[0] || {};
  const billing = calculateBilling(sessionsRes.rows, slotsRes.rows, slot_rate, tiers);

  const adjs = adjRes.rows;
  const creditHours = adjs.filter(a => a.type === 'credit_hours').reduce((s, a) => s + parseFloat(a.value), 0);
  const discountAmount = adjs.filter(a => ['discount_amount', 'monthly_discount'].includes(a.type)).reduce((s, a) => s + parseFloat(a.value), 0);
  const finalAmount = round2(Math.max(0, billing.totalAmount - creditHours * (billing.extraRatePerHour || billing.ratePerHour) - discountAmount));

  const result = await pool.query(
    `INSERT INTO invoices
       (therapist_id, year, month, total_hours, total_amount, rate_per_hour,
        has_slot, base_price, extra_hours, fixed_slot_hours, slot_rate_snapshot, extra_rate_per_hour)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (therapist_id, year, month) DO NOTHING
     RETURNING *`,
    [therapistId, year, month,
     billing.totalHours, finalAmount, billing.ratePerHour,
     billing.hasSlot, billing.basePrice, billing.extraHours, billing.fixedSlotHours,
     billing.slotRate, billing.extraRatePerHour || null]
  );
  return result.rows[0] || await getSnapshot(therapistId, year, month);
}

// המר שורת invoice ל-billing format
function invoiceToBilling(inv) {
  return {
    hasSlot: inv.has_slot,
    fixedSlotHours: parseFloat(inv.fixed_slot_hours) || 0,
    slotRate: inv.slot_rate_snapshot ? parseFloat(inv.slot_rate_snapshot) : null,
    basePrice: parseFloat(inv.base_price) || 0,
    extraHours: parseFloat(inv.extra_hours) || 0,
    totalHours: parseFloat(inv.total_hours),
    ratePerHour: parseFloat(inv.rate_per_hour),
    extraRatePerHour: inv.extra_rate_per_hour ? parseFloat(inv.extra_rate_per_hour) : parseFloat(inv.rate_per_hour),
    totalAmount: parseFloat(inv.total_amount),
  };
}

// GET /api/billing/summary/:year/:month
router.get('/summary/:year/:month', isAdmin, async (req, res) => {
  const { year, month } = req.params;
  try {
    const [therapistsResult, tiers] = await Promise.all([
      pool.query('SELECT id, name, email, slot_rate, monthly_discount FROM therapists WHERE active = true ORDER BY name'),
      fetchTiers(),
    ]);
    const therapists = therapistsResult;

    const summary = await Promise.all(
      therapists.rows.map(async (t) => {
        let billing;

        if (isPastMonth(year, month)) {
          // חודש עבר — snapshot
          let snapshot = await getSnapshot(t.id, year, month);
          if (!snapshot) snapshot = await createSnapshot(t.id, year, month);
          billing = invoiceToBilling(snapshot);
        } else {
          // חודש נוכחי — חישוב חי
          const [sessionsRes, slotsRes] = await Promise.all([
            pool.query(
              `SELECT start_time, end_time,
                      EXTRACT(EPOCH FROM (end_time - start_time)) / 3600 AS hours
               FROM sessions
               WHERE therapist_id = $1
                 AND EXTRACT(YEAR FROM start_time AT TIME ZONE 'Asia/Jerusalem') = $2
                 AND EXTRACT(MONTH FROM start_time AT TIME ZONE 'Asia/Jerusalem') = $3
                 AND status IN ('confirmed', 'cancelled_charged')
                 AND cancellation_waived = false`,
              [t.id, year, month]
            ),
            pool.query(
              'SELECT day_of_week, start_time, end_time FROM therapist_slots WHERE therapist_id = $1 AND active = true',
              [t.id]
            ),
          ]);
          billing = calculateBilling(sessionsRes.rows, slotsRes.rows, t.slot_rate, tiers);
          await ensureMonthlyDiscount(t.id, year, month, t.monthly_discount);
        }

        // זיכויים — תמיד חיים (גם לחודשים נעולים)
        const adjRes = await pool.query(
          'SELECT type, value FROM billing_adjustments WHERE therapist_id = $1 AND year = $2 AND month = $3',
          [t.id, year, month]
        );
        const adjs = adjRes.rows;
        const creditHours = adjs.filter(a => a.type === 'credit_hours').reduce((s, a) => s + parseFloat(a.value), 0);
        const discountAmount = adjs.filter(a => ['discount_amount', 'monthly_discount'].includes(a.type)).reduce((s, a) => s + parseFloat(a.value), 0);
        const totalAmount = round2(Math.max(0, billing.totalAmount - creditHours * (billing.extraRatePerHour || billing.ratePerHour) - discountAmount));

        return { id: t.id, name: t.name, email: t.email, ...billing, totalAmount, creditHours, discountAmount };
      })
    );

    res.json({ year: parseInt(year), month: parseInt(month), therapists: summary });
  } catch (err) {
    console.error('billing summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/:therapistId/:year/:month
router.get('/:therapistId/:year/:month', isAdminOrTherapist, async (req, res) => {
  const { therapistId, year, month } = req.params;

  if (!/^\d+$/.test(therapistId)) {
    return res.status(400).json({ error: 'therapistId לא תקין' });
  }
  if (req.user.role === 'therapist' && req.user.id !== parseInt(therapistId)) {
    return res.status(403).json({ error: 'אין הרשאה' });
  }

  try {
    const [therapistResult, tiers] = await Promise.all([
      pool.query('SELECT name, email, slot_rate, monthly_discount FROM therapists WHERE id = $1', [therapistId]),
      fetchTiers(),
    ]);
    if (!therapistResult.rows[0]) return res.status(404).json({ error: 'מטפל לא נמצא' });

    // שלוף sessions תמיד (לצורך תצוגת רשימת הפגישות)
    const [sessionsRes, slotsRes] = await Promise.all([
      pool.query(
        `SELECT id, start_time, end_time, status,
                EXTRACT(EPOCH FROM (end_time - start_time)) / 3600 AS hours
         FROM sessions
         WHERE therapist_id = $1
           AND EXTRACT(YEAR FROM start_time AT TIME ZONE 'Asia/Jerusalem') = $2
           AND EXTRACT(MONTH FROM start_time AT TIME ZONE 'Asia/Jerusalem') = $3
           AND status IN ('confirmed', 'cancelled_charged')
           AND cancellation_waived = false
         ORDER BY start_time`,
        [therapistId, year, month]
      ),
      pool.query(
        'SELECT id, day_of_week, start_time, end_time FROM therapist_slots WHERE therapist_id = $1 AND active = true ORDER BY day_of_week, start_time',
        [therapistId]
      ),
    ]);

    let billing;
    let frozenSlots = slotsRes.rows;

    if (isPastMonth(year, month)) {
      let snapshot = await getSnapshot(therapistId, year, month);
      if (!snapshot) snapshot = await createSnapshot(therapistId, year, month);
      billing = invoiceToBilling(snapshot);
    } else {
      const { slot_rate, monthly_discount } = therapistResult.rows[0];
      billing = calculateBilling(sessionsRes.rows, slotsRes.rows, slot_rate, tiers);
      await ensureMonthlyDiscount(therapistId, year, month, monthly_discount);
    }

    // סמן כל פגישה לפי חפיפה ל-slot
    const sessions = sessionsRes.rows.map(s => {
      if (frozenSlots.length === 0) return { ...s, inSlot: null };
      const sessionMins = (new Date(s.end_time) - new Date(s.start_time)) / 60000;
      const inSlotMins  = minutesInSlot(s, frozenSlots);
      const inSlot = inSlotMins === 0 ? false
        : inSlotMins >= sessionMins ? true
        : 'partial';
      return { ...s, inSlot };
    });

    res.json({
      therapist: therapistResult.rows[0],
      year: parseInt(year),
      month: parseInt(month),
      slots: frozenSlots,
      sessions,
      isSnapshot: isPastMonth(year, month),
      ...billing,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/billing/:therapistId/:year/:month/adjustments
router.get('/:therapistId/:year/:month/adjustments', isAdminOrTherapist, async (req, res) => {
  const { therapistId, year, month } = req.params;
  if (req.user.role === 'therapist' && req.user.id !== parseInt(therapistId)) {
    return res.status(403).json({ error: 'אין הרשאה' });
  }
  try {
    const result = await pool.query(
      'SELECT id, type, value, note, created_at FROM billing_adjustments WHERE therapist_id = $1 AND year = $2 AND month = $3 ORDER BY created_at',
      [therapistId, year, month]
    );
    res.json({ adjustments: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/:therapistId/:year/:month/adjustments
router.post('/:therapistId/:year/:month/adjustments', isAdmin, async (req, res) => {
  const { therapistId, year, month } = req.params;
  const { type, value, note } = req.body;
  if (!type || !value || value <= 0) {
    return res.status(400).json({ error: 'סוג וערך חיובי הם שדות חובה' });
  }
  if (!['credit_hours', 'discount_amount'].includes(type)) {
    return res.status(400).json({ error: 'סוג לא תקין' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO billing_adjustments (therapist_id, year, month, type, value, note)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, type, value, note, created_at`,
      [therapistId, year, month, type, value, note || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/billing/adjustments/:adjId
router.delete('/adjustments/:adjId', isAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM billing_adjustments WHERE id = $1', [req.params.adjId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/:therapistId/:year/:month/save
router.post('/:therapistId/:year/:month/save', isAdmin, async (req, res) => {
  const { therapistId, year, month } = req.params;
  try {
    const [sessionsRes, therapistRes, slotsRes, tiers] = await Promise.all([
      pool.query(
        `SELECT start_time, end_time, EXTRACT(EPOCH FROM (end_time - start_time)) / 3600 AS hours
         FROM sessions
         WHERE therapist_id = $1
           AND EXTRACT(YEAR FROM start_time AT TIME ZONE 'Asia/Jerusalem') = $2
           AND EXTRACT(MONTH FROM start_time AT TIME ZONE 'Asia/Jerusalem') = $3
           AND status IN ('confirmed', 'cancelled_charged')
           AND cancellation_waived = false`,
        [therapistId, year, month]
      ),
      pool.query('SELECT slot_rate FROM therapists WHERE id = $1', [therapistId]),
      pool.query('SELECT day_of_week, start_time, end_time FROM therapist_slots WHERE therapist_id = $1 AND active = true', [therapistId]),
      fetchTiers(),
    ]);

    const { slot_rate } = therapistRes.rows[0] || {};
    const billing = calculateBilling(sessionsRes.rows, slotsRes.rows, slot_rate, tiers);

    const result = await pool.query(
      `INSERT INTO invoices
         (therapist_id, year, month, total_hours, total_amount, rate_per_hour,
          has_slot, base_price, extra_hours, fixed_slot_hours, slot_rate_snapshot, extra_rate_per_hour)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (therapist_id, year, month)
       DO UPDATE SET
         total_hours = $4, total_amount = $5, rate_per_hour = $6,
         has_slot = $7, base_price = $8, extra_hours = $9,
         fixed_slot_hours = $10, slot_rate_snapshot = $11, extra_rate_per_hour = $12,
         generated_at = NOW()
       RETURNING *`,
      [therapistId, year, month,
       billing.totalHours, billing.totalAmount, billing.ratePerHour,
       billing.hasSlot, billing.basePrice, billing.extraHours, billing.fixedSlotHours,
       billing.slotRate, billing.extraRatePerHour || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;