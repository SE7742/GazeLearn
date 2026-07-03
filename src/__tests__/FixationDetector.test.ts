// Dosya ozeti: I-DT fiksasyon tespiti, blink bypass ve dispersion varyantlarini test eder.
import { describe, it, expect } from 'vitest';
import FixationDetector from '../core/FixationDetector';
import type { Fixation } from '../types';

describe('FixationDetector', () => {
  function feedSteadyGaze(
    fd: FixationDetector,
    x: number,
    y: number,
    count: number,
    startTs: number,
    interval = 16,
    jitter = 2,
  ) {
    const fixations = [];
    for (let i = 0; i < count; i++) {
      const jx = x + (Math.random() - 0.5) * jitter;
      const jy = y + (Math.random() - 0.5) * jitter;
      const f = fd.addPoint(jx, jy, 'open', startTs + i * interval);
      if (f) fixations.push(f);
    }
    return fixations;
  }

  it('detects fixation from steady gaze', () => {
    const fd = new FixationDetector(50, 100);
    const fixations = feedSteadyGaze(fd, 500, 300, 20, 1000, 16, 2);
    // After 20 frames x 16ms = 320ms > 100ms threshold, fixation should build
    // Fixation is emitted when gaze moves away
    const moved = fd.addPoint(900, 900, 'open', 1000 + 20 * 16);
    expect(moved !== null || fixations.length > 0).toBe(true);
  });

  it('does not emit fixation below duration threshold', () => {
    const fd = new FixationDetector(50, 200);
    // Only 5 frames x 16ms = 80ms < 200ms
    for (let i = 0; i < 5; i++) {
      const f = fd.addPoint(500, 300, 'open', 1000 + i * 16);
      expect(f).toBeNull();
    }
    // Move away — should not emit since duration was too short
    const result = fd.addPoint(900, 900, 'open', 1000 + 5 * 16);
    expect(result).toBeNull();
  });

  it('ignores closed (blink) gaze state', () => {
    const fd = new FixationDetector(50, 100);
    const result = fd.addPoint(500, 300, 'closed', 1000);
    expect(result).toBeNull();
  });

  it('preserves window across blink', () => {
    const fd = new FixationDetector(50, 100);
    for (let i = 0; i < 5; i++) {
      fd.addPoint(500, 300, 'open', 1000 + i * 16);
    }
    // Blink for 3 frames — window should persist
    for (let i = 0; i < 3; i++) {
      fd.addPoint(500, 300, 'closed', 1000 + (5 + i) * 16);
    }
    // Resume — total open duration should continue accumulating
    for (let i = 0; i < 5; i++) {
      fd.addPoint(500, 300, 'open', 1000 + (8 + i) * 16);
    }
    // Move away to trigger emit
    const f = fd.addPoint(900, 900, 'open', 1000 + 13 * 16);
    expect(f).not.toBeNull();
    if (f) {
      expect(f.type).toBe('fixation');
      expect(f.x).toBeCloseTo(500, -1);
      expect(f.y).toBeCloseTo(300, -1);
    }
  });

  it('rejects NaN coordinates', () => {
    const fd = new FixationDetector(50, 100);
    const f1 = fd.addPoint(NaN, 300, 'open', 1000);
    const f2 = fd.addPoint(500, NaN, 'open', 1016);
    expect(f1).toBeNull();
    expect(f2).toBeNull();
  });

  it('caps window at maxWindowSize and emits fixation', () => {
    const fd = new FixationDetector(1000, 100); // high dispersion threshold to keep building
    const fixations = [];
    // Feed 600 points (> 500 maxWindowSize) at same location
    for (let i = 0; i < 600; i++) {
      const f = fd.addPoint(500, 300, 'open', 1000 + i * 16);
      if (f) fixations.push(f);
    }
    // Should have emitted at least 1 fixation due to window trim
    expect(fixations.length).toBeGreaterThanOrEqual(1);
    expect(fixations[0].type).toBe('fixation');
  });

  it('counts fixations correctly', () => {
    const fd = new FixationDetector(50, 100);
    expect(fd.getFixationCount()).toBe(0);

    // Build fixation then move
    for (let i = 0; i < 15; i++) {
      fd.addPoint(500, 300, 'open', 1000 + i * 16);
    }
    fd.addPoint(900, 900, 'open', 1000 + 15 * 16);
    expect(fd.getFixationCount()).toBe(1);
  });

  it('resets all state', () => {
    const fd = new FixationDetector(50, 100);
    for (let i = 0; i < 15; i++) {
      fd.addPoint(500, 300, 'open', 1000 + i * 16);
    }
    fd.addPoint(900, 900, 'open', 1500);
    expect(fd.getFixationCount()).toBe(1);

    fd.reset();
    expect(fd.getFixationCount()).toBe(0);
    expect(fd.isFixation()).toBe(false);
    expect(fd.getCurrentFixation()).toBeNull();
  });

  it('dispersion calculation is correct', () => {
    const fd = new FixationDetector();
    const points = [
      { x: 10, y: 20, timestamp: 0 },
      { x: 30, y: 40, timestamp: 1 },
      { x: 20, y: 30, timestamp: 2 },
    ];
    // dispersion = (maxX-minX) + (maxY-minY) = (30-10) + (40-20) = 40
    expect(fd.getDispersion(points)).toBe(40);
  });

  describe('dispersion formula', () => {
    // dx = 30-10 = 20, dy = 40-20 = 20 for all formula tests
    const pts = [
      { x: 10, y: 20, timestamp: 0 },
      { x: 30, y: 40, timestamp: 1 },
      { x: 20, y: 30, timestamp: 2 },
    ];

    it("'euclidean' returns sqrt(dx²+dy²)", () => {
      const fd = new FixationDetector(50, 100, 'euclidean');
      expect(fd.getDispersion(pts)).toBeCloseTo(Math.sqrt(800), 5);
    });

    it("'max' returns max(dx, dy)", () => {
      const fd = new FixationDetector(50, 100, 'max');
      expect(fd.getDispersion(pts)).toBe(20);
    });

    it('setDispersionFormula switches formula at runtime', () => {
      const fd = new FixationDetector(50, 100, 'sum');
      expect(fd.getDispersion(pts)).toBe(40);
      fd.setDispersionFormula('max');
      expect(fd.getDispersion(pts)).toBe(20);
      fd.setDispersionFormula('euclidean');
      expect(fd.getDispersion(pts)).toBeCloseTo(Math.sqrt(800), 5);
      fd.setDispersionFormula('sum');
      expect(fd.getDispersion(pts)).toBe(40);
    });

    it("'max' detects fixation where 'sum' misses at same threshold", () => {
      // Alternating (500,300)/(520,320): dx=dy=20; sum=40, max=20; threshold=30
      const fdSum = new FixationDetector(30, 50, 'sum');
      const fdMax = new FixationDetector(30, 50, 'max');

      let sumFixation: Fixation | null = null;
      let maxFixation: Fixation | null = null;

      for (let i = 0; i < 10; i++) {
        const x = i % 2 === 0 ? 500 : 520;
        const y = i % 2 === 0 ? 300 : 320;
        const ts = 1000 + i * 10;
        const sf = fdSum.addPoint(x, y, 'open', ts);
        const mf = fdMax.addPoint(x, y, 'open', ts);
        if (sf) sumFixation = sf;
        if (mf) maxFixation = mf;
      }
      const sfFinal = fdSum.addPoint(900, 900, 'open', 1100);
      const mfFinal = fdMax.addPoint(900, 900, 'open', 1100);
      if (sfFinal) sumFixation = sfFinal;
      if (mfFinal) maxFixation = mfFinal;

      expect(sumFixation).toBeNull();
      expect(maxFixation).not.toBeNull();
      expect(maxFixation!.type).toBe('fixation');
    });
  });
});
