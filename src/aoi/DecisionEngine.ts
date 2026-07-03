// Dosya ozeti: AOI metriklerini esik tabanli kurallarla kolay, orta veya zor seviyelerine siniflandirir.
import type { AOIMetrics, DifficultyResult } from '../types';

/**
 * DecisionEngine — esik tabanli zorluk siniflandirma.
 * Literatur bulgulari:
 * - Fixation suresi artisi → zorluk (pozitif korelasyon)
 * - Regression orani yuksek → zorluk
 * - Re-reading (revisit) orani yuksek → anlasilmadi
 *
 * Bu sinif makine ogrenmesi modeli degildir. Gaze/ML tarafi yalnizca bakis noktasi
 * uretir; burada ise AOIManager'in cikardigi metrikler aciklanabilir kurallarla
 * yorumlanir. Bu nedenle her sonuc `reasons` ve `triggerMetrics` ile raporda
 * geriye izlenebilir.
 */
export default class DecisionEngine {
  private fixationThreshold: number;
  private regressionThreshold: number;
  private minDataDuration: number;

  /**
   * Esik varsayilanlari — PILOT VERIYLE KALIBRE EDILMEMIS heuristik degerlerdir (Issue 08).
   * Gerekce yon belirtir, mutlak deger iddiasi degildir:
   * - fixThreshold=2000 ms: bir blokta toplam fiksasyon ~2 sn'yi asinca zorlanma sinyali
   *   (fiksasyon suresi artisi ile bilissel yuk pozitif korelasyon). analyze() bunu seans
   *   medyaniyla normalize eder; bu deger yalnizca yeterli aktif bolge yoksa taban olarak kullanilir.
   * - regThreshold=2: blok basina 2'den fazla geri-donus (regression) anlama guclugu gostergesi.
   * - minDataDuration=3000 ms: bu sureden once karar uretilmez (orneklem yetersiz).
   * Mutlak esikler tez kapsaminda pilotla dogrulanmalidir; cikti "kesin sinif" degil guven
   * gostergesi olarak sunulur (bkz. DifficultyResult.confidence, AdaptiveOverlay).
   */
  constructor(
    fixThreshold: number = 2000,
    regThreshold: number = 2,
    minDataDuration: number = 3000,
  ) {
    this.fixationThreshold = fixThreshold;
    this.regressionThreshold = regThreshold;
    this.minDataDuration = minDataDuration;
  }

  analyze(metrics: AOIMetrics[]): DifficultyResult[] {
    // Sadece en az bir fiksasyon alan bolgeler siniflandirilir. Hic bakilmayan
    // bloklar "skipped" isaretiyle ayrilir; bunlari kolay diye kesin yorumlamiyoruz.
    const active = metrics.filter(m => m.fixationCount > 0);

    const fixationThreshold = this.getSessionFixationThreshold(active);

    const classified = active.map(m =>
      this.classifyRegionWithThresholds(m, fixationThreshold, this.regressionThreshold),
    );

    // Hic fiksasyon almayan bloklar: gorulmedi / atlandi.
    // confidence=0 bu bolgelerde karar guveninin olmadigini acikca gosterir.
    const skipped: DifficultyResult[] = metrics
      .filter(m => m.fixationCount === 0)
      .map(m => ({
        regionId: m.regionId,
        level: 'easy' as const,
        confidence: 0,
        reasons: [],
        triggerMetrics: {},
        skipped: true,
      }));

    return [...classified, ...skipped];
  }

  classifyRegion(metric: AOIMetrics): DifficultyResult {
    return this.classifyRegionWithThresholds(metric, this.fixationThreshold, this.regressionThreshold);
  }

  private getSessionFixationThreshold(active: AOIMetrics[]): number {
    if (active.length < 3) return this.fixationThreshold;

    const durations = active
      .filter(m => m.averageFixationDuration > 0)
      .map(m => m.averageFixationDuration)
      .sort((a, b) => a - b);

    if (durations.length === 0) return this.fixationThreshold;

    const median = durations[Math.floor(durations.length / 2)];
    // median*2.5: tipik blogun ~2.5 kati fiksasyon "uzun" sayilir; 1500 ms mutlak taban (heuristik).
    return Math.max(1500, median * 2.5);
  }

  private classifyRegionWithThresholds(
    metric: AOIMetrics,
    fixationThreshold: number,
    regressionThreshold: number,
  ): DifficultyResult {
    // Skor toplama bilincli olarak basit tutuldu. Amac kara kutu bir tahmin
    // degil, sonradan incelenebilir AOI sinyali uretmek.
    const triggers: Record<string, number> = {};
    const reasons: string[] = [];
    let score = 0;

    // Fixation suresi kontrolu: bir blokta uzun toplam bakis, bilissel yuk veya
    // duraksama sinyali olabilir. Tek basina tani/sonuc degildir.
    if (metric.totalFixationTime > fixationThreshold) {
      score += 2;
      reasons.push('Uzun fiksasyon suresi');
      triggers['totalFixationTime'] = metric.totalFixationTime;
    } else if (metric.totalFixationTime > fixationThreshold * 0.6) {
      score += 1;
      triggers['totalFixationTime'] = metric.totalFixationTime;
    }

    // Regression kontrolu: geriye donusler yeniden okuma ihtimalini gosterir.
    if (metric.regressionCount > regressionThreshold) {
      score += 2;
      reasons.push('Yuksek regression sayisi');
      triggers['regressionCount'] = metric.regressionCount;
    } else if (metric.regressionCount > regressionThreshold * 0.5) {
      score += 1;
      triggers['regressionCount'] = metric.regressionCount;
    }

    // Re-reading (revisit) kontrolu: ayni bloga tekrar donmek, ozellikle uzun
    // fiksasyonla birlikteyse zorlanma sinyalini guclendirir.
    if (metric.revisitCount > 2) {
      score += 1;
      reasons.push('Tekrarli okuma');
      triggers['revisitCount'] = metric.revisitCount;
    }

    // Ortalama fixation suresi: tekil fiksasyonlarin uzamasi dikkat/yuk sinyali
    // olarak kullanilir. Bu da sadece egitsel gosterge niteligindedir.
    if (metric.averageFixationDuration > 400) {
      score += 1;
      reasons.push('Yuksek ortalama fiksasyon suresi');
      triggers['averageFixationDuration'] = metric.averageFixationDuration;
    }

    let level: DifficultyResult['level'];
    let confidence: number;

    if (score >= 4) {
      level = 'hard';
      confidence = Math.min(0.95, 0.6 + score * 0.05);
    } else if (score >= 2) {
      level = 'medium';
      confidence = Math.min(0.85, 0.4 + score * 0.1);
    } else {
      level = 'easy';
      confidence = Math.min(0.9, 0.5 + (3 - score) * 0.1);
      if (reasons.length === 0) reasons.push('Normal okuma davranisi');
    }

    return {
      regionId: metric.regionId,
      level,
      confidence,
      reasons,
      triggerMetrics: triggers,
    };
  }

  /**
   * Seans ortalama metriklerine gore thresholdlari ayarla.
   * Bireysel farkliliklari absorbe etmek icin.
   */
  /** @deprecated Karar 11 — pilot verisiyle kişisel kalibrasyon için Faz 4 sonrası kullanılacak */
  adjustThresholds(sessionAverage: AOIMetrics): void {
    if (sessionAverage.totalFixationTime > 0) {
      this.fixationThreshold = Math.max(3000, sessionAverage.totalFixationTime * 1.5);
    }
    if (sessionAverage.regressionCount > 0) {
      this.regressionThreshold = Math.max(2, sessionAverage.regressionCount * 1.5);
    }
  }

  hasEnoughData(sessionDuration: number): boolean {
    return sessionDuration >= this.minDataDuration;
  }
}
