import type { DcdEnvName } from '../../config/environments';

/**
 * Auth context threaded through gateways and services. Callers build this once
 * (via resolveAuth) and the gateway spreads .headers into every fetch.
 */
export interface AuthContext {
  headers: Record<string, string>;
  mode: 'apiKey' | 'bearer';
  /**
   * Supabase JWT — present when mode === 'bearer'. Lets realtime subscriptions
   * authenticate the socket (RLS) without re-reading the session from disk.
   */
  accessToken?: string;
  /** Environment the session belongs to — present when mode === 'bearer'. */
  env?: DcdEnvName;
  /** Present when mode === 'bearer'. */
  orgId?: string;
  /** Present when mode === 'bearer'. */
  userEmail?: string;
}
