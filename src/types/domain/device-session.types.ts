// Hand-defined: the /device/sessions routes are not in the swagger spec the
// CLI generates schema.types.ts from. They mirror the API's own types in
// dcd/api/src/apps/live/live.types.ts and device-sessions.controller.ts.

export type DeviceSessionState =
  | 'active'
  | 'expired'
  | 'failed'
  | 'needs_human'
  | 'provisioning'
  | 'queued'
  | 'ready'
  | 'released';

/** States a session can no longer leave. */
export const ENDED_STATES: readonly DeviceSessionState[] = ['released', 'expired', 'failed'];

/**
 * The compact `session` block every /device/sessions response carries
 * (ILiveSessionSummary in the API). `id` is the session name, which every
 * `dcd device` command takes.
 */
export interface DeviceSession {
  id: string;
  live_id: number;
  state: DeviceSessionState;
  release_reason: null | string;
  platform: string;
  model: null | string;
  client_label: null | string;
  created_at: string;
  queue: {
    eta_s: null | number;
    position: null | number;
    reason: 'fleet_busy' | 'waiting_for_device';
  } | null;
  time_remaining_s: null | number;
  idle_remaining_s: null | number;
  cost_so_far_usd: null | number;
  last_crash: { at: string; summary: string } | null;
  warnings: string[];
  monitor_url: string;
}

/** POST /device/sessions. */
export interface StartDeviceSessionRequest {
  platform: 'android' | 'ios';
  binaryUploadId?: string;
  model?: string;
  os?: string;
  googlePlay?: boolean;
  deviceLocale?: string;
  clientLabel?: string;
  maxDurationMin?: number;
  record?: boolean;
}

/** One entry of GET /device/models. */
export interface DeviceModel {
  model: string;
  name: string;
  os: string[];
  default_os: string;
  google_play: boolean;
  default: boolean;
}

export interface DeviceCatalogue {
  android: DeviceModel[];
  ios: DeviceModel[];
}

/** What POST .../install answers with beside the session. */
export interface DeviceInstalledApp {
  app_id: null | string;
  binary_upload_id: string;
  reused: boolean;
}

/** The result of a typed action or a launch. */
export interface DeviceCommandResult {
  error?: string;
  output?: string;
  success: boolean;
}
