/**
 * Surf Forecast → Google Sheet sync (Apps Script web app)
 *
 * Setup (one-time):
 *   1. Open your target sheet:
 *      https://docs.google.com/spreadsheets/d/1bXjmDRXEi85z94zFpt00MEJTHrrWge9JRp3SGXckuWo/edit
 *   2. Extensions → Apps Script.
 *   3. Replace any existing code with this file's contents.
 *   4. (Optional) Change SHEET_NAME below if you rename your tab — currently
 *      "Calendar" (the first tab in the Spring-Summer 2026 workbook).
 *   5. Save, then Deploy → New deployment → Type: Web app.
 *        - Execute as: Me
 *        - Who has access: Anyone
 *   6. Copy the resulting /exec URL and paste it into the surf forecast app.
 *
 * Payload from the app:
 *   {
 *     "rows": [
 *       { "date": "18-Apr (Sat)", "surfable": "6:00-10:00", "good": "7:00-9:00" },
 *       { "date": "19-Apr (Sun)", "surfable": "",           "good": "POOR"    },
 *       ...
 *     ]
 *   }
 *
 * Behaviour:
 *   - Column A is matched as a plain string (the sheet stores dates like
 *     "18-Apr (Sat)"), so we compare trimmed strings.
 *   - For each matched row, column B ← surfable, column C ← good.
 *   - Dates that don't exist in column A are counted as `skipped` in the
 *     response (so the app can tell the user).
 */
var SHEET_NAME = 'Calendar';  // change if your tab is named differently

function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents || '{}');
    var rows = payload.rows || [];
    if (!rows.length) return jsonOut({ ok: false, error: 'no rows' });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_NAME) || ss.getSheets()[0];
    var lastRow = sheet.getLastRow();
    if (lastRow < 1) return jsonOut({ ok: false, error: 'sheet is empty' });

    // Read all of column A once (fast) and build a date → rowNumber index.
    var colA = sheet.getRange(1, 1, lastRow, 1).getValues();
    var dateToRow = {};
    for (var i = 0; i < colA.length; i++) {
      var key = String(colA[i][0]).trim();
      if (key) dateToRow[key] = i + 1;  // 1-indexed
    }

    var updated = 0, skipped = 0;
    var misses = [];
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j];
      var rowNum = dateToRow[String(row.date).trim()];
      if (!rowNum) { skipped++; misses.push(row.date); continue; }
      sheet.getRange(rowNum, 2).setValue(row.surfable || '');
      sheet.getRange(rowNum, 3).setValue(row.good || '');
      updated++;
    }

    return jsonOut({ ok: true, updated: updated, skipped: skipped, misses: misses });
  } catch (err) {
    return jsonOut({ ok: false, error: err.message || String(err) });
  }
}

// Simple GET for "is this deployed?" testing — open the /exec URL in a browser.
function doGet() {
  return jsonOut({ ok: true, hint: 'POST JSON { rows: [...] } to update the sheet.' });
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
