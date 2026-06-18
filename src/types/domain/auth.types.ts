/**
 * Auth context threaded through gateways and services. Callers build this once
 * (via resolveAuth) and the gateway spreads .headers into every fetch.
 */
export interface AuthContext {
  headers: Record<string, string>;
  mode: 'apiKey' | 'bearer';
  /** Present when mode === 'bearer'. */
  orgId?: string;
  /** Present when mode === 'bearer'. */
  userEmail?: string;
}
