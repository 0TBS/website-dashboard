// How many calls a request may make. Workers Free allows 50 outbound fetches
// ("subrequests") per request, and the one that goes over simply fails. A
// switch that dies half-way is worse than one that never starts, so every
// fetch a request makes (the Access keys, the Cloudflare API, the sites,
// public DNS) goes through one counted fetch, and the go-live code checks
// what is left before each step. Durable Object calls are not counted: they
// come out of a separate allowance of 1,000.
//
// Kept apart from worker.js so it can be tested under plain Node.

// 50 less a few, so a miscount is never the call that breaks a run.
export const LIMIT = 46;

export class BudgetError extends Error {
  constructor() {
    super('The desk has used its Cloudflare calls for this request.');
    this.name = 'BudgetError';
  }
}

// One per request. `used` goes up with every call a counted fetch makes.
export function budget(limit = LIMIT) {
  const b = { used: 0, limit, remaining: () => b.limit - b.used };
  return b;
}

// A fetch that counts against `allowance` (from budget()). The call that
// would go over the limit is refused before it is made, as a rejected promise
// like any failed fetch. A call that fails still counts: it went out. A
// followed redirect is another subrequest this cannot see, which is one more
// reason every caller fetches with redirect: 'manual'.
export function countedFetch(fetchImpl, allowance) {
  return async (input, init) => {
    if (allowance.used >= allowance.limit) throw new BudgetError();
    allowance.used += 1;
    return fetchImpl(input, init);
  };
}
