# GazeLearn Core

WebEyeTrack-oriented calibration, filtering, fixation detection, and AOI analytics layer.

This package is not a new gaze estimator. It is a processing layer built around the kind of raw gaze output produced by WebEyeTrack: normalized point-of-gaze, gaze state, timestamp, face/landmark presence, and optional confidence.

The main contribution is the layer after raw gaze estimation:

```text
WebEyeTrack-compatible raw gaze result
  -> clamp normalized gaze
  -> KalmanFilter
  -> PolyCorrection / Thin-Plate Spline calibration correction
  -> pixel coordinates
  -> FixationDetector
  -> AOIManager
  -> AOI metrics / DecisionEngine
```

## What Is Mine Here

- `GazePipeline`: central processing path for raw gaze output.
- `KalmanFilter`: smoothing layer used inside the pipeline.
- `PolyCorrection`: Thin-Plate Spline calibration correction.
- `CalibrationManager`: target/sample/error helper for calibration flows.
- `FixationDetector`: I-DT style fixation extraction.
- `AOIManager`: DOM AOI registration, hit-testing, revisit/regression metrics.
- `DecisionEngine`: explainable AOI score classification from metrics.
- Tests for the above behavior.

## What Is Not Included

- WebEyeTrack source code.
- MediaPipe runtime files.
- TensorFlow.js model assets.
- The full demo UI.
- Lesson editor, PDF flow, IndexedDB app shell, or student/teacher screens.

Those parts live in the original prototype/demo repository. This repo keeps only the calibration/AOI processing layer so the contribution is easier to inspect.

## Validation Boundary

The Kalman and calibration behavior were developed for the WebEyeTrack-style webcam gaze flow in the original prototype. They should not be advertised as universally optimal for every eye tracker or every project.

If another project uses a different gaze estimator, sampling rate, coordinate convention, camera setup, or noise profile, the thresholds and filter parameters should be re-tested.

## Integration Shape

```ts
import {
  AOIManager,
  GazePipeline,
  type GazeResult,
} from 'gazelearn-core';

const pipeline = new GazePipeline({}, window.innerWidth, window.innerHeight);
const aoi = new AOIManager();

aoi.registerRegion(element, 'region-1', 'Region 1', 'paragraph', 0);

pipeline.setCallbacks({
  onFixation: fixation => aoi.recordFixation(fixation),
  onProcessedGaze: gaze => {
    // Optional: draw cursor, log quality, or feed another analytics layer.
    void gaze;
  },
});

function onWebEyeTrackResult(result: GazeResult) {
  pipeline.process(result);
}
```

## Raw Gaze Input Contract

The expected input is intentionally close to the subset of WebEyeTrack output used by the pipeline:

```ts
interface GazeResult {
  normPog: [number, number];        // normalized gaze in [-0.5, 0.5]
  gazeState: 'open' | 'closed';
  timestamp: number;
  facialLandmarks: unknown[];       // empty means face_lost
  landmarkConfidence?: number;
}
```

## Core Code Map

- `src/core/GazePipeline.ts`
- `src/core/KalmanFilter.ts`
- `src/core/PolyCorrection.ts`
- `src/core/FixationDetector.ts`
- `src/calibration/CalibrationManager.ts`
- `src/aoi/AOIManager.ts`
- `src/aoi/DecisionEngine.ts`
- `src/types.ts`

## Verify

```bash
npm install
npm test
npm run typecheck
npm run build
```


## Attribution

See `ATTRIBUTION.md` for the relationship to WebEyeTrack and other omitted upstream/runtime pieces.
