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
  /**
   * The build the session asked for and where its install is. Null when no
   * build was asked for; absent from APIs older than this field.
   */
  install?: {
    binary_upload_id: string;
    error: null | string;
    status: 'failed' | 'installed' | 'installing';
  } | null;
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

/** One flow of a run, as newer APIs report it in `result.flows`. */
export interface DeviceFlowResult {
  error: null | string;
  /** The flow's path inside the bundle; null for a single flow. */
  file: null | string;
  success: boolean;
}

/** The result of a typed action, a launch or a run. */
export interface DeviceCommandResult {
  error?: string;
  /** Each flow of a run. Absent from APIs older than this field. */
  flows?: DeviceFlowResult[];
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

/** A short-lived download link for one stored artifact. */
export interface DeviceArtifactLink {
  bytes: null | number;
  content_type: string;
  created_at: string;
  /** Null when the file could not be signed (e.g. already cleaned up). */
  url: null | string;
}

/** GET .../artifacts: one page, newest actions first. */
export interface DeviceArtifactsPage {
  actions: {
    command_id: null | string;
    created_at: string;
    hierarchy: DeviceArtifactLink | null;
    screenshot: DeviceArtifactLink | null;
  }[];
  logs: DeviceArtifactLink | null;
  /** Pass as `before` for the next (older) page; null on the last page. */
  next_before: null | string;
  recording: DeviceArtifactLink | null;
  session: DeviceSession;
}

/** POST /device/bundles/upload-url: where to PUT the zip (both, when both are given). */
export interface DeviceBundleUploadUrls {
  id: string;
  mirror: { path: string; signedUrl: string } | null;
  upload: { path: string; signedUrl: string } | null;
}

/** A registered flow bundle. `run` takes its id as `flowUploadId`. */
export interface DeviceFlowBundle {
  bytes: number;
  created_at: string;
  encrypted: boolean;
  id: string;
  sha: string;
}
