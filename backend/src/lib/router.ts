import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { errorResponse, getUser, noContent, notFound, requireAccess, setRequestOrigin, type AuthUser } from './http';
import { logger } from './logger';

/** `user` is the signed-in account: handlers scope every read and write to `user.sub`. */
export type RouteHandler = (event: APIGatewayProxyEvent, user: AuthUser) => Promise<APIGatewayProxyResult>;

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
