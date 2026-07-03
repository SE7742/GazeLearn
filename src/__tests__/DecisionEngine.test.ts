// Dosya ozeti: DecisionEngine esik, confidence ve skipped bolge siniflandirma kurallarini test eder.
import { describe, it, expect } from 'vitest';
import DecisionEngine from '../aoi/DecisionEngine';
import type { AOIMetrics } from '../types';

function makeMetrics(overrides: Partial<AOIMetrics> = {}): AOIMetrics {
  return {
    regionId: 'p1',
    totalFixationTime: 0,
    fixationCount: 0,
    regressionCount: 0,
    firstFixationTime: 0,
    averageFixationDuration: 0,
    entryCount: 0,
    timeToFirstFixation: 0,
    revisitCount: 0,
    transitionCount: 0,
    ...overrides,
  };
}

describe('DecisionEngine', () => {
  it('classifies easy for low engagement', () => {
    const engine = new DecisionEngine();
    const result = engine.classifyRegion(makeMetrics({
      fixationCount: 3,
      totalFixationTime: 1000,
      regressionCount: 0,
      averageFixationDuration: 200,
    }));
    expect(result.level).toBe('easy');
    expect(result.reasons).toContain('Normal okuma davranisi');
  });

  it('classifies hard for high fixation + regression', () => {
    const engine = new DecisionEngine();
    const result = engine.classifyRegion(makeMetrics({
      regionId: 'f1',
      fixationCount: 20,
      totalFixationTime: 8000,
      regressionCount: 5,
      averageFixationDuration: 450,
      revisitCount: 3,
    }));
    expect(result.level).toBe('hard');
    expect(result.confidence).toBeGreaterThan(0.5);
    expect(result.triggerMetrics).toHaveProperty('totalFixationTime');
    expect(result.triggerMetrics).toHaveProperty('regressionCount');
  });

  it('classifies medium for moderate signals', () => {
    const engine = new DecisionEngine();
    const result = engine.classifyRegion(makeMetrics({
      fixationCount: 10,
      totalFixationTime: 6000, // > 5000
      regressionCount: 1,     // < 3
      averageFixationDuration: 350,
    }));
    expect(result.level).toBe('medium');
  });

  it('analyze includes skipped entry for zero-fixation regions', () => {
    const engine = new DecisionEngine();
    const results = engine.analyze([
      makeMetrics({ regionId: 'p1', fixationCount: 0 }),
      makeMetrics({ regionId: 'p2', fixationCount: 5, totalFixationTime: 1000 }),
    ]);
    expect(results.length).toBe(2);
    const classified = results.find(r => r.regionId === 'p2');
    const skipped = results.find(r => r.regionId === 'p1');
    expect(classified).toBeDefined();
    expect(skipped?.skipped).toBe(true);
    expect(skipped?.confidence).toBe(0);
  });

  it('analyze session normalization does not mutate future classifyRegion thresholds', () => {
    const engine = new DecisionEngine();
    const probe = makeMetrics({
      fixationCount: 4,
      totalFixationTime: 2500,
      averageFixationDuration: 250,
    });

    expect(engine.classifyRegion(probe).level).toBe('medium');

    engine.analyze([
      makeMetrics({ regionId: 'a', fixationCount: 5, totalFixationTime: 1000, averageFixationDuration: 2000 }),
      makeMetrics({ regionId: 'b', fixationCount: 5, totalFixationTime: 1000, averageFixationDuration: 2000 }),
      makeMetrics({ regionId: 'c', fixationCount: 5, totalFixationTime: 1000, averageFixationDuration: 2000 }),
    ]);

    expect(engine.classifyRegion(probe).level).toBe('medium');
  });

  it('hasEnoughData respects minimum duration', () => {
    const engine = new DecisionEngine(5000, 3, 10000);
    expect(engine.hasEnoughData(5000)).toBe(false);
    expect(engine.hasEnoughData(10000)).toBe(true);
    expect(engine.hasEnoughData(15000)).toBe(true);
  });

  it('adjustThresholds adapts to session average', () => {
    const engine = new DecisionEngine(5000, 3);

    // Simulate a session with high fixation times
    engine.adjustThresholds(makeMetrics({
      totalFixationTime: 10000,
      regressionCount: 5,
    }));

    // After adjustment, previously "hard" region should now be "easier"
    const result = engine.classifyRegion(makeMetrics({
      fixationCount: 10,
      totalFixationTime: 6000, // below adjusted threshold 10000*1.5=15000
      regressionCount: 4,      // below adjusted threshold 5*1.5=7.5
    }));
    expect(result.level).not.toBe('hard');
  });

  it('adjustThresholds enforces minimum thresholds', () => {
    const engine = new DecisionEngine(5000, 3);
    engine.adjustThresholds(makeMetrics({
      totalFixationTime: 100, // very low
      regressionCount: 0.5,   // very low
    }));
    // Thresholds should not go below minimums (3000 and 2)
    const result = engine.classifyRegion(makeMetrics({
      fixationCount: 5,
      totalFixationTime: 3500,
      regressionCount: 3,
    }));
    expect(result.level).not.toBe('easy');
  });

  it('confidence increases with higher scores', () => {
    const engine = new DecisionEngine();
    const easy = engine.classifyRegion(makeMetrics({
      fixationCount: 2, totalFixationTime: 500,
    }));
    const hard = engine.classifyRegion(makeMetrics({
      fixationCount: 30, totalFixationTime: 12000,
      regressionCount: 8, averageFixationDuration: 500, revisitCount: 5,
    }));
    expect(hard.confidence).toBeGreaterThanOrEqual(easy.confidence);
  });
});
