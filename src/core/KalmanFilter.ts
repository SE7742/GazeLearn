// Dosya ozeti: Tek eksende pozisyon ve hiz durumunu izleyen 1D Kalman filtresini uygular.
import type { KalmanState } from '../types';

/**
 * KalmanFilter - tek eksenli, iki durumlu (position + velocity) Kalman filtresi.
 *
 * Bu sinif gaze noktasini "ham model ciktisi" olarak degil, zaman icinde hareket
 * eden bir sinyal olarak ele alir. GazePipeline bu siniftan iki tane olusturur:
 * biri normalize X, digeri normalize Y ekseni icin.
 *
 * Neden merkezi pipeline'da?
 * WebEyeTrack kutuphanesinin kendi Kalman filtresi bu projede devre disi. Filtreleme
 * burada tutulunca debug paneli, benchmark ve kalite metrikleri ayni kaynaktan okunur.
 *
 * State:
 * - x: tahmini konum
 * - vx: tahmini hiz
 * - p/pv/pvx: konum, hiz ve capraz kovaryans belirsizlikleri
 *
 * q = process noise: kullanicinin bakisinin gercekten hareket etme payi.
 * r = measurement noise: webcam + BlazeGaze olcumunun guvenilmezlik payi.
 */
export default class KalmanFilter {
  // Son tahmini konum. Normalize gaze uzayinda calisir; piksel degildir.
  private x: number = 0;
  // Son tahmini hiz. Ani saccade hareketlerinde filtre gecikmesini azaltir.
  private vx: number = 0;
  // Konum belirsizligi. Buyukse yeni olcume daha cok guvenilir.
  private p: number = 1;
  // Hiz belirsizligi. Hareketin ne kadar serbest degisebilecegini belirler.
  private pv: number = 1;
  // Konum-hiz ortak belirsizligi. Pozisyon olcumuyle hiz state'ini de gunceller.
  private pvx: number = 0;
  private lastTimestamp: number = -1;
  private initialized: boolean = false;

  constructor(
    private q: number = 1e-4,
    private r: number = 0.01,
    private velocityNoiseFactor: number = 0.1,
  ) {
    this.r = Math.max(r, 1e-10);
    this.q = Math.max(q, 0);
  }

  /**
   * Predict step: hic yeni olcum yokmus gibi dt saniye ileri tahmin eder.
   *
   * Formul:
   * x'  = x + vx * dt
   * vx' = vx
   *
   * Bu adim goz sabitken jitter'i azaltir; goz hareketliyken hiz state'i sayesinde
   * filtre yeni konuma tamamen gec kalmaz.
   */
  predict(dt: number): number {
    if (dt <= 0) return this.x;

    this.x = this.x + this.vx * dt;

    // P' = F P F^T + Q.
    // 2x2 covariance'i manuel aciyoruz; matris kutuphanesi kullanmak yerine bu
    // kucuk hesap runtime'da daha hizli ve allocation uretmiyor.
    const p00 = this.p + 2 * dt * this.pvx + dt * dt * this.pv + this.q;
    const p01 = this.pvx + dt * this.pv;
    const p11 = this.pv + this.q * this.velocityNoiseFactor;

    this.p = p00;
    this.pvx = p01;
    this.pv = p11;

    return this.x;
  }

  /**
   * Update step: yeni olcumu state'e katar.
   *
   * H = [1, 0] oldugu icin sistem yalnizca pozisyonu olcer; hiz dogrudan olculmez.
   * `kv` kazanci pozisyon hatasindan hiz state'ine pay aktarir.
   */
  update(measurement: number): number {
    const s = this.p + this.r;
    const kx = this.p / s;
    const kv = this.pvx / s;

    // Innovation = mevcut tahmin ile BlazeGaze/Webcam olcumu arasindaki fark.
    // Kalman kazanci bu farkin ne kadarinin state'e yazilacagini belirler.
    const innovation = measurement - this.x;

    this.x = this.x + kx * innovation;
    this.vx = this.vx + kv * innovation;

    const p00 = (1 - kx) * this.p;
    const p01 = (1 - kx) * this.pvx;
    const p11 = this.pv - kv * this.pvx;

    this.p = Math.max(p00, 1e-12);
    this.pvx = p01;
    this.pv = Math.max(p11, 1e-12);

    return this.x;
  }

  /**
   * Tek frame icin predict + update adimini calistirir.
   *
   * Ilk frame'de onceki state olmadigi icin filtre dogrudan olcumle baslar.
   * Sonraki frame'lerde timestamp farkindan dt hesaplanir. dt anormal derecede
   * buyukse (sekme arka plana atildi, kamera durdu vb.) predict atlanir; aksi halde
   * eski hiz bilgisi yeni hedefin ilk sample'larini bozabilir.
   */
  step(measurement: number, timestamp: number): number {
    if (!isFinite(measurement) || !isFinite(timestamp)) {
      return this.x;
    }

    if (!this.initialized) {
      this.x = measurement;
      this.vx = 0;
      this.p = 1;
      this.pv = 1;
      this.pvx = 0;
      this.lastTimestamp = timestamp;
      this.initialized = true;
      return this.x;
    }

    const dt = (timestamp - this.lastTimestamp) / 1000;
    this.lastTimestamp = timestamp;

    if (dt > 0 && dt < 2) {
      this.predict(dt);
    }

    return this.update(measurement);
  }

  reset(): void {
    // Kalibrasyon hedefi degistiginde reset cagirilir. Aksi halde onceki hedefe
    // dogru olusan hiz/momentum yeni hedefin ilk sample'larini kirletir.
    this.x = 0;
    this.vx = 0;
    this.p = 1;
    this.pv = 1;
    this.pvx = 0;
    this.lastTimestamp = -1;
    this.initialized = false;
  }

  getState(): KalmanState {
    return { x: this.x, p: this.p, vx: this.vx };
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
