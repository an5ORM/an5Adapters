import type { AdapterTableClient, An5Adapter } from './an5Adapter';

// ─── Typed model access ──────────────────────────────────────────────────────
// The runtime adapter resolves `db.user` / `db.User` dynamically through a
// Proxy, which TypeScript normally types as `any` (An5Adapter declares
// `[key: string]: any`). These helpers let app code bind generated model
// delegate types (e.g. `UserTableClient` emitted by the schema generator) so
// `db.user` gets full autocomplete and compile-time argument checking — the
// standard ORM experience — without changing any runtime behavior.
//
// Usage:
//   import { createAn5Adapter } from '@an5/adapters';
//   import type { UserTableClient } from './generated/typescript/User';
//   import type { OrderTableClient } from './generated/typescript/Order';
//   const db = createAn5Adapter<{
//     user: UserTableClient;
//     order: OrderTableClient;
//   }>({ connectionString: process.env.DATABASE_URL! });
//   await db.user.findMany({ where: { email: { contains: '@example.com' } } });

// Public adapter surface (methods/getters) without the open-ended index
// signature, so explicit model props in TModels take effect instead of `any`.
type AdapterMethodKeys =
  | 'dialect'
  | 'exec'
  | '$queryRawUnsafe'
  | '$executeRaw'
  | '$executeRawUnsafe'
  | '$connect'
  | '$disconnect'
  | '$transaction'
  | '$begin'
  | 'table'
  | '$on'
  | '$off'
  | '$emit'
  | '$use'
  | 'view'
  | '$queryProc'
  | '$executeProc'
  | 'readRange'
  | 'writeRange'
  | 'appendRange'
  | 'listSheets'
  | 'deleteSheet';

export type AdapterAPI = Pick<An5Adapter, AdapterMethodKeys>;

// An5Adapter with dynamically-resolved model delegates typed as TModels.
// NOTE: keep AdapterMethodKeys in sync when adding public An5Adapter methods.
export type TypedAn5Adapter<TModels extends object = Record<string, AdapterTableClient<any>>> =
  AdapterAPI & TModels;
