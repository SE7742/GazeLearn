// Dosya ozeti: GazePipeline filtreleme, tracking state, callbacks, drift ve metrik davranislarini test eder.
import { describe, it, expect, vi } from 'vitest';
import GazePipeline from '../core/GazePipeline';
import type { CalibrationPoint, Fixation, ProcessedGaze } from '../types';
import { mockGazeResult } from './helpers';

function makeCalibPoint(tx: number, ty: number, px: number, py: number): CalibrationPoint {
  return {
    targetNormX: tx, targetNormY: ty,
    predictedNormX: px, predictedNormY: py,
    targetPixelX: (tx + 0.5) * 1920, targetPixelY: (ty + 0.5) * 1080,
    errorPixel: 0,
  };
}

describe('GazePipeline', () => {
  it('processes a normal gaze result into pixel space', () => {
    const pipeline = new GazePipeline({}, 1920, 1080);
    const result = pipeline.process(mockGazeResult(0.0, 0.0, 1000));
    expect(result.trackingStatus).toBe('tracking');
    expect(result.gazeState).toBe('open');
    expect(result.isFiltered).toBe(true);
    // normX=0, normY=0 → pixel center (960, 540)
    expect(result.pixelX).toBeCloseTo(960, -1);
    expect(result.pixelY).toBeCloseTo(540, -1);
  });

  it('clamps out-of-range normPog values', () => {
    const pipeline = new GazePipeline({ enableKalman: false }, 1920, 1080);
    const result = pipeline.process(mockGazeResult(1.5, -1.5, 1000));
    expect(result.normX).toBe(0.5);
    expect(result.normY).toBe(-0.5);
    expect(result.pixelX).toBeCloseTo(1920, 0);
    expect(result.pixelY).toBeCloseTo(0, 0);
  });

  it('returns last known coords on face_lost', () => {
    const pipeline = new GazePipeline({ enableKalman: false }, 1920, 1080);
    pipeline.process(mockGazeResult(0.1, -0.1, 1000));
    const lost = pipeline.process(mockGazeResult(0, 0, 1033, { faceLost: true }));
    expect(lost.trackingStatus).toBe('face_lost');
    expect(lost.normX).toBeCloseTo(0.1, 5);
    expect(lost.normY).toBeCloseTo(-0.1, 5);
  });

  it('returns last known coords on blink', () => {
    const pipeline = new GazePipeline({ enableKalman: false }, 1920, 1080);
    pipeline.process(mockGazeResult(0.2, 0.1, 1000));
    const blink = pipeline.process(mockGazeResult(0, 0, 1033, { gazeState: 'closed' }));
    expect(blink.trackingStatus).toBe('blink');
    expect(blink.normX).toBeCloseTo(0.2, 5);
    expect(blink.normY).toBeCloseTo(0.1, 5);
  });

  it('Kalman smooths noisy input', () => {
    const pipeline = new GazePipeline({ enableKalman: true, enableFixation: false }, 1920, 1080);
    const outputs: number[] = [];
    const noisy = [0, 0.05, -0.03, 0.04, -0.02, 0.03, -0.01, 0.02, 0.0, 0.01];
    for (let i = 0; i < noisy.length; i++) {
      const r = pipeline.process(mockGazeResult(noisy[i], 0, 1000 + i * 33));
      outputs.push(r.normX);
    }
    const inputVar = noisy.reduce((s, v) => s + v * v, 0) / noisy.length;
    const outputVar = outputs.reduce((s, v) => s + v * v, 0) / outputs.length;
    expect(outputVar).toBeLessThan(inputVar);
  });

  it('resetKalmanState drops carryover so next sample tracks from measurement', () => {
    const pipeline = new GazePipeline({ enableKalman: true, enableFixation: false }, 1920, 1080);
    pipeline.process(mockGazeResult(0.35, 0.35, 1000));
    pipeline.process(mockGazeResult(0.36, 0.36, 1033));
    pipeline.resetKalmanState();
    const r = pipeline.process(mockGazeResult(-0.3, -0.25, 2000));
    expect(r.normX).toBeCloseTo(-0.3, 2);
    expect(r.normY).toBeCloseTo(-0.25, 2);
  });

  it('fitPolyCorrection rejects degenerate calibration (same predicted gaze for all targets)', () => {
    const pipeline = new GazePipeline(
      { enableKalman: false, enablePolyCorrection: true, enableFixation: false },
      1920, 1080,
    );
    const calibPoints = [
      makeCalibPoint(-0.4, -0.4, 0.05, 0.05),
      makeCalibPoint(0, -0.4, 0.05, 0.05),
      makeCalibPoint(0.4, -0.4, 0.05, 0.05),
      makeCalibPoint(-0.4, 0, 0.05, 0.05),
      makeCalibPoint(0, 0, 0.05, 0.05),
      makeCalibPoint(0.4, 0, 0.05, 0.05),
      makeCalibPoint(-0.4, 0.4, 0.05, 0.05),
      makeCalibPoint(0, 0.4, 0.05, 0.05),
      makeCalibPoint(0.4, 0.4, 0.05, 0.05),
    ];
    expect(pipeline.fitPolyCorrection(calibPoints)).toBe(false);
  });

  it('PolyCorrection integrates and corrects offset', () => {
    const pipeline = new GazePipeline(
      { enableKalman: false, enablePolyCorrection: true, enableFixation: false },
      1920, 1080,
    );
    const off = 0.05;
    const targets = [
      [-0.4, -0.4], [0, -0.4], [0.4, -0.4],
      [-0.4, 0], [0, 0], [0.4, 0],
      [-0.4, 0.4], [0, 0.4], [0.4, 0.4],
    ];
    const calibPoints = targets.map(([tx, ty]) =>
      makeCalibPoint(tx, ty, tx + off, ty + off),
    );
    expect(pipeline.fitPolyCorrection(calibPoints)).toBe(true);

    const result = pipeline.process(mockGazeResult(0.05 + off, 0.0 + off, 1000));
    expect(Math.abs(result.normX - 0.05)).toBeLessThan(0.03);
    expect(Math.abs(result.normY - 0.0)).toBeLessThan(0.03);
  });

  it('FixationDetector emits fixation via callback', () => {
    const pipeline = new GazePipeline(
      { enableKalman: false, enableFixation: true, dispersionThreshold: 60, durationThreshold: 100 },
      1920, 1080,
    );
    const fixations: Fixation[] = [];
    pipeline.setCallbacks({
      onFixation: (f) => fixations.push(f),
      onProcessedGaze: null,
    });

    // Feed steady gaze for ~200ms
    for (let i = 0; i < 15; i++) {
      pipeline.process(mockGazeResult(0, 0, 1000 + i * 16));
    }
    // Move away to emit fixation
    pipeline.process(mockGazeResult(0.4, 0.4, 1000 + 15 * 16));

    expect(fixations.length).toBe(1);
    expect(fixations[0].type).toBe('fixation');
    expect(fixations[0].duration).toBeGreaterThanOrEqual(100);
  });

  it('onProcessedGaze callback fires on each frame', () => {
    const pipeline = new GazePipeline({ enableKalman: false }, 1920, 1080);
    const frames: ProcessedGaze[] = [];
    pipeline.setCallbacks({
      onFixation: null,
      onProcessedGaze: (g) => frames.push(g),
    });
    for (let i = 0; i < 5; i++) {
      pipeline.process(mockGazeResult(0, 0, 1000 + i * 33));
    }
    expect(frames.length).toBe(5);
  });

  it('callback error does not crash pipeline', () => {
    const pipeline = new GazePipeline({ enableKalman: false }, 1920, 1080);
    pipeline.setCallbacks({
      onFixation: null,
      onProcessedGaze: () => { throw new Error('boom'); },
    });
    expect(() => {
      pipeline.process(mockGazeResult(0, 0, 1000));
    }).not.toThrow();
  });

  it('metrics track FPS, blinks, and loss', () => {
    const pipeline = new GazePipeline({}, 1920, 1080);
    for (let i = 0; i < 10; i++) {
      pipeline.process(mockGazeResult(0, 0, 1000 + i * 33));
    }
    pipeline.process(mockGazeResult(0, 0, 1330, { gazeState: 'closed' }));
    pipeline.process(mockGazeResult(0, 0, 1363, { faceLost: true }));

    const m = pipeline.getMetrics();
    expect(m.fps).toBeGreaterThan(0);
    expect(m.blinkCount).toBe(1);
    expect(m.trackingLossCount).toBe(1);
    expect(m.qualityScore).toBeLessThan(1);
    expect(m.qualityScore).toBeGreaterThan(0);
  });

  it('resetAll clears all state', () => {
    const pipeline = new GazePipeline({}, 1920, 1080);
    for (let i = 0; i < 10; i++) {
      pipeline.process(mockGazeResult(0, 0, 1000 + i * 33));
    }
    pipeline.process(mockGazeResult(0, 0, 2000, { gazeState: 'closed' }));
    pipeline.resetAll();

    const m = pipeline.getMetrics();
    expect(m.fps).toBe(0);
    expect(m.blinkCount).toBe(0);
    expect(m.trackingLossCount).toBe(0);
    expect(m.fixationCount).toBe(0);
  });

  it('setScreenSize rejects non-positive values', () => {
    const pipeline = new GazePipeline({}, 1920, 1080);
    pipeline.setScreenSize(0, 500);
    const r = pipeline.process(mockGazeResult(0, 0, 1000));
    // Should still use old 1920x1080
    expect(r.pixelX).toBeCloseTo(960, -1);
  });

  it('dispersionFormula stored and returned by getConfig', () => {
    const p1 = new GazePipeline({}, 1920, 1080);
    expect(p1.getConfig().dispersionFormula).toBeUndefined();
    const p2 = new GazePipeline({ dispersionFormula: 'euclidean' }, 1920, 1080);
    expect(p2.getConfig().dispersionFormula).toBe('euclidean');
  });

  it('setConfig updates dispersionFormula', () => {
    const pipeline = new GazePipeline({}, 1920, 1080);
    pipeline.setConfig({ dispersionFormula: 'max' });
    expect(pipeline.getConfig().dispersionFormula).toBe('max');
  });

  it("dispersionFormula 'max' detects fixation where 'sum' does not at same threshold", () => {
    // Alternating pixel coords (960,540)/(980,560): dx=dy=20px; sum=40, max=20; threshold=30
    const pSum = new GazePipeline(
      { enableKalman: false, enableFixation: true, dispersionThreshold: 30, durationThreshold: 50, dispersionFormula: 'sum' },
      1920, 1080,
    );
    const pMax = new GazePipeline(
      { enableKalman: false, enableFixation: true, dispersionThreshold: 30, durationThreshold: 50, dispersionFormula: 'max' },
      1920, 1080,
    );

    const sumFixations: Fixation[] = [];
    const maxFixations: Fixation[] = [];
    pSum.setCallbacks({ onFixation: f => sumFixations.push(f), onProcessedGaze: null });
    pMax.setCallbacks({ onFixation: f => maxFixations.push(f), onProcessedGaze: null });

    // normX=0 → pixelX=960; normX=20/1920 → pixelX=980 (dx=20px)
    // normY=0 → pixelY=540; normY=20/1080 → pixelY=560 (dy=20px)
    const dNormX = 20 / 1920;
    const dNormY = 20 / 1080;
    for (let i = 0; i < 10; i++) {
      const nx = i % 2 === 0 ? 0 : dNormX;
      const ny = i % 2 === 0 ? 0 : dNormY;
      pSum.process(mockGazeResult(nx, ny, 1000 + i * 10));
      pMax.process(mockGazeResult(nx, ny, 1000 + i * 10));
    }
    pSum.process(mockGazeResult(0.4, 0.4, 1110));
    pMax.process(mockGazeResult(0.4, 0.4, 1110));

    expect(sumFixations.length).toBe(0);
    expect(maxFixations.length).toBe(1);
  });

  it('drift score computed from recent fixations', () => {
    const pipeline = new GazePipeline(
      { enableKalman: false, enableFixation: true, dispersionThreshold: 60, durationThreshold: 50 },
      1920, 1080,
    );

    // Create multiple fixations at different locations
    const locations = [[0.0, 0.0], [0.1, 0.1], [-0.1, -0.1], [0.05, 0.05]];
    let ts = 1000;
    for (const [nx, ny] of locations) {
      for (let i = 0; i < 10; i++) {
        pipeline.process(mockGazeResult(nx, ny, ts));
        ts += 16;
      }
      pipeline.process(mockGazeResult(0.45, 0.45, ts));
      ts += 16;
    }

    const drift = pipeline.checkDrift();
    expect(drift).toBeGreaterThan(0);
  });
});
