require('dotenv').config();
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const helmet = require('helmet');
const passport = require('./src/config/passport');

const authRoutes = require('./src/routes/auth');
const therapistRoutes = require('./src/routes/therapists');
const sessionRoutes = require('./src/routes/sessions');
const billingRoutes = require('./src/routes/billing');
const calendarRoutes = require('./src/routes/calendar').router;
const settingsRoutes = require('./src/routes/settings');
const contractRoutes = require('./src/routes/contracts');

const pool = require('./src/config/db');

const app = express();
const PORT = process.env.PORT || 3000;

// migration: add is_calendar_primary if missing
pool.query('ALTER TABLE admins ADD COLUMN IF NOT EXISTS is_calendar_primary BOOLEAN NOT NULL DEFAULT false')
  .catch(e => console.error('migration error:', e.message));

// migration: billing_notes table
pool.query(`CREATE TABLE IF NOT EXISTS billing_notes (
  therapist_id INTEGER REFERENCES therapists(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (therapist_id, year, month)
)`).catch(e => console.error('migration error (billing_notes):', e.message));

// migration: billing_adjustments.rate (תעריף מותאם לזיכוי שעות)
pool.query('ALTER TABLE billing_adjustments ADD COLUMN IF NOT EXISTS rate DECIMAL(8,2)')
  .catch(e => console.error('migration error (billing_adjustments.rate):', e.message));

// migration: therapists.is_admin (החרגת מנהל מסיכום החיובים)
pool.query('ALTER TABLE therapists ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false')
  .catch(e => console.error('migration error (therapists.is_admin):', e.message));

// migration: therapist_slots.end_date (תאריך סיום אופציונלי לשעת ססיה)
pool.query('ALTER TABLE therapist_slots ADD COLUMN IF NOT EXISTS end_date DATE')
  .catch(e => console.error('migration error (therapist_slots.end_date):', e.message));

// migration: slot_contracts table (חוזים תקופתיים) + index
pool.query(`CREATE TABLE IF NOT EXISTS slot_contracts (
  id SERIAL PRIMARY KEY,
  therapist_id INTEGER REFERENCES therapists(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  duration_months INTEGER NOT NULL CHECK (duration_months IN (6, 12)),
  end_date DATE NOT NULL,
  slot_rate DECIMAL(10,2),
  auto_renew BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
)`)
  .then(() => pool.query('CREATE INDEX IF NOT EXISTS idx_slot_contracts_therapist ON slot_contracts(therapist_id)'))
  .catch(e => console.error('migration error (slot_contracts):', e.message));

app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'cdn.jsdelivr.net', "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", 'cdn.jsdelivr.net', "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({ origin: process.env.CLIENT_ORIGIN || `http://localhost:${PORT}`, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true, limit: '100kb' }));

// Rate limiter קל-משקל בזיכרון (ללא תלות חיצונית) — חלון נע לפי IP.
// מגן על OAuth ועל סינק גוגל מפני abuse ומניעת מיצוי מכסת ה-API של גוגל.
function rateLimit({ windowMs, max }) {
  const hits = new Map(); // ip -> { count, resetAt }
  // ניקוי תקופתי כדי שה-Map לא יגדל ללא גבול
  setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of hits) if (rec.resetAt <= now) hits.delete(ip);
  }, windowMs).unref?.();

  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    let rec = hits.get(ip);
    if (!rec || rec.resetAt <= now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(ip, rec);
    }
    rec.count++;
    if (rec.count > max) {
      res.set('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'יותר מדי בקשות — נסה שוב מאוחר יותר' });
    }
    next();
  };
}

// הגבלות: התחברות — 20 בקשות ל-15 דק'; סינק/דחיפה לגוגל — 10 ל-5 דק'.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const calendarLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 10 });

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    // 'none' נדרש רק כשה-frontend מוגש מ-origin שונה (CLIENT_ORIGIN מוגדר במפורש).
    // בפריסה same-origin (ברירת המחדל) נשתמש ב-'lax' שמספק הגנת CSRF מובנית של הדפדפן.
    sameSite: (process.env.NODE_ENV === 'production' && process.env.CLIENT_ORIGIN) ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// Static files
app.use(express.static(path.join(__dirname, 'src/public')));

// API Routes
app.use('/auth', authLimiter, authRoutes);
app.use('/api/therapists', therapistRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/calendar', calendarLimiter, calendarRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/contracts', contractRoutes);

// Page routes
app.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect(req.user.role === 'admin' ? '/admin' : '/therapist');
  }
  res.sendFile(path.join(__dirname, 'src/public/login.html'));
});

app.get(['/admin', '/admin/*path'], (req, res, next) => {
  if (!req.isAuthenticated() || req.user.role !== 'admin') return res.redirect('/login');
  next();
});

app.get(['/therapist', '/therapist/*path'], (req, res, next) => {
  if (!req.isAuthenticated() || req.user.role !== 'therapist') return res.redirect('/login');
  next();
});

app.get('/', (req, res) => {
  if (!req.isAuthenticated()) return res.redirect('/login');
  res.redirect(req.user.role === 'admin' ? '/admin' : '/therapist');
});

// Terminal error handler — תופס JSON לא תקין, גוף גדול מדי (413) וכל שגיאה אחרת
// שלא טופלה ב-route. מחזיר JSON עקבי במקום דף HTML ברירת-המחדל של Express.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[unhandled error]', err.message, err.stack);
  const message = err.type === 'entity.too.large'
    ? 'גוף הבקשה גדול מדי'
    : err.type === 'entity.parse.failed'
      ? 'JSON לא תקין'
      : status >= 500 ? 'שגיאת שרת' : err.message;
  res.status(status).json({ error: message });
});

app.listen(PORT, () => {
  console.log(`Clinic Manager running on http://localhost:${PORT}`);
});

// חידוש ססיות אוטומטי — בדיקה יומית בשעה 06:00
function scheduleContractRenewal() {
  const msUntil6am = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(6, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next - now;
  };
  const run = async () => {
    try {
      const due = await pool.query(
        'SELECT * FROM slot_contracts WHERE auto_renew = true AND end_date <= CURRENT_DATE'
      );
      for (const c of due.rows) {
        const newStart = await pool.query(
          "SELECT ($1::date + interval '1 day')::date AS d", [c.end_date]
        ).then(r => r.rows[0].d);
        const newEnd = await pool.query(
          "SELECT ($1::date + ($2 * interval '1 month'))::date AS d", [newStart, c.duration_months]
        ).then(r => r.rows[0].d);
        // idempotent: אל תיצור חוזה המשך אם כבר קיים אחד שמתחיל באותו תאריך
        // (מונע כפילות כשהתזמון רץ שוב אחרי restart או יחד עם /renew-due ידני)
        const ins = await pool.query(
          `INSERT INTO slot_contracts (therapist_id, start_date, duration_months, end_date, slot_rate, auto_renew, notes)
           SELECT $1,$2,$3,$4,$5,true,$6
           WHERE NOT EXISTS (
             SELECT 1 FROM slot_contracts
             WHERE therapist_id = $1 AND start_date = $2 AND duration_months = $3
           )`,
          [c.therapist_id, newStart, c.duration_months, newEnd, c.slot_rate, c.notes]
        );
        await pool.query('UPDATE slot_contracts SET auto_renew = false WHERE id = $1', [c.id]);
        if (ins.rowCount > 0) {
          console.log(`Contract renewed: therapist ${c.therapist_id}, new period ${newStart} - ${newEnd}`);
        }
      }
    } catch (e) {
      console.error('contract renewal error:', e.message);
    }
    setTimeout(run, 24 * 60 * 60 * 1000);
  };
  setTimeout(run, msUntil6am());
}
scheduleContractRenewal();
