// Dosya ozeti: Kalman filtresinin predict, update, reset ve sayisal kararlilik davranislarini test eder.
import { describe, it, expect } from 'vitest';
import KalmanFilter from '../core/KalmanFilter';

describe('KalmanFilter', () => {
  it('initializes with first measurement', () => {
    const kf = new KalmanFilter();
    const result = kf.step(0.1, 1000);
    expect(result).toBe(0.1);
    expect(kf.isInitialized()).toBe(true);
  });

  it('smooths noisy input toward mean', () => {
    const kf = new KalmanFilter();
    const signal = [0, 0.1, -0.05, 0.08, -0.02, 0.03, 0.01, -0.01, 0.02, 0];
    const outputs: number[] = [];
    for (let i = 0; i < signal.length; i++) {
      outputs.push(kf.step(signal[i], 1000 + i * 33));
    }
    const inputVar = signal.reduce((s, v) => s + v * v, 0) / signal.length;
    const outputVar = outputs.reduce((s, v) => s + v * v, 0) / outputs.length;
    expect(outputVar).toBeLessThan(inputVar);
  });

  it('tracks a linear ramp with low lag', () => {
    const kf = new KalmanFilter(1e-3, 0.01);
    for (let i = 0; i < 30; i++) {
      kf.step(i * 0.01, 1000 + i * 33);
    }
    const lastOut = kf.step(0.30, 1000 + 30 * 33);
    expect(Math.abs(lastOut - 0.30)).toBeLessThan(0.05);
  });

  it('ignores NaN measurement, returns last state', () => {
    const kf = new KalmanFilter();
    kf.step(0.1, 1000);
    const before = kf.step(0.2, 1033);
    const afterNaN = kf.step(NaN, 1066);
    expect(afterNaN).toBe(before);
  });

  it('ignores Infinity timestamp', () => {
    const kf = new KalmanFilter();
    kf.step(0.1, 1000);
    const before = kf.step(0.2, 1033);
    const afterInf = kf.step(0.3, Infinity);
    expect(afterInf).toBe(before);
  });

  it('resets to uninitialized state', () => {
    const kf = new KalmanFilter();
    kf.step(0.5, 1000);
    expect(kf.isInitialized()).toBe(true);
    kf.reset();
    expect(kf.isInitialized()).toBe(false);
    const state = kf.getState();
    expect(state.x).toBe(0);
    expect(state.vx).toBe(0);
  });

  it('enforces r >= 1e-10 to prevent division by zero', () => {
    const kf = new KalmanFilter(1e-4, 0);
    kf.step(0.1, 1000);
    const result = kf.step(0.2, 1033);
    expect(isFinite(result)).toBe(true);
  });

  it('handles dt > 2s gap by skipping predict', () => {
    const kf = new KalmanFilter();
    kf.step(0.1, 1000);
    const result = kf.step(0.5, 5000);
    expect(isFinite(result)).toBe(true);
    expect(Math.abs(result - 0.5)).toBeLessThan(0.2);
  });

  it('covariance remains positive after many updates', () => {
    const kf = new KalmanFilter();
    for (let i = 0; i < 1000; i++) {
      kf.step(Math.sin(i * 0.1) * 0.3, 1000 + i * 16);
    }
    const state = kf.getState();
    expect(state.p).toBeGreaterThan(0);
  });
});
