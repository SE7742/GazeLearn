// Dosya ozeti: Kalibrasyon hedeflerini, ham sample'lari ve nokta bazli hata hesaplarini yoneten siniftir.
import type { CalibrationPoint, CalibrationRawSample } from '../types';

/**
 * CalibrationManager — kalibrasyon yoneticisi.
 * Nokta sayisi parametrik: 5 (guvenli) veya 9 (tam) olarak ayarlanabilir.
 * recordSample() icinde gazeState kontrolu yapilir, blink sample'lari atlanir (B8).
 * CalibrationPoint hem normalize hem piksel alanlari icerir (B9).
 */
export default class CalibrationManager {
  private points: CalibrationPoint[] = [];
  private targetPoints: [number, number][] = [];
  private currentIndex = 0;
  private sampleCountPerPoint: number[] = [];
  private samplesPerPointNormX: number[][] = [];
  private samplesPerPointNormY: number[][] = [];
  private rawSamples: CalibrationRawSample[] = [];

  /*
   * 9 noktanin kaynagi buradaki gridSize degeridir.
   *
   * gridSize = 3 oldugu icin generateTargets() 3 satir ve 3 sutun uretir:
   *   row = 0, 1, 2
   *   col = 0, 1, 2
   *
   * Ic ice iki dongu toplam 3 x 3 = 9 kez calisir.
   * Her calismada targets.push([normX, normY]) ile listeye 1 kalibrasyon noktasi eklenir.
   *
   * Yani kodda dogrudan "9" sayisi yazmaz.
   * 9 nokta, gridSize * gridSize hesabindan gelir.
   *
   * Ornekler:
   *   gridSize = 3  => 3 x 3 = 9 nokta
   *   gridSize = 4  => 4 x 4 = 16 nokta
   *   gridSize = 0  => ozel mod, 5 nokta kullanilir
   */
  constructor(private gridSize: number = 3) {
    this.reset();
  }

  /**
   * Hedef noktaları oluştur. gridSize=3 → 9 nokta, gridSize=0 → 5-nokta (merkez + 4 yakın köşe).
   * gridSize=0 özel mod: webcam dostu, daha az uç konum.
   */
  private generateTargets(): [number, number][] {
    if (this.gridSize === 0) {
      return this.generate5PointTargets();
    }
    const targets: [number, number][] = [];
    const padding = 0.15;
    for (let row = 0; row < this.gridSize; row++) {
      for (let col = 0; col < this.gridSize; col++) {
        const normX = padding + (col / (this.gridSize - 1)) * (1 - 2 * padding) - 0.5;
        const normY = padding + (row / (this.gridSize - 1)) * (1 - 2 * padding) - 0.5;
        targets.push([normX, normY]);
      }
    }
    return targets;
  }

  /**
   * 5 nokta: merkez + 4 yarı-köşe. Ekranın %20 padding alanında kalır,
   * uç köşelere gitmez — webcam modeli bu alanı çok daha güvenilir takip eder.
   */
  private generate5PointTargets(): [number, number][] {
    const p = 0.2;
    return [
      [0, 0],                  // merkez
      [-0.5 + p, -0.5 + p],   // sol üst (yakın)
      [0.5 - p, -0.5 + p],    // sağ üst (yakın)
      [-0.5 + p, 0.5 - p],    // sol alt (yakın)
      [0.5 - p, 0.5 - p],     // sağ alt (yakın)
    ];
  }

  getNextTarget(): [number, number] | null {
    if (this.currentIndex >= this.targetPoints.length) return null;
    return this.targetPoints[this.currentIndex];
  }

  getCurrentIndex(): number {
    return this.currentIndex;
  }

  getTotalPoints(): number {
    return this.targetPoints.length;
  }

  private static median(values: number[]): number {
    if (values.length === 0) return 0;
    const s = [...values].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * Kalibrasyon sirasinda bir sample kaydet.
   * B8: gazeState === 'closed' ise sample atlanir (blink filtresi).
   */
  recordSample(predicted: [number, number], gazeState: string, timestamp?: number): void {
    if (gazeState === 'closed') return;
    if (this.currentIndex >= this.targetPoints.length) return;

    const target = this.targetPoints[this.currentIndex];

    this.samplesPerPointNormX[this.currentIndex].push(predicted[0]);
    this.samplesPerPointNormY[this.currentIndex].push(predicted[1]);
    this.sampleCountPerPoint[this.currentIndex]++;

    this.rawSamples.push({
      pointIndex: this.currentIndex,
      targetNormX: target[0],
      targetNormY: target[1],
      predictedNormX: predicted[0],
      predictedNormY: predicted[1],
      timestamp: timestamp ?? Date.now(),
    });
  }

  getSampleCount(): number {
    if (this.currentIndex >= this.sampleCountPerPoint.length) return 0;
    return this.sampleCountPerPoint[this.currentIndex];
  }

  advanceToNext(): void {
    if (this.currentIndex < this.targetPoints.length) {
      this.currentIndex++;
    }
  }

  finalize(screenW?: number, screenH?: number): CalibrationPoint[] {
    const w = screenW ?? (typeof window !== 'undefined' ? window.innerWidth : 1920);
    const h = screenH ?? (typeof window !== 'undefined' ? window.innerHeight : 1080);

    this.points = this.targetPoints.map((target, i) => {
      const samplesX = this.samplesPerPointNormX[i];
      const samplesY = this.samplesPerPointNormY[i];

      const avgPredX = samplesX.length > 0 ? CalibrationManager.median(samplesX) : 0;
      const avgPredY = samplesY.length > 0 ? CalibrationManager.median(samplesY) : 0;

      const targetPixelX = (target[0] + 0.5) * w;
      const targetPixelY = (target[1] + 0.5) * h;
      const predPixelX = (avgPredX + 0.5) * w;
      const predPixelY = (avgPredY + 0.5) * h;

      const errorPixel = Math.sqrt(
        (targetPixelX - predPixelX) ** 2 + (targetPixelY - predPixelY) ** 2
      );

      return {
        targetNormX: target[0],
        targetNormY: target[1],
        predictedNormX: avgPredX,
        predictedNormY: avgPredY,
        targetPixelX,
        targetPixelY,
        errorPixel,
      };
    });

    return this.points;
  }

  getRawSamples(): CalibrationRawSample[] {
    return [...this.rawSamples];
  }

  getSampleCountForPoint(index: number): number {
    return this.sampleCountPerPoint[index] ?? 0;
  }

  getAverageError(): number {
    if (this.points.length === 0) return 0;
    return this.points.reduce((sum, p) => sum + p.errorPixel, 0) / this.points.length;
  }

  isComplete(): boolean {
    return this.currentIndex >= this.targetPoints.length;
  }

  /** Focused retry icin: sadece belirtilen noktalarla yeniden baslat */
  setTargetPoints(targets: [number, number][]): void {
    this.targetPoints = targets;
    this.currentIndex = 0;
    this.points = [];
    this.sampleCountPerPoint = new Array(targets.length).fill(0);
    this.samplesPerPointNormX = targets.map(() => []);
    this.samplesPerPointNormY = targets.map(() => []);
    this.rawSamples = [];
  }

  reset(): void {
    this.targetPoints = this.generateTargets();
    this.currentIndex = 0;
    this.points = [];
    this.sampleCountPerPoint = new Array(this.targetPoints.length).fill(0);
    this.samplesPerPointNormX = this.targetPoints.map(() => []);
    this.samplesPerPointNormY = this.targetPoints.map(() => []);
    this.rawSamples = [];
  }
}
