import { useSyncExternalStore } from 'react';
import type { NetworkMode } from '../contracts';
import { connectivity } from './connectivity';

/** React hook: the current network mode, re-rendering when it changes. */
export function useNetworkMode(): NetworkMode {
  return useSyncExternalStore(
    (cb) => connectivity.subscribe(cb),
    () => connectivity.mode(),
  );
}
