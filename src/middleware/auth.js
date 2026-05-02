function isAuthenticated(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'לא מחובר' });
}

function isAdmin(req, res, next) {
  if (req.isAuthenticated() && req.user.role === 'admin') return next();
  res.status(403).json({ error: 'אין הרשאה' });
}

function isTherapist(req, res, next) {
  if (req.isAuthenticated() && req.user.role === 'therapist') return next();
  res.status(403).json({ error: 'אין הרשאה' });
}

function isAdminOrTherapist(req, res, next) {
  if (req.isAuthenticated() && (req.user.role === 'admin' || req.user.role === 'therapist'))
    return next();
  res.status(403).json({ error: 'אין הרשאה' });
}

module.exports = { isAuthenticated, isAdmin, isTherapist, isAdminOrTherapist };
