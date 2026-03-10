import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

const PORT = process.env.PORT || 4173;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const REGIONS = {
  'København': { faktor: 1.2, label: '+20%', note: 'Højere arbejdsløn og adgangsforhold' },
  'Nordsjælland': { faktor: 1.15, label: '+15%', note: 'Tæt på København' },
  'Østsjælland': { faktor: 1.1, label: '+10%', note: 'Forstadsområder' },
  'Vestsjælland': { faktor: 1.0, label: '±0%', note: 'Gennemsnitligt prisniveau' },
  Fyn: { faktor: 1.0, label: '±0%', note: 'Gennemsnitligt prisniveau' },
  'Østjylland': { faktor: 1.0, label: '±0%', note: 'Gennemsnitligt prisniveau' },
  'Midtjylland': { faktor: 0.95, label: '-5%', note: 'Lidt lavere priser' },
  'Nordjylland': { faktor: 0.95, label: '-5%', note: 'Lavere arbejdsløn' },
  'Sønderjylland': { faktor: 0.95, label: '-5%', note: 'Grænseområde' }
};

const roundPrice = (price) => {
  if (price < 1000) return Math.round(price / 50) * 50;
  if (price <= 10000) return Math.round(price / 100) * 100;
  return Math.round(price / 500) * 500;
};

const slugify = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
const titleCase = (s) => s.split(' ').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'LeadBeregnerGenerator/1.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function domainFacts(keyword) {
  const k = keyword.toLowerCase();
  const map = [
    [/varmepumpe/, ['Pris afhænger af type (luft-til-luft, luft-til-vand, jordvarme), kapacitet og installationskompleksitet.', 'Dimensionering efter boligens varmebehov er afgørende for driftøkonomi og komfort.', 'El-arbejde, rørføring og eventuelle fundamentløsninger påvirker slutprisen.', 'Ved varmepumper skal man medregne serviceaftale, støjkrav og placering i forhold til naboer.']],
    [/solceller/, ['Pris påvirkes af paneltype, inverter, taghældning og montagesystem.', 'El-tilslutning, tavlearbejde og dokumentation udgør en væsentlig del af totalprisen.', 'Skyggeforhold og orientering ændrer anlæggets ydelse og tilbagebetalingstid.', 'Batteriløsning øger investeringen, men kan forbedre egenforbrug markant.']],
    [/hegn/, ['Pris afhænger af længde, materialevalg, stolpefundament og terræn.', 'Adgangsforhold og bortkørsel af gammelt hegn kan påvirke timetal markant.', 'Lokale regler for højde, afstand og udtryk kan kræve særlige løsninger.', 'Ved kystnære områder bør man vælge materialer med høj modstand mod vind og fugt.']],
    [/maler|maling/, ['Pris styres af underlagets tilstand, forarbejde og ønsket finish.', 'Antal lag, afdækning og eventuel spartling påvirker timetallet.', 'Udendørs arbejde påvirkes af temperatur og fugt, hvilket kan forlænge tidsplanen.', 'Kvalitetsmaling kan have højere indkøbspris men reducere vedligehold på sigt.']]
  ];
  const hit = map.find(([re]) => re.test(k));
  if (hit) return hit[1];
  return [
    `Pris for ${keyword} påvirkes af omfang, materialer, adgangsforhold og kvalitetsniveau.`,
    `${keyword} kræver som regel præcis opmåling og tydeligt scope for at undgå ekstraomkostninger.`,
    `Sammenlignelige tilbud på ${keyword} kræver samme forudsætninger for materialer og udførselsniveau.`,
    `Ved ${keyword} bør du medregne både etablering, eventuelle tillæg og fremtidigt vedligehold.`
  ];
}

async function researchKeyword(keyword) {
  const q = encodeURIComponent(`${keyword} pris Danmark`);
  try {
    const ddg = await fetchJson(`https://api.duckduckgo.com/?q=${q}&format=json&no_html=1&skip_disambig=1`);
    const related = (ddg.RelatedTopics || [])
      .flatMap((item) => (item.Topics ? item.Topics : [item]))
      .map((item) => item.Text)
      .filter(Boolean)
      .slice(0, 8);
    const abstract = ddg.AbstractText || '';
    const facts = [abstract, ...related]
      .join(' ')
      .split('. ')
      .map((s) => s.trim())
      .filter((s) => s.length > 40)
      .slice(0, 10);
    if (facts.length) return { source: 'duckduckgo', abstract, facts };
  } catch {
    // fallback below
  }
  const facts = domainFacts(keyword);
  return { source: 'local-domain-fallback', abstract: '', facts };
}

function inferPricing(keyword) {
  const k = keyword.toLowerCase();
  const byType = [
    { test: /(maler|maling)/, enhed: 'pr. m²', short: 'm²', baseLow: 90, baseHigh: 220 },
    { test: /(vvs|elektriker|montør|blikkenslager)/, enhed: 'pr. time', short: 'time', baseLow: 550, baseHigh: 1100 },
    { test: /(hegn|tag|gulv|køkken|solceller|varmepumpe)/, enhed: 'pr. m²', short: 'm²', baseLow: 400, baseHigh: 1400 }
  ];
  const found = byType.find((x) => x.test.test(k)) || { enhed: 'pr. enhed', short: 'enhed', baseLow: 350, baseHigh: 1200 };
  return found;
}

function regionBlocks(keyword, facts) {
  const fact = (i) => facts[i % facts.length] || `${keyword} projekter varierer efter adgang, materialevalg og omfang.`;
  return Object.fromEntries(Object.keys(REGIONS).map((region, idx) => [region, {
    lokale_forhold_tekst: `I ${region} påvirkes ${keyword}-projekter af lokale boligtyper, adgangsforhold og entreprenørkapacitet. ${fact(idx)}`,
    typisk_projekt: `Typisk projekt i ${region}: Et mellemstort ${keyword}-projekt med fokus på holdbarhed, planlagt efter lokale forhold og adgang til materiel.`,
    saerlige_overvejelser: `Særligt i ${region} bør man afklare lokalplaner, naboforhold og logistik før opstart af ${keyword}-opgaven.`,
    priskommentar: `Prisniveauet i ${region} ligger typisk ${REGIONS[region].label} i forhold til landsgennemsnittet, især pga. ${REGIONS[region].note.toLowerCase()}.`
  }]));
}

function buildContentBank(keyword, research) {
  const slug = slugify(keyword);
  const name = titleCase(keyword);
  const pricing = inferPricing(keyword);

  const types = [
    ['basis', 'Basis løsning', 1.0],
    ['standard', 'Standard løsning', 1.35],
    ['premium', 'Premium løsning', 1.7],
    ['special', 'Special løsning', 2.1]
  ].map(([id, label, multi], idx) => {
    const low = roundPrice(pricing.baseLow * multi);
    const high = roundPrice(pricing.baseHigh * multi);
    return {
      id: `${slug}-${id}`,
      navn: `${name} ${label}`,
      pris_pr_enhed_low: low,
      pris_pr_enhed_high: high,
      pris_standardprojekt_low: roundPrice(low * 30),
      pris_standardprojekt_high: roundPrice(high * 40),
      standardprojekt_beskrivelse: `Standardprojekt for ${name} med ${idx + 1} kompleksitetsniveau.`,
      levetid: `${8 + idx * 4}–${15 + idx * 5} år`,
      beskrivelse: research.facts[idx] || `${name} i ${label.toLowerCase()} med fokus på kvalitet og levetid.`,
      fordele: ['Dokumenteret løsning', 'Forudsigelig pris', 'Tilpasses projektet'],
      ulemper: ['Afhænger af lokale forhold', 'Kræver korrekt opmåling'],
      vedligeholdelse: idx > 1 ? 'Lav' : 'Middel',
      populaer: idx === 1
    };
  });

  const faqGeneral = Array.from({ length: 8 }).map((_, i) => ({
    spoergsmaal: `Hvad påvirker prisen på ${name}? (${i + 1})`,
    svar: `Prisen påvirkes især af størrelse, materialevalg, lokation og adgang. Typisk prisniveau ligger omkring ${types[0].pris_pr_enhed_low}–${types[3].pris_pr_enhed_high} kr. ${pricing.enhed}.`
  }));

  return {
    branche: {
      id: slug,
      navn: name,
      slug,
      kategori: 'Håndværker',
      meta: {
        title_template: `${name} pris {BY} — Hvad koster ${keyword} i 2026? | LeadBeregner`,
        title_template_pillar: `Hvad koster ${keyword} i 2026? Priser, typer og beregner | LeadBeregner`,
        title_template_problem: '{PROBLEM_TITLE} — Priser og guide 2026 | LeadBeregner',
        meta_description_template: `Se hvad ${keyword} koster i {BY} i 2026. {TYPE_POPULAER} fra {PRIS_REGIONSJUSTERET_LOW} kr/${pricing.short}. Beregn din pris på 2 min.`,
        meta_description_pillar: `Komplet guide til ${keyword}-priser i 2026. Beregn din pris gratis.`,
        opdateret: '2026-03-01'
      }
    },
    prisdata: {
      valuta: 'DKK',
      moms_inkluderet: false,
      enhed: pricing.enhed,
      enhed_kort: pricing.short,
      prisaar: 2026,
      kilde_note: `Prisestimater kombinerer offentlige beskrivelser og markedsreferencer for ${keyword}, genereret ${new Date().toISOString().slice(0, 10)}.`,
      typer: types,
      tillaegsydelser: [
        { id: 'opmaaling', navn: 'Opmåling og plan', pris_low: 1000, pris_high: 3000, beskrivelse: 'Præcis opmåling og projektplan.' },
        { id: 'bortskaffelse', navn: 'Bortskaffelse', pris_low: 1200, pris_high: 4500, beskrivelse: 'Bortskaffelse af eksisterende materialer.' },
        { id: 'hastetid', navn: 'Hasteopstart', pris_low: 1500, pris_high: 7000, beskrivelse: 'Prioriteret opstart ved kort deadline.' }
      ],
      prisgrupper: REGIONS
    },
    regionale_indholdsblokke: regionBlocks(keyword, research.facts),
    by_kategorier: {
      storby: { definition: 'Byer med 50.000+ indbyggere', prisscenarier: [{ titel: 'Lille projekt', beskrivelse: `Mindre ${keyword}-opgave i tæt bymiljø med adgangsbegrænsning.`, detaljer: 'Storby', pris_low: 12000, pris_high: 26000 }, { titel: 'Mellemstort projekt', beskrivelse: `Typisk parcel/rækkehus-opgave med koordineret logistik.`, detaljer: 'Storby', pris_low: 28000, pris_high: 52000 }, { titel: 'Stort projekt', beskrivelse: `Større sammenhængende ${keyword}-projekt med høj kompleksitet.`, detaljer: 'Storby', pris_low: 55000, pris_high: 110000 }], ekstra_sektioner: ['parkering_adgang', 'grundejerforening'], intro_variant_pool: 'A' },
      mellemstor: { definition: 'Byer med 10.000-50.000 indbyggere', prisscenarier: [{ titel: 'Lille projekt', beskrivelse: `Standard ${keyword}-opgave med normal adgang.`, detaljer: 'Mellemstor', pris_low: 10000, pris_high: 22000 }, { titel: 'Mellemstort projekt', beskrivelse: `Mellemstort projekt i parcelhuskvarter.`, detaljer: 'Mellemstor', pris_low: 23000, pris_high: 45000 }, { titel: 'Stort projekt', beskrivelse: `Kompleks opgave med flere delområder.`, detaljer: 'Mellemstor', pris_low: 45000, pris_high: 90000 }], ekstra_sektioner: ['goer_det_selv_intro'], intro_variant_pool: 'B' },
      mindre: { definition: 'Byer med under 10.000 indbyggere', prisscenarier: [{ titel: 'Lille projekt', beskrivelse: `Lille ${keyword}-opgave med god plads til udførsel.`, detaljer: 'Mindre by', pris_low: 9000, pris_high: 18000 }, { titel: 'Mellemstort projekt', beskrivelse: `Mellemstort projekt med længere kørsel for fagfolk.`, detaljer: 'Mindre by', pris_low: 20000, pris_high: 40000 }, { titel: 'Stort projekt', beskrivelse: `Stort projekt på større grund eller landejendom.`, detaljer: 'Mindre by', pris_low: 39000, pris_high: 82000 }], ekstra_sektioner: ['goer_det_selv_fuld', 'transport_tillæg'], intro_variant_pool: 'C' }
    },
    tekstvarianter: {
      intro_tekster: {
        A: [`I {BY} ses ${keyword} ofte som en investering i funktion og ejendomsværdi.`, `${name} i {BY} planlægges bedst med klar afgrænsning af omfang, adgang og materialer.`, `Prisforskelle på ${keyword} i {BY} hænger tæt sammen med logistik og kvalitetsniveau.`],
        B: [`I {BY} vælger mange en ${keyword}-løsning med balance mellem pris og levetid.`, `Tidspunktet for ${keyword} i {BY} har betydning for både ventetid og tilbudspris.`, `Sammenligning af løsningstyper i {BY} giver ofte mærkbar prisforskel.`],
        C: [`Lokale leverandører i {BY} kan ofte optimere ${keyword}-projekter via kendskab til området.`, `For ${keyword} i {BY} kan DIY være relevant på afgrænsede delopgaver.`, `Lang holdbarhed for ${keyword} i {BY} starter med korrekt udførelse og vedligehold.`]
      },
      prisfaktorer_intro: ['Forstå prisdriverne før du sammenligner tilbud.', 'Et godt tilbud kræver ens forudsætninger hos alle leverandører.', 'Overraskelser undgås med tydelig scope og materialevalg.'],
      proces_intro: ['En tydelig proces giver mere stabile priser.', 'Klar tidsplan reducerer risiko for forsinkelser.', 'God forberedelse giver bedre kvalitet i udførslen.'],
      tips_intro: ['Små valg i planlægningen kan spare markant på totalprisen.', 'Kvalitet i de tidlige valg giver færre reparationer senere.', 'Typiske fejl kan undgås med få konkrete tjekpunkter.'],
      cta_tekster: [`Beregn pris på ${keyword} i {BY} og få et hurtigt estimat.`, `Få et datapunkt for ${keyword} i {BY} før du indhenter tilbud.`, `Start med en gratis prisberegning for ${keyword} i {BY}.`]
    },
    prisfaktorer: [
      { id: 'stoerrelse', titel: 'Projektstørrelse', ikon: '📐', kort_tekst: 'Omfang styrer timer og materialer.', lang_tekst: 'Større projekter kræver flere arbejdstimer, mere logistik og ofte flere materialeleverancer.', effekt: 'Kan ændre pris med 20–60%' },
      { id: 'materiale', titel: 'Materialevalg', ikon: '🧱', kort_tekst: 'Materialekvalitet påvirker både pris og levetid.', lang_tekst: 'Valg af basis, standard eller premium-materialer flytter både anlægspris og vedligehold over tid.', effekt: 'Kan ændre pris med 15–45%' },
      { id: 'lokation', titel: 'Lokation og adgang', ikon: '📍', kort_tekst: 'Adgangsforhold kan øge tidsforbrug.', lang_tekst: 'Svær adgang, begrænset parkering og bynær logistik kan løfte timeforbruget betydeligt.', effekt: 'Kan ændre pris med 5–25%' },
      { id: 'saeson', titel: 'Sæson', ikon: '🌦️', kort_tekst: 'Efterspørgsel varierer gennem året.', lang_tekst: 'I højsæson er kapaciteten presset, hvilket kan øge både ventetid og prisniveau.', effekt: 'Kan ændre pris med 5–15%' },
      { id: 'terraen', titel: 'Terræn/underlag', ikon: '⛰️', kort_tekst: 'Underlag bestemmer forarbejde.', lang_tekst: 'Ujævnt terræn, behov for afretning eller særligt underlag kan tilføje væsentlig ekstraarbejde.', effekt: 'Kan ændre pris med 10–30%' },
      { id: 'kvalitet', titel: 'Kvalitetsniveau', ikon: '⭐', kort_tekst: 'Finish og detaljer koster.', lang_tekst: 'Højere finish og længere garantier giver typisk højere pris men lavere fejlrate.', effekt: 'Kan ændre pris med 10–25%' }
    ],
    procestrin: [
      { nummer: 1, titel: 'Behovsafklaring', tekst: `Afklar mål, funktion og ønsket kvalitet for ${keyword}.`, ikon: '📝' },
      { nummer: 2, titel: 'Opmåling', tekst: 'Gennemfør præcis opmåling af areal og adgangsforhold.', ikon: '📏' },
      { nummer: 3, titel: 'Tilbud', tekst: 'Indhent 2-3 sammenlignelige tilbud med samme scope.', ikon: '💬' },
      { nummer: 4, titel: 'Udførelse', tekst: 'Koordinér materialer, tidsplan og kvalitetskontrol i udførslen.', ikon: '🔧' },
      { nummer: 5, titel: 'Aflevering', tekst: 'Gennemgå resultat, dokumentation og vedligeholdelsesplan.', ikon: '✅' }
    ],
    tips: [
      { titel: 'Sammenlign på samme scope', tekst: 'Bed alle leverandører prissætte identiske forudsætninger.', type: 'penge' },
      { titel: 'Vælg løsning efter levetid', tekst: 'Laveste anlægspris er ikke altid laveste totalpris over tid.', type: 'vigtigt' },
      { titel: 'Book uden for højsæson', tekst: 'Lavsæson kan give bedre priser og hurtigere opstart.', type: 'penge' },
      { titel: 'Afklar adgang i god tid', tekst: 'Parkering, løftebehov og adgang påvirker mandskabstimer.', type: 'praktisk' },
      { titel: 'Aftal milepæle skriftligt', tekst: 'Milepæle og betalingsplan reducerer risiko for tvister.', type: 'vigtigt' },
      { titel: 'Dokumentér før/efter', tekst: 'Fotos og notater gør kvalitetstjek og reklamation lettere.', type: 'praktisk' }
    ],
    fejl_at_undgaa: [
      { titel: 'Uklart scope', tekst: 'Et uklart scope giver ekstraarbejde og prisusikkerhed. Beskriv opgaven konkret før tilbud.' },
      { titel: 'Kun fokus på laveste pris', tekst: 'Laveste pris kan mangle kvalitet, garanti eller nødvendige ydelser.' },
      { titel: 'Ingen afklaring af regler', tekst: 'Ignorerede lokalplaner kan give dyre ændringer efter opstart.' },
      { titel: 'For lidt tidsbuffer', tekst: 'Manglende buffer giver presset udførelse og øger fejlrisiko.' }
    ],
    goer_det_selv: {
      intro: `${name} kan delvist løses som DIY, men kritiske dele bør typisk udføres af fagpersoner.`,
      pro: { titel: 'Professionel', punkter: ['Garanti', 'Hurtigere udførelse', 'Faglig kvalitet', 'Korrekt værktøj', 'Mindre fejlrisiko'], pris_eksempel: `Standardprojekt: ${types[1].pris_standardprojekt_low}–${types[2].pris_standardprojekt_high} kr.` },
      diy: { titel: 'Gør-det-selv', punkter: ['Lavere lønudgift', 'Mere tidsforbrug', 'Krav til værktøj', 'Højere fejlrisiko', 'Ingen entreprenørgaranti'], pris_eksempel: `Standardprojekt (materialer): ${roundPrice(types[0].pris_standardprojekt_low * 0.55)}–${roundPrice(types[1].pris_standardprojekt_high * 0.7)} kr.` },
      anbefaling: 'DIY er mest relevant til simple, ikke-kritiske delopgaver med lav teknisk risiko.'
    },
    ekstra_sektioner: {
      parkering_adgang: { titel: 'Parkering og adgangsforhold i {BY}', tekst: `${name}-projekter i tætte områder kan kræve ekstra tid til transport, adgang og aflæsning.` },
      grundejerforening: { titel: 'Grundejerforeninger og lokalplaner', tekst: `Undersøg regler for ${name} i dit område før opstart, så materialevalg og udførsel matcher lokale krav.` },
      goer_det_selv_intro: { titel: `Kan du selv lave ${name}?`, tekst: `Nogle dele af ${name} er DIY-egnede, men kritiske dele bør udføres af fagfolk.` },
      goer_det_selv_fuld: { titel: `Gør-det-selv vs. professionel ${name}`, tekst: 'Brug den fulde pro/diy-sammenligning fra goer_det_selv-objektet.' },
      transport_tillæg: { titel: 'Transport og kørsel i {BY}-området', tekst: 'Længere afstand til nærmeste leverandør kan udløse kørselstillæg på ca. 500–1.500 kr.' }
    },
    regler_og_tilladelser: {
      intro: `${name}-projekter kan være omfattet af lokale regler, nabohensyn og eventuelle tilladelser.`,
      punkter: [
        { titel: 'Lokalplan', tekst: 'Kontrollér kommunale bestemmelser og grundejerforeningens krav.' },
        { titel: 'Nabohensyn', tekst: 'Afklar afstande, støjperioder og praktiske forhold med naboer.' }
      ]
    },
    faq: {
      generelle: faqGeneral,
      lokale_skabeloner: [
        { spoergsmaal_template: `Hvad koster ${name} i {BY}?`, svar_template: `${name} i {BY} koster typisk {PRIS_REGIONSJUSTERET_LOW}–{PRIS_REGIONSJUSTERET_HIGH} kr. {ENHED}. {REGIONAL_PRISKOMMENTAR}` },
        { spoergsmaal_template: `Hvem laver ${name} i {BY}?`, svar_template: `Der findes lokale ${name}-leverandører i og omkring {BY}.` },
        { spoergsmaal_template: `Hvornår er det bedst at få lavet ${name} i {BY}?`, svar_template: '{SAESON_SVAR_REGIONAL}' },
        { spoergsmaal_template: `Hvor lang tid tager ${name} i {BY}?`, svar_template: '{VARIGHED_SVAR_BYKATEGORI}' }
      ],
      by_kategori_skabeloner: {
        storby: [{ spoergsmaal: 'Kræver det tilladelse fra kommunen?', svar: 'I storbyer ses oftere krav via lokalplaner eller foreninger, så tjek altid regler før opstart.' }, { spoergsmaal: 'Kan håndværkeren parkere ved min bolig?', svar: 'Parkering kan kræve tilladelse i tætte områder og påvirke pris og tidsplan.' }],
        mellemstor: [{ spoergsmaal: 'Hvor mange tilbud bør jeg indhente i {BY}?', svar: '2-3 tilbud er normalt nok til et solidt sammenligningsgrundlag i mellemstore byer.' }, { spoergsmaal: 'Er ventetiden lang i {BY}?', svar: 'Ventetid afhænger af sæson, men planlægning 4-8 uger frem giver ofte bedst valg.' }],
        mindre: [{ spoergsmaal: `Er der ${name}-firmaer i {BY}?`, svar: 'Fagfolk dækker ofte et større opland, så der er normalt mulighed for tilbud.' }, { spoergsmaal: 'Kan jeg spare ved selv at forberede opgaven?', svar: 'Ja, klargøring kan reducere timer, men tekniske dele bør udføres af fagfolk.' }]
      }
    },
    saeson: { regional_varianter: { kyst_vind: 'Kystnære områder kræver fokus på vejr, vind og materialevalg med høj robusthed.', indland: 'I indlandet påvirker frost, regn og jordforhold planlægningen.', storby: 'Storbyer har ofte høj efterspørgsel året rundt, men bedst pris i lavsæson.' } },
    intern_linking: {
      relaterede_brancher: [
        { navn: 'Maler', slug: 'maler', link_tekst: 'Maler pris {BY}' },
        { navn: 'Tømrer', slug: 'tomrer', link_tekst: 'Tømrer pris {BY}' },
        { navn: 'VVS', slug: 'vvs', link_tekst: 'VVS pris {BY}' },
        { navn: 'Elektriker', slug: 'elektriker', link_tekst: 'Elektriker pris {BY}' },
        { navn: 'Tag', slug: 'tag', link_tekst: 'Tag pris {BY}' }
      ],
      problemsider: [{ slug: `${slug}-pris-pr-enhed`, titel: `${name} pris pr. ${pricing.short}` }, { slug: `billigste-${slug}`, titel: `Billigste ${name}` }, { slug: `regler-for-${slug}`, titel: `Regler for ${name}` }]
    }
  };
}

function buildProblemPages(keyword, contentBank) {
  const name = titleCase(keyword);
  const slug = slugify(keyword);
  const popular = contentBank.prisdata.typer.filter((t) => t.populaer).at(0) || contentBank.prisdata.typer[0];
  const topics = [
    [`hvad-koster-${slug}-${popular.id.split('-').at(-1)}`, `Hvad koster ${popular.navn}`, 'transactional'],
    [`hvad-koster-${slug}-premium`, `Hvad koster ${name} premium`, 'transactional'],
    [`hvad-koster-${slug}-basis`, `Hvad koster ${name} basis`, 'transactional'],
    [`${slug}-pris-pr-${contentBank.prisdata.enhed_kort}`, `${name} pris pr. ${contentBank.prisdata.enhed_kort}`, 'transactional'],
    [`billigste-${slug}`, `Billigste ${name}`, 'transactional'],
    [`regler-for-${slug}`, `Regler for ${name}`, 'informational'],
    [`diy-${slug}`, `Kan jeg selv lave ${name}?`, 'informational']
  ];

  return topics.map(([id, emne, intent]) => ({
    id,
    emne,
    soegeord: emne.toLowerCase(),
    soege_intention: intent,
    slug_suffix: id,
    title: `${emne} — priser og guide 2026`,
    h1: emne,
    meta_description: `${name} typisk ${popular.pris_pr_enhed_low}–${popular.pris_pr_enhed_high} kr/${contentBank.prisdata.enhed_kort}. Se pris, regler og guide 2026.`,
    sections: [1, 2, 3, 4, 5].map((n) => ({
      heading: `${emne}: sektion ${n}`,
      body: `${name} prisniveau ligger typisk mellem ${contentBank.prisdata.typer[0].pris_pr_enhed_low} og ${contentBank.prisdata.typer.at(-1).pris_pr_enhed_high} kr/${contentBank.prisdata.enhed_kort}, afhængigt af kompleksitet, materialer og lokation. Ved ${emne.toLowerCase()} er det vigtigt at sammenligne tilbud med samme specifikation, så du kan skelne mellem forskelle i kvalitet og ikke kun pris.\n\nI praksis bør du opdele tilbud i materialer, timer, transport og eventuelle tillæg. Den tilgang giver mere præcis budgetstyring og gør det lettere at vælge den løsning, der matcher både forventet levetid og den ønskede finish.`
    })),
    faq: [1, 2, 3, 4].map((i) => ({
      question: `${emne} — spørgsmål ${i}?`,
      answer: `${name} koster ofte ${popular.pris_pr_enhed_low}–${popular.pris_pr_enhed_high} kr/${contentBank.prisdata.enhed_kort}, men endelig pris afhænger af omfang, materialer og adgang.`
    }))
  }));
}

async function handleApi(req, res) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Ugyldig JSON' }));
  }

  const keyword = (body.keyword || '').trim();
  if (!keyword) {
    res.writeHead(400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'keyword mangler' }));
  }

  try {
    const research = await researchKeyword(keyword);
    const contentBank = buildContentBank(keyword, research);
    const problemTemplates = buildProblemPages(keyword, contentBank);
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ research, contentBank, problemTemplates }, null, 2));
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    console.error(error);
    return res.end(JSON.stringify({ error: `Research fejl: ${error.message}`, stack: error.stack }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && url.pathname === '/api/generate') {
    return handleApi(req, res);
  }

  const filePath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const fullPath = join(process.cwd(), filePath);
  try {
    const data = await readFile(fullPath);
    const mime = MIME[extname(fullPath)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': mime });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

server.listen(PORT, () => {
  console.log(`Server kører på http://localhost:${PORT}`);
});
