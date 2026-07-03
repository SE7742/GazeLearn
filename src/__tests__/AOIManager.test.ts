// Dosya ozeti: AOIManager bolge kaydi, hit-test, metrik ve cleanup davranislarini dogrulayan testleri icerir.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import AOIManager from '../aoi/AOIManager';
import type { Fixation } from '../types';

function makeFixation(x: number, y: number, duration: number, startTime: number): Fixation {
  return {
    type: 'fixation', x, y, duration, startTime,
    endTime: startTime + duration, pointCount: 10,
  };
}

// Minimal HTMLElement mock for AOI region registration
function makeMockElement(rect: DOMRect): HTMLElement {
  return {
    getBoundingClientRect: () => rect,
  } as unknown as HTMLElement;
}

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height,
    right: left + width, bottom: top + height,
    x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

// Stub ResizeObserver and window for node env
const observeMock = vi.fn();
const unobserveMock = vi.fn();
const disconnectMock = vi.fn();

vi.stubGlobal('ResizeObserver', class {
  constructor(private cb: () => void) {}
  observe = observeMock;
  unobserve = unobserveMock;
  disconnect = disconnectMock;
});

vi.stubGlobal('window', {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

describe('AOIManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers region and computes metrics', () => {
    const aoi = new AOIManager();
    const el = makeMockElement(makeRect(100, 200, 400, 100));
    aoi.registerRegion(el, 'p1', 'Paragraph 1', 'paragraph');

    const m = aoi.getMetrics('p1');
    expect(m).not.toBeNull();
    expect(m!.fixationCount).toBe(0);
    expect(m!.regionId).toBe('p1');
  });

  it('hitTest finds correct region', () => {
    const aoi = new AOIManager();
    aoi.registerRegion(
      makeMockElement(makeRect(100, 200, 400, 100)),
      'p1', 'Para 1', 'paragraph',
    );
    aoi.registerRegion(
      makeMockElement(makeRect(100, 400, 400, 100)),
      'p2', 'Para 2', 'paragraph',
    );

    expect(aoi.hitTest(300, 250)?.id).toBe('p1');
    expect(aoi.hitTest(300, 450)?.id).toBe('p2');
    expect(aoi.hitTest(0, 0)).toBeNull();
  });

  it('adaptive scale enlarges hit zone', () => {
    const aoi = new AOIManager();
    aoi.registerRegion(
      makeMockElement(makeRect(100, 200, 400, 100)),
      'p1', 'Para 1', 'paragraph',
    );
    // Point just outside the region
    expect(aoi.hitTest(95, 250)).toBeNull();

    aoi.setAdaptiveScale(250); // > 200px → scale 1.6
    // Now the padding should extend the hit zone
    expect(aoi.hitTest(95, 250)?.id).toBe('p1');
  });

  it('exact hit on small region wins over earlier large region padded halo', () => {
    const aoi = new AOIManager();
    aoi.setAdaptiveScale(250); // > 200px → scale 1.6
    // Large image block registered first — its halo (pad ~168px) covers the paragraph below
    aoi.registerRegion(
      makeMockElement(makeRect(100, 100, 640, 560)),
      'img1', 'Gorsel', 'image',
    );
    aoi.registerRegion(
      makeMockElement(makeRect(100, 676, 640, 100)),
      'p1', 'Para 1', 'paragraph',
    );
    // Gaze is inside the paragraph rect — must resolve to p1, not the image halo
    expect(aoi.hitTest(300, 700)?.id).toBe('p1');
  });

  it('overlapping padded halos resolve to nearest region', () => {
    const aoi = new AOIManager();
    aoi.setAdaptiveScale(250); // > 200px → scale 1.6
    aoi.registerRegion(
      makeMockElement(makeRect(100, 100, 640, 560)),
      'img1', 'Gorsel', 'image',
    );
    aoi.registerRegion(
      makeMockElement(makeRect(100, 700, 640, 100)),
      'p1', 'Para 1', 'paragraph',
    );
    // Point in the gap, inside both halos: 35px from image edge, 5px from paragraph
    expect(aoi.hitTest(300, 695)?.id).toBe('p1');
  });

  it('recordFixation updates metrics', () => {
    const aoi = new AOIManager();
    aoi.registerRegion(
      makeMockElement(makeRect(100, 200, 400, 100)),
      'p1', 'Para 1', 'paragraph',
    );
    aoi.recordFixation(makeFixation(300, 250, 200, 5000));

    const m = aoi.getMetrics('p1')!;
    expect(m.fixationCount).toBe(1);
    expect(m.totalFixationTime).toBe(200);
    expect(m.averageFixationDuration).toBe(200);
    expect(m.entryCount).toBe(1);
    expect(m.firstFixationTime).toBe(5000);
  });

  it('recordFixation ignores fixation outside all regions', () => {
    const aoi = new AOIManager();
    aoi.registerRegion(
      makeMockElement(makeRect(100, 200, 400, 100)),
      'p1', 'Para 1', 'paragraph',
    );
    aoi.recordFixation(makeFixation(0, 0, 200, 5000));
    expect(aoi.getMetrics('p1')!.fixationCount).toBe(0);
  });

  it('detects regression (backward saccade)', () => {
    const aoi = new AOIManager();
    aoi.registerRegion(
      makeMockElement(makeRect(100, 200, 400, 100)),
      'p1', 'Para 1', 'paragraph',
    );
    aoi.registerRegion(
      makeMockElement(makeRect(100, 400, 400, 100)),
      'p2', 'Para 2', 'paragraph',
    );

    // p1 → p2 → p1 (regression)
    aoi.recordFixation(makeFixation(300, 250, 200, 1000)); // p1
    aoi.recordFixation(makeFixation(300, 450, 200, 2000)); // p2
    aoi.recordFixation(makeFixation(300, 250, 200, 3000)); // p1 again

    const m = aoi.getMetrics('p1')!;
    expect(m.regressionCount).toBeGreaterThanOrEqual(1);
    expect(m.revisitCount).toBeGreaterThanOrEqual(1);
  });

  it('tracks transitions between regions', () => {
    const aoi = new AOIManager();
    aoi.registerRegion(
      makeMockElement(makeRect(100, 200, 400, 100)),
      'p1', 'Para 1', 'paragraph',
    );
    aoi.registerRegion(
      makeMockElement(makeRect(100, 400, 400, 100)),
      'p2', 'Para 2', 'paragraph',
    );

    aoi.recordFixation(makeFixation(300, 250, 200, 1000)); // p1
    aoi.recordFixation(makeFixation(300, 450, 200, 2000)); // p2

    expect(aoi.getMetrics('p1')!.transitionCount).toBe(1);
  });

  it('duplicate registerRegion unobserves old element', () => {
    const aoi = new AOIManager();
    const el1 = makeMockElement(makeRect(100, 200, 400, 100));
    aoi.registerRegion(el1, 'p1', 'Para 1', 'paragraph');
    expect(observeMock).toHaveBeenCalledTimes(1);

    const el2 = makeMockElement(makeRect(200, 300, 400, 100));
    aoi.registerRegion(el2, 'p1', 'Para 1 Updated', 'paragraph');
    expect(unobserveMock).toHaveBeenCalledWith(el1);
    expect(observeMock).toHaveBeenCalledTimes(2);
  });

  it('duplicate registerRegion preserves existing metrics', () => {
    const aoi = new AOIManager();
    const el1 = makeMockElement(makeRect(100, 200, 400, 100));
    aoi.registerRegion(el1, 'p1', 'Para 1', 'paragraph');
    aoi.recordFixation(makeFixation(300, 250, 200, 5000));
    expect(aoi.getMetrics('p1')!.fixationCount).toBe(1);

    const el2 = makeMockElement(makeRect(100, 200, 400, 100));
    aoi.registerRegion(el2, 'p1', 'Para 1 Updated', 'paragraph');
    expect(aoi.getMetrics('p1')!.fixationCount).toBe(1);
  });

  it('high fixation count does not crash', () => {
    const aoi = new AOIManager();
    aoi.registerRegion(
      makeMockElement(makeRect(0, 0, 9999, 9999)),
      'p1', 'Big', 'paragraph',
    );
    for (let i = 0; i < 600; i++) {
      aoi.recordFixation(makeFixation(500, 500, 50, 1000 + i * 100));
    }
    const allMetrics = aoi.getAllMetrics();
    expect(allMetrics.length).toBe(1);
    // Should not crash or OOM — implicit pass
  });

  it('removeRegion cleans up', () => {
    const aoi = new AOIManager();
    const el = makeMockElement(makeRect(100, 200, 400, 100));
    aoi.registerRegion(el, 'p1', 'Para', 'paragraph');
    aoi.removeRegion('p1');
    expect(aoi.getMetrics('p1')).toBeNull();
    expect(aoi.hitTest(300, 250)).toBeNull();
    expect(unobserveMock).toHaveBeenCalledWith(el);
  });

  it('reset clears metrics but keeps regions', () => {
    const aoi = new AOIManager();
    aoi.registerRegion(
      makeMockElement(makeRect(100, 200, 400, 100)),
      'p1', 'Para', 'paragraph',
    );
    aoi.recordFixation(makeFixation(300, 250, 200, 5000));
    aoi.reset();
    expect(aoi.getMetrics('p1')!.fixationCount).toBe(0);
    expect(aoi.hitTest(300, 250)?.id).toBe('p1');
  });

  it('destroy disconnects observer and clears maps', () => {
    const aoi = new AOIManager();
    aoi.registerRegion(
      makeMockElement(makeRect(100, 200, 400, 100)),
      'p1', 'Para', 'paragraph',
    );
    aoi.destroy();
    expect(disconnectMock).toHaveBeenCalled();
    expect(aoi.getAllMetrics()).toEqual([]);
  });

  it('scroll listener added and removed', () => {
    const addSpy = vi.mocked(window.addEventListener);
    const removeSpy = vi.mocked(window.removeEventListener);

    const aoi = new AOIManager();
    expect(addSpy).toHaveBeenCalledWith('scroll', expect.any(Function), { passive: true });

    aoi.destroy();
    expect(removeSpy).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
