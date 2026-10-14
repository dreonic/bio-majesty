import { createContext, useContext } from 'react';

/** What the shell needs from the signed-in session (real Cognito or mock mode). */
export interface Session {
  email: string | null;
  signOut: () => void;
  demo: boolean;
}

export const SessionContext = createContext<Session>({ email: null, signOut: () => undefined, demo: false });

export function useSession(): Session {
  return useContext(SessionContext);
}
