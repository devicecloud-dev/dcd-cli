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
  /** When a device was assigned (billing starts); null while queued. Absent from older APIs. */
  started_at?: null | string;
  /** When it ended; null while open. Absent from older APIs. */
  released_at?: null | string;
  /** When its maximum duration ends it; null while queued and once ended. Absent from older APIs. */
  expires_at?: null | string;
  queue: {
    eta_s: null | number;
    position: null | number;
    /**
     * Why it waits. org_concurrency_full: the org's tests and sessions hold
     * every slot it has; fleet_busy: the platform is at its fleet-wide cap;
     * waiting_for_device: waiting for a free device.
     */
    reason: 'fleet_busy' | 'org_concurrency_full' | 'waiting_for_device';
    /** Seconds since the session was created. Absent from older APIs. */
    waited_s?: null | number;
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
  /**
   * Who started the session, and how that stands to you. Absent from an API
   * that predates it.
   */
  started_by?: DeviceSessionStarter;
}

/** Who started a session. */
export interface DeviceSessionStarter {
  /** The name of the API key that started it, when one did: its label, never the key. */
  key_name: null | string;
  client_label: null | string;
  /** The person who started it, when a person did. */
  email: null | string;
  /** Started from this connection (the same `dcd mcp` process). */
  this_client: boolean;
  /** Started by you: this person, or this API key. */
  you: boolean;
}

/**
 * GET .../human and POST .../request-human (ILiveHumanStatus in the API):
 * whether the session waits for a person, and what they said on handing back.
 */
export interface DeviceHumanStatus {
  /** The session is in needs_human: wait, polling this. */
  waiting: boolean;
  /** Why help was asked for, while waiting. */
  reason: null | string;
  /** When help was asked for, while waiting. */
  since: null | string;
  /** When the session ends unless a person hands it back, while waiting. */
  expires_at: null | string;
  /** A person handed the session back since help was last asked for. */
  handed_back: boolean;
  /** Their note, if they left one. */
  note: null | string;
  handed_back_at: null | string;
  /** A person has taken control in the console; commands answer 409 meanwhile. */
  human_in_control: boolean;
  controller_user_id: null | string;
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

/**
 * Where a flow failed, as the device worked it out from the flow files.
 * Absent from older APIs, and when only a position is known.
 */
export interface DeviceFailureLocation {
  /** The runFlow lines that led there, outermost first, e.g. `main.yaml:4`. */
  call_chain: string[];
  /** The command as written, on one line; null when only a line is known. */
  command: null | string;
  /** The file, as a path inside the bundle; `flow.yaml` for a flow sent inline. */
  file: string;
  /** 1-based line in that file. */
  line: number;
}

/** Where a failure was: one place, or several that all fit the error. */
export interface DeviceFailedAt {
  failed_at?: DeviceFailureLocation;
  /** Two or more commands fit the error, and any of them may have failed. */
  failed_at_candidates?: DeviceFailureLocation[];
}

/** One flow of a run, as newer APIs report it in `result.flows`. */
export interface DeviceFlowResult extends DeviceFailedAt {
  error: null | string;
  /** The flow's path inside the bundle; null for a single flow. */
  file: null | string;
  success: boolean;
}

export type DeviceSwipeDirection = 'down' | 'left' | 'right' | 'up';
export interface DevicePoint {
  /** Percentages of the screen's width and height, 0 to 100. */
  x: number;
  y: number;
}

/**
 * One typed action for POST /device/sessions/:id/actions. `mode` is
 * deprecated: the API still accepts `'maestro'` and ignores it, and the CLI
 * no longer sends it.
 */
export type DeviceActionRequest =
  | {
      id?: string;
      mode?: 'maestro';
      text?: string;
      /** With `text` or `id`: seconds to wait for it to appear (0 to 60; 0 looks once). */
      timeoutSeconds?: number;
      type: 'tap';
      x?: number;
      y?: number;
    }
  | { key: string; mode?: 'maestro'; type: 'press_key' }
  | { mode?: 'maestro'; sensitive?: boolean; text: string; type: 'type' }
  | {
      direction?: DeviceSwipeDirection;
      from?: DevicePoint;
      mode?: 'maestro';
      to?: DevicePoint;
      type: 'swipe';
    }
  | { sensitive?: boolean; type: 'open_link'; url: string }
  | { latitude: number; longitude: number; type: 'set_location' };

/** The keys press_key takes, as the API names them. */
export const DEVICE_KEYS = [
  'back',
  'home',
  'enter',
  'backspace',
  'tab',
  'volume_up',
  'volume_down',
  'lock',
  'power',
] as const;

export const SWIPE_DIRECTIONS: readonly DeviceSwipeDirection[] = ['up', 'down', 'left', 'right'];

/** The result of a typed action, a launch or a run. */
export interface DeviceCommandResult extends DeviceFailedAt {
  error?: string;
  /** Each flow of a run. Absent from APIs older than this field. */
  flows?: DeviceFlowResult[];
  output?: string;
  /** A failed run: the app's visible text just after it failed. */
  screen_text?: string[];
  success: boolean;
}

/** One element of the compact screen (Maestro's key names). */
export interface DeviceScreenElement {
  /** Bounds, "[left,top][right,bottom]". */
  b: string;
  a11y?: string;
  checked?: true;
  /** False when disabled; absent when enabled. */
  enabled?: false;
  focused?: true;
  hint?: string;
  rid?: string;
  selected?: true;
  txt?: string;
}

/** GET .../inspect: the elements worth targeting, and what each key means. */
export interface DeviceScreen {
  elements: DeviceScreenElement[];
  /** False when no new frame came in time; this is then the latest. */
  fresh: boolean;
  height: number;
  /** Keyboard keys and System UI left out (only when some were); --all shows them. */
  hidden?: { keyboard: number; system: number };
  /** An on-screen keyboard is showing (Android). */
  keyboard_open?: true;
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

/** GET .../screenshot?full=true: a PNG at the device's own resolution, as a link. */
export interface DeviceFullScreenshot {
  bytes: null | number;
  captured_at: string;
  content_type: string;
  /** How long `url` works, in seconds. */
  expires_in_s: number;
  full: true;
  /** In the device's own pixels; null when the device could not say. */
  height: null | number;
  url: string;
  width: null | number;
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
  /** How many lines were looked through before the filters. Absent from older APIs. */
  scanned?: number;
  /** logcat, ios-unified-log, or none before an app is installed. */
  source: string;
  /** The answer's size cap (24 KB) dropped older lines. Absent when it did not. */
  truncated?: true;
}

/** The filters GET .../logs takes. */
export const LOG_LEVELS = ['warning', 'error'] as const;
export type DeviceLogLevel = (typeof LOG_LEVELS)[number];

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
  /**
   * Files the runner is still uploading after the session ended: the video
   * and the device log land up to a minute or so later. Absent from APIs
   * older than this field.
   */
  pending?: ('logs' | 'recording')[];
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
