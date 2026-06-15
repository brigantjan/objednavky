// =====================================================================
// KONFIGURÁCIA - doplň svoje údaje z Supabase projektu "dispecing-dev"
//
// 1) PROJECT URL:
//    V Supabase dashboarde projektu dispecing-dev klikni vpravo hore na
//    zelené tlačidlo "Connect" -> v hornej časti je "Project URL"
//    (tvar https://xxxxxxxx.supabase.co).
//
// 2) KĻÚČ (anon / publishable key):
//    Settings -> API Keys.
//    - Ak vidíš záložku "API Keys" a v nej "Publishable key"
//      (tvar sb_publishable_...) -> skopíruj tento. Ak tam žiadny nie
//      je, klikni "Create new API Keys" a potom skopíruj Publishable key.
//    - Ak má projekt len záložku "Legacy API Keys", skopíruj odtiaľ
//      "anon" / "anon public" key (tvar dlhého JWT reťazca eyJ...).
//
// Tento kľúč je VEREJNÝ a je v poriadku, že je tu vidieť - bez
// prihlásenia (email+heslo) sa cez neho nedá prečítať ani zapísať
// žiadny záznam (chráni to Row Level Security v databáze).
// =====================================================================

const SUPABASE_URL = "https://qpzktpuiyqwujbfhvxnb.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_B-2vQMUsXudJCUKSZFYTKg_RrXwf2_o";

// Schéma, v ktorej žije objednávkový systém (nie "public")
const SUPABASE_SCHEMA = "objednavky";
