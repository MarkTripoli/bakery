export type BoundaryVerdict = { readonly behavior: string } | null;

type ForbiddenPattern = {
  readonly pattern: RegExp;
  readonly behavior: string;
};

export const forbiddenPatterns: readonly {
  pattern: RegExp;
  behavior: string;
}[] = [
  {
    pattern:
      /^(?:with\b[\s\S]*\b(?:insert|update|delete|merge)\b|insert|update|delete|merge|truncate|copy)\b/i,
    behavior: "changes data",
  },
  { pattern: /\bcheck\s*\(/i, behavior: "defines a CHECK constraint" },
  {
    pattern: /\bcreate\s+(?:or\s+replace\s+)?(?:function|procedure)\b/i,
    behavior: "defines a stored routine",
  },
  {
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+|event\s+)?trigger\b/i,
    behavior: "defines a trigger",
  },
  {
    pattern:
      /\bcreate\s+(?:or\s+replace\s+)?(?:(?:temp|temporary)\s+)?(?:recursive\s+)?(?:materialized\s+)?view\b/i,
    behavior: "defines a view",
  },
  {
    pattern: /\bcreate\s+(?:or\s+replace\s+)?rule\b/i,
    behavior: "defines a rule",
  },
  { pattern: /\bcreate\s+policy\b/i, behavior: "defines a policy" },
  {
    pattern: /\brow\s+level\s+security\b/i,
    behavior: "configures row-level security",
  },
  { pattern: /^do\b/i, behavior: "runs a procedural block" },
  {
    // select_with_parens is recursive in gram.y: `as ((select …))` is valid.
    pattern:
      /\bcreate\s+(?:(?:global\s+|local\s+)?(?:temporary|temp)\s+|unlogged\s+)?table\b[\s\S]*\bas\s*(?:\(\s*)*(?:select|with|table|values|execute)\b/i,
    behavior: "materializes query results",
  },
  {
    pattern: /^refresh\s+materialized\s+view\b/i,
    behavior: "refreshes a materialized view",
  },
  {
    // Parenthesised and CTE-led forms are ordinary ways to run a routine.
    pattern:
      /^(?:\(\s*)*(?:with|select|values|table|call|perform|execute|explain|fetch|declare|notify)\b/i,
    behavior: "executes a query or routine at migration time",
  },
  {
    // `set standard_conforming_strings = off` (session, role, or database
    // scope) would change how every later literal lexes, silently bypassing
    // this scanner. Migrations never need to change configuration.
    pattern:
      /^(?:set|reset)\b|^alter\s+(?:database|role|user|system)\b|\bstandard_conforming_strings\b/i,
    behavior: "changes session or cluster configuration",
  },
  {
    // Enabling, disabling, or re-scoping triggers and rules changes runtime
    // behaviour without defining anything new.
    pattern:
      /\b(?:enable|disable)\s+(?:(?:always|replica)\s+)?(?:trigger|rule)\b/i,
    behavior: "toggles a trigger or rule",
  },
] satisfies readonly ForbiddenPattern[];

export const migrationRoots = [
  "apps/server/src/platform/migrations",
  "apps/server/src/modules/auth/migrations",
  "apps/server/src/modules/work/migrations",
  "apps/server/src/modules/agents/migrations",
  "apps/server/src/modules/repository-rules/migrations",
  "apps/server/src/modules/integrations/migrations",
  "apps/server/src/modules/delivery/migrations",
] as const;

// PostgreSQL dollar-quote tags accept non-ASCII identifier characters
// (scan.l: dolq_start / dolq_cont include \200-\377).
const DOLLAR_QUOTE =
  /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

type TokenKind = "code" | "string" | "escape" | "ident" | "dollar" | "comment";

type Token = {
  readonly kind: TokenKind;
  readonly text: string;
};

function isIdentifierCharacter(character: string | undefined): boolean {
  if (character === undefined) return false;
  return /[A-Za-z0-9_$]/.test(character) ||
    character.charCodeAt(0) >= 0x80;
}

function dollarDelimiterAt(sql: string, index: number): string | null {
  if (sql[index] !== "$" || isIdentifierCharacter(sql[index - 1])) {
    return null;
  }
  return DOLLAR_QUOTE.exec(sql.slice(index))?.[0] ?? null;
}

// PostgreSQL joins adjacent quoted chunks separated by whitespace that
// contains a newline into ONE literal that keeps the first chunk's mode
// (scan.l: quotecontinue = {quote}{whitespace_with_newline}{quote}, where a
// `--` comment may appear before the newline and comments/whitespace after
// it). Returns the index of the continuing quote, or null.
function continuationQuoteAt(sql: string, index: number): number | null {
  let position = index;
  while (position < sql.length) {
    if (/[ \t\f\v]/.test(sql[position])) {
      position++;
    } else if (sql[position] === "-" && sql[position + 1] === "-") {
      while (
        position < sql.length && sql[position] !== "\n" &&
        sql[position] !== "\r"
      ) position++;
    } else {
      break;
    }
  }
  if (sql[position] !== "\n" && sql[position] !== "\r") return null;
  while (position < sql.length) {
    if (/[ \t\n\r\f\v]/.test(sql[position])) {
      position++;
    } else if (sql[position] === "-" && sql[position + 1] === "-") {
      while (
        position < sql.length && sql[position] !== "\n" &&
        sql[position] !== "\r"
      ) position++;
    } else {
      break;
    }
  }
  return sql[position] === "'" ? position : null;
}

// Scans a quoted literal body starting just after its opening quote; returns
// the index after the final closing quote. `escape` enables backslash escapes.
function scanQuotedLiteral(
  sql: string,
  index: number,
  escape: boolean,
): number {
  while (index < sql.length) {
    if (escape && sql[index] === "\\") {
      index += 2;
    } else if (sql[index] === "'") {
      if (sql[index + 1] === "'") {
        index += 2;
        continue;
      }
      index++;
      const continuation = continuationQuoteAt(sql, index);
      if (continuation === null) return index;
      index = continuation + 1;
    } else {
      index++;
    }
  }
  throw new Error(`unterminated ${escape ? "escape" : "string"} in SQL`);
}

function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let codeStart = 0;

  const flushCode = (end: number): void => {
    if (codeStart < end) {
      tokens.push({ kind: "code", text: sql.slice(codeStart, end) });
    }
  };

  while (index < sql.length) {
    if (
      (sql[index] === "E" || sql[index] === "e") &&
      sql[index + 1] === "'" &&
      !isIdentifierCharacter(sql[index - 1])
    ) {
      flushCode(index);
      const start = index;
      index = scanQuotedLiteral(sql, index + 2, true);
      tokens.push({ kind: "escape", text: sql.slice(start, index) });
      codeStart = index;
      continue;
    }

    if (sql[index] === "'") {
      flushCode(index);
      const start = index;
      index = scanQuotedLiteral(sql, index + 1, false);
      tokens.push({ kind: "string", text: sql.slice(start, index) });
      codeStart = index;
      continue;
    }

    if (sql[index] === '"') {
      flushCode(index);
      const start = index;
      index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') index += 2;
          else {
            index++;
            closed = true;
            break;
          }
        } else {
          index++;
        }
      }
      if (!closed) throw new Error("unterminated ident in SQL");
      tokens.push({ kind: "ident", text: sql.slice(start, index) });
      codeStart = index;
      continue;
    }

    if (sql[index] === "-" && sql[index + 1] === "-") {
      flushCode(index);
      const start = index;
      index += 2;
      // PostgreSQL ends a line comment at CR or LF (scan.l: newline).
      while (
        index < sql.length && sql[index] !== "\n" && sql[index] !== "\r"
      ) index++;
      tokens.push({ kind: "comment", text: sql.slice(start, index) });
      codeStart = index;
      continue;
    }

    if (sql[index] === "/" && sql[index + 1] === "*") {
      flushCode(index);
      const start = index;
      index += 2;
      let depth = 1;
      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth++;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth--;
          index += 2;
        } else {
          index++;
        }
      }
      if (depth !== 0) throw new Error("unterminated comment in SQL");
      tokens.push({ kind: "comment", text: sql.slice(start, index) });
      codeStart = index;
      continue;
    }

    const delimiter = sql[index] === "$" ? dollarDelimiterAt(sql, index) : null;
    if (delimiter !== null) {
      flushCode(index);
      const start = index;
      index += delimiter.length;
      let closed = false;
      while (index < sql.length) {
        if (sql.startsWith(delimiter, index)) {
          index += delimiter.length;
          closed = true;
          break;
        }
        index++;
      }
      if (!closed) throw new Error("unterminated dollar in SQL");
      tokens.push({ kind: "dollar", text: sql.slice(start, index) });
      codeStart = index;
      continue;
    }

    index++;
  }

  flushCode(sql.length);
  return tokens;
}

export function splitStatements(sql: string): readonly string[] {
  const statements: string[] = [];
  const current: string[] = [];

  const pushCurrent = (): void => {
    const statement = current.join("").trim();
    if (statement) statements.push(statement);
    current.length = 0;
  };

  for (const token of tokenize(sql)) {
    // PostgreSQL treats a comment as whitespace. Emitting a space keeps token
    // boundaries identical when the statement is tokenized again by
    // maskLiterals (`default/*c*/E'…'` must not become `defaultE'…'`).
    if (token.kind === "comment") {
      current.push(" ");
      continue;
    }
    if (token.kind !== "code") {
      current.push(token.text);
      continue;
    }

    let start = 0;
    for (let index = 0; index < token.text.length; index++) {
      if (token.text[index] !== ";") continue;
      if (start < index) current.push(token.text.slice(start, index));
      pushCurrent();
      start = index + 1;
    }
    if (start < token.text.length) current.push(token.text.slice(start));
  }
  pushCurrent();
  return statements;
}

export function maskLiterals(statement: string): string {
  try {
    return tokenize(statement).map((token) => {
      switch (token.kind) {
        case "string":
          return "''";
        case "escape":
          return "E''";
        case "comment":
          return "";
        default:
          return token.text;
      }
    }).join("");
  } catch {
    return statement;
  }
}

/**
 * Stored routines the boundary permits. Each is pinned whole: the exact
 * header (name, argument list, `security definer`, pinned `search_path` ending
 * in `pg_temp`) and the exact body, both compared after comments are removed
 * and whitespace and case are normalised. A new routine needs its own entry
 * here, reviewed with its migration; nothing is approved by name alone.
 */
const approvedRoutines: readonly { header: string; body: string }[] = [
  {
    header:
      "create function bakery.set_installation_license(new_key text, expected_version integer, updater uuid) returns integer language sql security definer set search_path = pg_catalog, bakery, pg_temp as",
    body:
      "update bakery.installation_settings set license_key = new_key, version = version + 1, updated_by_principal_id = updater, updated_at = clock_timestamp() where id = true and version = expected_version returning version",
  },
  {
    header:
      "create function bakery.purge_audit_events(p_organization_id uuid, p_before timestamptz, p_max_rows integer) returns integer language plpgsql security definer set search_path = pg_catalog, bakery, pg_temp as",
    body:
      "declare purged integer; begin if p_before > now() - interval '30 days' then return 0; end if; with doomed as (select audit.id from bakery.audit_events as audit where audit.organization_id = p_organization_id and audit.created_at < p_before and not exists (select 1 from bakery.budget_release_evidence as evidence where evidence.source_event_id = audit.id) order by audit.created_at, audit.id limit greatest(p_max_rows, 0) for update of audit skip locked) delete from bakery.audit_events as removed using doomed where removed.id = doomed.id; get diagnostics purged = row_count; return purged; end;",
  },
  {
    // The trusted authoritative-receipt writer. Definer-owned so the
    // runtime role keeps no direct insert; enforces a bound call intent,
    // authoritative cost and immutable receipts before storing.
    header:
      "create function bakery.record_provider_usage_receipt(p_organization_id uuid, p_provider_call_intent_id uuid, p_provider_call_id text, p_usage_fact_id text, p_input_tokens bigint, p_output_tokens bigint, p_cost_usd numeric, p_measurement text, p_occurred_at timestamptz, p_receipt_digest text) returns uuid language plpgsql security definer set search_path = '' as",
    body:
      "declare v_existing record; v_id uuid; begin if p_provider_call_id is null or length(p_provider_call_id) > 255 then raise exception 'provider_call_identity_invalid' using errcode = '22023'; end if; if p_measurement not in ('reported', 'estimated') then raise exception 'provider_receipt_measurement_invalid' using errcode = '22023'; end if; if p_cost_usd is null then raise exception 'provider_receipt_cost_missing' using errcode = '22023'; end if; if not exists (select 1 from bakery.provider_call_intents call where call.organization_id = p_organization_id and call.id = p_provider_call_intent_id and call.provider_call_id = p_provider_call_id and call.status = 'bound') then raise exception 'provider_call_unbound' using errcode = '23514'; end if; select id, receipt_digest into v_existing from bakery.provider_authoritative_receipts where provider_call_intent_id = p_provider_call_intent_id; if found then if v_existing.receipt_digest = p_receipt_digest then return v_existing.id; end if; raise exception 'provider_receipt_mismatch' using errcode = '23505'; end if; insert into bakery.provider_authoritative_receipts (id, organization_id, provider_call_intent_id, provider_call_id, usage_fact_id, input_tokens, output_tokens, cost_usd, measurement, occurred_at, receipt_digest, version) values (gen_random_uuid(), p_organization_id, p_provider_call_intent_id, p_provider_call_id, p_usage_fact_id, p_input_tokens, p_output_tokens, p_cost_usd, p_measurement, p_occurred_at, p_receipt_digest, 1) returning id into v_id; return v_id; end;",
  },
  {
    // The trusted authoritative-receipt writer. Definer-owned so the
    // runtime role keeps no direct insert; enforces a bound call intent,
    // authoritative cost and immutable receipts before storing.
    header:
      "create function bakery.record_provider_usage_receipt(p_organization_id uuid, p_provider_call_intent_id uuid, p_provider_call_id text, p_usage_fact_id text, p_input_tokens bigint, p_output_tokens bigint, p_cost_usd numeric, p_measurement text, p_occurred_at timestamptz, p_receipt_digest text) returns uuid language plpgsql security definer set search_path = pg_catalog, bakery, pg_temp as",
    body:
      "declare v_existing record; v_id uuid; begin if p_provider_call_id is null or length(p_provider_call_id) > 255 then raise exception 'provider_call_identity_invalid' using errcode = '22023'; end if; if p_measurement not in ('reported', 'estimated') then raise exception 'provider_receipt_measurement_invalid' using errcode = '22023'; end if; if p_cost_usd is null then raise exception 'provider_receipt_cost_missing' using errcode = '22023'; end if; if not exists (select 1 from bakery.provider_call_intents call where call.organization_id = p_organization_id and call.id = p_provider_call_intent_id and call.provider_call_id = p_provider_call_id and call.status = 'bound') then raise exception 'provider_call_unbound' using errcode = '23514'; end if; select id, receipt_digest into v_existing from bakery.provider_authoritative_receipts where provider_call_intent_id = p_provider_call_intent_id; if found then if v_existing.receipt_digest = p_receipt_digest then return v_existing.id; end if; raise exception 'provider_receipt_mismatch' using errcode = '23505'; end if; insert into bakery.provider_authoritative_receipts (id, organization_id, provider_call_intent_id, provider_call_id, usage_fact_id, input_tokens, output_tokens, cost_usd, measurement, occurred_at, receipt_digest, version) values (gen_random_uuid(), p_organization_id, p_provider_call_intent_id, p_provider_call_id, p_usage_fact_id, p_input_tokens, p_output_tokens, p_cost_usd, p_measurement, p_occurred_at, p_receipt_digest, 1) returning id into v_id; return v_id; end;",
  },
];

function normalizeSql(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")")
    .trim().toLowerCase();
}

function isApprovedRoutine(statement: string): boolean {
  let tokens: Token[];
  try {
    tokens = tokenize(statement);
  } catch {
    return false;
  }
  const bodyIndex = tokens.findIndex((token) => token.kind === "dollar");
  if (bodyIndex < 0) return false;
  const tail = tokens.slice(bodyIndex + 1);
  if (
    tail.some((token) => token.kind !== "comment" && token.text.trim() !== "")
  ) {
    return false;
  }
  const head = tokens.slice(0, bodyIndex);
  if (head.some((token) => !["code", "comment"].includes(token.kind))) {
    return false;
  }
  const header = normalizeSql(
    head.map((token) => token.kind === "comment" ? " " : token.text).join(""),
  );
  const bodyToken = tokens[bodyIndex].text;
  const delimiter = DOLLAR_QUOTE.exec(bodyToken)?.[0];
  if (!delimiter || !bodyToken.endsWith(delimiter)) return false;
  let inner: Token[];
  try {
    inner = tokenize(bodyToken.slice(delimiter.length, -delimiter.length));
  } catch {
    return false;
  }
  const body = normalizeSql(
    inner.map((token) => token.kind === "comment" ? " " : token.text).join(""),
  );
  return approvedRoutines.some((routine) =>
    routine.header === header && routine.body === body
  );
}

export function classifyStatement(statement: string): BoundaryVerdict {
  const masked = maskLiterals(statement);
  for (const { pattern, behavior } of forbiddenPatterns) {
    if (pattern.test(masked)) return { behavior };
  }
  return null;
}

export function assertStructuralMigration(path: string, sql: string): void {
  let statements: readonly string[];
  try {
    statements = splitStatements(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`POSTGRESQL_BOUNDARY_VIOLATION: ${path} ${message}`);
  }

  for (const statement of statements) {
    if (isApprovedRoutine(statement)) continue;
    const verdict = classifyStatement(statement);
    if (verdict !== null) {
      throw new Error(
        `POSTGRESQL_BOUNDARY_VIOLATION: ${path} ${verdict.behavior}`,
      );
    }
  }
}
