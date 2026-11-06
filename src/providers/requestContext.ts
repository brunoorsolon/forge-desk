import { AsyncLocalStorage } from 'node:async_hooks';

/** Distinguishes admitted units from ordinary reads in shared provider helpers.
 * Each unit gets its own lane so coalescing cannot transfer its pacing/priority.
 */
export const requestContext = new AsyncLocalStorage<object>();
