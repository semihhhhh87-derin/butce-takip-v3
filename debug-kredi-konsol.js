// Bu kodu tarayıcı konsoluna yapıştır (uygulama açıkken)
// window.__budgetData__ değişkenini page.tsx'te set etmemiz lazım
// Şimdilik mevcut state'i okuyalım:

// 1. Haftalık hedefler
const d = window.__bd__;
if (!d) {
  console.warn("window.__bd__ yok. page.tsx'e eklemem lazım.");
} else {
  const kart = d.haftalik_hedefler?.kart;
  const nakit = d.haftalik_hedefler?.nakit;
  const milat = d.butce_plani?.butce_baslangic_tarihi;
  const kapanislar = d.haftalik_kapanislar || {};

  console.log("Kart hedef:", kart);
  console.log("Nakit hedef:", nakit);
  console.log("Milat:", milat);
  console.log("Kapalı haftalar:");
  for (const [k, c] of Object.entries(kapanislar)) {
    console.log(` ${c.baslangic} → ${c.bitis} | kart: ${c.kart} | nakit: ${c.nakit}`);
  }

  // Bu hafta harcamalar (17-23 Ağ)
  const buHafta = (d.haftalik_harcamalar || []).filter(r => r.tarih >= "2026-08-17" && r.tarih <= "2026-08-23");
  let kt = 0, nt = 0;
  for (const r of buHafta) {
    if (r.tur === "kart") kt += Number(r.tutar) || 0;
    if (r.tur === "nakit") nt += Number(r.tutar) || 0;
  }
  console.log(`Bu hafta kart: ${kt.toFixed(2)} TL, nakit: ${nt.toFixed(2)} TL`);
}
