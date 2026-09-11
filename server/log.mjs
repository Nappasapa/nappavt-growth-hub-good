// Tiny structured logger. NEVER log secrets: no passwords, session cookies,
// OAuth tokens, authorization headers or DB credentials.
const ts = () => new Date().toISOString();
const write = (level, msg, extra) => {
  const line = `[growth-hub] ${ts()} ${level} ${msg}`;
  if (extra === undefined) console.log(line);
  else console.log(line, extra);
};

export const log = {
  info: (msg, extra) => write('info ', msg, extra),
  warn: (msg, extra) => write('warn ', msg, extra),
  error: (msg, extra) => write('error', msg, extra),
};

export function maskEmail(email) {
  const [name, domain] = String(email || '').split('@');
  if (!domain) return '***';
  return `${(name || '').slice(0, 2)}***@${domain}`;
}

// Error reporter: full error stays server-side; response shapes stay generic.
export function describeError(err) {
  if (!err) return 'unknown';
  const code = err.code ? `${err.code}: ` : '';
  return code + (err.message || String(err)).slice(0, 400);
}
