# Rezervacijski sistem za restavracijo

Dve strani in skupna logika, brez gradnje in brez odvisnosti:

| Datoteka | Namen |
|---|---|
| `index.html` | Spletna rezervacija za goste: osebe → datum → ura → podatki → potrditev s kodo in `.ics` za koledar. Gost lahko s kodo in e-pošto/telefonom rezervacijo preveri ali prekliče. |
| `admin.html` | Za osebje: dnevni pregled (kazalniki, razpored miz po urah, seznam s hitrimi statusi), nova/urejanje rezervacije z izbiro miz, izvoz CSV, tisk, nastavitve. |
| `rezervacije.js` | Podatki in pravila: odpiralni čas, termini, samodejna dodelitev miz (ena miza ali dve v isti coni), omejitev gostov na termin, validacija, CSV/ICS. |
| `rezervacije.css` | Skupni slogi. |

## Kaj zna

- Razpoložljivost upošteva trajanje obiska (daljše za velike skupine), zasedenost miz, kapaciteto kuhinje na termin, najmanjši čas vnaprej in okno rezervacij.
- Zaprti dnevi (prazniki) in do dve izmeni na dan.
- Statusi: čaka potrditev, potrjena, za mizo, zaključena, preklicana, ni prišel — z zgodovino sprememb.
- Samodejna ali ročna potrditev spletnih rezervacij.
- Zavihka gost/osebje v istem brskalniku se sinhronizirata v živo.

## Demo način

Sistem je nastavljen kot **demo** (`DEMO = true` v `rezervacije.js`):

- ob prvem obisku in vsak nov dan se samodejno naloži sveže primere rezervacij za naslednjih 7 dni, zato je razpored vedno poln;
- na strani za goste je trak »DEMO«, v pogledu osebja gumb **Ponastavi demo**;
- vse ostane v brskalniku obiskovalca — nič se ne pošlje restavraciji.

## Vgradnja v spletno stran restavracije

Dodajte `?embed=1` in stran vstavite v `<iframe>` — skrije glavo, naslovni del in nogo. Stran sporoči svojo višino (`postMessage`), da se okvir prilagodi. Delujoč primer s kodo za kopiranje je v `vgradnja.html`.

Lahko pa na strani restavracije preprosto dodate gumb, ki vodi na `/rezervacije/`.

## Za pravo uporabo (ni del dema)

Ta različica **hrani podatke v `localStorage` brskalnika**. Rezervacija gosta z njegovega telefona zato *ne* pride do računalnika v restavraciji. Za pravo uporabo je treba:

1. **Strežnik in baza** — funkciji `load()` in `save()` v `rezervacije.js` (ter `create`, `update`, `remove`) zamenjati s klici API-ja (npr. Vercel/Netlify funkcije + Postgres, Supabase ali Firebase). Preverjanje razpoložljivosti mora teči tudi na strežniku, da dva gosta ne dobita iste mize.
2. **Prijava za osebje** — `admin.html` trenutno nima gesla.
3. **Potrditvena e-pošta/SMS** — zdaj gost vidi kodo samo na zaslonu.
4. **Pravno besedilo** — razdelek »Kaj se zgodi s podatki« je osnutek; rok hrambe in pravno podlago naj potrdi restavracija.

Ime, naslov, telefon in e-pošta restavracije so primeri — nastavite jih v zavihku Nastavitve.
