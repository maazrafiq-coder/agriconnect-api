#!/usr/bin/env node
/**
 * Builds a minimal @prisma/client shim so the project compiles and the
 * Jest suite (which always stub-overrides PrismaService) can run in this
 * sandbox — which has no network access to Prisma's engine-binary CDN.
 *
 * This does NOT talk to a database. It only:
 *   1. Parses `enum X { ... }` blocks out of prisma/schema.prisma and
 *      emits them as plain JS objects (matching Prisma's generated enum
 *      shape) so `import { BookingStatus } from '@prisma/client'` etc.
 *      works at both compile-time and runtime.
 *   2. Emits a `PrismaClient` class stub with $connect/$disconnect and a
 *      Proxy that returns a chainable no-op delegate for any model
 *      property access (`prisma.user.findMany(...)` etc.), so code that
 *      merely *references* the client (constructors, DI) doesn't throw.
 *      Every real DB interaction in tests goes through the
 *      PrismaService stub-override pattern instead — this class is never
 *      actually queried against a real database in this sandbox.
 *
 * Re-run this after any schema.prisma enum change.
 */
const fs = require('fs');
const path = require('path');

const schemaPath = path.join(__dirname, '..', 'prisma', 'schema.prisma');
const schema = fs.readFileSync(schemaPath, 'utf8');

const enumRegex = /enum\s+(\w+)\s*{([^}]*)}/g;
const enums = {};
let m;
while ((m = enumRegex.exec(schema))) {
  const name = m[1];
  const body = m[2];
  const values = body
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '').trim())
    .filter(Boolean);
  enums[name] = values;
}

console.log(`Parsed ${Object.keys(enums).length} enums:`, Object.keys(enums).join(', '));

const enumJsLines = Object.entries(enums).map(([name, values]) => {
  const body = values.map((v) => `  ${v}: '${v}'`).join(',\n');
  return `exports.${name} = Object.freeze({\n${body}\n});`;
});

const clientDir = path.join(__dirname, '..', 'node_modules', '.prisma', 'client');
fs.mkdirSync(clientDir, { recursive: true });

const indexJs = `'use strict';
// AUTO-GENERATED SHIM — see scripts/build-prisma-shim.js
// Enums-only; no real query engine. All real DB calls in tests go through
// the PrismaService stub-override pattern (see MIGRATION_NOTES_R2_M4.md /
// the Round 2 handoff brief for why this exists in this sandbox).

${enumJsLines.join('\n\n')}

function makeModelDelegate() {
  const noop = async () => {
    throw new Error(
      'Prisma shim: real database access is not available in this sandbox. ' +
      'This PrismaClient instance should never be queried directly here — ' +
      'override PrismaService with a stub in tests (see warehouse-booking-lifecycle.spec.ts).'
    );
  };
  return new Proxy(
    {},
    {
      get: () => noop,
    }
  );
}

class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop === 'string' && prop.startsWith('$')) return target[prop];
        return makeModelDelegate();
      },
    });
  }
  async $connect() {}
  async $disconnect() {}
  async $transaction(arg) {
    if (typeof arg === 'function') return arg(this);
    return Promise.all(arg);
  }
}

exports.PrismaClient = PrismaClient;
class PrismaClientKnownRequestError extends Error {
  constructor(message, opts) {
    super(message);
    this.code = opts && opts.code;
    this.meta = opts && opts.meta;
  }
}
class PrismaClientValidationError extends Error {}
exports.Prisma = { PrismaClientKnownRequestError, PrismaClientValidationError };
`;

const dtsBody = `${Object.keys(enums)
  .map((name) => `export type ${name} = string;\nexport const ${name}: Record<string, string>;`)
  .join('\n')}
export class PrismaClient {
  constructor(...args: any[]);
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction(arg: any): Promise<any>;
  [key: string]: any;
}
export namespace Prisma {
  class PrismaClientKnownRequestError extends Error { code: string; meta?: { target?: string[]; [key: string]: any }; }
  class PrismaClientValidationError extends Error {}
}
`;

fs.writeFileSync(path.join(clientDir, 'index.js'), indexJs);
fs.writeFileSync(path.join(clientDir, 'default.js'), `module.exports = require('./index.js');\n`);
fs.writeFileSync(path.join(clientDir, 'index.d.ts'), dtsBody);
fs.writeFileSync(path.join(clientDir, 'default.d.ts'), dtsBody);

console.log('Wrote shim to', clientDir);
