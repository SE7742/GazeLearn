export interface GazeResult {
  normPog: [number, number];
  gazeState: 'open' | 'closed';
  timestamp: number;
  facialLandmarks: unknown[];
  landmarkConfidence?: number;
}

export interface PipelineConfig {
  enableKalman: boolean;
  enablePolyCorrection: boolean;
  enableFixation: boolean;
  dispersionThreshold: number;
  durationThreshold: number;
  blinkBypass: boolean;
  driftWindowSize: number;
  dispersionFormula?: 'sum' | 'euclidean' | 'max';
  kalmanVelocityFactor?: number;
}

export interface PipelineCallbacks {
  onFixation: ((fixation: Fixation) => void) | null;
  onProcessedGaze: ((gaze: ProcessedGaze) => void) | null;
}

export interface Fixation {
  type: 'fixation';
  x: number;
  y: number;
  duration: number;
  startTime: number;
  endTime: number;
  pointCount: number;
}

export interface CalibrationPoint {
  targetNormX: number;
  targetNormY: number;
  predictedNormX: number;
  predictedNormY: number;
  targetPixelX: number;
  targetPixelY: number;
  errorPixel: number;
}

export interface CalibrationRawSample {
  pointIndex: number;
  targetNormX: number;
  targetNormY: number;
  predictedNormX: number;
  predictedNormY: number;
  timestamp: number;
}

export interface CalibrationStats {
  avgError: number;
  maxError: number;
  pointErrors: number[];
  worstPointCount: number;
}

export interface ProcessedGaze {
  normX: number;
  normY: number;
  pixelX: number;
  pixelY: number;
  gazeState: 'open' | 'closed';
  trackingStatus: 'tracking' | 'blink' | 'face_lost';
  timestamp: number;
  isFiltered: boolean;
  confidence?: number;
}

export interface PipelineMetrics {
  fps: number;
  kalmanLatency: number;
  fixationCount: number;
  lastTrackingStatus: ProcessedGaze['trackingStatus'];
  driftScore: number;
  trackingLossCount: number;
  blinkCount: number;
  qualityScore: number;
  layerErrors: Record<string, number>;
  frameCount: number;
}

export interface KalmanState {
  x: number;
  p: number;
  vx: number;
}

export interface AOIRegion {
  id: string;
  element: HTMLElement;
  rect: DOMRect;
  label: string;
  category: 'paragraph' | 'image' | 'formula' | 'question';
  orderIndex: number;
}

export interface AOIMetrics {
  regionId: string;
  totalFixationTime: number;
  fixationCount: number;
  regressionCount: number;
  firstFixationTime: number;
  averageFixationDuration: number;
  entryCount: number;
  timeToFirstFixation: number;
  revisitCount: number;
  transitionCount: number;
  avgMatchConfidence?: number;
}

export interface DifficultyResult {
  regionId: string;
  level: 'easy' | 'medium' | 'hard';
  confidence: number;
  reasons: string[];
  triggerMetrics: Record<string, number>;
  skipped?: boolean;
}
