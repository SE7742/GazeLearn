// Dosya ozeti: Piksel koordinatlarindan I-DT algoritmasi ile fiksasyon pencerelerini ve olaylarini cikarir.
import type { Fixation } from '../types';

interface GazePoint {
  x: number;
  y: number;
  timestamp: number;
}

/**
 * FixationDetector — I-DT (Identification by Dispersion-Threshold) algoritmasi.
 * Piksel uzayinda calisir (Kalman + PolyCorrection + toPixel sonrasi).
 * Blink bypass: gazeState === "closed" ise nokta eklenmez, mevcut pencere korunur.
 *
 * I-DT mantigi:
 * - Kisa bir zaman penceresinde gaze noktalarinin ekranda ne kadar dagildigina bakar.
 * - Dagilim esigin altinda ve sure yeterince uzunsa bu pencere fixation kabul edilir.
 * - Dagilim esigi asilinca onceki stabil pencere fixation olarak emit edilir.
 *
 * Neden piksel uzayi?
 * AOI bolgeleri DOMRect ile piksel olarak tutulur. Bu nedenle fiksasyon merkezi de
 * dogrudan ekran pikselinde uretilir ve AOIManager'a kayipsiz aktarilir.
 */
export default class FixationDetector {
  private window: GazePoint[] = [];
  private currentFixation: Fixation | null = null;
  private totalFixationCount = 0;
  private readonly maxWindowSize = 500;

  constructor(
    private dispersionThreshold: number = 50,
    private durationThreshold: number = 100,
    private dispersionFormula: 'sum' | 'euclidean' | 'max' = 'sum',
  ) {}

  /**
   * Esikleri degistir. Instance'i yeniden yaratmadan akis icinde guncelleme
   * yapar; boylece mevcut pencere ve fixation sayaci korunur (O8).
   */
  setThresholds(dispersionThreshold: number, durationThreshold: number): void {
    if (isFinite(dispersionThreshold) && dispersionThreshold > 0) {
      this.dispersionThreshold = dispersionThreshold;
    }
    if (isFinite(durationThreshold) && durationThreshold > 0) {
      this.durationThreshold = durationThreshold;
    }
  }

  setDispersionFormula(formula: 'sum' | 'euclidean' | 'max'): void {
    this.dispersionFormula = formula;
  }

  /**
   * Yeni bir gaze noktasi ekle. Blink durumunda (gazeState === "closed")
   * nokta eklenmez ve mevcut pencere korunur.
   * Fixation tamamlandiginda Fixation nesnesi dondurulur, aksi halde null.
   */
  addPoint(x: number, y: number, gazeState: string, timestamp: number): Fixation | null {
    if (gazeState === 'closed') return null;
    if (!isFinite(x) || !isFinite(y)) return null;

    this.window.push({ x, y, timestamp });

    // Uzun fixation'larda pencereyi sinirla — en eski noktalari cikar, fixation'i emit et.
    // Bu guard kullanici uzun sure ayni bolgeye bakarsa array'in sinirsiz buyumesini onler.
    if (this.window.length > this.maxWindowSize) {
      let emitted: Fixation | null = null;
      if (this.currentFixation && this.currentFixation.duration >= this.durationThreshold) {
        emitted = { ...this.currentFixation };
        this.totalFixationCount++;
        this.currentFixation = null;
      }
      const half = Math.floor(this.maxWindowSize / 2);
      this.window = this.window.slice(-half);
      if (emitted) return emitted;
    }

    const duration = this.window[this.window.length - 1].timestamp - this.window[0].timestamp;
    if (duration < this.durationThreshold) return null;

    // Dispersion, pencere icindeki noktalarin ekran uzerindeki yayilma miktaridir.
    // Kucuk dispersion = goz ayni bolgede kalmis; buyuk dispersion = saccade/hareket.
    const dispersion = this.getDispersion(this.window);

    if (dispersion <= this.dispersionThreshold) {
      const avgX = this.window.reduce((s, p) => s + p.x, 0) / this.window.length;
      const avgY = this.window.reduce((s, p) => s + p.y, 0) / this.window.length;

      this.currentFixation = {
        type: 'fixation',
        x: avgX,
        y: avgY,
        duration,
        startTime: this.window[0].timestamp,
        endTime: this.window[this.window.length - 1].timestamp,
        pointCount: this.window.length,
      };

      return null;
    }

    // Dispersion esik asildiysa, onceki pencereden fixation cikart
    let result: Fixation | null = null;

    if (this.currentFixation && this.currentFixation.duration >= this.durationThreshold) {
      result = { ...this.currentFixation };
      this.totalFixationCount++;
    }

    this.currentFixation = null;

    // Pencereyi daralt: dispersion esigi asildigi anda en eski noktayi cikar.
    // Frame basina max 20 shift ile O(n^2) main thread blogu onlenir.
    let shrinkCount = 0;
    while (this.window.length > 2 && this.getDispersion(this.window) > this.dispersionThreshold && shrinkCount < 20) {
      this.window.shift();
      shrinkCount++;
    }

    return result;
  }

  getDispersion(points: GazePoint[]): number {
    if (points.length === 0) return 0;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const dx = maxX - minX;
    const dy = maxY - minY;
    if (this.dispersionFormula === 'euclidean') return Math.sqrt(dx * dx + dy * dy);
    if (this.dispersionFormula === 'max') return Math.max(dx, dy);
    return dx + dy; // 'sum' — orijinal I-DT (Salvucci & Goldberg 2000)
  }

  isFixation(): boolean {
    return this.currentFixation !== null;
  }

  reset(): void {
    this.window = [];
    this.currentFixation = null;
    this.totalFixationCount = 0;
  }

  getCurrentFixation(): Fixation | null {
    return this.currentFixation ? { ...this.currentFixation } : null;
  }

  getFixationCount(): number {
    return this.totalFixationCount;
  }
}
