import { errorMessage, logger } from '../lib/logger';
import { deleteUser } from '../lib/users';
import { deleteAccountData } from '../repo/account-data';

export interface AccountDeleteEvent {
  sub: string;
  username: string;
}

/**
 * Deletes an account's data, then its (already disabled) Cognito user. Invoked asynchronously by
 * the Admin page, so a large account isn't bound by the API's 29-second limit; Lambda retries a
 * failed attempt twice, and the user stays listed (disabled) until the whole deletion succeeds.
 */
export async function handler(event: AccountDeleteEvent): Promise<void> {
  try {
    const deleted = await deleteAccountData(event.sub);
    await deleteUser(event.username);
    logger.info('Deleted account', { sub: event.sub, ...deleted });
  } catch (err) {
    logger.error('Account deletion failed', { sub: event.sub, error: errorMessage(err) });
    throw err;
  }
}
