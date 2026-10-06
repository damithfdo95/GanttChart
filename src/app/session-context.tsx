import { createContext, useContext } from 'react';
import type { SessionEnd } from './sessionEnd';

export interface SessionApi {
  /** End the signed-in session in the UI (drops the principal, workspace and tenant state; the device's own data stays). */
  endSession: (end: SessionEnd) => void;
}

const SessionContext = createContext<SessionApi>({ endSession: () => undefined });

export const SessionProvider = SessionContext.Provider;

export function useSession(): SessionApi {
  return useContext(SessionContext);
}
