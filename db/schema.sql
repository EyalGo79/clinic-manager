-- Clinic Manager Schema

CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  google_id VARCHAR(255) UNIQUE,
  refresh_token TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS therapists (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  google_id VARCHAR(255) UNIQUE,
  phone VARCHAR(50),
  type VARCHAR(20) NOT NULL CHECK (type IN ('fixed', 'flexible')),
  calendar_name VARCHAR(255), -- שם כפי שמופיע בגוגל קאלנדר (לסינק)
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  therapist_id INTEGER REFERENCES therapists(id) ON DELETE SET NULL,
  start_time TIMESTAMP NOT NULL,
  end_time TIMESTAMP NOT NULL,
  google_event_id VARCHAR(255) UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'cancelled', 'cancelled_charged')),
  -- cancelled_charged = ביטול מחויב (פחות מ-24 שעות)
  cancelled_at TIMESTAMP,
  cancellation_waived BOOLEAN DEFAULT false, -- המנהל פטר מחיוב
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  therapist_id INTEGER REFERENCES therapists(id) ON DELETE SET NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  total_hours DECIMAL(6,2) NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  rate_per_hour DECIMAL(6,2) NOT NULL,
  has_slot BOOLEAN DEFAULT false,
  base_price DECIMAL(10,2) DEFAULT 0,
  extra_hours DECIMAL(6,2) DEFAULT 0,
  fixed_slot_hours DECIMAL(6,2) DEFAULT 0,
  slot_rate_snapshot DECIMAL(6,2),
  extra_rate_per_hour DECIMAL(6,2),
  generated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(therapist_id, year, month)
);

-- ססיות קבועות שבועיות לכל מטפל
CREATE TABLE IF NOT EXISTS therapist_slots (
  id SERIAL PRIMARY KEY,
  therapist_id INTEGER REFERENCES therapists(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=ראשון
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

-- עמודות נוספות על therapists
ALTER TABLE therapists ADD COLUMN IF NOT EXISTS slot_rate DECIMAL(6,2); -- מחיר לשעה לססיה קבועה

-- זיכויים והנחות חד פעמיות לחיוב חודשי
CREATE TABLE IF NOT EXISTS billing_adjustments (
  id SERIAL PRIMARY KEY,
  therapist_id INTEGER REFERENCES therapists(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('credit_hours', 'discount_amount', 'monthly_discount')),
  value DECIMAL(8,2) NOT NULL CHECK (value > 0),
  note TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- מדרגות חיוב
CREATE TABLE IF NOT EXISTS rate_tiers (
  id SERIAL PRIMARY KEY,
  max_hours DECIMAL(6,2),  -- NULL = ללא גבול עליון
  rate DECIMAL(6,2) NOT NULL,
  effective_from DATE DEFAULT CURRENT_DATE
);

-- עמודות נוספות על therapists
ALTER TABLE therapists ADD COLUMN IF NOT EXISTS monthly_discount DECIMAL(8,2);

-- אינדקסים
CREATE INDEX IF NOT EXISTS idx_sessions_therapist ON sessions(therapist_id);
CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_invoices_therapist ON invoices(therapist_id);
CREATE INDEX IF NOT EXISTS idx_slots_therapist ON therapist_slots(therapist_id);
CREATE INDEX IF NOT EXISTS idx_adjustments_therapist ON billing_adjustments(therapist_id, year, month);
