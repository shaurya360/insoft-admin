/**
 * @OnlyCurrentDoc
 * (Limits the script's access to this one spreadsheet, not all of your Google Sheets.)
 *
 * INSOFT — Vendor list → Google Sheets (read-only copy)
 *
 * Copies the vendor directory from the INSOFT admin app into a "Vendors" tab:
 * company, owner mobile, address, contact person, contact number, categories, brands.
 * No clients, payables, balances or any other data are included.
 *
 * The sheet is a copy: edit vendors in the admin app. Sync runs only when you
 * choose Insoft → Sync vendors now. Before replacing the list, the current tab is
 * copied to "Vendors (previous sync)", and the sync stops to ask you if the new
 * list is empty or much shorter — so an accidental deletion in the app can't
 * silently wipe this copy.
 *
 * Setup (once):
 *   1. Extensions → Apps Script, paste this file, save.
 *   2. Project Settings (gear) → Script properties → add:
 *        SUPABASE_URL       https://<project-ref>.supabase.co
 *        SUPABASE_ANON_KEY  <anon / publishable key>
 *        VENDOR_EXPORT_KEY  <vendor export key>
 *   3. Run syncVendors once and allow access when Google asks.
 *   Reload the spreadsheet to see the "Insoft" menu (Sync vendors now).
 *   If you set up the earlier hourly version, run removeHourlySync once.
 */

const SHEET_NAME = 'Vendors';
const BACKUP_NAME = 'Vendors (previous sync)';
const HEADER = ['Company', 'Owner mobile', 'Address', 'Contact person', 'Contact number', 'Categories', 'Brands', 'Last updated in app'];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Insoft')
    .addItem('Sync vendors now', 'syncVendors')
    .addToUi();
}

function syncVendors() {
  const props = PropertiesService.getScriptProperties();
  const url = (props.getProperty('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
  const anon = (props.getProperty('SUPABASE_ANON_KEY') || '').trim();
  const key = (props.getProperty('VENDOR_EXPORT_KEY') || '').trim();
  if (!url || !anon || !key) {
    throw new Error('Add SUPABASE_URL, SUPABASE_ANON_KEY and VENDOR_EXPORT_KEY under Project Settings → Script properties.');
  }

  const res = UrlFetchApp.fetch(url + '/rest/v1/rpc/export_vendors', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: anon, Authorization: 'Bearer ' + anon },
    payload: JSON.stringify({ p_key: key }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Vendor sync failed (' + res.getResponseCode() + '): ' + res.getContentText().slice(0, 200));
  }
  const vendors = JSON.parse(res.getContentText());

  const ss = SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);

  // Safety check: never silently replace a list with an empty or much shorter one
  const current = Math.max(sheet.getLastRow() - 1, 0);
  if (current > 0 && vendors.length < current) {
    const ui = SpreadsheetApp.getUi();
    const msg = vendors.length === 0
      ? 'The admin app returned NO vendors, but this sheet has ' + current + '.'
      : 'The admin app has ' + vendors.length + ' vendors, but this sheet has ' + current + ' (' + (current - vendors.length) + ' fewer).';
    const answer = ui.alert(
      'Check before replacing',
      msg + '\n\nIf vendors were deleted in the app on purpose, click Yes. ' +
        'If not, click No — this sheet stays as it is.\n\n' +
        'The current list is also copied to "' + BACKUP_NAME + '" before any change.',
      ui.ButtonSet.YES_NO,
    );
    if (answer !== ui.Button.YES) {
      ss.toast('Sync cancelled — the sheet was not changed', 'Insoft', 6);
      return;
    }
  }

  // Keep the previous list in its own tab
  if (current > 0) {
    const old = ss.getSheetByName(BACKUP_NAME);
    if (old) ss.deleteSheet(old);
    sheet.copyTo(ss).setName(BACKUP_NAME);
    ss.setActiveSheet(sheet);
  }
  const rows = vendors.map((v) => [
    v.company || '',
    v.owner_mobile || '',
    v.address || '',
    v.poc_name || '',
    v.poc_phone || '',
    v.categories || '',
    v.brands || '',
    v.updated_at ? new Date(v.updated_at) : '',
  ]);

  sheet.clear();
  const width = HEADER.length;
  sheet.getRange(1, 1, 1, width).setValues([HEADER])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#0056b3');
  if (rows.length) {
    const body = sheet.getRange(2, 1, rows.length, width);
    // Plain text, so numbers like "+91 98100 10005" and names starting with "=" stay exactly as typed
    sheet.getRange(2, 1, rows.length, width - 1).setNumberFormat('@');
    sheet.getRange(2, width, rows.length, 1).setNumberFormat('dd mmm yyyy, h:mm am/pm');
    body.setValues(rows).setVerticalAlignment('top').setWrap(true);
  }
  sheet.setFrozenRows(1);
  sheet.setColumnWidths(1, 1, 220);
  sheet.setColumnWidths(2, 1, 150);
  sheet.setColumnWidths(3, 1, 280);
  sheet.setColumnWidths(4, 2, 150);
  sheet.setColumnWidths(6, 1, 200);
  sheet.setColumnWidths(7, 1, 320);
  sheet.setColumnWidths(8, 1, 170);

  const note = 'Synced from INSOFT admin ' + Utilities.formatDate(new Date(), 'Asia/Kolkata', 'dd MMM yyyy, h:mm a') +
    ' IST · ' + rows.length + ' vendors. Edit vendors in the admin app — changes here are overwritten on the next sync.';
  sheet.getRange(1, 1).setNote(note);

  // Warn (but don't block) anyone editing the copy by hand
  const existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
  if (!existing.length) sheet.protect().setDescription('Vendor list synced from INSOFT admin').setWarningOnly(true);

  ss.toast(rows.length + ' vendors synced', 'Insoft', 5);
}

// Removes the hourly trigger used by the earlier version of this script.
function removeHourlySync() {
  const triggers = ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'syncVendors');
  triggers.forEach((t) => ScriptApp.deleteTrigger(t));
  SpreadsheetApp.getActive().toast(triggers.length + ' automatic sync trigger(s) removed. Sync now runs only from the Insoft menu.', 'Insoft', 6);
}
