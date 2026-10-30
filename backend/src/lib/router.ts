import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorResponse, getUser, noContent, notFound, requireAccess, setRequestOrigin, type AuthUser, type ProfileUser } from './http';
import { logger } from './logger';
import { resolveProfile } from './profile-access';

/** `user` is the signed-in account (account-level routes: its profiles, user management). */
export type RouteHandler = (event: APIGatewayProxyEvent, user: AuthUser) => Promise<APIGatewayProxyResult>;

/** `user.profileId` is one of the account's profiles: handlers scope every read and write to it. */
export type ProfileRouteHandler = (event: APIGatewayProxyEvent, user: ProfileUser) => Promise<APIGatewayProxyResult>;

/**
 * Minimal router for API Gateway REST proxy events. Routes are keyed by
 * `"METHOD /resource/{param}"`, matching `event.httpMethod` + `event.resource`.
 */
export function createRouter(routes: Record<string, RouteHandler>) {
  return async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const key = `${event.httpMethod} ${event.resource}`;
    setRequestOrigin(event);
    if (event.httpMethod === 'OPTIONS') return noContent();
    const handler = routes[key];
    try {
      requireAccess(event);
      if (!handler) throw notFound(`No route for ${key}`);
      return await handler(event, getUser(event));
    } catch (err) {
      logger.warn('Request failed', { route: key });
      return errorResponse(err);
    }
  };
}

/** A router whose routes work on the profile the request names (the X-Profile-Id header), if it is the caller's. */
export function createProfileRouter(routes: Record<string, ProfileRouteHandler>) {
  return createRouter(
    Object.fromEntries(Object.entries(routes).map(([key, handler]) => [key, async (event, user) => handler(event, await resolveProfile(event, user))])),
  );
}
