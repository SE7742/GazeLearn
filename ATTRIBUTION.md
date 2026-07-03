# Attribution

GazeLearn Core was extracted from a larger browser prototype that used WebEyeTrack as the raw webcam gaze-estimation layer.

## Upstream / External Work

- WebEyeTrack provides the raw gaze-estimation flow in the original prototype context.
- MediaPipe and TensorFlow.js assets were used in the original demo app to produce face landmarks and model inference.
- These upstream source files and model/runtime assets are not bundled in this core package.

## This Package's Scope

This package contains the processing layer built on top of raw gaze output:

- Kalman smoothing.
- Thin-Plate Spline calibration correction.
- Normalized-to-pixel coordinate conversion.
- I-DT fixation detection.
- AOI hit-testing and AOI metric extraction.
- Explainable AOI scoring.

## Important Claim Boundary

The calibration and filtering behavior was developed and tested around WebEyeTrack-style webcam gaze output. It should be described as a WebEyeTrack-oriented extension layer, not as a universally validated eye-tracking SDK.
