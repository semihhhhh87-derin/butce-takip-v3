import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");

function section(start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `${start} bölümü bulunamadı`);
  assert.notEqual(to, -1, `${end} bölüm sınırı bulunamadı`);
  return source.slice(from, to);
}

test("ana gezinme beş temel ekranı ve karşılık gelen içerikleri korur", () => {
  const dashboard = section("function Dashboard(", "function Payments(");
  for (const [key, label] of [
    ["ozet", "Özet"],
    ["odemeler", "Ödemeler"],
    ["harcama", "Haftalık"],
    ["aylik", "Aylık"],
    ["ayarlar", "Güncelle"],
  ]) {
    assert.match(dashboard, new RegExp(`\\["${key}", "${label}"\\]`));
    assert.match(dashboard, new RegExp(`tab === "${key}"`));
  }
});

test("oturum geri yükleme ve çıkış yolları birlikte bulunur", () => {
  const homeAndAuth = section("export default function Home()", "function Dashboard(");
  assert.match(homeAndAuth, /getSession\(\)/);
  assert.match(homeAndAuth, /onAuthStateChange/);
  assert.match(source, /supabase\.auth\.signOut\(\)/);
});

test("senkronizasyon uzak değişikliği birleştirir ve başarısız kaydı yeniden dener", () => {
  const dashboard = section("function Dashboard(", "function Payments(");
  assert.match(dashboard, /mergeChanged\(base, next, normalize\(fresh\.data\.payload\)\)/);
  assert.match(dashboard, /retryPendingSave/);
  assert.match(dashboard, /pendingSaveRef\.current/);
  assert.match(dashboard, /\.channel\(`budget-state-\$\{family\}`\)/);
});

test("ödeme silme güvenli ve tam silme seçeneklerini ayrı tutar", () => {
  const payments = section("function Payments(", "function PaymentForm(");
  assert.match(payments, /doDelete\(true\)/);
  assert.match(payments, /Planı kaldır, geçmişi koru/);
  assert.match(payments, /doDelete\(false\)/);
  assert.match(payments, /Her şeyi sil/);
  assert.match(payments, /removePaymentDependencies/);
});

test("ödeme formu tutar ve zorunlu alanları doğrular, Android geri hareketini dinler", () => {
  const form = section("function PaymentForm(", "function WeekBox(");
  assert.match(form, /parseTrMoney\(rawBuAy\)/);
  assert.match(form, /Ödeme adı zorunludur/);
  assert.match(form, /Tutar sıfır veya daha büyük olmalıdır/);
  assert.match(form, /window\.history\.pushState/);
  assert.match(form, /window\.addEventListener\("popstate"/);
  assert.match(form, /window\.removeEventListener\("popstate"/);
});

test("harcama girişi geçersiz ve çift kaydı engeller, mobil geri hareketini temizler", () => {
  const expense = section("function WeekBox(", "function Weekly(");
  assert.match(expense, /savingExpense/);
  assert.match(expense, /parseTrMoney\(amount\)/);
  assert.match(expense, /disabled=\{\(parseTrMoney\(amount\) \?\? 0\) <= 0 \|\| savingExpense\}/);
  assert.match(expense, /window\.addEventListener\("popstate"/);
  assert.match(expense, /window\.removeEventListener\("popstate"/);
});

test("haftalık kayıt düzenleme ve silme açık onay akışlarını korur", () => {
  const weekly = section("function Weekly(", "function Update(");
  assert.match(weekly, /Harcama düzeltildi/);
  assert.match(weekly, /setConfirmDelete\(r\)/);
  assert.match(weekly, /kalıcı olarak silinecek\. Emin misiniz/);
  assert.match(weekly, /Evet, sil/);
  assert.match(weekly, /Vazgeç/);
});

test("güncelleme ekranı banka, kart, hedef, maaş ve cüzdan işlemlerini korur", () => {
  const update = section("function Update(", "function Field(");
  for (const message of [
    "Banka fotoğrafı güncellendi",
    "YK kart ve hesap özeti güncellendi",
    "Haftalık hedefler güncellendi",
    "Maaş takvimi güncellendi",
    "Cüzdan takibi açıldı",
  ]) assert.match(update, new RegExp(message));
  assert.match(update, /Geçerli bir başlangıç tarihi seçin/);
  assert.match(update, /Hesap kesim tarihi zorunludur/);
});

test("tarih ve para alanları uygun HTML giriş türlerini kullanır", () => {
  const fields = source.slice(source.indexOf("function Field("));
  assert.match(fields, /inputMode="decimal"/);
  assert.match(fields, /type="date"/);
  assert.match(fields, /parseTrMoney\(input\.value\)/);
});

test("Özet ödeme listesini beş satırla sınırlar ve Ödemeler yalnız ödeme toplamlarını gösterir", () => {
  const dashboard = section("function Dashboard(", "function Payments(");
  const payments = section("function Payments(", "function PaymentForm(");
  assert.match(dashboard, /rows=\{payments\.slice\(0, 5\)\}/);
  assert.match(dashboard, /payments\.length > 5/);
  assert.doesNotMatch(payments, /mSummary\.goal/);
  assert.match(payments, /Ödenen/);
  assert.match(payments, /Bekleyen/);
});
