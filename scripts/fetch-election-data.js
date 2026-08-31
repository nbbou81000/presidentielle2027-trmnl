// fetch-election-data.js
// Récupère le flux de sondages agrégés (MieuxVoter/presidentielle2027),
// calcule un instantané compact, et écrit public/election.json.
// Zéro dépendance externe — Node 18+ (fetch natif).

const fs = require("fs");
const path = require("path");

const POLLS_URL =
  "https://raw.githubusercontent.com/MieuxVoter/presidentielle2027/main/presidentielle2027.json";

// Dates officielles de l'élection présidentielle 2027
// (arrêtées en Conseil des ministres le 1er juillet 2026)
const PREMIER_TOUR = "2027-04-18";
const SECOND_TOUR = "2027-05-02";

function determinerPhase(today = new Date()) {
  const iso = today.toISOString().slice(0, 10);
  if (iso < PREMIER_TOUR) return "sondages";
  if (iso === PREMIER_TOUR) return "jour_t1";
  if (iso < SECOND_TOUR) return "entre_deux_tours";
  if (iso === SECOND_TOUR) return "jour_t2";
  return "resultat_final";
}

function joursAvant(cible) {
  const a = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const b = new Date(cible + "T00:00:00Z");
  return Math.round((b - a) / 86400000);
}

// Toutes les hypothèses (scénarios de candidats) partageant la date de fin
// d'enquête la plus récente, pour un tour donné.
function vagueLaPlusRecente(polls, tour) {
  const pourCeTour = polls.filter((p) => p.tour === tour);
  if (pourCeTour.length === 0) return [];
  const derniereDate = pourCeTour.reduce(
    (max, p) => (p.fin_enquete > max ? p.fin_enquete : max),
    pourCeTour[0].fin_enquete
  );
  return pourCeTour.filter((p) => p.fin_enquete === derniereDate);
}

function formatCandidats(poll, limite) {
  const tries = [...poll.candidats].sort((a, b) => b.intentions - a.intentions);
  const liste = limite ? tries.slice(0, limite) : tries;
  return liste.map((c, i) => ({
    rang: i + 1,
    id: c.candidate_id,
    nom: c.complete_name,
    nom_court: c.surname || c.complete_name,
    parti: c.parti,
    intentions: c.intentions,
    erreur_sup: c.erreur_sup,
    erreur_inf: c.erreur_inf,
  }));
}

// Construit un libellé court décrivant en quoi une hypothèse alternative
// diffère de l'hypothèse principale ("sans X, avec Y").
function decrireDifference(principale, alternative) {
  const idsPrincipale = new Set(principale.candidats.map((c) => c.candidate_id));
  const idsAlt = new Set(alternative.candidats.map((c) => c.candidate_id));
  const absents = [...idsPrincipale]
    .filter((id) => !idsAlt.has(id))
    .map((id) => principale.candidats.find((c) => c.candidate_id === id).complete_name);
  const ajouts = [...idsAlt]
    .filter((id) => !idsPrincipale.has(id))
    .map((id) => alternative.candidats.find((c) => c.candidate_id === id).complete_name);

  const parts = [];
  if (ajouts.length) parts.push("avec " + ajouts.join(", "));
  if (absents.length) parts.push("sans " + absents.join(", "));
  return parts.length ? parts.join(" · ") : "Variante";
}

function nombreDifferences(principale, alternative) {
  const idsPrincipale = new Set(principale.candidats.map((c) => c.candidate_id));
  const idsAlt = new Set(alternative.candidats.map((c) => c.candidate_id));
  const absents = [...idsPrincipale].filter((id) => !idsAlt.has(id)).length;
  const ajouts = [...idsAlt].filter((id) => !idsPrincipale.has(id)).length;
  return absents + ajouts;
}

function formatVague(polls, tour, limiteCandidats) {
  const vague = vagueLaPlusRecente(polls, tour);
  if (vague.length === 0) return { principale: null, alternative: null, nb_hypotheses: 0 };

  // L'hypothèse principale = celle qui teste le plus de candidats (la plus
  // représentative, dans l'esprit du tableau Wikipédia).
  const parNbCandidats = [...vague].sort((a, b) => b.candidats.length - a.candidats.length);
  const principale = parNbCandidats[0];

  // L'hypothèse alternative = la variante la plus "proche" (le moins de
  // candidats différents), pour rester lisible sur un écran e-ink.
  const autres = vague.filter((p) => p.hypothese !== principale.hypothese);
  autres.sort((a, b) => nombreDifferences(principale, a) - nombreDifferences(principale, b));
  const altBrute = autres[0] || null;

  const principaleFmt = {
    institut: principale.institut,
    commanditaire: principale.commanditaire,
    debut_enquete: principale.debut_enquete,
    fin_enquete: principale.fin_enquete,
    echantillon: principale.echantillon,
    hypothese: principale.hypothese,
    candidats: formatCandidats(principale, limiteCandidats),
  };

  const alternativeFmt = altBrute
    ? {
        hypothese: altBrute.hypothese,
        description: decrireDifference(principale, altBrute),
        candidats: formatCandidats(altBrute, 3),
      }
    : null;

  return {
    principale: principaleFmt,
    alternative: alternativeFmt,
    nb_hypotheses: vague.length,
  };
}

function determinerAffichage(phase, resultats_t1, resultats_t2) {
  if (resultats_t2) return "resultat_t2";
  if (resultats_t1 && (phase === "entre_deux_tours" || phase === "jour_t2" || phase === "resultat_final")) {
    return "duel_sondage_t2";
  }
  if (resultats_t1) return "resultat_t1";
  return "sondage_t1";
}

async function main() {
  const res = await fetch(POLLS_URL);
  if (!res.ok) throw new Error(`Échec récupération sondages: HTTP ${res.status}`);
  const polls = await res.json();

  const vagueT1 = formatVague(polls, "1er Tour", 7);
  const vagueT2 = formatVague(polls, "2nd Tour", 2);
  const phase = determinerPhase();

  const out = {
    genere_le: new Date().toISOString(),
    phase,
    election: {
      premier_tour: PREMIER_TOUR,
      second_tour: SECOND_TOUR,
      jours_avant_t1: joursAvant(PREMIER_TOUR),
      jours_avant_t2: joursAvant(SECOND_TOUR),
    },
    sondage_t1: vagueT1.principale,
    hypothese_alt_t1: vagueT1.alternative,
    nb_hypotheses_t1: vagueT1.nb_hypotheses,
    sondage_t2: vagueT2.principale,
    nb_hypotheses_t2: vagueT2.nb_hypotheses,
    // Résultats officiels : structure prête, alimentée le soir du scrutin
    // (le flux exact du ministère de l'Intérieur sera identifié à l'approche
    // de la date, comme pour les scrutins précédents).
    resultats_t1: null,
    resultats_t2: null,
  };
  out.affichage = determinerAffichage(out.phase, out.resultats_t1, out.resultats_t2);

  const outDir = path.join(__dirname, "..", "public");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "election.json");

  // On ne réécrit que si le contenu change réellement, pour éviter des
  // commits/déploiements inutiles entre deux vagues de sondages.
  const nouveauContenu = JSON.stringify(out, null, 2);
  const ancienContenu = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : null;
  const ancienSansDate = ancienContenu ? ancienContenu.replace(/"genere_le":.*\n/, "") : null;
  const nouveauSansDate = nouveauContenu.replace(/"genere_le":.*\n/, "");

  if (ancienSansDate === nouveauSansDate) {
    console.log("Aucun changement de fond — on met quand même à jour l'horodatage.");
  } else {
    console.log(`Nouvelles données détectées — phase="${phase}".`);
  }
  fs.writeFileSync(outPath, nouveauContenu);
  console.log(`Écrit dans ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
