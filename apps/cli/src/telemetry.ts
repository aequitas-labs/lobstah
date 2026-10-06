import {
  TELEMETRY_NOTICE,
  buildTelemetryPayload,
  disableTelemetry,
  enableTelemetry,
  ensureTelemetryState,
  serializeTelemetryPayload,
  telemetryStatus,
  toonKV,
} from '@lobstah/core';
import type { TelemetryStatus } from '@lobstah/core';

function statusFields(s: TelemetryStatus): Record<string, string> {
  return {
    sharing: s.sharing ? 'on' : 'off',
    offBy: s.offBy.length > 0 ? s.offBy.join('; ') : '(no off switch set)',
    endpoint: s.endpoint || '(none — this build sends nothing)',
    noticeShown: s.noticeShown ? 'yes' : 'no (nothing is sent until it is shown on an interactive run)',
    installId: s.installId ?? '(not created yet)',
    lastSent: s.lastSentDate ?? '(never)',
  };
}

/** `lobstah telemetry [status [--json] | enable | disable | show]`. */
export function telemetryCommand(sub: string, opts: { json?: boolean; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env;
  switch (sub) {
    case 'enable': {
      enableTelemetry();
      const s = telemetryStatus(env);
      const still = s.sharing ? '' : `\nStill off: ${s.offBy.join('; ')}`;
      return `${TELEMETRY_NOTICE}\n\n${toonKV(statusFields(s))}${still}`;
    }
    case 'disable':
      disableTelemetry();
      return toonKV(statusFields(telemetryStatus(env)));
    case 'show':
      // Exactly the bytes a send would POST, whether or not sharing is on.
      return serializeTelemetryPayload(buildTelemetryPayload(ensureTelemetryState().installId));
    default: {
      const s = telemetryStatus(env);
      return opts.json ? JSON.stringify(s) : toonKV(statusFields(s));
    }
  }
}
