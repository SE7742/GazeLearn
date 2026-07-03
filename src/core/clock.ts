// Dosya ozeti: Sistem saatindeki geri alma etkilerinden korunmak icin monotonik zaman yardimcisi saglar.
/**
 * Monotonik zaman kaynagi (D3).
 *
 * Date.now() kullanici sistemi saatine baglidir; NTP senkronu, DST veya manuel
 * saat degisimi suresince **geri sayabilir**. Bu yuzden seans sureleri, drift
 * penceresi, "time-to-first-fixation" gibi hesaplamalarda performance.now()
 * tercih edilir — sayfa yuklemesinden itibaren monotonic artan ms degerini verir.
 *
 * SessionData.date gibi "kullaniciya gosterilecek mutlak zaman damgasi" icin
 * hala Date.now() kullanilir; clock.ts sadece sure olcumleri icin.
 */
export function monotonicNow(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}
