// Hand-defined: the swagger spec has no /live routes, so openapi-typescript
// cannot generate these in schema.types.ts.

/** Summary returned when a live session is created. */
export interface LiveSessionSummary {
  id: number;
  platform: string;
  session_name: string;
  status: string;
}

/** One node of the device view hierarchy, as the live API exposes it. */
export interface LiveHierarchyElement {
  id: string;
  text?: string;
  accessibilityText?: string;
  resourceId?: string;
  resourceIdIndex?: number;
  textIndex?: number;
  bounds?: { x: number; y: number; width: number; height: number };
}

/** The device view hierarchy plus the frame it was captured against. */
export interface LiveHierarchy {
  elements: LiveHierarchyElement[];
  width: number;
  height: number;
  /** base64 PNG of the frame the hierarchy was captured against. */
  screenshot: string;
}

/** Where the device is in its boot/stream lifecycle. */
export interface LiveDeviceState {
  phase: string;
  /** Server-derived human label for `phase` — prefer this over mapping it. */
  phase_label?: string;
  last_seen_at?: string;
}

/**
 * Full live session record returned by `GET /live/:identifier`. The API returns
 * far more than the create summary — including the current screenshot, the view
 * hierarchy, and a `ready` flag — which the screenshot/hierarchy/--wait commands
 * read directly.
 */
export interface LiveSession extends LiveSessionSummary {
  binary_upload_id: null | string;
  created_at: string;
  device_state?: LiveDeviceState | null;
  /** Current device frame as a `data:image/png;base64,...` URL. */
  screenshot_data_url?: null | string;
  hierarchy?: LiveHierarchy | null;
  /** True when the session can accept exec requests (RUNNING + streaming). */
  ready?: boolean;
  /** Model the simulator actually cloned, e.g. "pixel-7-api-34". */
  device_model?: null | string;
  /** Locale requested for the session, e.g. "de_DE", or null for default. */
  device_locale?: null | string;
  seconds_until_auto_cancel?: null | number;
}

/** Result of executing Maestro YAML against a live session. */
export interface LiveExecResult {
  error?: string;
  output?: string;
  success: boolean;
  /** Async mode only: id of the queued command to poll, and its submit status. */
  commandId?: string;
  status?: string;
}

/** Status of a queued live command (async exec poll). */
export interface LiveCommandStatus {
  status: string;
  /** True once the command reached a terminal state (passed/failed/timeout). */
  done: boolean;
  success: boolean;
  output?: string;
  error?: string;
}
