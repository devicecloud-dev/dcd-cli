// Hand-defined: the swagger spec has no /live routes, so openapi-typescript
// cannot generate these in schema.types.ts.

/** Summary returned when a live session is created. */
export interface LiveSessionSummary {
  id: number;
  platform: string;
  session_name: string;
  status: string;
}

/** Full live session record returned by the status endpoint. */
export interface LiveSession extends LiveSessionSummary {
  binary_upload_id: null | string;
  created_at: string;
}

/** Result of executing Maestro YAML against a live session. */
export interface LiveExecResult {
  error?: string;
  output?: string;
  success: boolean;
}
