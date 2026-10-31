import { DomainError } from './types.ts';

/** Transport errors can contain credentialized RPC URLs and signed payloads.
 * Only messages constructed at our own validated boundary may cross the API. */
export function publicErrorMessage(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  return 'The request did not complete reliably. Check the connection and configuration, then reconcile the existing instruction before retrying.';
}
