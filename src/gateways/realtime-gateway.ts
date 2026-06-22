/**
 * Supabase Realtime subscription to test-result status changes.
 *
 * This is a *latency optimisation* layered on top of HTTP polling, not a
 * replacement for it. A logged-in (bearer) user's JWT authorises a
 * `postgres_changes` subscription on the `results` table (RLS scopes rows to
 * the user's org via `app_metadata.org_ids`). Each relevant change fires
 * `onChange`, which the polling loop uses to fetch immediately instead of
 * waiting out the full backstop interval.
 *
 * We deliberately only read the `new` row's `test_upload_id` — Postgres always
 * ships the full new tuple on INSERT/UPDATE regardless of REPLICA IDENTITY, so
 * no DB change is required. Mirrors the frontend pattern in
 * dcd/frontend/app/stores/Results.store.ts.
 */
import {
  createClient,
  REALTIME_SUBSCRIBE_STATES,
  type SupabaseClient,
} from '@supabase/supabase-js';

import { ENVIRONMENTS, type DcdEnvName } from '../config/environments';

export interface RealtimeResultsSubscription {
  /** Tear down the channel and close the socket. Best-effort, never throws. */
  unsubscribe(): Promise<void>;
}

export interface RealtimeSubscribeOptions {
  /** Supabase JWT (AuthContext.accessToken) — authorises the socket for RLS. */
  accessToken: string;
  debug?: boolean;
  env: DcdEnvName;
  /** Stderr-safe logger; stdout is reserved by some callers (MCP). */
  log?: (message: string) => void;
  /** Fired when a result row for this upload changes. */
  onChange: () => void;
  orgId: string;
  uploadId: string;
}

/**
 * The `new` record we care about from a `results` row change. Loosely typed —
 * we only ever read `test_upload_id`.
 */
interface ResultChangePayload {
  new?: { test_upload_id?: string } | null;
}

export class RealtimeResultsGateway {
  /**
   * Open a realtime subscription to `results` changes for the given upload.
   * Construction never throws — on any failure the caller simply keeps polling.
   */
  static subscribe(
    options: RealtimeSubscribeOptions,
  ): RealtimeResultsSubscription {
    const { accessToken, debug, env, log, onChange, orgId, uploadId } = options;
    const dbg = (message: string) => {
      if (debug && log) log(`[DEBUG] [realtime] ${message}`);
    };

    let client: SupabaseClient | undefined;
    try {
      const { url, anonKey } = ENVIRONMENTS[env].supabase;
      client = createClient(url, anonKey, {
        // Match SupabaseClientGateway / the frontend; no session persistence —
        // we set the token explicitly below.
        auth: { autoRefreshToken: false, persistSession: false },
        realtime: { params: { eventsPerSecond: 10 } },
      });

      // Attach the user's JWT to the socket so RLS is enforced on the channel.
      client.realtime.setAuth(accessToken);

      const channel = client
        .channel(`results-cli-${uploadId}`)
        .on(
          // The typings don't cover the postgres_changes overload cleanly.
          'postgres_changes' as never,
          {
            event: '*',
            schema: 'public',
            table: 'results',
            filter: `org_id=eq.${orgId}`,
          } as never,
          (payload: ResultChangePayload) => {
            if (payload.new?.test_upload_id === uploadId) {
              dbg(`change for upload ${uploadId}`);
              onChange();
            }
          },
        )
        .subscribe((status) => {
          if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
            dbg('subscribed');
          } else if (
            status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
            status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
            status === REALTIME_SUBSCRIBE_STATES.CLOSED
          ) {
            // Don't try to recover — the backstop poll covers us. Surface in
            // debug so a network-blocked websocket is diagnosable.
            dbg(`channel ${status}; relying on backstop poll`);
          }
        });

      const activeClient = client;
      return {
        async unsubscribe() {
          try {
            await activeClient.removeChannel(channel);
            await activeClient.realtime.disconnect();
          } catch {
            /* best effort — process is exiting anyway */
          }
        },
      };
    } catch (error) {
      dbg(`failed to subscribe: ${error instanceof Error ? error.message : String(error)}`);
      // Best-effort cleanup of a half-built client, then degrade to polling.
      try {
        client?.realtime.disconnect();
      } catch {
        /* ignore */
      }
      return { async unsubscribe() {} };
    }
  }
}
