// Dosya ozeti: Ham gaze sonucunu filtreleme, kalibrasyon duzeltme, piksel donusumu ve fiksasyon katmanlarindan gecirir.
import type {
  GazeResult,
  PipelineConfig,
  PipelineCallbacks,
  PipelineMetrics,
  ProcessedGaze,
  Fixation,
  CalibrationPoint,
} from '../types';
import KalmanFilter from './KalmanFilter';
import FixationDetector from './FixationDetector';
import PolyCorrection from './PolyCorrection';

const DEFAULT_CONFIG: PipelineConfig = {
  enableKalman: true,
  enablePolyCorrection: true,
  enableFixation: true,
  dispersionThreshold: 100,
  durationThreshold: 100,
  blinkBypass: true,
  driftWindowSize: 20,
};

/**
 * GazePipeline — sinyal isleme orkestratoru.
 * Akis: blink check → clamp → Kalman → PolyCorrection → toPixel → FixationDetector
 * Her katman try-catch ile sarili; hata olursa bypass edilir (I1 notu).
 *
 * Bu sinif uygulamanin "tek dogru gaze veri yolu"dur. WebEyeTrack yalnizca ham
 * `GazeResult` uretir; UI, AOI ve raporlar ise bu sinifin urettigi `ProcessedGaze`
 * ve fixation eventlerine bakar.
 *
 * Katman mantigi:
 * 1. face_lost / blink gibi takip durumlarini erken ayir.
 * 2. Model ciktisini guvenli normalize araliga clamp et.
 * 3. Kalman ile frame-to-frame jitter'i azalt.
 * 4. Kalibrasyon varsa TPS/PolyCorrection ile sistematik offset'i duzelt.
 * 5. Normalize koordinati piksele cevir.
 * 6. I-DT fiksasyon algilayiciya ver.
 *
 * Her katman bagimsiz flag ile acilip kapatilabilir. Bu sayede DebugOverlay ve
 * LayerBenchmark hangi katmanin metriklere ne kattigini gosterebilir.
 */
export default class GazePipeline {
  private config: PipelineConfig;
  private callbacks: PipelineCallbacks = { onFixation: null, onProcessedGaze: null };

  private kalmanX: KalmanFilter;
  private kalmanY: KalmanFilter;
  private fixationDetector: FixationDetector;
  private polyCorrection: PolyCorrection;

  private screenWidth: number;
  private screenHeight: number;

  // Metrik sayaclari: ders sonunda kalite bayraklari ve debug paneli bu sayilari okur.
  private frameCount = 0;
  private trackingLossCount = 0;
  private blinkCount = 0;
  private lastTrackingStatus: ProcessedGaze['trackingStatus'] = 'tracking';
  private lastProcessTimestamp = 0;
  private fpsBuffer: number[] = [];

  // Drift tespiti icin son fixation'lar. Gaze noktasi zamanla kayarsa bu pencerenin
  // standart sapmasi artar ve LessonView yeniden kalibrasyon uyarisi verebilir.
  private recentFixations: Fixation[] = [];
  private driftScore = 0;

  // Katman bazli hata sayaclari (Y8) — susturulmus bypass hatalarini gorunur kilar
  private layerErrorCounts: Record<string, number> = {};

  // Kalman latency olcumu (H2)
  private kalmanLatencySum = 0;
  private kalmanLatencyCount = 0;

  // face_lost / blink sirasinda son bilinen koordinatlari korumak icin.
  // UI cursor bir anda (0,0)'a ziplamaz; metrikler trackingStatus ile bu frame'i ayiklar.
  private lastNormX = 0;
  private lastNormY = 0;
  private lastPixelX = 0;
  private lastPixelY = 0;

  constructor(
    config?: Partial<PipelineConfig>,
    screenW?: number,
    screenH?: number,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.screenWidth = screenW ?? (typeof window !== 'undefined' ? window.innerWidth : 1920);
    this.screenHeight = screenH ?? (typeof window !== 'undefined' ? window.innerHeight : 1080);

    this.kalmanX = new KalmanFilter(1e-4, 0.01, this.config.kalmanVelocityFactor ?? 0.1);
    this.kalmanY = new KalmanFilter(1e-4, 0.01, this.config.kalmanVelocityFactor ?? 0.1);
    this.fixationDetector = new FixationDetector(
      this.config.dispersionThreshold,
      this.config.durationThreshold,
      this.config.dispersionFormula,
    );
    this.polyCorrection = new PolyCorrection(2);
  }

  /**
   * Ana isleme metodu — GazeResult'u ProcessedGaze'e donusturur.
   * Blink ve face_lost durumlari pipeline oncesinde ele alinir.
   */
  process(gazeResult: GazeResult): ProcessedGaze {
    this.frameCount++;
    const now = gazeResult.timestamp;

    // FPS hesabi — dt=0 korumasile Infinity onlenir
    if (this.lastProcessTimestamp > 0) {
      const dt = now - this.lastProcessTimestamp;
      if (dt > 0) {
        this.fpsBuffer.push(1000 / dt);
        if (this.fpsBuffer.length > 30) this.fpsBuffer.shift();
      }
    }
    this.lastProcessTimestamp = now;

    // Face lost kontrolu: hic landmark gelmediyse model ciktisi uretilemez.
    // Son bilinen koordinat dondurulur, ama trackingStatus 'face_lost' oldugu icin
    // AOI/dwell tarafinda metrik olarak sayilmaz.
    if (gazeResult.facialLandmarks.length === 0) {
      this.trackingLossCount++;
      this.lastTrackingStatus = 'face_lost';
      return this.buildOutput(
        this.lastNormX, this.lastNormY, this.lastPixelX, this.lastPixelY,
        gazeResult.gazeState, 'face_lost', now, false, 0,
      );
    }

    // Blink kontrolu: goz kapaliyken BlazeGaze tahmini anlamsizdir.
    // Kalman'a bu frame'i vermiyoruz; aksi halde filtre kapali goz frame'lerine dogru kayar.
    if (gazeResult.gazeState === 'closed') {
      this.blinkCount++;
      this.lastTrackingStatus = 'blink';
      return this.buildOutput(
        this.lastNormX, this.lastNormY, this.lastPixelX, this.lastPixelY,
        'closed', 'blink', now, false, gazeResult.landmarkConfidence ?? 0.3,
      );
    }

    this.lastTrackingStatus = 'tracking';

    let normX = gazeResult.normPog[0];
    let normY = gazeResult.normPog[1];

    // Clamp [-0.5, 0.5]. BlazeGaze normalize point-of-gaze bu aralikta beklenir.
    // Outlier degerler piksel donusumunde ekran disina tasmasin diye erken sinirlanir.
    normX = this.clampNorm(normX);
    normY = this.clampNorm(normY);

    let isFiltered = false;

    // Kalman filtre: ham frame jitter'ini azaltir. Bu katman yalnizca zamansal
    // yumusatma yapar; kullaniciya ozel kalibrasyon/offset duzeltmesi degildir.
    if (this.config.enableKalman) {
      try {
        const t0 = performance.now();
        normX = this.kalmanX.step(normX, now);
        normY = this.kalmanY.step(normY, now);
        this.kalmanLatencySum += performance.now() - t0;
        this.kalmanLatencyCount++;
        isFiltered = true;
      } catch (err) {
        this.handleLayerError('KalmanFilter', err as Error);
      }
    }

    // PolyCorrection/TPS: kalibrasyondan ogrenilen sistematik kaymayi duzeltir.
    // Normalize uzayda uygulanir; boylece ekran cozunurlugunden bagimsiz kalir.
    if (this.config.enablePolyCorrection && this.polyCorrection.isReady()) {
      try {
        const [cx, cy] = this.polyCorrection.correct(normX, normY);
        normX = this.clampNorm(cx);
        normY = this.clampNorm(cy);
      } catch (err) {
        this.handleLayerError('PolyCorrection', err as Error);
      }
    }

    // Son bilinen normalize koordinatlari kaydet
    this.lastNormX = normX;
    this.lastNormY = normY;

    // Piksel donusumu: UI, AOI ve fixation detector ekran koordinatiyla calisir.
    const [pixelX, pixelY] = this.toPixel(normX, normY);
    this.lastPixelX = pixelX;
    this.lastPixelY = pixelY;

    // Fixation tespiti (piksel uzayda). I-DT algoritmasi ard arda gelen noktalarin
    // belirli sure boyunca dar bir alanda kalip kalmadigina bakar.
    if (this.config.enableFixation) {
      try {
        const fixation = this.fixationDetector.addPoint(pixelX, pixelY, 'open', now);
        if (fixation) {
          this.recentFixations.push(fixation);
          if (this.recentFixations.length > this.config.driftWindowSize) {
            this.recentFixations.shift();
          }
          try {
            this.callbacks.onFixation?.(fixation);
          } catch (cbErr) {
            this.handleLayerError('onFixation callback', cbErr as Error);
          }
        }
      } catch (err) {
        this.handleLayerError('FixationDetector', err as Error);
      }
    }

    const result = this.buildOutput(normX, normY, pixelX, pixelY, 'open', 'tracking', now, isFiltered, gazeResult.landmarkConfidence ?? 0.7);
    try {
      this.callbacks.onProcessedGaze?.(result);
    } catch (err) {
      this.handleLayerError('onProcessedGaze callback', err as Error);
    }
    return result;
  }

  clampNorm(value: number): number {
    if (!isFinite(value)) return 0;
    return Math.max(-0.5, Math.min(0.5, value));
  }

  toPixel(normX: number, normY: number): [number, number] {
    return [
      (normX + 0.5) * this.screenWidth,
      (normY + 0.5) * this.screenHeight,
    ];
  }

  // ── Config & Callbacks ──

  getConfig(): PipelineConfig {
    return { ...this.config };
  }

  setConfig(config: Partial<PipelineConfig>): void {
    this.config = { ...this.config, ...config };

    // O8: FixationDetector instance'ini yeniden yaratmak yerine esikleri guncelle
    // — boylece pencere ve fixation sayaci korunur.
    if (config.dispersionThreshold !== undefined || config.durationThreshold !== undefined) {
      this.fixationDetector.setThresholds(
        this.config.dispersionThreshold,
        this.config.durationThreshold,
      );
    }
    if (config.dispersionFormula !== undefined) {
      this.fixationDetector.setDispersionFormula(this.config.dispersionFormula!);
    }
  }

  setCallbacks(cb: PipelineCallbacks): void {
    this.callbacks = cb;
  }

  setScreenSize(w: number, h: number): void {
    if (w > 0 && h > 0) {
      this.screenWidth = w;
      this.screenHeight = h;
    }
  }

  /**
   * Kalman durumunu sifirla — kalibrasyon/dogruluk noktasi degisiminde
   * onceki noktadan kalan momentumun yeni ornekleri kirletmesini onler.
   */
  resetKalmanState(): void {
    this.kalmanX.reset();
    this.kalmanY.reset();
  }

  // ── PolyCorrection bridge ──

  /**
   * TPS kalibrasyonunu sifirlar. Yeni kalibrasyon baslarken onceki oturumun
   * duzeltme yuzeyi tasinmamalidir.
   */
  resetPolyCorrection(): void {
    this.polyCorrection.reset();
  }

  fitPolyCorrection(calibrationPoints: CalibrationPoint[]): boolean {
    // Isim geriye uyumluluk icin PolyCorrection; gercek algoritma TPS'tir.
    // Basarisiz fit, yetersiz/bozuk nokta veya tekil matris anlamina gelir.
    const ok = this.polyCorrection.fit(calibrationPoints);
    if (!ok) return false;
    const res = this.polyCorrection.getResidualError();
    const maxResidualNorm = 0.25;
    if (res > maxResidualNorm) {
      // Residual normalize uzayda asiri buyukse katsayilar calissa bile guvenilmezdir.
      // Bu durumda duzeltmeyi komple kapatmak ham modele gore daha guvenlidir.
      this.polyCorrection.reset();
      return false;
    }
    return true;
  }

  getPolyResidualError(): number {
    return this.polyCorrection.getResidualError();
  }

  // ── Drift & Metrics ──

  /**
   * Son N fixation'in std sapmasindan drift skoru hesapla (I2).
   * Yuksek skor = kalibrasyon muhtemelen bozulmus.
   */
  checkDrift(): number {
    const fixes = this.recentFixations;
    if (fixes.length < 3) {
      this.driftScore = 0;
      return 0;
    }

    const xs = fixes.map(f => f.x);
    const ys = fixes.map(f => f.y);

    const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
    const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;

    const varX = xs.reduce((s, v) => s + (v - meanX) ** 2, 0) / xs.length;
    const varY = ys.reduce((s, v) => s + (v - meanY) ** 2, 0) / ys.length;

    this.driftScore = Math.sqrt(varX + varY);
    return this.driftScore;
  }

  getMetrics(): PipelineMetrics {
    this.checkDrift();

    const fps = this.fpsBuffer.length > 0
      ? this.fpsBuffer.reduce((a, b) => a + b, 0) / this.fpsBuffer.length
      : 0;

    // face_lost = gercek kopma (1.0 ceza), blink = dogal davranis (0.15 ceza)
    const qualityScore = this.frameCount > 0
      ? 1 - (this.trackingLossCount + this.blinkCount * 0.15) / this.frameCount
      : 1;

    return {
      fps,
      kalmanLatency: this.kalmanLatencyCount > 0
        ? this.kalmanLatencySum / this.kalmanLatencyCount
        : 0,
      fixationCount: this.fixationDetector.getFixationCount(),
      lastTrackingStatus: this.lastTrackingStatus,
      driftScore: this.driftScore,
      trackingLossCount: this.trackingLossCount,
      blinkCount: this.blinkCount,
      qualityScore: Math.max(0, qualityScore),
      layerErrors: { ...this.layerErrorCounts },
      frameCount: this.frameCount,
    };
  }

  resetAll(): void {
    this.kalmanX.reset();
    this.kalmanY.reset();
    this.fixationDetector.reset();
    this.polyCorrection.reset();
    this.frameCount = 0;
    this.trackingLossCount = 0;
    this.blinkCount = 0;
    this.fpsBuffer = [];
    this.recentFixations = [];
    this.driftScore = 0;
    this.lastProcessTimestamp = 0;
    this.lastTrackingStatus = 'tracking';
    this.lastNormX = 0;
    this.lastNormY = 0;
    this.lastPixelX = 0;
    this.lastPixelY = 0;
    this.layerErrorCounts = {};
  }

  // ── Private helpers ──

  private buildOutput(
    normX: number, normY: number,
    pixelX: number, pixelY: number,
    gazeState: 'open' | 'closed',
    trackingStatus: ProcessedGaze['trackingStatus'],
    timestamp: number,
    isFiltered: boolean,
    confidence?: number,
  ): ProcessedGaze {
    return { normX, normY, pixelX, pixelY, gazeState, trackingStatus, timestamp, isFiltered, confidence };
  }

  private handleLayerError(layerName: string, error: Error): void {
    this.layerErrorCounts[layerName] = (this.layerErrorCounts[layerName] ?? 0) + 1;
    console.warn(`[GazePipeline] ${layerName} hatasi, bypass ediliyor:`, error.message);
  }
}
