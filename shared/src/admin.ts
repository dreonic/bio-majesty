import { z } from 'zod';
import { IsoDateTime } from './common';

/** A user of the pool as the Admin page shows it. */
export const AdminUserSchema = z.object({
  /** Cognito username: a UUID for invited users, Google_<id> for Google sign-ins. */
  username: z.string(),
  /** Owner of the account's data (its partition). */
  sub: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  provider: z.enum(['email', 'google']),
  /** FORCE_CHANGE_PASSWORD = invited, has not signed in yet. */
  status: z.string(),
  enabled: z.boolean(),
  /** Member of the dashboard-users group. */
  access: z.boolean(),
  /** Member of the admins group. */
  admin: z.boolean(),
  createdAt: IsoDateTime,
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export interface AdminUsersResponse {
  users: AdminUser[];
  /** The signed-in admin's username (they can't remove, disable or delete themselves). */
  me: string;
}

export const InviteUserRequestSchema = z.object({ email: z.string().trim().toLowerCase().pipe(z.email().max(254)) });
export type InviteUserRequest = z.infer<typeof InviteUserRequestSchema>;

export const UpdateUserRequestSchema = z
  .object({ access: z.boolean(), admin: z.boolean(), enabled: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;
