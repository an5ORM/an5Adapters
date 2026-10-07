// ─── SQLite vector search ──────────────────────────────────────────────────────────
//
// SQLite has no vector type, so `VECTOR(n)` columns are stored as a BLOB of
// little-endian float32 values (see `encodeVector`) and searched in one of four
// ways. The order is fixed so every runtime that speaks SQLite can implement it:
//
//   1. sqlite-vec   the extension, if it loads. Fastest, and the only option
//                   that can use an ANN index.
//   2. udf          `an5_vec_cosine` / `an5_vec_l2` / `an5_vec_ip` registered by
//                   the driver. Reads the BLOB and the legacy JSON text.
//   3. sql          `json_each` brute force in plain SQL. No UDF needed, so it
//                   works in browsers and on JDBC, but only for JSON text.
//   4. memory       the adapter loads the column and scores it in the client.
//
// Strategies 1-3 rank in the database and only transfer the `take` rows that
// match, which is the reason they are preferred over the in-memory path.

export type VectorMetric = 'cosine' | 'euclidean' | 'dot';
export type SqliteVectorStrategy = 'sqlite-vec' | 'udf' | 'sql' | 'memory';
export type VectorStrategyPreference = 'auto' | SqliteVectorStrategy;

/** Scalar functions shipped by the sqlite-vec extension. */
export const SQLITE_VEC_FUNCTIONS: Record<VectorMetric, string> = {
  cosine: 'vec_distance_cosine',
  euclidean: 'vec_distance_l2',
  dot: 'vec_distance_ip',
};

/** Scalar functions the adapter registers itself when the driver allows it. */
export const AN5_VECTOR_FUNCTIONS: Record<VectorMetric, string> = {
  cosine: 'an5_vec_cosine',
  euclidean: 'an5_vec_l2',
  dot: 'an5_vec_ip',
};

const BYTES_PER_FLOAT = 4;

function normalizeMetric(metric: unknown): VectorMetric {
  return metric === 'euclidean' || metric === 'dot' ? metric : 'cosine';
}

// ─── Codec ─────────────────────────────────────────────────────────────────────────

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return value;
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

/** Read a numeric array out of the shapes a driver can hand back. */
export function parseVector(value: unknown): number[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const out = new Array<number>(value.length);
    for (let i = 0; i < value.length; i++) {
      const n = Number(value[i]);
      if (!Number.isFinite(n)) return null;
      out[i] = n;
    }
    return out.length ? out : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('[')) return null;
    try {
      return parseVector(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Decode a stored vector: a float32 BLOB, a legacy JSON text column, or an
 * array the caller already decoded.
 */
export function decodeVector(value: unknown): number[] | null {
  const direct = parseVector(value);
  if (direct) return direct;

  const bytes = toBytes(value);
  if (!bytes || bytes.length === 0 || bytes.length % BYTES_PER_FLOAT !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Array<number>(bytes.length / BYTES_PER_FLOAT);
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * BYTES_PER_FLOAT, true);
  return out;
}

/** Encode a vector as the little-endian float32 BLOB `VECTOR(n)` columns store. */
export function encodeVector(values: readonly number[]): Buffer {
  const buf = Buffer.alloc(values.length * BYTES_PER_FLOAT);
  for (let i = 0; i < values.length; i++) buf.writeFloatLE(Number(values[i]) || 0, i * BYTES_PER_FLOAT);
  return buf;
}

/** True when the value still needs encoding on its way into a `VECTOR(n)` column. */
export function needsVectorEncoding(value: unknown): boolean {
  return Array.isArray(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

/** True when a generated metadata entry describes a `VECTOR(n)` column. */
export function isVectorField(def: unknown): boolean {
  if (!def) return false;
  if (typeof def === 'string') return def.includes('[]') || /^VECTOR\b/i.test(def.trim());
  const record = def as { ts?: string; sql?: string; type?: string; kind?: string };
  if (record.kind === 'vector') return true;
  const sql = String(record.sql ?? record.type ?? '');
  if (/^VECTOR\s*(\(|$)/i.test(sql.trim())) return true;
  return String(record.ts ?? '').includes('[]');
}

// ─── Distance ──────────────────────────────────────────────────────────────────────

/**
 * Distance between two equal-length vectors, lower is closer. Mirrors the
 * functions registered on the drivers so a search ranks the same way whichever
 * strategy ran.
 */
export function vectorDistance(a: readonly number[], b: readonly number[], metric: unknown): number | null {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    magA += av * av;
    magB += bv * bv;
  }
  const resolved = normalizeMetric(metric);
  if (resolved === 'euclidean') {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const diff = (Number(a[i]) || 0) - (Number(b[i]) || 0);
      sum += diff * diff;
    }
    return Math.sqrt(sum);
  }
  if (resolved === 'dot') return -dot;
  return magA && magB ? 1 - dot / (Math.sqrt(magA) * Math.sqrt(magB)) : 1;
}

// ─── Query builders ────────────────────────────────────────────────────────────────

/** `json_valid` fails on a float32 BLOB, so the JSON path needs this guard. */
function jsonText(column: string): string {
  return `CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END`;
}

function jsonDistanceExpr(metric: VectorMetric, column: string): string {
  const row = jsonText(column);
  const sameLength = `(SELECT COUNT(*) FROM json_each(${row})) = (SELECT COUNT(*) FROM q)`;
  const terms: Record<VectorMetric, string> = {
    cosine: `1.0 - (SELECT SUM(je.value * q.v) FROM json_each(${row}) je JOIN q ON q.k = je.key)`
      + ` / NULLIF(sqrt((SELECT SUM(q.v * q.v) FROM q)) * sqrt((SELECT SUM(je.value * je.value) FROM json_each(${row}) je)), 0)`,
    euclidean: `sqrt((SELECT SUM((je.value - q.v) * (je.value - q.v)) FROM json_each(${row}) je JOIN q ON q.k = je.key))`,
    dot: `-(SELECT SUM(je.value * q.v) FROM json_each(${row}) je JOIN q ON q.k = je.key)`,
  };
  return `CASE WHEN ${sameLength} THEN ${terms[metric]} END`;
}

export interface SqliteVectorQuery {
  sql: string;
  params: Record<string, any>;
}

interface BuildArgs {
  strategy: SqliteVectorStrategy;
  metric: VectorMetric;
  /** Already quoted, e.g. `[documents]`. */
  table: string;
  /** Already quoted column reference. */
  column: string;
  /** The query embedding. */
  vector: number[];
  take: number;
  /** A WHERE tail built by the caller, or empty. */
  tail?: string;
  /** Pre-bound WHERE parameters shared with the caller. */
  params: Record<string, any>;
}

/**
 * Ranking SQL for one strategy. `sqlite-vec` and `udf` bind the query vector as
 * a float32 BLOB; `sql` binds it as JSON text because `json_each` reads text.
 */
export function buildSqliteVectorQuery(args: BuildArgs): SqliteVectorQuery {
  const { strategy, metric, table, column, take } = args;
  const params = args.params;
  const tail = args.tail ?? '';
  const queryVector = args.vector as number[];
  // A row whose stored vector cannot be scored (a NULL, a text column, another
  // dimension) yields a NULL distance; those rows are dropped rather than
  // reported, so a caller never has to sort them out of the result.
  const rank = (inner: string) =>
    `SELECT * FROM (${inner}) AS an5_ranked WHERE distance IS NOT NULL ORDER BY distance ASC LIMIT ${take}`;

  if (strategy === 'sqlite-vec') {
    params.an5_vector = encodeVector(queryVector);
    params.an5_vector_bytes = queryVector.length * BYTES_PER_FLOAT;
    const fn = SQLITE_VEC_FUNCTIONS[metric];
    const distance = `${fn}(${column}, @an5_vector)`;
    // sqlite-vec only understands float32 BLOB operands, so the rows stored any
    // other way are excluded instead of aborting the query.
    return {
      sql: rank(`SELECT *, ${distance} AS distance FROM ${table}`
        + ` WHERE typeof(${column}) = 'blob' AND length(${column}) = @an5_vector_bytes${tail}`),
      params,
    };
  }

  if (strategy === 'udf') {
    params.an5_vector = encodeVector(queryVector);
    const distance = `${AN5_VECTOR_FUNCTIONS[metric]}(${column}, @an5_vector)`;
    return { sql: rank(`SELECT *, ${distance} AS distance FROM ${table}${tail}`), params };
  }

  params.an5_vector_json = JSON.stringify(queryVector);
  const distance = jsonDistanceExpr(metric, column);
  return {
    sql: 'WITH q AS (SELECT je.key AS k, CAST(je.value AS REAL) AS v FROM json_each(@an5_vector_json) je) '
      + rank(`SELECT *, ${distance} AS distance FROM ${table}${tail}`),
    params,
  };
}

// ─── Capabilities ──────────────────────────────────────────────────────────────────

export interface SqliteVectorCapabilities {
  /** `vec_version()` answered, so the sqlite-vec extension is loaded. */
  vec: boolean;
  /** The adapter's own distance functions are registered with the driver. */
  udf: boolean;
  /** `json_each()` is available, which the pure-SQL strategy needs. */
  json1: boolean;
}

export interface SqliteVectorOptions {
  /** Path to the sqlite-vec extension binary to load before probing. */
  sqliteVec?: string | undefined;
  /** Pin a strategy instead of probing for the fastest one available. */
  vectorStrategy?: VectorStrategyPreference | undefined;
}

/**
 * A driver hook the engine can supply to register the distance functions and
 * load the sqlite-vec extension. Every field is optional: a driver that offers
 * nothing simply reports no capabilities and the search falls back.
 */
/**
 * Registers a scalar function with the driver. Implementations that take a
 * determinism flag (better-sqlite3) supply it themselves.
 */
export type SqliteVectorFunctionRegistrar = (
  name: string,
  fn: (...args: any[]) => any,
) => void;

export interface SqliteVectorHooks {
  /** Raw driver handle, used for `loadExtension`. */
  native?: () => any;
  /** Register `name` with the driver's scalar-function API. */
  registerFunction?: SqliteVectorFunctionRegistrar;
}

function probed<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

/**
 * Resolve the ordered list of strategies to try for this connection.
 *
 * `declaredType` is the column's DDL type: the JSON strategy only reaches rows
 * stored as text, so a `BLOB` column drops it from the order.
 */
export function planSqliteVectorStrategies(
  caps: SqliteVectorCapabilities,
  declaredType: string | null,
  preference?: VectorStrategyPreference,
): SqliteVectorStrategy[] {
  const wanted = preference && preference !== 'auto' ? [preference] : [];
  const available: SqliteVectorStrategy[] = [];
  if (caps.vec) available.push('sqlite-vec');
  if (caps.udf) available.push('udf');
  if (caps.json1) available.push('sql');
  if (wanted.length > 0) return wanted.filter((s) => s !== 'memory');
  const plan = available;
  // A BLOB column has no JSON to read, so `json_each` can only produce NULLs.
  const type = String(declaredType ?? '').toUpperCase();
  if (type && !/TEXT|CHAR|CLOB|STRING|JSON/.test(type)) {
    return plan.filter((s) => s !== 'sql');
  }
  return plan;
}

/**
 * Register `an5_vec_*` on a driver and load sqlite-vec when a path is configured.
 * Safe to call repeatedly; each driver hook is used at most once.
 */
export class SqliteVectorSupport {
  private caps: SqliteVectorCapabilities | null = null;

  constructor(
    private readonly hooks: SqliteVectorHooks,
    private readonly options: SqliteVectorOptions = {},
  ) {}

  async capabilities(): Promise<SqliteVectorCapabilities> {
    if (this.caps) return this.caps;
    const caps: SqliteVectorCapabilities = { vec: false, udf: false, json1: false };

    const native = probed(() => this.hooks.native?.());
    if (native) {
      if (this.options.sqliteVec) {
        probed(() => native.loadExtension(this.options.sqliteVec));
      }
      if (probed(() => native.prepare('SELECT vec_version()').get()) !== null) caps.vec = true;
    }

    const register = this.hooks.registerFunction;
    if (register) {
      // better-sqlite3 takes an options object where every other driver takes a
      // plain function, so both shapes are offered and the driver picks.
      const names = Object.values(AN5_VECTOR_FUNCTIONS);
      const impls = (Object.keys(AN5_VECTOR_FUNCTIONS) as VectorMetric[]).map((metric) => {
        const fn = (...args: any[]) => {
          const a = decodeVector(args[0]);
          const b = decodeVector(args[1]);
          return a && b ? vectorDistance(a, b, metric) : null;
        };
        return { name: AN5_VECTOR_FUNCTIONS[metric], fn };
      });
      let all = true;
      for (const { name, fn } of impls) {
        if (probed(() => register(name, fn)) === null) { all = false; break; }
      }
      // A driver that accepts the registration is trusted here; a query that
      // still fails falls through to the next strategy.
      caps.udf = all && names.length > 0;
    }

    this.caps = caps;
    return caps;
  }

  /** Confirms JSON1 and a usable sqlite-vec/UDF before a query is built for them. */
  async probe(exec: (sql: string, params?: Record<string, any>) => Promise<any[]>): Promise<SqliteVectorCapabilities> {
    const caps = await this.capabilities();
    if (!caps.json1) {
      try {
        await exec("SELECT json_valid('[1]') AS an5_json_ok");
        caps.json1 = true;
      } catch {
        caps.json1 = false;
      }
    }
    return caps;
  }
}

/** Reads a vector column's declared DDL type, or null when it cannot be found. */
export async function readSqliteColumnType(
  exec: (sql: string, params?: Record<string, any>) => Promise<any[]>,
  table: string,
  column: string,
): Promise<string | null> {
  const rows = await exec("SELECT type FROM pragma_table_info(@an5_table) WHERE name = @an5_column", {
    an5_table: table,
    an5_column: column,
  });
  const value = rows?.[0]?.type;
  return value ? String(value) : null;
}

export interface SqliteVectorSearchArgs {
  exec: (sql: string, params?: Record<string, any>) => Promise<any[]>;
  /** Absent when the engine cannot register functions or load extensions. */
  vectorSupport?: SqliteVectorSupport | null;
  /** Quoted table reference, e.g. `[documents]`. */
  table: string;
  /** Unquoted table name, for `pragma_table_info`. */
  rawTable: string;
  /** Quoted column reference. */
  column: string;
  /** Unquoted column name. */
  rawColumn: string;
  vector: number[];
  metric: VectorMetric;
  take: number;
  /** A WHERE tail (leading space included) or empty. */
  tail?: string | undefined;
  /** Parameter object shared with the caller's WHERE clause. */
  params: Record<string, any>;
  preference?: VectorStrategyPreference | undefined;
}

/**
 * Rank a SQLite table by distance inside the database, trying each available
 * strategy in order. Returns null when the connection offers none, so the
 * caller can fall back to scoring in memory.
 */
export async function runSqliteVectorSearch(
  args: SqliteVectorSearchArgs,
): Promise<{ rows: Record<string, any>[]; strategy: SqliteVectorStrategy } | null> {
  if (!Array.isArray(args.vector) || args.vector.length === 0) return null;

  const caps = args.vectorSupport
    ? await args.vectorSupport.probe(args.exec)
    : { vec: false, udf: false, json1: false };
  if (!args.vectorSupport) {
    try {
      await args.exec("SELECT json_valid('[1]') AS an5_json_ok");
      caps.json1 = true;
    } catch {
      caps.json1 = false;
    }
  }

  let declaredType: string | null = null;
  try {
    declaredType = await readSqliteColumnType(args.exec, args.rawTable, args.rawColumn);
  } catch {
    declaredType = null;
  }

  for (const strategy of planSqliteVectorStrategies(caps, declaredType, args.preference)) {
    const params: Record<string, any> = { ...args.params };
    const query = buildSqliteVectorQuery({
      strategy,
      metric: normalizeMetric(args.metric),
      table: args.table,
      column: args.column,
      vector: args.vector,
      take: args.take,
      tail: args.tail ?? '',
      params,
    });
    try {
      const rows = await args.exec(query.sql, params);
      return { rows: rows ?? [], strategy };
    } catch {
      // The driver advertised the capability but the query failed, e.g. an
      // extension that did not really load. The next strategy is cheaper than
      // reporting the failure, and memory is always available as a last resort.
    }
  }
  return null;
}
