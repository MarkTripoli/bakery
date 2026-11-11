const isIdentifierChar = (char: string | undefined) =>
  char !== undefined && /[\p{L}\p{N}_$]/u.test(char);

/**
 * One left-to-right pass that blanks everything that is not SQL syntax:
 * `--` line comments, nested block comments, single-quoted strings (`''`
 * escapes), `E'...'` strings (backslash escapes), dollar-quoted strings
 * (`$$..$$`, `$tag$..$tag$`) and double-quoted identifiers. Doing it in one
 * pass matters: `select '--'; update ...` must not read as a comment, and a
 * quote inside a comment must not open a string. Unterminated tokens run to
 * the end of the text.
 */
export function stripSqlNoise(sql: string): string {
  let out = "";
  let at = 0;
  while (at < sql.length) {
    const char = sql[at];
    const next = sql[at + 1];
    if (char === "-" && next === "-") {
      const end = sql.indexOf("\n", at);
      out += " ";
      at = end === -1 ? sql.length : end;
    } else if (char === "/" && next === "*") {
      let depth = 1;
      at += 2;
      while (at < sql.length && depth > 0) {
        if (sql[at] === "/" && sql[at + 1] === "*") {
          depth++;
          at += 2;
        } else if (sql[at] === "*" && sql[at + 1] === "/") {
          depth--;
          at += 2;
        } else at++;
      }
      out += " ";
    } else if (char === "'") {
      const escaped = (out.at(-1) === "E" || out.at(-1) === "e") &&
        !isIdentifierChar(out.at(-2));
      at++;
      while (at < sql.length) {
        if (escaped && sql[at] === "\\") at += 2;
        else if (sql[at] === "'" && sql[at + 1] === "'") at += 2;
        else if (sql[at] === "'") {
          at++;
          break;
        } else at++;
      }
      out += "''";
    } else if (char === '"') {
      at++;
      while (at < sql.length) {
        if (sql[at] === '"' && sql[at + 1] === '"') at += 2;
        else if (sql[at] === '"') {
          at++;
          break;
        } else at++;
      }
      out += '""';
    } else if (char === "$" && !isIdentifierChar(sql[at - 1])) {
      // Tags may hold any letter, digit or underscore (a digit never first).
      // Adjacent dollar strings with no space swallow the rest: invalid SQL, left as is.
      const tag = /^\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/u.exec(sql.slice(at))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, at + tag.length);
        at = end === -1 ? sql.length : end + tag.length;
        out += "''";
      } else {
        out += char;
        at++;
      }
    } else {
      out += char;
      at++;
    }
  }
  return out;
}

const WRITE_WORDS =
  /\b(insert|update|delete|merge|truncate|copy|lock|setval|nextval|alter|drop|create|grant|revoke|vacuum|execute|notify|reindex|analy[sz]e|call|do|refresh\s+materialized\s+view|for\s+(?:no\s+key\s+|key\s+)?share|pg_(?:try_)?advisory\w*)\b|\bselect\b[^;]*?\binto\b/i;

/**
 * Statements that write, lock, advance a sequence or run code, wherever the
 * keyword sits (leading, inside a WITH ... CTE, an aliased UPDATE, a locking
 * clause such as `for key share`, `select ... into`, `call`/`do`, a
 * materialized-view refresh, or an advisory-lock function). Literals,
 * identifiers and comments are ignored, and `updated_at`-style identifiers do
 * not match (word boundaries).
 */
export function writeStatementsOf(statements: readonly string[]): string[] {
  return statements.filter((sql) => WRITE_WORDS.test(stripSqlNoise(sql)));
}
