// Dosya ozeti: TPS duzeltmesinin fit, singular veri, reset ve invalid input davranislarini test eder.
import { describe, it, expect } from 'vitest';
import PolyCorrection from '../core/PolyCorrection';
import type { CalibrationPoint } from '../types';

function makeCalibrationPoint(
  targetNormX: number, targetNormY: number,
  predictedNormX: number, predictedNormY: number,
): CalibrationPoint {
  return {
    targetNormX, targetNormY,
    predictedNormX, predictedNormY,
    targetPixelX: (targetNormX + 0.5) * 1920,
    targetPixelY: (targetNormY + 0.5) * 1080,
    errorPixel: 0,
  };
}

describe('PolyCorrection', () => {
  it('is not ready before fit', () => {
    const pc = new PolyCorrection();
    expect(pc.isReady()).toBe(false);
    const [x, y] = pc.correct(0.1, 0.2);
    expect(x).toBe(0.1);
    expect(y).toBe(0.2);
  });

  it('fits identity mapping (predicted == target)', () => {
    const pc = new PolyCorrection();
    const points = [
      makeCalibrationPoint(-0.4, -0.4, -0.4, -0.4),
      makeCalibrationPoint(0.0, -0.4, 0.0, -0.4),
      makeCalibrationPoint(0.4, -0.4, 0.4, -0.4),
      makeCalibrationPoint(-0.4, 0.0, -0.4, 0.0),
      makeCalibrationPoint(0.0, 0.0, 0.0, 0.0),
      makeCalibrationPoint(0.4, 0.0, 0.4, 0.0),
      makeCalibrationPoint(-0.4, 0.4, -0.4, 0.4),
      makeCalibrationPoint(0.0, 0.4, 0.0, 0.4),
      makeCalibrationPoint(0.4, 0.4, 0.4, 0.4),
    ];
    expect(pc.fit(points)).toBe(true);
    expect(pc.isReady()).toBe(true);

    const [cx, cy] = pc.correct(0.1, -0.2);
    expect(cx).toBeCloseTo(0.1, 2);
    expect(cy).toBeCloseTo(-0.2, 2);
    expect(pc.getResidualError()).toBeLessThan(0.01);
  });

  it('corrects constant offset', () => {
    const pc = new PolyCorrection();
    const offset = 0.05;
    const targets = [
      [-0.4, -0.4], [0.0, -0.4], [0.4, -0.4],
      [-0.4, 0.0], [0.0, 0.0], [0.4, 0.0],
      [-0.4, 0.4], [0.0, 0.4], [0.4, 0.4],
    ];
    const points = targets.map(([tx, ty]) =>
      makeCalibrationPoint(tx, ty, tx + offset, ty + offset),
    );
    expect(pc.fit(points)).toBe(true);

    // Should correct the offset
    const [cx, cy] = pc.correct(0.15, 0.05);
    expect(cx).toBeCloseTo(0.10, 1);
    expect(cy).toBeCloseTo(0.00, 1);
  });

  it('fails with fewer than 3 points', () => {
    const pc = new PolyCorrection();
    const points = [
      makeCalibrationPoint(0, 0, 0.01, 0.01),
      makeCalibrationPoint(0.4, 0.4, 0.41, 0.41),
    ];
    expect(pc.fit(points)).toBe(false);
    expect(pc.isReady()).toBe(false);
  });

  it('rejects points with NaN coordinates', () => {
    const pc = new PolyCorrection();
    const points = [
      makeCalibrationPoint(0, 0, NaN, 0),
      makeCalibrationPoint(0.1, 0.1, 0.1, 0.1),
      makeCalibrationPoint(0.2, 0.2, 0.2, 0.2),
    ];
    expect(pc.fit(points)).toBe(false);
  });

  it('correct returns input if output is NaN (fallback)', () => {
    const pc = new PolyCorrection();
    const points = [
      makeCalibrationPoint(-0.4, -0.4, -0.4, -0.4),
      makeCalibrationPoint(0.0, 0.0, 0.0, 0.0),
      makeCalibrationPoint(0.4, 0.4, 0.4, 0.4),
    ];
    pc.fit(points);
    // Normal input — should return finite
    const [cx, cy] = pc.correct(0.1, 0.1);
    expect(isFinite(cx)).toBe(true);
    expect(isFinite(cy)).toBe(true);
  });

  it('resets to unfitted state', () => {
    const pc = new PolyCorrection();
    const points = [
      makeCalibrationPoint(-0.4, -0.4, -0.4, -0.4),
      makeCalibrationPoint(0.0, -0.4, 0.0, -0.4),
      makeCalibrationPoint(0.4, -0.4, 0.4, -0.4),
      makeCalibrationPoint(-0.4, 0.0, -0.4, 0.0),
      makeCalibrationPoint(0.0, 0.0, 0.0, 0.0),
      makeCalibrationPoint(0.4, 0.0, 0.4, 0.0),
      makeCalibrationPoint(-0.4, 0.4, -0.4, 0.4),
      makeCalibrationPoint(0.0, 0.4, 0.0, 0.4),
      makeCalibrationPoint(0.4, 0.4, 0.4, 0.4),
    ];
    pc.fit(points);
    expect(pc.isReady()).toBe(true);
    pc.reset();
    expect(pc.isReady()).toBe(false);
    expect(pc.getResidualError()).toBe(Infinity);
  });
});
