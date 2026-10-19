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

/** One element of the compact screen (Maestro's key names). */
export interface DeviceScreenElement {
  /** Bounds, "[left,top][right,bottom]". */
  b: string;
  a11y?: string;
  hint?: string;
  rid?: string;
  txt?: string;
}

/** GET .../inspect: the elements worth targeting, and what each key means. */
export interface DeviceScreen {
  elements: DeviceScreenElement[];
  /** False when no new frame came in time; this is then the latest. */
  fresh: boolean;
  height: number;
  keys: Record<string, string>;
  width: number;
}

/** GET .../screenshot. */
export interface DeviceScreenshot {
  captured_at: null | string;
  /** A JPEG data URL. */
  data_url: string;
  fresh: boolean;
}

/** POST .../run and GET .../commands/:id. */
export interface DeviceRunResponse {
  command_id: string;
  result: DeviceCommandResult | null;
  session: DeviceSession;
  /** `running` when the flow outlasted the API's wait: poll the command. */
  status: 'failed' | 'passed' | 'running';
}

/** GET .../logs. */
export interface DeviceLogs {
  app_id: null | string;
  lines: string[];
  /** logcat, ios-unified-log, or none before an app is installed. */
  source: string;
}
