import { useEffect, useState } from 'react';
import { apiCached, peekCached } from './api';

/** Shape of `GET /v1/system/version`. */
export interface VersionInfo {
  name: string;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  installCommand: string;
  github: string;
  checkedAt: string;
}

const PATH = '/v1/system/version';
// The server caches the npm lookup for an hour; the client re-checks every 6h
// per session so a long-lived tab eventually notices a release.
const RECHECK_MS = 6 * 60 * 60 * 1_000;

/**
 * Poll the platform's release metadata so the UI can prompt an npm update when
 * a newer `@agentis-labs/cli` is published. Seeds from the SWR cache for an
 * instant first paint, then revalidates. Never throws — a failed check simply
 * yields `updateAvailable: false`.
 */
export function useVersionUpdate(): VersionInfo | null {
  const [info, setInfo] = useState<VersionInfo | null>(() => peekCached<VersionInfo>(PATH) ?? null);

  useEffect(() => {
    let alive = true;
    const check = () => {
      apiCached<VersionInfo>(PATH)
        .then((data) => { if (alive) setInfo(data); })
        .catch(() => { /* offline / unauthenticated — stay silent */ });
    };
    check();
    const timer = setInterval(check, RECHECK_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  return info;
}
