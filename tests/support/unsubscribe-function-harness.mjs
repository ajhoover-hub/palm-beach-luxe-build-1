import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import esbuild from "esbuild";

// Headers from @supabase/supabase-js 2.119.2 dist/cors.mjs (npm:@supabase/supabase-js@2/cors).
// The unpinned edge import resolves on the 2.x line; 2.119.2 is the current 2.x release.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": [
    "authorization",
    "x-client-info",
    "apikey",
    "content-type",
    "x-retry-count",
    "traceparent",
    "tracestate",
    "baggage",
  ].join(", "),
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const sourcePath = path.join(root, "supabase/functions/handle-email-unsubscribe/index.ts");

function compare(op, left, right) {
  if (op === "eq") return left === right;
  if (op === "neq") return left !== right;
  if (op === "is") return right === null ? left == null : left === right;
  if (op === "lt") return left < right;
  if (op === "lte") return left <= right;
  if (op === "gt") return left > right;
  if (op === "gte") return left >= right;
  throw new Error(`unsupported filter ${op}`);
}

function matches(row, filters) {
  return filters.every((filter) => compare(filter.op, row[filter.col], filter.value));
}

/**
 * In-memory stand-in for the PostgREST calls this function makes.
 * select/update/upsert apply every filter the function passes, including a
 * later expiry filter on created_at.
 */
export function createMemorySupabase(state) {
  return {
    from(table) {
      return new Query(state, table);
    },
  };
}

class Query {
  constructor(state, table) {
    this.state = state;
    this.table = table;
    this.filters = [];
    this.action = "select";
    this.patch = null;
    this.upsertRow = null;
    this.onConflict = null;
    this.finished = false;
  }

  select() {
    return this;
  }

  eq(col, value) {
    this.filters.push({ op: "eq", col, value });
    return this;
  }

  neq(col, value) {
    this.filters.push({ op: "neq", col, value });
    return this;
  }

  is(col, value) {
    this.filters.push({ op: "is", col, value });
    return this;
  }

  lt(col, value) {
    this.filters.push({ op: "lt", col, value });
    return this;
  }

  lte(col, value) {
    this.filters.push({ op: "lte", col, value });
    return this;
  }

  gt(col, value) {
    this.filters.push({ op: "gt", col, value });
    return this;
  }

  gte(col, value) {
    this.filters.push({ op: "gte", col, value });
    return this;
  }

  filter(col, op, value) {
    this.filters.push({ op, col, value });
    return this;
  }

  update(patch) {
    this.action = "update";
    this.patch = patch;
    return this;
  }

  insert(row) {
    this.action = "insert";
    this.upsertRow = row;
    return this;
  }

  upsert(row, options = {}) {
    this.action = "upsert";
    this.upsertRow = row;
    this.onConflict = options.onConflict ?? null;
    return this.finish();
  }

  maybeSingle() {
    return this.finish();
  }

  single() {
    return this.finish();
  }

  then(resolve, reject) {
    return this.finish().then(resolve, reject);
  }

  finish() {
    if (this.finished) {
      return Promise.resolve({ data: null, error: { message: "query already executed" } });
    }
    this.finished = true;
    const rows = this.state[this.table] ?? (this.state[this.table] = []);

    if (this.action === "upsert" || this.action === "insert") {
      const row = { ...this.upsertRow };
      const key = this.onConflict;
      const existing = key ? rows.find((item) => item[key] === row[key]) : null;
      if (existing) Object.assign(existing, row);
      else rows.push(row);
      return Promise.resolve({ data: null, error: null });
    }

    const matched = rows.filter((row) => matches(row, this.filters));
    if (this.action === "update") {
      for (const row of matched) Object.assign(row, this.patch);
    }
    if (matched.length > 1) {
      return Promise.resolve({
        data: null,
        error: { message: "multiple rows returned" },
      });
    }
    return Promise.resolve({
      data: matched[0] ? { ...matched[0] } : null,
      error: null,
    });
  }
}

let handlerPromise;

export function loadUnsubscribeHandler() {
  if (!handlerPromise) handlerPromise = loadOnce();
  return handlerPromise;
}

async function loadOnce() {
  const source = readFileSync(sourcePath, "utf8")
    .replace(
      "import { createClient } from 'npm:@supabase/supabase-js@2'",
      "function createClient(...args) { return globalThis.__unsubscribeCreateClient(...args); }",
    )
    .replace(
      "import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors'",
      "const corsHeaders = globalThis.__unsubscribeCorsHeaders;",
    );
  const transformed = esbuild.transformSync(source, {
    loader: "ts",
    format: "esm",
  });
  const outfile = path.join(tmpdir(), `handle-email-unsubscribe-${process.pid}.mjs`);
  writeFileSync(outfile, transformed.code);
  const env = {
    SUPABASE_URL: "http://127.0.0.1",
    SUPABASE_SERVICE_ROLE_KEY: "SERVICE_ROLE_PLACEHOLDER",
  };
  let handler;
  globalThis.__unsubscribeCorsHeaders = corsHeaders;
  globalThis.Deno = {
    serve(fn) {
      handler = fn;
    },
    env: {
      get(name) {
        return env[name];
      },
    },
  };
  await import(pathToFileURL(outfile).href);
  if (!handler) throw new Error("handle-email-unsubscribe did not register a server");
  return handler;
}

export function installClient(state) {
  globalThis.__unsubscribeCreateClient = () => createMemorySupabase(state);
}

export const MAX_UNUSED_TOKEN_AGE_MS = 30 * 24 * 60 * 60 * 1000;
