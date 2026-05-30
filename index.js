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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// Static files
app.use(express.static(path.join(__dirname, 'src/public')));

// API Routes
app.use('/auth', authRoutes);
app.use('/api/therapists', therapistRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/calendar', calendarRoutes);
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
        await pool.query(
          `INSERT INTO slot_contracts (therapist_id, start_date, duration_months, end_date, slot_rate, auto_renew, notes)
           VALUES ($1,$2,$3,$4,$5,true,$6)`,
          [c.therapist_id, newStart, c.duration_months, newEnd, c.slot_rate, c.notes]
        );
        await pool.query('UPDATE slot_contracts SET auto_renew = false WHERE id = $1', [c.id]);
        console.log(`Contract renewed: therapist ${c.therapist_id}, new period ${newStart} - ${newEnd}`);
      }
    } catch (e) {
      console.error('contract renewal error:', e.message);
    }
    setTimeout(run, 24 * 60 * 60 * 1000);
  };
  setTimeout(run, msUntil6am());
}
scheduleContractRenewal();
