/**
 * Surf Forecast → Google Sheet sync (Apps Script web app + 3am automation)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE DOES
 * ─────────────────────────────────────────────────────────────────────────
 *  1. doPost: receives sync payloads from the HTML app and writes
 *     Spot / Rating / Tide / Best surf into the sheet (manual flow).
 *  2. runDailyAutoSync: the unattended 3am job. For each upcoming row in
 *     column O ("place" — formerly N before the Spot-column migration),
 *     map the place name to a surf spot (Japan → Aoshima, Lisbon/Cascais
 *     → Parede, Fuerteventura → Majanicho), fetch Open-Meteo marine +
 *     forecast (and WorldTides if a key is configured), score the day,
 *     and write rating/surfable/good/spot back to the row.
 *  3. setupDailyTrigger: one-time install of the 3am time trigger.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SETUP — first time
 * ─────────────────────────────────────────────────────────────────────────
 *   1. Open your target sheet:
 *      https://docs.google.com/spreadsheets/d/1bXjmDRXEi85z94zFpt00MEJTHrrWge9JRp3SGXckuWo/edit
 *   2. Extensions → Apps Script.
 *   3. Replace any existing code with this file's contents.
 *   4. Save (⌘S).
 *   5. (Optional but recommended) If you have a WorldTides API key, run
 *      the function `setWorldTidesKey` once after pasting your key into
 *      the prompt — it'll be saved to Script Properties so the 3am job
 *      can use it.
 *   6. Deploy → Manage deployments → edit (pencil) → New version → Deploy.
 *      The /exec URL stays the same so the HTML app keeps working.
 *   7. Run `setupDailyTrigger` once. Confirm in Triggers (clock icon
 *      sidebar) that you see "runDailyAutoSync" at 3 am.
 *   8. Run `runDailyAutoSync` once manually to fill the next 7 rows now —
 *      verify in the sheet that Spot/Rating/Tide/Best columns populated.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SHEET COLUMN LAYOUT (after migrations run automatically on first call)
 * ─────────────────────────────────────────────────────────────────────────
 *   A  Date         e.g. "18-May (Mon)"   — primary key, never overwritten
 *   B  Spot         surf spot used for the forecast (Aoshima / Parede / Majanicho)
 *   C  Rating       Epic 🟣 / Great 🟢 / Decent 🟡 / Marginal 🟠 / Poor 🔴
 *   D  Tide         comma-joined hour ranges where tide is in your range
 *   E  Best surf    the recommended best window, or "POOR"
 *   F+ everything else (untouched by this script)
 *   O  place        what you wrote as your daily Stay/Place (was column N
 *                   before the Spot migration shifted everything right)
 */

// ════════════════════════════════════════════════
//  CONFIG — edit these to taste
// ════════════════════════════════════════════════

var SPREADSHEET_ID = '1bXjmDRXEi85z94zFpt00MEJTHrrWge9JRp3SGXckuWo';
var SHEET_NAME     = 'Calendar';
var ACCEPTED_SCHEMA = 'surf-v2';

// Surf-spot definitions. Each entry has location + the per-spot tuning the
// HTML app uses (orientation, tide datum, tide range). To add a new spot,
// drop another entry below — then add a matcher in PLACE_RULES.
var SURF_SPOTS = {
  Aoshima: {
    name: 'Aoshima',
    region: 'Miyazaki, Japan',
    latitude: 31.8045, longitude: 131.4730,
    beachFacing: 90,        // east-facing
    tideDatum: 'CD',
    minTide: 0.0, maxTide: 1.5,
  },
  Parede: {
    name: 'Parede',
    region: 'Cascais, Portugal',
    latitude: 38.6889, longitude: -9.3528,
    beachFacing: 180,       // south-facing (Estoril coast)
    tideDatum: 'CD',
    minTide: 0.5, maxTide: 2.5,
  },
  Majanicho: {
    name: 'Majanicho',
    region: 'Fuerteventura, Spain',
    latitude: 28.7473, longitude: -13.9349,
    beachFacing: 0,         // north-facing (Majanicho reefs face north)
    tideDatum: 'CD',
    minTide: 0.0, maxTide: 2.5,
  },
};

// Place-name matcher rules. First matching rule wins. Tested
// case-insensitively against the trimmed text in column O.
// To extend: add { test: <regex>, spot: 'SpotKey' } entries.
var PLACE_RULES = [
  // Anything in Japanese script (hiragana / katakana / CJK) → Aoshima
  { test: /[぀-ヿ一-鿿]/, spot: 'Aoshima' },
  // Latin-letter Japan place names
  { test: /\b(daikanyama|tokyo|miyazaki|aoshima|himeji|osaka|kyoto|chiba|kamakura|shonan|kugenuma)\b/i, spot: 'Aoshima' },
  // Lisbon/Cascais area → Parede
  { test: /\b(lis|lisbon|lisboa|cascais|parede|estoril|carcavelos|costa\s*da\s*caparica)\b/i, spot: 'Parede' },
  // Fuerteventura → Majanicho
  { test: /\b(majanicho|lajares|fuerteventura|fue|corralejo|el\s*cotillo)\b/i, spot: 'Majanicho' },
];

// Global default surf preferences (mirror the HTML app's defaults).
// Per-spot overrides come from SURF_SPOTS above.
var DEFAULT_CONDITIONS = {
  minWave: 0.5,
  maxWave: 2.0,
  maxWindKn: 15,
  minPeriod: 8,
  beachFacing: 'any',
  minTide: 0.0,
  maxTide: 3.0,
  earliestHour: 6,
  latestHour: 18,
  minSessionHrs: 2,
  waveModel: 'ecmwf_wam025',
  tideDatum: 'CD',
};

// 3am trigger — adjust if you'd rather it fire elsewhere
var TRIGGER_HOUR = 3;

// How many rows ahead of today to fill (today + next N days)
var FORECAST_DAYS_AHEAD = 7;

// Column positions (1-indexed). These reflect the layout AFTER the Spot
// migration runs. _ensureSchemaMigrations() guarantees they're correct.
var COL_DATE   = 1;  // A
var COL_SPOT   = 2;  // B
var COL_RATING = 3;  // C
var COL_TIDE   = 4;  // D
var COL_BEST   = 5;  // E
var COL_PLACE  = 15; // O  (was 14 / N before Spot migration)

// ════════════════════════════════════════════════
//  WEB APP ENDPOINTS (manual sync from HTML app)
// ════════════════════════════════════════════════

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents || '{}');
    var rows = payload.rows || [];
    if (!rows.length) return jsonOut({ ok: false, error: 'no rows' });

    if (payload.schema !== ACCEPTED_SCHEMA) {
      return jsonOut({ ok: false, error: 'schema out-of-date — please hard-refresh the Surf Forecast page and try again' });
    }
    if (rows[0] && !('rating' in rows[0])) {
      return jsonOut({ ok: false, error: 'schema out-of-date (no rating field) — hard-refresh the Surf Forecast page' });
    }

    // Content guard for Rating column.
    var LEGAL_RATINGS = {
      '': 1,
      'Epic 🟣': 1, 'Great 🟢': 1, 'Decent 🟡': 1,
      'Marginal 🟠': 1, 'Poor 🔴': 1,
    };
    for (var ri = 0; ri < rows.length; ri++) {
      var rv = rows[ri].rating;
      if (rv == null) continue;
      var rvs = String(rv);
      if (!LEGAL_RATINGS.hasOwnProperty(rvs)) {
        return jsonOut({
          ok: false,
          error: 'rating value not recognised — refusing to write "' + rvs +
                 '" into the Rating column. Hard-refresh the Surf Forecast page and try again.',
          offendingRow: ri,
          offendingValue: rvs,
        });
      }
    }

    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
    _ensureSchemaMigrations(sheet);

    var dateToRow = _buildDateToRowIndex(sheet);
    var updated = 0, skipped = 0, misses = [];

    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      var key = String(row.date).trim();
      var rowNum = dateToRow[key];
      if (!rowNum) {
        var m = key.match(/^(\d{1,2}-[A-Za-z]{3})/);
        if (m) rowNum = dateToRow[m[1]];
      }
      if (!rowNum) { skipped++; misses.push(key); continue; }

      // The HTML app may not always send `spot`. Only write it if present
      // so manual syncs from older browser tabs don't blank the column.
      if (row.spot) sheet.getRange(rowNum, COL_SPOT).setValue(row.spot);
      sheet.getRange(rowNum, COL_RATING).setValue(row.rating   || '');
      sheet.getRange(rowNum, COL_TIDE  ).setValue(row.surfable || '');
      sheet.getRange(rowNum, COL_BEST  ).setValue(row.good     || '');
      updated++;
    }

    return jsonOut({
      ok: true,
      updated: updated,
      skipped: skipped,
      misses: misses,
      sheetName: sheet.getName(),
    });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message || String(err), stack: err.stack });
  }
}

function doGet(e) {
  try {
    // ?diag=places returns column O (place) for the next 14 days so the
    // user can sanity-check what runDailyAutoSync will see.
    var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
    _ensureSchemaMigrations(sheet);

    if (e && e.parameter && e.parameter.diag === 'places') {
      var todayRow = _findTodayRow(sheet);
      if (!todayRow) return jsonOut({ ok: false, error: 'today not found in column A' });
      var rowsToRead = Math.min(FORECAST_DAYS_AHEAD + 1, sheet.getLastRow() - todayRow + 1);
      var dispA = sheet.getRange(todayRow, 1, rowsToRead, 1).getDisplayValues();
      var placeVals = sheet.getRange(todayRow, COL_PLACE, rowsToRead, 1).getDisplayValues();
      var preview = [];
      for (var i = 0; i < rowsToRead; i++) {
        var place = String(placeVals[i][0] || '').trim();
        var spotKey = place ? _resolveSurfSpotKey(place) : null;
        preview.push({
          row: todayRow + i,
          date: dispA[i][0],
          place: place,
          resolvedSpot: spotKey,
        });
      }
      return jsonOut({ ok: true, preview: preview });
    }

    var lastRow = Math.min(sheet.getLastRow(), 5);
    var sample = sheet.getRange(1, 1, lastRow, 1).getDisplayValues()
                      .map(function(r, i) { return { row: i + 1, displayed: r[0] }; });
    return jsonOut({ ok: true, sheetName: sheet.getName(), sample: sample });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message || String(err) });
  }
}

// ════════════════════════════════════════════════
//  THE 3 AM JOB — entry point installed by setupDailyTrigger
// ════════════════════════════════════════════════

function runDailyAutoSync() {
  var ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
  _ensureSchemaMigrations(sheet);

  var todayRow = _findTodayRow(sheet);
  if (!todayRow) {
    Logger.log('runDailyAutoSync: could not locate today\'s row in column A — bailing.');
    return;
  }

  // Pull the next FORECAST_DAYS_AHEAD+1 rows worth of date + place values.
  var rowsToRead = Math.min(FORECAST_DAYS_AHEAD + 1, sheet.getLastRow() - todayRow + 1);
  var dispA      = sheet.getRange(todayRow, 1,           rowsToRead, 1).getDisplayValues();
  var rawA       = sheet.getRange(todayRow, 1,           rowsToRead, 1).getValues();
  var placeVals  = sheet.getRange(todayRow, COL_PLACE,   rowsToRead, 1).getDisplayValues();

  // Group rows by surf spot so we fetch each location once. Each entry:
  //   { spotKey, sheetRow, dateIso (YYYY-MM-DD), dateDisplay }
  var jobs = [];
  for (var i = 0; i < rowsToRead; i++) {
    var place = String(placeVals[i][0] || '').trim();
    if (!place) continue;
    var spotKey = _resolveSurfSpotKey(place);
    if (!spotKey) {
      Logger.log('Skipping row ' + (todayRow + i) + ' "' + dispA[i][0] + '" — place "' + place + '" not recognised by PLACE_RULES.');
      continue;
    }
    var iso = _coerceIsoDate(rawA[i][0]) || _coerceIsoDate(dispA[i][0]);
    if (!iso) {
      Logger.log('Skipping row ' + (todayRow + i) + ' — could not parse date "' + dispA[i][0] + '".');
      continue;
    }
    jobs.push({
      spotKey: spotKey,
      sheetRow: todayRow + i,
      dateIso: iso,
      dateDisplay: dispA[i][0],
    });
  }

  // Group jobs by spot — one fetch per location.
  var bySpot = {};
  jobs.forEach(function(j) {
    if (!bySpot[j.spotKey]) bySpot[j.spotKey] = [];
    bySpot[j.spotKey].push(j);
  });

  var written = 0, errors = [];
  Object.keys(bySpot).forEach(function(spotKey) {
    var spot = SURF_SPOTS[spotKey];
    if (!spot) { errors.push('no SURF_SPOTS entry for ' + spotKey); return; }
    try {
      var days = _buildForecastForSpot(spot);
      // Build YYYY-MM-DD → day index for fast row lookup.
      var dayMap = {};
      days.forEach(function(d) { dayMap[d.date] = d; });

      bySpot[spotKey].forEach(function(j) {
        var d = dayMap[j.dateIso];
        if (!d) {
          Logger.log('No forecast data for ' + j.dateIso + ' at ' + spotKey + ' (beyond model horizon?).');
          return;
        }
        var sheetRow = _buildSheetRow(d, _conditionsForSpot(spot));
        sheet.getRange(j.sheetRow, COL_SPOT  ).setValue(spot.name);
        sheet.getRange(j.sheetRow, COL_RATING).setValue(sheetRow.rating);
        sheet.getRange(j.sheetRow, COL_TIDE  ).setValue(sheetRow.surfable);
        sheet.getRange(j.sheetRow, COL_BEST  ).setValue(sheetRow.good);
        written++;
      });
    } catch (err) {
      errors.push(spotKey + ': ' + (err.message || err));
      Logger.log('Forecast failure for ' + spotKey + ': ' + (err.stack || err));
    }
  });

  Logger.log('runDailyAutoSync: wrote ' + written + ' row(s); errors=' + JSON.stringify(errors));
}

// ════════════════════════════════════════════════
//  TRIGGER SETUP — run once after deploying
// ════════════════════════════════════════════════

function setupDailyTrigger() {
  // Remove any pre-existing runDailyAutoSync triggers so re-running this
  // setup doesn't pile up duplicates.
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'runDailyAutoSync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDailyAutoSync')
    .timeBased()
    .atHour(TRIGGER_HOUR)
    .everyDays(1)
    .create();
  Logger.log('Daily trigger installed at ' + TRIGGER_HOUR + ':00 (script TZ = ' +
             Session.getScriptTimeZone() + ')');
}

// One-time: store WorldTides API key in Script Properties so 3am runs can
// use it. Run this manually from the Apps Script editor and follow the
// browser prompt for input. You can also paste the value directly.
function setWorldTidesKey() {
  var ui = SpreadsheetApp.getUi();
  var resp = ui.prompt('WorldTides API key',
    'Paste your WorldTides API key (leave blank to clear):',
    ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  var key = (resp.getResponseText() || '').trim();
  var props = PropertiesService.getScriptProperties();
  if (key) {
    props.setProperty('WORLDTIDES_API_KEY', key);
    ui.alert('Saved (' + key.length + ' chars). Run runDailyAutoSync to test.');
  } else {
    props.deleteProperty('WORLDTIDES_API_KEY');
    ui.alert('Cleared. The job will run without tide data.');
  }
}

// ════════════════════════════════════════════════
//  SCHEMA MIGRATIONS  (idempotent — gated by Document Properties)
// ════════════════════════════════════════════════

function _ensureSchemaMigrations(sheet) {
  var props = PropertiesService.getDocumentProperties();

  // v1 — insert Rating column at position 2 (already done in production
  // earlier). Keep the gate so a fresh sheet still gets it.
  if (props.getProperty('surf_sync_rating_col_v1') !== '1') {
    sheet.insertColumnBefore(2);
    var hr = _findHeaderRow(sheet);
    if (hr) sheet.getRange(hr, 2).setValue('Rating');
    props.setProperty('surf_sync_rating_col_v1', '1');
  }

  // v2 — insert Spot column at position 2 (this shifts Rating to col 3,
  // Tide to col 4, Best surf to col 5, and pushes "place" from N → O).
  if (props.getProperty('surf_sync_spot_col_v1') !== '1') {
    sheet.insertColumnBefore(2);
    var hr2 = _findHeaderRow(sheet);
    if (hr2) sheet.getRange(hr2, 2).setValue('Spot');
    props.setProperty('surf_sync_spot_col_v1', '1');
  }
}

function _findHeaderRow(sheet) {
  // Scans the first 3 rows × first 20 cols for any recognisable header
  // keyword. The Calendar sheet has A1 blank and "Rating" in B1, so we
  // can't anchor on column 1. Returns 1-indexed row, or null.
  var maxRow = Math.min(3, sheet.getLastRow());
  var maxCol = Math.min(20, sheet.getLastColumn());
  if (maxRow < 1 || maxCol < 1) return null;
  var keywords = {date:1, day:1, when:1, rating:1, spot:1, tide:1,
                  'best surf':1, route:1, stay:1, place:1, hotel:1};
  for (var r = 1; r <= maxRow; r++) {
    for (var c = 1; c <= maxCol; c++) {
      var v = String(sheet.getRange(r, c).getDisplayValue() || '').trim().toLowerCase();
      if (keywords[v]) return r;
    }
  }
  return null;
}

// ════════════════════════════════════════════════
//  PLACE → SPOT RESOLUTION
// ════════════════════════════════════════════════

function _resolveSurfSpotKey(placeText) {
  if (!placeText) return null;
  var t = String(placeText).trim();
  for (var i = 0; i < PLACE_RULES.length; i++) {
    if (PLACE_RULES[i].test.test(t)) return PLACE_RULES[i].spot;
  }
  return null;
}

function _conditionsForSpot(spot) {
  // Build a per-call conditions object: global defaults + per-spot
  // overrides for orientation / tide datum / tide range.
  var c = {};
  for (var k in DEFAULT_CONDITIONS) c[k] = DEFAULT_CONDITIONS[k];
  if (spot.beachFacing != null) c.beachFacing = String(spot.beachFacing);
  if (spot.tideDatum)           c.tideDatum   = spot.tideDatum;
  if (spot.minTide   != null)   c.minTide     = spot.minTide;
  if (spot.maxTide   != null)   c.maxTide     = spot.maxTide;
  c.tidesKey = PropertiesService.getScriptProperties().getProperty('WORLDTIDES_API_KEY') || '';
  return c;
}

// ════════════════════════════════════════════════
//  DATE INDEXING (shared by manual + auto sync)
// ════════════════════════════════════════════════

function _buildDateToRowIndex(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return {};
  var displayed = sheet.getRange(1, 1, lastRow, 1).getDisplayValues();
  var raw       = sheet.getRange(1, 1, lastRow, 1).getValues();
  var idx = {};
  var monNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  var pad2 = function(n) { return n < 10 ? '0' + n : '' + n; };
  for (var i = 0; i < displayed.length; i++) {
    var rowNum = i + 1;
    var disp = String(displayed[i][0] || '').trim();
    if (disp) idx[disp] = rowNum;
    var d = _coerceDate(raw[i][0]) || _coerceDate(disp);
    if (d) {
      var dd = pad2(d.getDate());
      var mIdx = d.getMonth(), mAbbr = monNames[mIdx];
      var dAbbr = dayNames[d.getDay()], yr = d.getFullYear();
      var mNum = pad2(mIdx + 1);
      idx[dd + '-' + mAbbr + ' (' + dAbbr + ')'] = rowNum;
      idx[dd + '-' + mAbbr]                       = rowNum;
      idx[mAbbr + ' ' + dd]                       = rowNum;
      idx[mAbbr + ' ' + parseInt(dd,10)]          = rowNum;
      idx[parseInt(dd,10) + '-' + mAbbr]          = rowNum;
      idx[yr + '-' + mNum + '-' + dd]             = rowNum;
      idx[yr + '/' + mNum + '/' + dd]             = rowNum;
      idx[mNum + '/' + dd]                        = rowNum;
      idx[mNum + '/' + dd + '/' + yr]             = rowNum;
      idx[parseInt(mNum,10) + '/' + parseInt(dd,10)] = rowNum;
    }
  }
  return idx;
}

function _findTodayRow(sheet) {
  var tz = Session.getScriptTimeZone();
  var todayIso = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var lastRow = sheet.getLastRow();
  var raw = sheet.getRange(1, 1, lastRow, 1).getValues();
  var disp = sheet.getRange(1, 1, lastRow, 1).getDisplayValues();
  for (var i = 0; i < lastRow; i++) {
    var d = _coerceDate(raw[i][0]) || _coerceDate(disp[i][0]);
    if (d && Utilities.formatDate(d, tz, 'yyyy-MM-dd') === todayIso) return i + 1;
  }
  return null;
}

function _coerceDate(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return v;
  if (typeof v !== 'string') return null;
  var s = v.trim();
  var yr = new Date().getFullYear();
  var monNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  function monIdxOf(x) { return monNames.indexOf(x.charAt(0).toUpperCase() + x.slice(1, 3).toLowerCase()); }
  var m;
  m = s.match(/^(\d{1,2})[\s\-\/\.](Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*(?:[\s,]+(\d{2,4}))?/i);
  if (m) return new Date(m[3] ? parseInt(m[3],10) : yr, monIdxOf(m[2]), parseInt(m[1],10));
  m = s.match(/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[\s\-\/\.]+(\d{1,2})(?:[\s,]+(\d{2,4}))?/i);
  if (m) return new Date(m[3] ? parseInt(m[3],10) : yr, monIdxOf(m[1]), parseInt(m[2],10));
  m = s.match(/^(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})/);
  if (m) return new Date(parseInt(m[1],10), parseInt(m[2],10)-1, parseInt(m[3],10));
  m = s.match(/^(\d{1,2})[\-\/](\d{1,2})(?:[\-\/](\d{2,4}))?/);
  if (m) {
    var a = parseInt(m[1],10), b = parseInt(m[2],10);
    var mon = (a >= 1 && a <= 12) ? a - 1 : b - 1;
    var day = (a >= 1 && a <= 12) ? b : a;
    return new Date(m[3] ? parseInt(m[3],10) : yr, mon, day);
  }
  return null;
}

function _coerceIsoDate(v) {
  var d = _coerceDate(v);
  return d ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd') : null;
}

// ════════════════════════════════════════════════
//  FORECAST ENGINE — port of the HTML app's logic
// ════════════════════════════════════════════════

function _buildForecastForSpot(spot) {
  var cond = _conditionsForSpot(spot);
  var marine  = _fetchMarine(spot.latitude, spot.longitude, cond.waveModel);
  var wind    = (cond.waveModel || '').indexOf('ecmwf') === 0 ? 'ecmwf_ifs025' : null;
  var weather = _fetchWeather(spot.latitude, spot.longitude, wind);
  var tides   = null;
  if (cond.tidesKey && cond.tidesKey.length > 6) {
    try {
      tides = _fetchTides(spot.latitude, spot.longitude, cond.tidesKey, cond.tideDatum);
    } catch (e) {
      Logger.log('WorldTides fetch failed for ' + spot.name + ': ' + e.message);
    }
  }
  return _processForecast(marine, weather, tides, cond);
}

function _fetchMarine(lat, lon, model) {
  var m = model || 'ecmwf_wam025';
  var daysFor = function(mdl) {
    return mdl === 'ewam' ? 5 : (mdl.indexOf('ecmwf') === 0 ? 15 : 16);
  };
  var build = function(mdl) {
    return 'https://marine-api.open-meteo.com/v1/marine?'
      + 'latitude=' + lat + '&longitude=' + lon
      + '&hourly=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period'
      + '&models=' + mdl
      + '&forecast_days=' + daysFor(mdl)
      + '&timezone=auto';
  };
  var isAllNull = function(d) {
    var w = d && d.hourly && d.hourly.wave_height;
    if (!Array.isArray(w) || !w.length) return true;
    for (var i = 0; i < w.length; i++) if (w[i] !== null) return false;
    return true;
  };
  var tryFetch = function(mdl) {
    var resp = UrlFetchApp.fetch(build(mdl), { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      throw new Error('Marine API ' + mdl + ' HTTP ' + resp.getResponseCode());
    }
    return JSON.parse(resp.getContentText());
  };
  var primary = tryFetch(m);
  if (!isAllNull(primary)) return primary;
  var chain = (m.indexOf('ecmwf') === 0)
    ? ['ncep_gfswave025', 'ewam']
    : ['ewam', 'ecmwf_wam025'];
  for (var i = 0; i < chain.length; i++) {
    try {
      var alt = tryFetch(chain[i]);
      if (!isAllNull(alt)) {
        alt._fellBackFrom = m; alt._fellBackTo = chain[i];
        return alt;
      }
    } catch (e) { /* try next */ }
  }
  primary._fellBackFrom = m; primary._fellBackTo = null;
  return primary;
}

function _fetchWeather(lat, lon, model) {
  var url = 'https://api.open-meteo.com/v1/forecast?'
    + 'latitude=' + lat + '&longitude=' + lon
    + '&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,weathercode,precipitation'
    + '&daily=sunrise,sunset,precipitation_sum'
    + (model ? '&models=' + model : '')
    + '&forecast_days=16&timezone=auto';
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('Weather API HTTP ' + resp.getResponseCode());
  return JSON.parse(resp.getContentText());
}

function _fetchTides(lat, lon, apiKey, datum) {
  var startUnix = Math.floor(Date.now() / (1000 * 3600)) * 3600;
  var url = 'https://www.worldtides.info/api/v3?heights'
    + '&lat=' + lat + '&lon=' + lon
    + '&datum=' + (datum || 'CD')
    + '&start=' + startUnix + '&days=16&step=3600'
    + '&key=' + encodeURIComponent(apiKey);
  var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) throw new Error('WorldTides HTTP ' + resp.getResponseCode());
  var data = JSON.parse(resp.getContentText());
  if (data.error) throw new Error('WorldTides: ' + data.error);
  return data;
}

// ── Per-hour scoring (mirror of HTML scoreHour) ───────────────────────
function _scoreHour(waveH, windKn, period, windDir, tideH, cond) {
  var score = 0;
  // Wave height (0–35)
  if (waveH >= cond.minWave && waveH <= cond.maxWave) {
    var mid = (cond.minWave + cond.maxWave) / 2;
    var spread = (cond.maxWave - cond.minWave) / 2 || 0.1;
    var dist = Math.abs(waveH - mid) / spread;
    score += Math.round(35 * (1 - dist * 0.4));
  } else if (waveH < cond.minWave) {
    score += Math.round(35 * (waveH / cond.minWave) * 0.4);
  } else {
    score += Math.max(0, Math.round(35 * (1 - (waveH - cond.maxWave) / cond.maxWave * 0.8)));
  }
  // Wind (0–45)
  if (cond.beachFacing !== 'any' && windDir !== null) {
    var calmness = Math.max(0, 1 - windKn / (cond.maxWindKn * 1.5));
    var speedFactor = Math.min(1, windKn / 10);
    var facing = parseFloat(cond.beachFacing);
    var offshoreFrom = (facing + 180) % 360;
    var diff = Math.abs(windDir - offshoreFrom);
    var angle = Math.min(diff, 360 - diff);
    var dirMult = 0.1 + 0.9 * (1 + Math.cos(angle * Math.PI / 180)) / 2;
    var blended = (1 - speedFactor) * 1.0 + speedFactor * dirMult;
    var windScore = calmness * blended;
    score += Math.round(45 * Math.max(0, Math.min(1, windScore)));
  } else {
    if (windKn <= cond.maxWindKn) {
      score += Math.round(45 * (1 - windKn / cond.maxWindKn * 0.4));
    } else {
      score += Math.max(0, Math.round(45 * (1 - (windKn - cond.maxWindKn) / cond.maxWindKn)));
    }
  }
  // Period (0–10)
  score += period >= cond.minPeriod ? 10 : Math.round(10 * period / cond.minPeriod);
  // Tide (0–10) — only when in range
  if (tideH !== null && tideH !== undefined) {
    if (tideH >= cond.minTide && tideH <= cond.maxTide) {
      var mid2 = (cond.minTide + cond.maxTide) / 2;
      var spread2 = (cond.maxTide - cond.minTide) / 2 || 0.1;
      var dist2 = Math.abs(tideH - mid2) / spread2;
      score += Math.round(10 * (1 - dist2 * 0.2));
    }
  }
  return Math.min(100, Math.max(0, score));
}

function _kmhToKnots(kmh) { return kmh * 0.539957; }

function _parseHourFrac(iso) {
  if (!iso) return null;
  var h = parseInt(iso.substr(11, 2), 10);
  var m = parseInt(iso.substr(14, 2), 10);
  return h + m / 60;
}

// ── Day-by-day processing (mirror of HTML processForecast) ────────────
function _processForecast(marine, weather, tidesData, cond) {
  var utcOff = (marine && marine.utc_offset_seconds) || (weather && weather.utc_offset_seconds) || 0;

  // Build tide map keyed by "YYYY-MM-DD|H"
  var tideMap = {};
  if (tidesData && tidesData.heights) {
    tidesData.heights.forEach(function(pt) {
      var d = new Date((pt.dt + utcOff) * 1000);
      var yyyy = d.getUTCFullYear();
      var mm = ('0' + (d.getUTCMonth() + 1)).slice(-2);
      var dd = ('0' + d.getUTCDate()).slice(-2);
      var hh = d.getUTCHours();
      tideMap[yyyy + '-' + mm + '-' + dd + '|' + hh] = pt.height;
    });
  }
  var hasTides = Object.keys(tideMap).length > 0;

  // Sun map
  var sunMap = {};
  if (weather.daily && weather.daily.time) {
    weather.daily.time.forEach(function(date, i) {
      sunMap[date] = {
        riseStr:  weather.daily.sunrise[i],
        setStr:   weather.daily.sunset[i],
        riseFrac: _parseHourFrac(weather.daily.sunrise[i]),
        setFrac:  _parseHourFrac(weather.daily.sunset[i]),
        rainMm:   (weather.daily.precipitation_sum && weather.daily.precipitation_sum[i]) || 0,
      };
    });
  }

  // Index weather hourly by time string for fast join
  var wTimeIdx = {};
  weather.hourly.time.forEach(function(t, i) { wTimeIdx[t] = i; });

  // Build per-day hour arrays
  var hours = marine.hourly.time;
  var byDate = {};
  for (var i = 0; i < hours.length; i++) {
    var t = hours[i];
    var date = t.substr(0, 10);
    var hour = parseInt(t.substr(11, 2), 10);
    if (!byDate[date]) byDate[date] = [];

    // Normalise undefined → null at ingestion so downstream null-checks
    // (which are strict `!== null` in the HTML port) don't leak NaN.
    var nz = function(v) { return v == null ? null : v; };
    var waveH  = nz(marine.hourly.wave_height[i]);
    var period = nz(marine.hourly.wave_period[i]);
    var swellH = nz(marine.hourly.swell_wave_height[i]);
    var wi = (wTimeIdx[t] !== undefined) ? wTimeIdx[t] : -1;
    var windKmh = wi >= 0 ? nz(weather.hourly.wind_speed_10m[wi])     : null;
    var windDir = wi >= 0 ? nz(weather.hourly.wind_direction_10m[wi]) : null;
    var rainHr  = wi >= 0 ? nz(weather.hourly.precipitation[wi])      : null;
    var windKn  = windKmh != null ? _kmhToKnots(windKmh) : null;
    var tideH   = tideMap[date + '|' + hour];
    if (tideH === undefined) tideH = null;
    var score = (waveH != null && windKn != null && period != null)
              ? _scoreHour(waveH, windKn, period, windDir, tideH, cond) : 0;
    byDate[date].push({
      hour: hour, waveH: waveH, period: period, swellH: swellH,
      windKn: windKn, windDir: windDir, rainHr: rainHr, tideH: tideH, score: score,
    });
  }

  // Residual chop penalty
  if (cond.beachFacing !== 'any') {
    var facing = parseFloat(cond.beachFacing);
    var offshoreFrom = (facing + 180) % 360;
    Object.keys(byDate).forEach(function(date) {
      var hrs = byDate[date];
      for (var i = 0; i < hrs.length; i++) {
        var h = hrs[i];
        if (h.windDir === null || h.windDir === undefined) continue;
        var chopPenalty = 0;
        for (var back = 1; back <= 2; back++) {
          var prev = hrs[i - back];
          if (!prev || prev.windDir === null || prev.windDir === undefined) continue;
          var pd = Math.abs(prev.windDir - offshoreFrom);
          var pa = Math.min(pd, 360 - pd);
          var prevOnshore = Math.max(0, (pa - 90) / 90);
          var prevStrength = Math.min(1, prev.windKn / 12);
          var chopCreated = prevOnshore * prevStrength;
          var cd = Math.abs(h.windDir - offshoreFrom);
          var ca = Math.min(cd, 360 - cd);
          var cleanup = ca < 60 ? 0.3 : ca < 100 ? 0.6 : 0.9;
          var decay = back === 1 ? 1.0 : 0.5;
          chopPenalty += chopCreated * cleanup * decay;
        }
        if (chopPenalty > 0) {
          h.score = Math.round(h.score * (1 - Math.min(0.15, chopPenalty * 0.15)));
        }
      }
    });
  }

  // Per-day rollup
  var dates = Object.keys(byDate).sort().slice(0, 16);
  return dates.map(function(date) {
    var allHrs = byDate[date].filter(function(h) { return h.waveH !== null && h.waveH !== undefined; });
    if (!allHrs.length) return null;
    var sun = sunMap[date] || { riseFrac: 6, setFrac: 19 };

    var afterDaylight = allHrs.filter(function(h) {
      return (h.hour + 1) > sun.riseFrac && h.hour < sun.setFrac
          && h.hour >= cond.earliestHour && h.hour < cond.latestHour;
    });
    if (!afterDaylight.length) afterDaylight = allHrs;

    var allTideHrs = afterDaylight.filter(function(h) { return h.tideH !== null && h.tideH !== undefined; });

    var useHrs, noTideWindow = false;
    if (hasTides && allTideHrs.length > 0) {
      var tideFiltered = afterDaylight.filter(function(h) {
        return h.tideH !== null && h.tideH !== undefined && h.tideH >= cond.minTide && h.tideH <= cond.maxTide;
      });
      if (tideFiltered.length > 0) useHrs = tideFiltered;
      else { noTideWindow = true; useHrs = afterDaylight; }
    } else {
      useHrs = afterDaylight;
    }

    // Best window with end-boundary check + tier extension
    var minSess = cond.minSessionHrs || 2;
    var bestWindow = null, bestWindowScore = -1, bestWindowBoundaryOK = false;
    var noConsecutiveWindow = false, tideDropsAtEnd = false;

    if (!noTideWindow && useHrs.length > 0) {
      var dayHrMap = {};
      afterDaylight.forEach(function(h) { dayHrMap[h.hour] = h; });
      var runs = [];
      var run = [useHrs[0]];
      for (var i = 1; i < useHrs.length; i++) {
        if (useHrs[i].hour === useHrs[i-1].hour + 1) run.push(useHrs[i]);
        else { runs.push(run); run = [useHrs[i]]; }
      }
      if (run.length) runs.push(run);

      runs.forEach(function(r) {
        if (r.length < minSess) return;
        for (var i = 0; i <= r.length - minSess; i++) {
          var slice = r.slice(i, i + minSess);
          var sliceEndHr = slice[slice.length - 1].hour;
          var boundaryOK = true;
          if (hasTides) {
            var b = dayHrMap[sliceEndHr + 1];
            if (b && b.tideH !== null && b.tideH !== undefined) {
              boundaryOK = b.tideH >= cond.minTide && b.tideH <= cond.maxTide;
            }
          }
          var ws = slice.reduce(function(s, h) { return s + h.score; }, 0) / slice.length;
          if (boundaryOK && !bestWindowBoundaryOK) {
            bestWindowBoundaryOK = true; bestWindowScore = ws; bestWindow = slice;
          } else if (boundaryOK === bestWindowBoundaryOK && ws > bestWindowScore) {
            bestWindowScore = ws; bestWindow = slice;
          }
        }
      });

      if (bestWindow && !bestWindowBoundaryOK) tideDropsAtEnd = true;

      // Tier-based extension (anchor stays in same rating tier)
      if (bestWindow && bestWindowScore >= 50) {
        var containingRun = null;
        runs.forEach(function(r) {
          if (bestWindow[0].hour >= r[0].hour
              && bestWindow[bestWindow.length - 1].hour <= r[r.length - 1].hour) {
            containingRun = r;
          }
        });
        if (containingRun) {
          var tier = bestWindowScore >= 80 ? 80 : bestWindowScore >= 65 ? 65 : 50;
          var lo = -1, hi = -1;
          for (var k = 0; k < containingRun.length; k++) {
            if (containingRun[k].hour === bestWindow[0].hour) lo = k;
            if (containingRun[k].hour === bestWindow[bestWindow.length - 1].hour) hi = k;
          }
          while (lo > 0 && containingRun[lo - 1].score >= tier) lo--;
          while (hi < containingRun.length - 1) {
            var nx = containingRun[hi + 1];
            if (nx.score < tier) break;
            var nextBoundaryOK = true;
            if (hasTides) {
              var bb = dayHrMap[nx.hour + 1];
              if (bb && bb.tideH !== null && bb.tideH !== undefined) {
                nextBoundaryOK = bb.tideH >= cond.minTide && bb.tideH <= cond.maxTide;
              }
            }
            if (bestWindowBoundaryOK && !nextBoundaryOK) break;
            hi++;
          }
          bestWindow = containingRun.slice(lo, hi + 1);
          bestWindowScore = bestWindow.reduce(function(s, h) { return s + h.score; }, 0) / bestWindow.length;
        }
      }

      if (!bestWindow && useHrs.length > 0) noConsecutiveWindow = true;
    }

    var bestHour  = bestWindow ? bestWindow[0].hour : null;
    var bestEndHr = bestWindow ? bestWindow[bestWindow.length - 1].hour + 1 : null;

    var rawDayScore = noTideWindow ? 0
      : bestWindow ? bestWindowScore
      : useHrs.reduce(function(s, h) { return s + h.score; }, 0) / useHrs.length;
    var windowRain = afterDaylight.reduce(function(s, h) {
      return s + ((h.rainHr !== null && h.rainHr !== undefined) ? h.rainHr : 0);
    }, 0);
    var dayScore = windowRain > 10 ? Math.min(rawDayScore, 30) : rawDayScore;

    return {
      date: date,
      dayScore: dayScore,
      bestHour: bestHour, bestEndHr: bestEndHr,
      noTideWindow: noTideWindow, noConsecutiveWindow: noConsecutiveWindow,
      tideDropsAtEnd: tideDropsAtEnd,
      hasTides: hasTides,
      allWindowHrs: afterDaylight.map(function(h) {
        return { hour: h.hour, tideH: h.tideH };
      }),
    };
  }).filter(function(d) { return d !== null; });
}

// ── Sheet row builder (mirror of HTML buildSheetRows) ─────────────────
function _buildSheetRow(d, cond) {
  var rating = _rateDay(d);
  var ratingLabel = _RATING_LABELS[rating] || '';
  if (rating === 'poor') {
    return { rating: ratingLabel, surfable: '', good: 'POOR' };
  }
  var dayHasTideData = (d.allWindowHrs || []).some(function(h) { return h.tideH !== null && h.tideH !== undefined; });
  var surfableHrs = (d.allWindowHrs || []).filter(function(h) {
    if (d.hasTides && dayHasTideData) {
      return h.tideH !== null && h.tideH !== undefined && h.tideH >= cond.minTide && h.tideH <= cond.maxTide;
    }
    return true;
  }).map(function(h) { return h.hour; });
  var surfable = surfableHrs.length ? _hoursToRanges(surfableHrs) : '';
  var good = (d.bestHour !== null && d.bestEndHr !== null)
    ? d.bestHour + ':00–' + d.bestEndHr + ':00'
    : 'POOR';
  return { rating: ratingLabel, surfable: surfable, good: good };
}

function _rateDay(d) {
  if (d.noTideWindow || d.noConsecutiveWindow) return 'poor';
  if (d.dayScore >= 80) return 'epic';
  if (d.dayScore >= 65) return 'great';
  if (d.dayScore >= 50) return 'decent';
  if (d.dayScore >= 35) return 'marginal';
  return 'poor';
}

var _RATING_LABELS = {
  epic:     'Epic 🟣',
  great:    'Great 🟢',
  decent:   'Decent 🟡',
  marginal: 'Marginal 🟠',
  poor:     'Poor 🔴',
};

function _hoursToRanges(hours) {
  if (!hours.length) return '';
  var sorted = hours.slice().sort(function(a, b) { return a - b; });
  var ranges = [];
  var start = sorted[0], prev = sorted[0];
  for (var i = 1; i < sorted.length; i++) {
    if (sorted[i] === prev + 1) prev = sorted[i];
    else { ranges.push(start + ':00–' + (prev + 1) + ':00'); start = sorted[i]; prev = sorted[i]; }
  }
  ranges.push(start + ':00–' + (prev + 1) + ':00');
  return ranges.join(', ');
}

// ════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
