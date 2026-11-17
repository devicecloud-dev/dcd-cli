// Hand-defined: GET /org/settings is newer than the swagger spec the CLI
// generates schema.types.ts from. It mirrors OrgSettingsResponseDto in the
// API (dcd/api/src/apps/org-settings/dto/org-settings.dto.ts).

export type Platform = 'android' | 'ios';

export type SignInRequirement = 'off' | 'passkey' | 'passkey_and_code' | 'two_factor';

export interface TeamSettings {
  orgId: number;
  name: null | string;
  /**
   * True when the caller is a standard member: `signInRequirement`,
   * `retryEscalation` and `overage` are then null. Owners, admins and org API
   * keys see them.
   */
  restricted: boolean;
  concurrency: {
    /** Runner types with their own limit. A pooled runner type is listed under its pool. */
    runners: Array<{ max: number; min: number; platform: Platform; runnerType: string }>;
    /** Limits shared by several runner types. */
    pools: Array<{
      max: number;
      members: Array<{ platform: Platform; runnerType: string }>;
      min: number;
      name: string;
    }>;
  };
  testRuntime: {
    defaultMinutes: number;
    /** With the EXTENDED_RUNTIME override; null when extended runtime is off. */
    extendedMinutes: null | number;
  };
  integrations: { github: boolean; slack: boolean; webhook: boolean };
  signInRequirement: null | SignInRequirement;
  retryEscalation: {
    available: boolean;
    enabled: boolean;
    /** Runner type an Android test is retried on after an infrastructure failure. */
    target: 'gpu1' | 'm1' | null;
  } | null;
  overage: {
    hasSubscription: boolean;
    /** US dollars per billing period on top of included credits; null when uncapped. */
    limitUsd: null | number;
  } | null;
}
