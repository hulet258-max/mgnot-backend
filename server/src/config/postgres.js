const crypto = require("crypto");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const { Pool } = require("pg");

const REQUIRED_DATABASE = "mgnot";
const MAINTENANCE_DATABASE = process.env.PGMAINTENANCE_DATABASE || "postgres";
const USE_DATABASE_URL = Boolean(process.env.DATABASE_URL && !process.env.PGPASSWORD);

function databaseUrlFor(source, database) {
  const parsed = new URL(source);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

function connectionConfigFor(database) {
  if (USE_DATABASE_URL) {
    return {
      connectionString: databaseUrlFor(process.env.DATABASE_URL, database),
    };
  }

  return {
    host: process.env.PGHOST || "localhost",
    port: Number(process.env.PGPORT || 5432),
    database,
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD,
  };
}

const configuredDatabase = USE_DATABASE_URL
  ? decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.replace(/^\/+/, ""))
  : process.env.PGDATABASE;
if (configuredDatabase && configuredDatabase !== REQUIRED_DATABASE) {
  console.warn(`[postgres] overriding configured database "${configuredDatabase}" with required database "${REQUIRED_DATABASE}".`);
}

const poolConfig = connectionConfigFor(REQUIRED_DATABASE);
const pool = new Pool(poolConfig);
let initPromise = null;

function getConnectionTarget() {
  if (poolConfig.connectionString) {
    return {
      mode: "DATABASE_URL",
      host: "from DATABASE_URL",
      port: "from DATABASE_URL",
      database: REQUIRED_DATABASE,
      user: "from DATABASE_URL",
      password: "from DATABASE_URL",
    };
  }

  return {
    mode: "PGHOST/PGPORT",
    host: poolConfig.host,
    port: poolConfig.port,
    database: poolConfig.database,
    user: poolConfig.user,
    password: poolConfig.password ? "set" : "missing",
  };
}

async function ensureRequiredDatabase() {
  const maintenancePool = new Pool(connectionConfigFor(MAINTENANCE_DATABASE));
  try {
    const existing = await maintenancePool.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [REQUIRED_DATABASE]
    );
    if (existing.rowCount) return;

    try {
      await maintenancePool.query(`CREATE DATABASE "${REQUIRED_DATABASE}"`);
      console.log(`[postgres] created database "${REQUIRED_DATABASE}".`);
    } catch (error) {
      // Multiple API/worker replicas may race during the first deployment.
      if (error.code !== "42P04") throw error;
    }
  } catch (error) {
    if (error.code === "42501") {
      throw new Error(
        `PostgreSQL database "${REQUIRED_DATABASE}" does not exist and the configured role cannot create it. Create it in the provider control panel, then restart the service.`
      );
    }
    throw error;
  } finally {
    await maintenancePool.end();
  }
}

function logPostgresFault(prefix, error) {
  console.error(`[postgres] ${prefix}`);
  console.error("[postgres] target:", getConnectionTarget());
  console.error("[postgres] fault:", {
    message: error.message,
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    address: error.address,
    port: error.port,
  });
}

pool.on("error", (error) => {
  logPostgresFault("idle client error", error);
});

async function verifyPostgresConnection() {
  const startedAt = Date.now();
  console.log("[postgres] connecting:", getConnectionTarget());

  try {
    const result = await pool.query(`
      SELECT
        current_database() AS database,
        current_user AS "user",
        inet_server_addr() AS host,
        inet_server_port() AS port,
        version() AS version
    `);
    const row = result.rows[0] || {};

    console.log("[postgres] connected:", {
      database: row.database,
      user: row.user,
      host: row.host || poolConfig.host || "DATABASE_URL",
      port: row.port || poolConfig.port || "DATABASE_URL",
      latencyMs: Date.now() - startedAt,
      version: row.version ? row.version.split(" ").slice(0, 2).join(" ") : "unknown",
    });
  } catch (error) {
    logPostgresFault("connection failed", error);
    throw error;
  }
}

const FieldValue = {
  serverTimestamp: () => ({ __op: "serverTimestamp" }),
  increment: (value) => ({ __op: "increment", value: Number(value || 0) }),
  arrayUnion: (...values) => ({ __op: "arrayUnion", values }),
  arrayRemove: (...values) => ({ __op: "arrayRemove", values }),
};

function isFieldValue(value) {
  return value && typeof value === "object" && typeof value.__op === "string";
}

function splitPath(path) {
  return String(path).split("/").filter(Boolean);
}

function collectionPathFromDocPath(path) {
  const parts = splitPath(path);
  return parts.slice(0, -1).join("/");
}

function docIdFromPath(path) {
  const parts = splitPath(path);
  return parts[parts.length - 1];
}

function getByPath(target, dottedPath) {
  return String(dottedPath)
    .split(".")
    .reduce((current, key) => (current && current[key] !== undefined ? current[key] : undefined), target);
}

function setByPath(target, dottedPath, value) {
  const keys = String(dottedPath).split(".");
  let current = target;
  keys.slice(0, -1).forEach((key) => {
    if (!current[key] || typeof current[key] !== "object" || Array.isArray(current[key])) {
      current[key] = {};
    }
    current = current[key];
  });
  current[keys[keys.length - 1]] = value;
}

function applyValue(currentValue, nextValue) {
  if (!isFieldValue(nextValue)) return nextValue;

  if (nextValue.__op === "serverTimestamp") {
    return new Date().toISOString();
  }

  if (nextValue.__op === "increment") {
    return Number(currentValue || 0) + nextValue.value;
  }

  if (nextValue.__op === "arrayUnion") {
    const current = Array.isArray(currentValue) ? currentValue : [];
    const serialized = new Set(current.map((item) => JSON.stringify(item)));
    const result = [...current];
    nextValue.values.forEach((item) => {
      const key = JSON.stringify(item);
      if (!serialized.has(key)) {
        serialized.add(key);
        result.push(item);
      }
    });
    return result;
  }

  if (nextValue.__op === "arrayRemove") {
    const removeSet = new Set(nextValue.values.map((item) => JSON.stringify(item)));
    return (Array.isArray(currentValue) ? currentValue : []).filter((item) => !removeSet.has(JSON.stringify(item)));
  }

  return nextValue;
}

function materializeData(input, existing = {}) {
  const output = { ...(existing || {}) };
  Object.entries(input || {}).forEach(([key, value]) => {
    const currentValue = getByPath(output, key);
    setByPath(output, key, applyValue(currentValue, value));
  });
  return output;
}

async function initPostgres() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    await ensureRequiredDatabase();
    await verifyPostgresConnection();
    console.log("[postgres] ensuring schema");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_documents (
        path TEXT PRIMARY KEY,
        collection_path TEXT NOT NULL,
        doc_id TEXT NOT NULL,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_app_documents_collection_path
        ON app_documents(collection_path);
    `);

    console.log("[postgres] schema ready");
  })();

  try {
    return await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}

class DocumentSnapshot {
  constructor(ref, row) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = Boolean(row);
    this._data = row?.data || null;
  }

  data() {
    return this._data ? { ...this._data } : undefined;
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
    this.size = docs.length;
  }
}

class DocumentReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = docIdFromPath(path);
  }

  collection(name) {
    return new CollectionReference(this.db, `${this.path}/${name}`);
  }

  async get(client, lock = false) {
    const executor = client || pool;
    const result = await executor.query(
      `SELECT data FROM app_documents WHERE path = $1${lock && client ? " FOR UPDATE" : ""}`,
      [this.path]
    );
    return new DocumentSnapshot(this, result.rows[0] || null);
  }

  async set(data, options = {}, client) {
    const executor = client || pool;
    const existingSnap = options.merge ? await this.get(executor) : null;
    const existing = existingSnap?.exists ? existingSnap.data() : {};
    const nextData = options.merge ? materializeData(data, existing) : materializeData(data, {});

    await executor.query(
      `
        INSERT INTO app_documents(path, collection_path, doc_id, data)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (path) DO UPDATE
        SET data = EXCLUDED.data, updated_at = NOW()
      `,
      [this.path, collectionPathFromDocPath(this.path), this.id, JSON.stringify(nextData)]
    );
  }

  async update(data, client) {
    const snap = await this.get(client);
    if (!snap.exists) {
      throw new Error(`Document not found: ${this.path}`);
    }
    await this.set(materializeData(data, snap.data()), {}, client);
  }
}

class Query {
  constructor(collectionRef, filters = []) {
    this.collectionRef = collectionRef;
    this.filters = filters;
  }

  where(field, operator, value) {
    return new Query(this.collectionRef, [...this.filters, { field, operator, value }]);
  }

  async get(client) {
    const snapshot = await this.collectionRef.get(client);
    const docs = snapshot.docs.filter((doc) => {
      const data = doc.data() || {};
      return this.filters.every(({ field, operator, value }) => {
        if (operator !== "==") {
          throw new Error(`Unsupported Postgres adapter query operator: ${operator}`);
        }
        return getByPath(data, field) === value;
      });
    });
    return new QuerySnapshot(docs);
  }
}

class CollectionReference {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.id = splitPath(path).slice(-1)[0];
  }

  doc(id) {
    return new DocumentReference(this.db, `${this.path}/${id}`);
  }

  async add(data) {
    const id = crypto.randomUUID();
    const ref = this.doc(id);
    await ref.set(data);
    return ref;
  }

  where(field, operator, value) {
    return new Query(this, [{ field, operator, value }]);
  }

  async get(client) {
    const executor = client || pool;
    const result = await executor.query(
      "SELECT path, data FROM app_documents WHERE collection_path = $1 ORDER BY created_at ASC",
      [this.path]
    );
    return new QuerySnapshot(
      result.rows.map((row) => new DocumentSnapshot(this.doc(docIdFromPath(row.path)), row))
    );
  }
}

class WriteBatch {
  constructor(db) {
    this.db = db;
    this.operations = [];
  }

  set(ref, data, options) {
    this.operations.push({ type: "set", ref, data, options });
  }

  update(ref, data) {
    this.operations.push({ type: "update", ref, data });
  }

  async commit() {
    return this.db.runTransaction(async (tx) => {
      for (const operation of this.operations) {
        if (operation.type === "set") {
          await tx.set(operation.ref, operation.data, operation.options);
        } else if (operation.type === "update") {
          await tx.update(operation.ref, operation.data);
        }
      }
    });
  }
}

const db = {
  FieldValue,
  REQUIRED_DATABASE,
  async init() {
    await initPostgres();
  },
  collection(name) {
    return new CollectionReference(this, String(name));
  },
  batch() {
    return new WriteBatch(this);
  },
  async runTransaction(callback) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tx = {
        get: (ref) => ref.get(client, true),
        set: (ref, data, options) => ref.set(data, options, client),
        update: (ref, data) => ref.update(data, client),
      };
      const result = await callback(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  },
  async listCollections() {
    const result = await pool.query("SELECT DISTINCT split_part(collection_path, '/', 1) AS id FROM app_documents");
    return result.rows.map((row) => ({ id: row.id }));
  },
  async query(text, params) {
    return pool.query(text, params);
  },
  async close() {
    await pool.end();
  },
};

module.exports = db;
module.exports._internals = {
  connectionConfigFor,
  databaseUrlFor,
};
