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

// --- Écran "Tendance" -------------------------------------------------
// Calcule directement les points SVG (polyline) pour chaque candidat,
// pour éviter de faire des maths dans le Liquid de TRMNL.
function calculerTendance(polls, tour) {
  const pourTour = polls.filter((p) => p.tour === tour);
  const dates = [...new Set(pourTour.map((p) => p.fin_enquete))].sort();
  const dernieresDates = dates.slice(-8);
  if (dernieresDates.length < 2) return null;

  const snapshotParDate = dernieresDates.map((d) => {
    const ceJourLa = pourTour.filter((p) => p.fin_enquete === d);
    ceJourLa.sort((a, b) => b.candidats.length - a.candidats.length);
    return { date: d, poll: ceJourLa[0] };
  });

  const dernierPoll = snapshotParDate[snapshotParDate.length - 1].poll;
  const top4Ids = [...dernierPoll.candidats]
    .sort((a, b) => b.intentions - a.intentions)
    .slice(0, 4)
    .map((c) => c.candidate_id);

  const LARGEUR = 700;
  const HAUTEUR = 320;
  const MARGE_X = 10;
  const MARGE_DROITE = 140; // réserve la place pour les étiquettes de fin de ligne
  const MARGE_Y = 16;
  const n = dernieresDates.length;

  let toutesValeurs = [];
  const brut = top4Ids.map((id) => {
    const ref = dernierPoll.candidats.find((c) => c.candidate_id === id);
    const vals = snapshotParDate.map((s) => {
      const c = s.poll.candidats.find((cc) => cc.candidate_id === id);
      if (c) toutesValeurs.push(c.intentions);
      return c ? c.intentions : null;
    });
    return { id, nom_court: ref.surname || ref.complete_name, parti: ref.parti, vals };
  });

  const minV = Math.floor(Math.min(...toutesValeurs) - 1.5);
  const maxV = Math.ceil(Math.max(...toutesValeurs) + 1.5);

  const xFor = (i) => MARGE_X + (i * (LARGEUR - MARGE_DROITE - MARGE_X)) / (n - 1);
  const yFor = (v) => HAUTEUR - MARGE_Y - ((v - minV) / (maxV - minV)) * (HAUTEUR - 2 * MARGE_Y);

  const styles = ["plein", "tirets", "gris", "pointille"];
  const series = brut.map((s, idx) => {
    const pts = [];
    s.vals.forEach((v, i) => {
      if (v !== null) pts.push(`${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`);
    });
    const derniereVal = [...s.vals].reverse().find((v) => v !== null);
    const pointY = yFor(derniereVal);
    return {
      nom_court: s.nom_court,
      parti: s.parti,
      points: pts.join(" "),
      style: styles[idx] || "plein",
      derniere_valeur: derniereVal,
      derniere_x: xFor(n - 1).toFixed(1),
      point_y: pointY.toFixed(1),
      label_y: pointY,
    };
  });

  // Évite que les étiquettes de fin de ligne se chevauchent quand deux
  // candidats ont des scores proches : on les trie par position verticale
  // puis on impose un écart minimum entre étiquettes consécutives (le
  // point sur la courbe, lui, reste à sa vraie position).
  const ECART_MIN_LABEL = 26;
  const parY = [...series].sort((a, b) => a.label_y - b.label_y);
  for (let i = 1; i < parY.length; i++) {
    if (parY[i].label_y - parY[i - 1].label_y < ECART_MIN_LABEL) {
      parY[i].label_y = parY[i - 1].label_y + ECART_MIN_LABEL;
    }
  }
  series.forEach((s) => {
    s.label_y = s.label_y.toFixed(1);
  });

  return {
    largeur: LARGEUR,
    hauteur: HAUTEUR,
    date_debut: dernieresDates[0],
    date_fin: dernieresDates[dernieresDates.length - 1],
    series,
  };
}

// --- Écran "Toutes les hypothèses" ------------------------------------
function calculerToutesHypotheses(polls, tour) {
  const vague = vagueLaPlusRecente(polls, tour);
  if (vague.length === 0) return [];
  const parNb = [...vague].sort((a, b) => b.candidats.length - a.candidats.length);
  const principale = parNb[0];
  return parNb.map((p) => ({
    hypothese: p.hypothese,
    reference: p.hypothese === principale.hypothese,
    description:
      p.hypothese === principale.hypothese ? "Hypothèse de référence" : decrireDifference(principale, p),
    candidats: formatCandidats(p, 3),
  }));
}

// --- Écran "Comparatif instituts" -------------------------------------
function calculerComparatifInstituts(polls, tour, max) {
  const pourTour = polls.filter((p) => p.tour === tour);
  const parInstitut = {};
  pourTour.forEach((p) => {
    const cur = parInstitut[p.institut];
    if (
      !cur ||
      p.fin_enquete > cur.fin_enquete ||
      (p.fin_enquete === cur.fin_enquete && p.candidats.length > cur.candidats.length)
    ) {
      parInstitut[p.institut] = p;
    }
  });
  return Object.values(parInstitut)
    .sort((a, b) => b.fin_enquete.localeCompare(a.fin_enquete))
    .slice(0, max)
    .map((p) => ({
      institut: p.institut,
      fin_enquete: p.fin_enquete,
      candidats: formatCandidats(p, 3),
    }));
}

// --- Écran "Grille des duels 2nd tour" --------------------------------
function calculerGrilleDuels(polls, max) {
  const vague = vagueLaPlusRecente(polls, "2nd Tour");
  return vague
    .map((p) => {
      const tries = [...p.candidats].sort((a, b) => b.intentions - a.intentions);
      const ecart = tries.length === 2 ? Math.round((tries[0].intentions - tries[1].intentions) * 10) / 10 : null;
      return {
        hypothese: p.hypothese,
        ecart,
        candidats: tries.map((c) => ({
          nom_court: c.surname || c.complete_name,
          parti: c.parti,
          intentions: c.intentions,
        })),
      };
    })
    .sort((a, b) => (a.ecart ?? 999) - (b.ecart ?? 999))
    .slice(0, max);
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
    // Écrans additionnels, pilotés par le champ de config TRMNL "ecran"
    tendance_t1: calculerTendance(polls, "1er Tour"),
    toutes_hypotheses_t1: calculerToutesHypotheses(polls, "1er Tour"),
    comparatif_instituts_t1: calculerComparatifInstituts(polls, "1er Tour", 6),
    grille_duels_t2: calculerGrilleDuels(polls, 4),
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
