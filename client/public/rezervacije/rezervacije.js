/*
 * Rezervacijski sistem — podatkovna plast in poslovna logika.
 *
 * Shramba: localStorage v brskalniku (ključ "rs:v1"). To pomeni, da podatki živijo
 * samo v brskalniku, kjer so bili vneseni — za produkcijo z več napravami je treba
 * funkciji load()/save() zamenjati s klici na strežniški API. Vsa ostala logika
 * (razpoložljivost, dodelitev miz, validacija) je neodvisna od shrambe.
 */
(function (global) {
  "use strict";

  var KEY = "rs:v1";
  var listeners = [];

  var STATUS = {
    potrjena:   { label: "Potrjena",   cls: "st-potrjena",   active: true  },
    cakajoca:   { label: "Čaka potrditev", cls: "st-cakajoca", active: true },
    prispeli:   { label: "Za mizo",    cls: "st-prispeli",   active: true  },
    zakljucena: { label: "Zaključena", cls: "st-zakljucena", active: false },
    preklicana: { label: "Preklicana", cls: "st-preklicana", active: false },
    noshow:     { label: "Ni prišel",  cls: "st-noshow",     active: false }
  };
  // Zasedenost mize v času obiska: zaključena miza se sprosti.
  var BLOCKING = { potrjena: 1, cakajoca: 1, prispeli: 1 };

  var DAYS = ["Nedelja", "Ponedeljek", "Torek", "Sreda", "Četrtek", "Petek", "Sobota"];
  var DAYS_SHORT = ["Ned", "Pon", "Tor", "Sre", "Čet", "Pet", "Sob"];
  var MONTHS = ["januar", "februar", "marec", "april", "maj", "junij", "julij", "avgust", "september", "oktober", "november", "december"];

  function defaultSettings() {
    var lunchDinner = [{ open: "12:00", close: "15:00" }, { open: "18:00", close: "22:30" }];
    return {
      name: "Restavracija Lipa",
      tagline: "Sezonska kuhinja, domača vina",
      address: "Primer: Glavni trg 1, 1000 Ljubljana",
      phone: "+386 1 000 00 00",
      email: "rezervacije@primer.si",
      slotMinutes: 15,
      durationMinutes: 120,
      bigPartyDuration: 150,   // za skupine od bigPartyFrom dalje
      bigPartyFrom: 7,
      maxOnlineParty: 8,       // večje skupine → pokličite
      leadMinutes: 60,         // najmanj toliko vnaprej
      windowDays: 60,          // največ toliko dni vnaprej
      maxCoversPerSlot: 24,    // največ novih gostov na isti začetni termin (kuhinja)
      autoConfirm: true,       // false → spletne rezervacije čakajo potrditev
      cancelHours: 2,          // gost lahko prekliče do toliko ur prej
      hours: {                 // 0 = nedelja
        0: [{ open: "12:00", close: "17:00" }],
        1: [],
        2: lunchDinner, 3: lunchDinner, 4: lunchDinner,
        5: [{ open: "12:00", close: "15:00" }, { open: "18:00", close: "23:00" }],
        6: [{ open: "12:00", close: "23:00" }]
      },
      closedDates: [],         // ["2026-12-25", ...]
      tables: [
        { id: "T1",  name: "1",  seats: 2, zone: "Salon" },
        { id: "T2",  name: "2",  seats: 2, zone: "Salon" },
        { id: "T3",  name: "3",  seats: 2, zone: "Salon" },
        { id: "T4",  name: "4",  seats: 4, zone: "Salon" },
        { id: "T5",  name: "5",  seats: 4, zone: "Salon" },
        { id: "T6",  name: "6",  seats: 4, zone: "Salon" },
        { id: "T7",  name: "7",  seats: 6, zone: "Salon" },
        { id: "T8",  name: "8",  seats: 2, zone: "Okno" },
        { id: "T9",  name: "9",  seats: 2, zone: "Okno" },
        { id: "T10", name: "10", seats: 4, zone: "Okno" },
        { id: "T11", name: "11", seats: 4, zone: "Terasa" },
        { id: "T12", name: "12", seats: 4, zone: "Terasa" },
        { id: "T13", name: "13", seats: 8, zone: "Terasa" }
      ]
    };
  }

  /* ---------- shramba ---------- */
  var state = null;

  function load() {
    var raw = null;
    try { raw = global.localStorage.getItem(KEY); } catch (e) {}
    var parsed = null;
    if (raw) { try { parsed = JSON.parse(raw); } catch (e) {} }
    var s = parsed || {};
    state = {
      settings: Object.assign(defaultSettings(), s.settings || {}),
      reservations: Array.isArray(s.reservations) ? s.reservations : []
    };
    return state;
  }

  function save() {
    try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    emit();
  }

  function emit() { listeners.forEach(function (fn) { try { fn(state); } catch (e) { console.error(e); } }); }
  function subscribe(fn) { listeners.push(fn); }

  // Sinhronizacija med zavihki (npr. gost rezervira, osebje takoj vidi).
  global.addEventListener("storage", function (e) { if (e.key === KEY) { load(); emit(); } });

  /* ---------- datumi in časi (vedno lokalni čas) ---------- */
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parseYmd(s) { var p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function toMin(hhmm) { var p = hhmm.split(":"); return (+p[0]) * 60 + (+p[1]); }
  function fromMin(m) { return pad(Math.floor(m / 60) % 24) + ":" + pad(m % 60); }
  function addDays(d, n) { var x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); return x; }
  function today() { return ymd(new Date()); }
  function nowMin() { var d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
  function fmtDateLong(s) { var d = parseYmd(s); return DAYS[d.getDay()] + ", " + d.getDate() + ". " + MONTHS[d.getMonth()] + " " + d.getFullYear(); }
  function fmtDateShort(s) { var d = parseYmd(s); return DAYS_SHORT[d.getDay()] + " " + d.getDate() + ". " + (d.getMonth() + 1) + "."; }

  /* ---------- pomožno ---------- */
  function uid() { return "r_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function makeCode() {
    // Brez dvoumnih znakov (0/O, 1/I/L).
    var abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789", out = "";
    var rnd = new Uint32Array(6);
    (global.crypto || global.msCrypto).getRandomValues(rnd);
    for (var i = 0; i < 6; i++) out += abc[rnd[i] % abc.length];
    return out;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function durationFor(party) {
    var s = state.settings;
    return party >= s.bigPartyFrom ? s.bigPartyDuration : s.durationMinutes;
  }

  /* ---------- odpiralni čas ---------- */
  function periodsFor(dateStr) {
    var s = state.settings;
    if (s.closedDates.indexOf(dateStr) !== -1) return [];
    return s.hours[parseYmd(dateStr).getDay()] || [];
  }
  function isOpenDay(dateStr) { return periodsFor(dateStr).length > 0; }

  // Začetni termini: od odprtja do (zaprtje − trajanje obiska).
  function slotTimes(dateStr, party) {
    var s = state.settings, dur = durationFor(party || 2), out = [];
    periodsFor(dateStr).forEach(function (p) {
      var start = toMin(p.open), last = toMin(p.close) - Math.min(dur, 90); // zadnji sprejem 90 min pred zaprtjem
      for (var m = start; m <= last; m += s.slotMinutes) out.push(m);
    });
    return out;
  }

  /* ---------- zasedenost miz ---------- */
  function overlaps(aStart, aDur, bStart, bDur) { return aStart < bStart + bDur && bStart < aStart + aDur; }

  function busyTables(dateStr, startMin, dur, ignoreId) {
    var busy = {};
    state.reservations.forEach(function (r) {
      if (r.date !== dateStr || !BLOCKING[r.status] || r.id === ignoreId) return;
      if (overlaps(startMin, dur, toMin(r.time), r.duration)) (r.tableIds || []).forEach(function (t) { busy[t] = 1; });
    });
    return busy;
  }

  // Najboljša razporeditev: ena miza z najmanj praznimi sedeži, sicer dve sosednji mizi v isti coni.
  function findTables(dateStr, startMin, party, ignoreId) {
    var dur = durationFor(party);
    var busy = busyTables(dateStr, startMin, dur, ignoreId);
    var free = state.settings.tables.filter(function (t) { return !busy[t.id]; });
    var singles = free.filter(function (t) { return t.seats >= party && t.seats - party <= 3; })
                      .sort(function (a, b) { return a.seats - b.seats; });
    if (singles.length) return [singles[0].id];
    var best = null;
    for (var i = 0; i < free.length; i++) for (var j = i + 1; j < free.length; j++) {
      var a = free[i], b = free[j];
      if (a.zone !== b.zone) continue;
      var seats = a.seats + b.seats;
      if (seats < party || seats - party > 3) continue;
      if (!best || seats < best.seats) best = { ids: [a.id, b.id], seats: seats };
    }
    return best ? best.ids : null;
  }

  function coversStartingAt(dateStr, startMin, ignoreId) {
    return state.reservations.reduce(function (sum, r) {
      return sum + (r.date === dateStr && BLOCKING[r.status] && r.id !== ignoreId && toMin(r.time) === startMin ? r.party : 0);
    }, 0);
  }

  // Seznam terminov za gosta: {min, time, ok, reason}
  function availability(dateStr, party) {
    var s = state.settings;
    var isToday = dateStr === today();
    var cutoff = isToday ? nowMin() + s.leadMinutes : -1;
    return slotTimes(dateStr, party).map(function (m) {
      var ok = true, reason = "";
      if (m < cutoff) { ok = false; reason = "prepozno"; }
      else if (coversStartingAt(dateStr, m) + party > s.maxCoversPerSlot) { ok = false; reason = "kuhinja polna"; }
      else if (!findTables(dateStr, m, party)) { ok = false; reason = "zasedeno"; }
      return { min: m, time: fromMin(m), ok: ok, reason: reason };
    });
  }

  function dayLoad(dateStr) {
    var cap = state.settings.tables.reduce(function (a, t) { return a + t.seats; }, 0);
    var res = state.reservations.filter(function (r) { return r.date === dateStr && BLOCKING[r.status]; });
    var covers = res.reduce(function (a, r) { return a + r.party; }, 0);
    return { covers: covers, count: res.length, capacity: cap };
  }

  /* ---------- validacija ---------- */
  function validateGuest(d) {
    var e = {};
    if (!d.name || d.name.trim().length < 2) e.name = "Vpišite ime in priimek.";
    var phone = (d.phone || "").replace(/[\s\-\/().]/g, "");
    if (!/^\+?\d{8,15}$/.test(phone)) e.phone = "Vpišite veljavno telefonsko številko (npr. 041 123 456).";
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email.trim())) e.email = "E-naslov ni veljaven.";
    if (d.requireEmail && !d.email) e.email = "Vpišite e-naslov za potrditev.";
    if (!(d.party >= 1)) e.party = "Izberite število oseb.";
    return e;
  }

  /* ---------- operacije ---------- */
  function create(data, opts) {
    opts = opts || {};
    var s = state.settings, party = +data.party, m = toMin(data.time);
    var tables = data.tableIds && data.tableIds.length ? data.tableIds : findTables(data.date, m, party);
    if (!tables && !opts.force) return { error: "Za izbrani termin ni več proste mize. Izberite drug čas." };
    if (!opts.staff) {
      var slot = availability(data.date, party).filter(function (x) { return x.min === m; })[0];
      if (!slot || !slot.ok) return { error: "Termin žal ni več na voljo. Izberite drugega." };
    }
    var codes = {}; state.reservations.forEach(function (r) { codes[r.code] = 1; });
    var code; do { code = makeCode(); } while (codes[code]);
    var r = {
      id: uid(), code: code,
      date: data.date, time: fromMin(m), party: party, duration: durationFor(party),
      name: data.name.trim(), phone: data.phone.trim(), email: (data.email || "").trim(),
      notes: (data.notes || "").trim(), occasion: data.occasion || "", allergies: (data.allergies || "").trim(),
      tableIds: tables || [],
      status: opts.staff ? (data.status || "potrjena") : (s.autoConfirm ? "potrjena" : "cakajoca"),
      source: data.source || (opts.staff ? "telefon" : "splet"),
      marketing: !!data.marketing,
      createdAt: new Date().toISOString(),
      history: [{ at: new Date().toISOString(), what: opts.staff ? "Ustvarilo osebje" : "Spletna rezervacija" }]
    };
    state.reservations.push(r);
    save();
    return { reservation: r };
  }

  function update(id, patch, note) {
    var r = get(id); if (!r) return null;
    Object.keys(patch).forEach(function (k) { r[k] = patch[k]; });
    if (patch.party) r.duration = durationFor(+patch.party);
    (r.history = r.history || []).push({ at: new Date().toISOString(), what: note || "Urejeno" });
    save();
    return r;
  }

  function setStatus(id, status) { return update(id, { status: status }, "Status: " + STATUS[status].label); }
  function get(id) { return state.reservations.filter(function (r) { return r.id === id; })[0] || null; }
  function findByCode(code, contact) {
    code = (code || "").trim().toUpperCase(); contact = (contact || "").trim().toLowerCase().replace(/\s/g, "");
    return state.reservations.filter(function (r) {
      return r.code === code && (r.email.toLowerCase() === contact || r.phone.replace(/\s/g, "") === contact);
    })[0] || null;
  }
  function canGuestCancel(r) {
    if (!BLOCKING[r.status] || r.status === "prispeli") return false;
    var start = parseYmd(r.date); start.setMinutes(toMin(r.time));
    return start.getTime() - Date.now() > state.settings.cancelHours * 3600e3;
  }
  function remove(id) { state.reservations = state.reservations.filter(function (r) { return r.id !== id; }); save(); }
  function forDay(dateStr) {
    return state.reservations.filter(function (r) { return r.date === dateStr; })
      .sort(function (a, b) { return toMin(a.time) - toMin(b.time) || a.name.localeCompare(b.name); });
  }
  function saveSettings(patch) { Object.assign(state.settings, patch); save(); }
  function tableName(id) { var t = state.settings.tables.filter(function (x) { return x.id === id; })[0]; return t ? t.name : "?"; }

  /* ---------- izvoz ---------- */
  function toCSV(rows) {
    var cols = ["code", "date", "time", "party", "name", "phone", "email", "status", "source", "tables", "occasion", "allergies", "notes", "createdAt"];
    var head = ["Koda", "Datum", "Ura", "Osebe", "Ime", "Telefon", "E-pošta", "Status", "Vir", "Mize", "Priložnost", "Alergije", "Opombe", "Ustvarjeno"];
    function cell(v) { v = String(v == null ? "" : v); return /[";\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var lines = [head.join(";")];
    rows.forEach(function (r) {
      lines.push(cols.map(function (c) {
        if (c === "tables") return cell((r.tableIds || []).map(tableName).join("+"));
        if (c === "status") return cell(STATUS[r.status] ? STATUS[r.status].label : r.status);
        return cell(r[c]);
      }).join(";"));
    });
    return "﻿" + lines.join("\r\n"); // BOM za Excel in šumnike
  }

  function toICS(r) {
    var s = state.settings, d = parseYmd(r.date);
    var start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, toMin(r.time));
    var end = new Date(start.getTime() + r.duration * 60000);
    function f(x) { return x.getFullYear() + pad(x.getMonth() + 1) + pad(x.getDate()) + "T" + pad(x.getHours()) + pad(x.getMinutes()) + "00"; }
    function t(v) { return String(v).replace(/[\\;,]/g, "\\$&").replace(/\n/g, "\\n"); }
    return [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Rezervacije//SL", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
      "UID:" + r.id + "@rezervacije", "DTSTAMP:" + f(new Date()), "DTSTART:" + f(start), "DTEND:" + f(end),
      "SUMMARY:" + t("Rezervacija – " + s.name + " (" + r.party + " os.)"),
      "LOCATION:" + t(s.address),
      "DESCRIPTION:" + t("Koda rezervacije: " + r.code + "\nTelefon restavracije: " + s.phone),
      "END:VEVENT", "END:VCALENDAR"
    ].join("\r\n");
  }

  function download(name, content, type) {
    var blob = new Blob([content], { type: type });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ---------- demo podatki ---------- */
  function seedDemo() {
    var names = ["Novak", "Horvat", "Kovačič", "Krajnc", "Zupančič", "Potočnik", "Mlakar", "Kos", "Vidmar", "Golob", "Turk", "Božič", "Kralj", "Zupan", "Bizjak", "Hribar", "Kavčič", "Rozman"];
    var first = ["Ana", "Luka", "Maja", "Jan", "Eva", "Nik", "Nina", "Tim", "Sara", "Žan", "Petra", "Matej"];
    var occ = ["", "", "", "rojstni dan", "obletnica", "poslovno"];
    var base = new Date(), made = 0;
    for (var d = 0; d < 7; d++) {
      var ds = ymd(addDays(base, d));
      if (!isOpenDay(ds)) continue;
      var slots = slotTimes(ds, 2);
      var n = d === 0 ? 14 : 6 + ((d * 5) % 9);
      for (var i = 0; i < n; i++) {
        var party = [2, 2, 2, 3, 4, 4, 5, 6][(i * 7 + d) % 8];
        var m = slots[(i * 11 + d * 3) % slots.length];
        var tbl = findTables(ds, m, party);
        if (!tbl) continue;
        var nm = first[(i + d) % first.length] + " " + names[(i * 3 + d) % names.length];
        var status = "potrjena";
        if (d === 0 && m < nowMin() - 150) status = (i % 6 === 0) ? "noshow" : "zakljucena";
        else if (d === 0 && m < nowMin()) status = "prispeli";
        else if (i % 9 === 4) status = "cakajoca";
        state.reservations.push({
          id: uid(), code: makeCode(), date: ds, time: fromMin(m), party: party, duration: durationFor(party),
          name: nm, phone: "+386 41 " + pad((i * 13) % 100) + pad(d * 7 + 10) + " " + pad((i * 29) % 100) + "0",
          email: nm.toLowerCase().replace(/ /g, ".").normalize("NFD").replace(/[̀-ͯ]/g, "") + "@primer.si",
          notes: i % 5 === 2 ? "Miza ob oknu, če je mogoče" : "", occasion: occ[(i + d) % occ.length],
          allergies: i % 7 === 3 ? "brez glutena" : "", tableIds: tbl, status: status,
          source: ["splet", "splet", "telefon", "splet", "walk-in"][i % 5], marketing: false,
          createdAt: new Date().toISOString(), history: [{ at: new Date().toISOString(), what: "Demo podatki" }]
        });
        made++;
      }
    }
    save();
    return made;
  }

  function resetAll() { state = { settings: defaultSettings(), reservations: [] }; save(); }

  load();

  global.RS = {
    STATUS: STATUS, BLOCKING: BLOCKING, DAYS: DAYS, DAYS_SHORT: DAYS_SHORT, MONTHS: MONTHS,
    get state() { return state; },
    subscribe: subscribe, load: load, save: save,
    ymd: ymd, parseYmd: parseYmd, toMin: toMin, fromMin: fromMin, addDays: addDays, today: today, nowMin: nowMin,
    fmtDateLong: fmtDateLong, fmtDateShort: fmtDateShort, esc: esc, pad: pad,
    periodsFor: periodsFor, isOpenDay: isOpenDay, slotTimes: slotTimes, availability: availability,
    findTables: findTables, busyTables: busyTables, durationFor: durationFor, dayLoad: dayLoad,
    validateGuest: validateGuest, create: create, update: update, setStatus: setStatus, get: get, remove: remove,
    findByCode: findByCode, canGuestCancel: canGuestCancel, forDay: forDay, saveSettings: saveSettings,
    tableName: tableName, toCSV: toCSV, toICS: toICS, download: download, seedDemo: seedDemo, resetAll: resetAll,
    defaultSettings: defaultSettings
  };
})(window);
