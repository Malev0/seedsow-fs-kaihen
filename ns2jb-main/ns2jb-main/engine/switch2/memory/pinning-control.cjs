'use strict';

// Only the initial, deliberately aborted control can release a misplaced pin
// and try again. Native errors and uncertain placement must still stop the run.
class PinningWindowMiss extends Error {
  constructor(row) {
    super('Pinning storage was not created while the canary was pending');
    this.name = 'PinningWindowMiss';
    this.row = row;
  }
}

function releasablePinningControl(row, pinBytes = 13616) {
  return row.profile === 'abort-control' && row.pinningCreated === true &&
    row.restored === true &&
    row.newPersistentBytes === pinBytes && row.triggerAborted === true &&
    row.nativeGuard?.completed === 1 && Array.isArray(row.changedPaths) &&
    row.changedPaths.length === 0 && row.canaryResult === 0 && row.canaryType === 1;
}

function retryablePinningMiss(row, pinBytes) {
  // The first abort-control wave measures pinBytes itself, so the caller still
  // holds null when it asks whether that row is retryable. Fall back to the
  // row's own measured cost; otherwise the retry never fires on a fresh boot.
  const expected = pinBytes == null ? row.newPersistentBytes : pinBytes;
  return releasablePinningControl(row, expected) && row.pinningOverlapped === false;
}

async function retryPinningControl(wave, releasePin, pinBytes = 13616) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { return await wave(); }
    catch (error) {
      if (!(error instanceof PinningWindowMiss) || !retryablePinningMiss(error.row, pinBytes)) throw error;
      // Release even on the last miss; a failed release ends the run immediately.
      await releasePin(error.row, attempt);
      if (attempt === 3)
        throw new Error('Initial pinning timing missed on all 3 attempts; restart the console before another launch',
          {cause: error});
    }
  }
}

module.exports = {PinningWindowMiss, releasablePinningControl, retryablePinningMiss, retryPinningControl};
