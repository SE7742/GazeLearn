// Dosya ozeti: Testlerde kullanilan ImageData stub'u ve mock GazeResult olusturucusunu saglar.
import type { GazeResult } from '../types';

// Stub ImageData for Node environment
if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as any).ImageData = class ImageData {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
      this.data = new Uint8ClampedArray(w * h * 4);
    }
  };
}

/**
 * Build a minimal GazeResult mock for pipeline testing.
 * Only fields used by GazePipeline are populated.
 */
export function mockGazeResult(
  normX: number,
  normY: number,
  timestamp: number,
  opts: {
    gazeState?: 'open' | 'closed';
    faceLost?: boolean;
  } = {},
): GazeResult {
  return {
    facialLandmarks: opts.faceLost
      ? []
      : [{ x: 0.5, y: 0.5, z: 0 }] as any,
    eyePatch: new ImageData(1, 1),
    headVector: [0, 0, 1],
    faceOrigin3D: [0, 0, -0.5],
    gazeState: opts.gazeState ?? 'open',
    normPog: [normX, normY],
    timestamp,
  } as GazeResult;
}
