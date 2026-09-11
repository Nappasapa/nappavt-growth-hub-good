// Splits a .sql migration file into individual statements. Handles:
//  - single-line comments (-- x, # x)
//  - block comments (/* ... */)
//  - quoted strings with ' " and ` (including escaped quotes '' and \')
// No DELIMITER/stored-procedure support — migrations are pure DDL/DML by rule.
export function splitStatements(sqlText) {
  const statements = [];
  let current = '';
  let i = 0;
  const n = sqlText.length;
  while (i < n) {
    const ch = sqlText[i];
    const next = i + 1 < n ? sqlText[i + 1] : '';

    // line comments
    if ((ch === '-' && next === '-') || (ch === '#')) {
      const end = sqlText.indexOf('\n', i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    // block comments
    if (ch === '/' && next === '*') {
      const end = sqlText.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    // quoted strings
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let body = ch;
      while (j < n) {
        const c = sqlText[j];
        body += c;
        if (c === '\\' && j + 1 < n) { body += sqlText[j + 1]; j += 2; continue; }
        if (c === quote) {
          if (quote === '\'' && sqlText[j + 1] === '\'') { body += '\''; j += 2; continue; } // '' escape
          j += 1;
          break;
        }
        j += 1;
      }
      current += body;
      i = j;
      continue;
    }
    if (ch === ';') {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}
