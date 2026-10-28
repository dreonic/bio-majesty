/**
 * Cognito group whose members may use the dashboard. Signing in is not enough (with Google
 * login, any Google account gets a Cognito user): an admin adds people to it on the Admin page.
 */
export const ACCESS_GROUP = 'dashboard-users';

/** Cognito group whose members also manage users (the Admin page). */
export const ADMIN_GROUP = 'admins';

/**
 * Groups from a `cognito:groups` claim: an array in the ID token, a string in API Gateway's
 * authorizer claims ("a", "a,b" or "[a b]").
 */
export function claimGroups(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (typeof claim !== 'string') return [];
  return claim
    .replace(/^\[|\]$/g, '')
    .split(/[,\s]+/)
    .filter(Boolean);
}

export function hasAccess(groupsClaim: unknown): boolean {
  return claimGroups(groupsClaim).includes(ACCESS_GROUP);
}

/** Admins manage users; they need dashboard access too. */
export function isAdmin(groupsClaim: unknown): boolean {
  const groups = claimGroups(groupsClaim);
  return groups.includes(ACCESS_GROUP) && groups.includes(ADMIN_GROUP);
}
