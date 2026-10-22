import { estimateAlignment } from './alignment-estimator';
import type { RasterPage } from './revision-comparison';

const workerScope = self as unknown as {onmessage: ((event: MessageEvent<{id: number; base: RasterPage; revision: RasterPage}>) => void) | null; postMessage(value: unknown): void};
workerScope.onmessage = event => {
  const {id, base, revision} = event.data;
  void estimateAlignment(base, revision).then(result => workerScope.postMessage({id, result}), error => workerScope.postMessage({id, error: error instanceof Error ? error.message : String(error)}));
};
