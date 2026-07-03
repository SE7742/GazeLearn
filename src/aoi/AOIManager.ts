// Dosya ozeti: DOM bloklarini AOI bolgelerine baglar ve fiksasyon, revisit, regression gibi bolge metriklerini hesaplar.
import type { AOIRegion, AOIMetrics, Fixation } from '../types';
import { monotonicNow } from '../core/clock';

/**
 * AOIManager — DOM elementleri uzerinde bolge yonetimi.
 * hitTest ile fixation-to-region esleme, regression tespiti,
 * adaptif boyut (A3 bulgusu: min ~300px).
 * ResizeObserver ile rect guncellemesi.
 *
 * AOI = Area of Interest. Bu projede her ders blogu (paragraf, gorsel, formul,
 * soru) bir AOI bolgesidir. GazePipeline piksel koordinati uretir; AOIManager bu
 * koordinatin hangi ders bloguna denk geldigini hesaplar.
 *
 * Cikti metrikleri dogrudan egitsel karar degildir. DecisionEngine bu metrikleri
 * yorumlayarak "zor/orta/kolay" sonucunu uretir.
 */
export default class AOIManager {
  private regions = new Map<string, AOIRegion>();
  private metrics = new Map<string, AOIMetrics>();
  private adaptiveScale = 1;
  private observer: ResizeObserver | null = null;
  private lastVisitedRegionId: string | null = null;
  // O9: revisit tespiti tarihsel; Set ile O(1) uyelik kontrolu.
  private everVisitedRegions: Set<string> = new Set();
  private sessionStartTime = 0;
  private scrollHandler: (() => void) | null = null;

  constructor() {
    // D3: monotonik saat — saat geri alinsa bile duration negatif olmaz.
    this.sessionStartTime = monotonicNow();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.updateRects());
    }
    if (typeof window !== 'undefined') {
      this.scrollHandler = () => this.updateRects();
      window.addEventListener('scroll', this.scrollHandler, { passive: true });
    }
  }

  registerRegion(element: HTMLElement, id: string, label: string, category: AOIRegion['category'], orderIndex?: number): void {
    // React render sonrasi her ders blogunun DOM elementi buraya kaydedilir.
    // orderIndex okuma sirasi icindir; regression tespiti bu sira uzerinden yapilir.
    const existing = this.regions.get(id);
    if (existing) {
      this.observer?.unobserve(existing.element);
    }

    const region: AOIRegion = {
      id,
      element,
      rect: element.getBoundingClientRect(),
      label,
      category,
      orderIndex: orderIndex ?? this.regions.size,
    };
    this.regions.set(id, region);
    if (!this.metrics.has(id)) {
      this.metrics.set(id, this.createEmptyMetrics(id));
    }
    this.observer?.observe(element);
  }

  removeRegion(id: string): void {
    const region = this.regions.get(id);
    if (region) {
      this.observer?.unobserve(region.element);
      this.regions.delete(id);
      this.metrics.delete(id);
    }
  }

  updateRects(): void {
    for (const region of this.regions.values()) {
      region.rect = region.element.getBoundingClientRect();
    }
  }

  hitTest(pixelX: number, pixelY: number): AOIRegion | null {
    // Hit-test once gercek rect icinde tam isabet arar. Isabet yoksa kalibrasyon
    // hatasina gore genisletilmis "halo" alani denenir.
    let best: AOIRegion | null = null;
    let bestDist = Infinity;
    for (const region of this.regions.values()) {
      const r = region.rect;
      // Tam isabet (padding'siz rect): bloklar ayrik oldugundan tekil — dogrudan don.
      if (pixelX >= r.left && pixelX <= r.right && pixelY >= r.top && pixelY <= r.bottom) {
        return region;
      }
      const pad = (this.adaptiveScale - 1) * Math.min(r.width, r.height) * 0.5;
      if (
        pixelX >= r.left - pad &&
        pixelX <= r.right + pad &&
        pixelY >= r.top - pad &&
        pixelY <= r.bottom + pad
      ) {
        // Haleler cakisirsa rect'e en yakin bolge kazanir — buyuk gorsel AOI'nin
        // genis halesi kucuk yazi blogunu golgelemesin.
        const dx = Math.max(r.left - pixelX, 0, pixelX - r.right);
        const dy = Math.max(r.top - pixelY, 0, pixelY - r.bottom);
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = region;
        }
      }
    }
    return best;
  }

  /**
   * Fixation'i ilgili bolgeye kaydet.
   * Regression, entry, revisit ve transition sayilarini gunceller.
   */
  recordFixation(fixation: Fixation): void {
    const region = this.hitTest(fixation.x, fixation.y);
    if (!region) return;

    const m = this.metrics.get(region.id);
    if (!m) return;

    m.fixationCount++;
    m.totalFixationTime += fixation.duration;
    m.averageFixationDuration = m.totalFixationTime / m.fixationCount;

    // Esleme guven skoru: merkeze uzaklik / yaricap. 1=merkez, 0=kenar.
    // Dusuk ortalama guven, AOI'nin genisletilmis halo ile yakalandigini ve metriklerin
    // daha dikkatli yorumlanmasi gerektigini gosterir.
    const r = region.rect;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const halfDiag = Math.hypot(r.width, r.height) / 2;
    const dist = Math.hypot(fixation.x - cx, fixation.y - cy);
    const matchConf = halfDiag > 0 ? Math.max(0, 1 - dist / halfDiag) : 1;
    const prev = m.avgMatchConfidence ?? 0;
    m.avgMatchConfidence = prev + (matchConf - prev) / m.fixationCount;

    if (m.firstFixationTime === 0) {
      m.firstFixationTime = fixation.startTime;
      m.timeToFirstFixation = fixation.startTime - this.sessionStartTime;
    }

    // Entry / revisit tracking — revisit tarihsel Set uzerinden (O9); trim etkilemez.
    if (this.lastVisitedRegionId !== region.id) {
      m.entryCount++;
      if (this.everVisitedRegions.has(region.id)) {
        m.revisitCount++;
      } else {
        this.everVisitedRegions.add(region.id);
      }
      if (this.lastVisitedRegionId) {
        const prevM = this.metrics.get(this.lastVisitedRegionId);
        if (prevM) prevM.transitionCount++;
      }
    }

    // Regression tespiti: okuma sirasinda geriye saccade (B6).
    // Bu tek basina yorumlanacak bir sonuc degil; bolgeye geri donus davranisini
    // gosteren AOI sinyalidir.
    if (this.detectRegression(region.id)) {
      m.regressionCount++;
    }

    this.lastVisitedRegionId = region.id;
  }

  /**
   * Regression: son ziyaret edilen bolgeye gore okuma sirasinda geriye hareket.
   * Mevcut bolgenin orderIndex'i bir onceki bolgenin orderIndex'inden kucukse
   * regression — visitSequence yerine orderIndex karsilastirmasi kullanilir.
   */
  detectRegression(currentRegionId: string): boolean {
    if (!this.lastVisitedRegionId || this.lastVisitedRegionId === currentRegionId) return false;
    const cur = this.regions.get(currentRegionId);
    const last = this.regions.get(this.lastVisitedRegionId);
    if (!cur || !last) return false;
    return cur.orderIndex < last.orderIndex;
  }

  getMetrics(regionId: string): AOIMetrics | null {
    return this.metrics.get(regionId) ?? null;
  }

  getAllMetrics(): AOIMetrics[] {
    return Array.from(this.metrics.values());
  }

  /**
   * Kalibrasyon hatasina gore adaptif boyut ayarla (A3).
   * < 100px → scale 1.0 (kucuk AOI)
   * 100-200px → scale 1.3 (orta)
   * > 200px → scale 1.6 (buyuk)
   */
  setAdaptiveScale(calibrationError: number): void {
    // Kalibrasyon hatasi buyukse gaze noktasi dogru blogun hemen disina dusebilir.
    // AOI halo'sunu buyutmek bu durumda false negative'i azaltir; cok buyutmek ise
    // yanlis bloga esleme riskini artirir. Bu nedenle uc seviyeli kontrollu scale kullanilir.
    // EC-10a: negatif veya gecersiz deger → hata bilinmiyor, guvenli varsayilan.
    const err = isFinite(calibrationError) && calibrationError >= 0 ? calibrationError : 0;
    if (err < 100) {
      this.adaptiveScale = 1.0;
    } else if (err < 200) {
      this.adaptiveScale = 1.3;
    } else {
      this.adaptiveScale = 1.6;
    }
  }

  reset(): void {
    for (const [id] of this.metrics) {
      this.metrics.set(id, this.createEmptyMetrics(id));
    }
    this.lastVisitedRegionId = null;
    this.everVisitedRegions.clear();
    this.sessionStartTime = monotonicNow();
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.scrollHandler) {
      window.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }
    this.regions.clear();
    this.metrics.clear();
  }

  private createEmptyMetrics(regionId: string): AOIMetrics {
    return {
      regionId,
      totalFixationTime: 0,
      fixationCount: 0,
      regressionCount: 0,
      firstFixationTime: 0,
      averageFixationDuration: 0,
      entryCount: 0,
      timeToFirstFixation: 0,
      revisitCount: 0,
      transitionCount: 0,
      avgMatchConfidence: 0,
    };
  }
}
