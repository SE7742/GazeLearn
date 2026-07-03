// Dosya ozeti: Kalibrasyon noktalarindan Thin-Plate Spline duzeltmesi fit edip normalize gaze tahminini duzeltir.
import type { CalibrationPoint } from '../types';

/**
 * Thin-Plate Spline (TPS) kalibrasyon düzeltme.
 * Kernel: U(r²) = r² · ln(r²)  (r²=0 → 0)
 * f(p) = a0 + a1·px + a2·py + Σ_i w_i · U(||p − c_i||²)
 *
 * Referans: Bookstein 1989; Tobii/iMotions ticari uygulamaları;
 * ETRA 2016-2024 webcam gaze correction literature.
 *
 * Polynomial regression yerine seçildi: kalibrasyon noktaları dışında
 * monoton uzanır, oscillation olmaz, kenar saturasyonuna dayanıklı.
 *
 * Bu sinif ad olarak `PolyCorrection` kaldi; cunku pipeline ve eski testler bu API'yi
 * kullanıyor. Ancak algoritma polinom regresyon degil, TPS tabanli yuzey fitidir.
 *
 * Girdi ve cikti normalize gaze uzayindadir:
 * - predictedNormX/Y: BlazeGaze + Kalman sonrasinda modelin baktigini sandigi nokta
 * - targetNormX/Y: kalibrasyon hedefinin gercek normalize koordinati
 *
 * Fit sonucu iki ayri fonksiyon uretilir:
 * - X duzeltme yuzeyi
 * - Y duzeltme yuzeyi
 *
 * Bu yuzeyler canli derste her gaze frame'ine uygulanir ve sistematik kamera/model
 * kaymasini azaltir. Duzeltme basarisiz veya sayisal olarak kararsizsa pipeline ham
 * koordinata geri doner; kotu kalibrasyonun takibi daha da bozmasi engellenir.
 */
export default class PolyCorrection {
  // TPS kontrol noktalaridir. Her nokta kullanicinin kalibrasyonda baktigi ham tahmindir.
  private controlPoints: [number, number][] = [];
  // X ve Y icin ayri katsayi vektorleri tutulur; ayni kontrol noktalarindan iki yuzey fit edilir.
  private weightsX: number[] = [];
  private weightsY: number[] = [];
  private isFitted: boolean = false;
  private residualError: number = Infinity;

  private readonly lambda: number;

  // degree parametresi interface uyumu icin korundu, TPS'de kullanilmiyor.
  // lambda regularization degeridir: 0'a yaklastikca noktaya birebir uyar,
  // buyudukce outlier noktalara karsi daha yumusak davranir.
  constructor(_degree: number = 2, lambda: number = 0.05) {
    this.lambda = lambda;
  }

  private kernel(r2: number): number {
    // TPS kernel r=0 icin teorik olarak 0 kabul edilir. Bu guard log(0) -> -Infinity
    // uretmesini engeller.
    if (r2 < 1e-12) return 0;
    return r2 * Math.log(r2);
  }

  fit(calibrationPoints: CalibrationPoint[]): boolean {
    const n = calibrationPoints.length;
    // TPS'in affine kismini cozmek icin en az 3 nokta gerekir. Daha az nokta
    // sayisal olarak anlamli bir yuzey tanimlamaz.
    if (n < 3) {
      this.isFitted = false;
      return false;
    }

    const hasInvalid = calibrationPoints.some(
      cp => !isFinite(cp.predictedNormX) || !isFinite(cp.predictedNormY)
        || !isFinite(cp.targetNormX) || !isFinite(cp.targetNormY),
    );
    if (hasInvalid) {
      this.isFitted = false;
      return false;
    }

    // Kontrol noktalari "predicted" uzaydan alinir; cunku canli derste elimizde yine
    // modelin predicted gaze ciktisi olacak ve onu target uzayina map edecegiz.
    const pts = calibrationPoints.map(
      cp => [cp.predictedNormX, cp.predictedNormY] as [number, number],
    );
    const dim = n + 3;

    // L = [[K + lambda*I, P], [P^T, 0]]
    //
    // K: kontrol noktalarinin TPS kernel uzaklik matrisi.
    // P: affine terimler [1, x, y]. TPS yalnizca radial bükülme degil, global affine
    // kayma/olcek etkisini de yakalar.
    // lambda: tek bir kotu noktaya asiri uyumu engelleyen regularization.
    const L: number[][] = Array.from({ length: dim }, () => new Array(dim).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const dx = pts[i][0] - pts[j][0];
        const dy = pts[i][1] - pts[j][1];
        L[i][j] = this.kernel(dx * dx + dy * dy);
      }
      L[i][i] += this.lambda;
      L[i][n] = 1; L[i][n + 1] = pts[i][0]; L[i][n + 2] = pts[i][1];
      L[n][i] = 1; L[n + 1][i] = pts[i][0]; L[n + 2][i] = pts[i][1];
    }

    // Sag taraf iki kez cozulur: ayni L matrisiyle hedef X ve hedef Y ayri ayri fit edilir.
    const rhsX = [...calibrationPoints.map(cp => cp.targetNormX), 0, 0, 0];
    const rhsY = [...calibrationPoints.map(cp => cp.targetNormY), 0, 0, 0];

    const wx = this.solveLinear(L, rhsX, dim);
    const wy = this.solveLinear(L, rhsY, dim);
    if (!wx || !wy) {
      this.isFitted = false;
      return false;
    }

    this.controlPoints = pts;
    this.weightsX = wx;
    this.weightsY = wy;
    this.isFitted = true;
    this.residualError = this.computeResidual(calibrationPoints);
    return true;
  }

  correct(normX: number, normY: number): [number, number] {
    if (!this.isFitted) return [normX, normY];

    const n = this.controlPoints.length;
    // Once affine taban uygulanir: a0 + a1*x + a2*y.
    let cx = this.weightsX[n] + this.weightsX[n + 1] * normX + this.weightsX[n + 2] * normY;
    let cy = this.weightsY[n] + this.weightsY[n + 1] * normX + this.weightsY[n + 2] * normY;

    // Ardindan her kontrol noktasinin radial etkisi eklenir. Noktaya yakin bolgeler
    // daha cok, uzak bolgeler daha yumusak etkilenir.
    for (let i = 0; i < n; i++) {
      const dx = normX - this.controlPoints[i][0];
      const dy = normY - this.controlPoints[i][1];
      const k = this.kernel(dx * dx + dy * dy);
      cx += this.weightsX[i] * k;
      cy += this.weightsY[i] * k;
    }

    // Sayisal patlama olursa ham koordinata geri don. Bu fail-safe, kalibrasyon
    // katsayisi bozuldu diye kullanicinin gaze akisini tamamen bozmaz.
    if (!isFinite(cx) || !isFinite(cy)) return [normX, normY];
    return [cx, cy];
  }

  getResidualError(): number {
    return this.residualError;
  }

  isReady(): boolean {
    return this.isFitted;
  }

  reset(): void {
    this.controlPoints = [];
    this.weightsX = [];
    this.weightsY = [];
    this.isFitted = false;
    this.residualError = Infinity;
  }

  private computeResidual(points: CalibrationPoint[]): number {
    // Fit'in kendi noktalarinda ortalama hatasini olcer. GazePipeline bu degeri
    // kullanarak asiri kotu fit'i reddeder.
    let total = 0;
    for (const cp of points) {
      const [cx, cy] = this.correct(cp.predictedNormX, cp.predictedNormY);
      total += Math.sqrt((cx - cp.targetNormX) ** 2 + (cy - cp.targetNormY) ** 2);
    }
    return total / points.length;
  }

  private solveLinear(A: number[][], b: number[], n: number): number[] | null {
    // Basit Gauss-Jordan eliminasyonu. Matris boyutu kalibrasyon nokta sayisi kadar
    // kucuk oldugu icin burada ek kutuphane kullanmadan cozum yeterli.
    const aug: number[][] = A.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < n; col++) {
      let maxRow = col;
      let maxVal = Math.abs(aug[col][col]);
      for (let row = col + 1; row < n; row++) {
        const val = Math.abs(aug[row][col]);
        if (val > maxVal) { maxVal = val; maxRow = row; }
      }
      // Pivot cok kucukse matris tekil/kararsizdir. Bu genelde ayni noktalar,
      // collinear hedefler veya bozuk kalibrasyon verisi anlamina gelir.
      if (maxVal < 1e-12) return null;
      if (maxRow !== col) [aug[col], aug[maxRow]] = [aug[maxRow], aug[col]];

      const pivot = aug[col][col];
      for (let j = col; j <= n; j++) aug[col][j] /= pivot;
      for (let row = 0; row < n; row++) {
        if (row === col) continue;
        const factor = aug[row][col];
        for (let j = col; j <= n; j++) aug[row][j] -= factor * aug[col][j];
      }
    }

    return aug.map(row => row[n]);
  }
}
