Inputs - input.config().

Name: waveRecordId,
Value: Airtable record ID,

/*******************************************************
 * Automation: Print CSV — Free Overlay branch
 *
 * Lives in: Print CSV automation > "Otherwise if goal is Free Overlay"
 * Trigger (inherited): Waves.Status == "Print-CSV"
 * Success: set Waves.Status = "Printed"
 * Failure: set Waves.Status = "Error"
 *
 * Simplified schema for Free Overlay:
 * - 1 recipe = 1 source creative + 1 overlay
 * - No Recipe Slots iteration; everything read straight from Recipes
 *
 * Recipes fields used:
 * - auto_id            (sort order)
 * - source_video_path  (string: full S3 path to source creative)
 * - free_overlay       (link to Overlays OR plain text; auto-detected)
 *
 * Recipe Exports output:
 * - id        = sequential 1..N
 * - slot_1    = source_video_path
 * - overlay_1 = free_overlay path
 *
 * Clears ALL rows in Recipe Exports before writing.
 *******************************************************/

const TABLE_WAVES = 'Waves';
const TABLE_RECIPES = 'Recipes';
const TABLE_EXPORTS = 'Recipe Exports';
const TABLE_OVERLAYS = 'Overlays';

const STATUS_PRINT = 'Print-CSV';
const STATUS_PRINTED = 'Printed';
const STATUS_ERROR = 'Error';

// ---------- helpers ----------
function safeGetField(table, name) { try { return table.getField(name); } catch { return null; } }
function getFirstExistingField(table, names) {
  for (const n of names) { const f = safeGetField(table, n); if (f) return f; }
  return null;
}
function getLinks(cell) { return Array.isArray(cell) ? cell : []; }
function chunk(arr, size) { const out = []; for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size)); return out; }
function normaliseSingleSelect(field, name) {
  if (!field) return null;
  if (field.type !== 'singleSelect') return name;
  return name ? { name } : null;
}
function findLinkFieldTo(table, linkedTable) {
  const linkedId = linkedTable.id;
  return table.fields.find(f =>
    f.type === 'multipleRecordLinks' &&
    f.options &&
    f.options.linkedTableId === linkedId
  ) || null;
}

async function main() {
  const { waveRecordId } = input.config();
  if (!waveRecordId) throw new Error('Missing input: waveRecordId');

  const wavesTable = base.getTable(TABLE_WAVES);
  const recipesTable = base.getTable(TABLE_RECIPES);
  const exportsTable = base.getTable(TABLE_EXPORTS);
  const overlaysTable = base.getTable(TABLE_OVERLAYS);

  // ===== Wave status guard =====
  const fWaveStatus = getFirstExistingField(wavesTable, ['Status', 'status']);
  if (!fWaveStatus) throw new Error('Waves.Status not found');

  const wave = await wavesTable.selectRecordAsync(waveRecordId, {
    fields: [fWaveStatus.id],
  });
  if (!wave) throw new Error('Wave not found');

  const statusCell = wave.getCellValue(fWaveStatus);
  const statusName = (statusCell && typeof statusCell === 'object' && statusCell.name)
    ? statusCell.name
    : wave.getCellValueAsString(fWaveStatus);
  if (String(statusName) !== STATUS_PRINT) return;

  // ===== Recipes fields =====
  const rfRecipesToWaves = findLinkFieldTo(recipesTable, wavesTable);
  if (!rfRecipesToWaves) throw new Error('Recipes -> Waves link field not found');

  const fRecipeAutoId = getFirstExistingField(recipesTable, ['auto_id']);
  if (!fRecipeAutoId) throw new Error('Recipes.auto_id not found');

  const fRecipeSourcePath = getFirstExistingField(recipesTable, ['source_video_path', 'source path']);
  if (!fRecipeSourcePath) throw new Error('Recipes.source_video_path not found');

  const fRecipeFreeOverlay = getFirstExistingField(recipesTable, ['free_overlay', 'free overlay']);
  if (!fRecipeFreeOverlay) throw new Error('Recipes.free_overlay not found');

  // ===== Export fields =====
  const fExpId = getFirstExistingField(exportsTable, ['id', 'ID']);
  const fExpSlot1 = getFirstExistingField(exportsTable, ['slot_1']);
  const fExpOverlay1 = getFirstExistingField(exportsTable, ['overlay_1']);
  if (!fExpId || !fExpSlot1 || !fExpOverlay1) {
    throw new Error('Recipe Exports: require fields id + slot_1 + overlay_1');
  }

  // ===== Resolve overlay source (link OR plain text) =====
  const isOverlayLink = fRecipeFreeOverlay.type === 'multipleRecordLinks';
  const overlayPathByRecordId = new Map();
  if (isOverlayLink) {
    const fOverlayS3 = getFirstExistingField(overlaysTable, ['s3_link', 'S3_link', 's3 link']);
    if (!fOverlayS3) throw new Error('Overlays.s3_link not found');
    const oq = await overlaysTable.selectRecordsAsync({ fields: [fOverlayS3.id] });
    for (const o of oq.records) {
      overlayPathByRecordId.set(o.id, o.getCellValueAsString(fOverlayS3) || '');
    }
  }

  // ===== Clear ALL exports =====
  const allExp = await exportsTable.selectRecordsAsync();
  const delIds = allExp.records.map(r => r.id);
  for (const b of chunk(delIds, 50)) await exportsTable.deleteRecordsAsync(b);

  // ===== Load recipes for this wave =====
  const rq = await recipesTable.selectRecordsAsync({
    fields: [rfRecipesToWaves.id, fRecipeAutoId.id, fRecipeSourcePath.id, fRecipeFreeOverlay.id],
  });

  const waveRecipes = rq.records.filter(r => {
    const wLinks = getLinks(r.getCellValue(rfRecipesToWaves));
    return wLinks.some(x => x.id === waveRecordId);
  });

  if (waveRecipes.length === 0) {
    await wavesTable.updateRecordAsync(waveRecordId, {
      [fWaveStatus.id]: normaliseSingleSelect(fWaveStatus, STATUS_PRINTED),
    });
    return;
  }

  // Sort by auto_id (numeric)
  const recipesSorted = waveRecipes.slice().sort((a, b) => {
    const idA = Number(a.getCellValue(fRecipeAutoId)) || 0;
    const idB = Number(b.getCellValue(fRecipeAutoId)) || 0;
    return idA - idB;
  });

  // ===== Build export rows =====
  const exportPayload = [];
  for (let idx = 0; idx < recipesSorted.length; idx++) {
    const r = recipesSorted[idx];
    const outFields = {};

    outFields[fExpId.id] = idx + 1;
    outFields[fExpSlot1.id] = r.getCellValueAsString(fRecipeSourcePath) || '';

    let overlayPath = '';
    if (isOverlayLink) {
      const links = getLinks(r.getCellValue(fRecipeFreeOverlay));
      if (links.length > 0) overlayPath = overlayPathByRecordId.get(links[0].id) || '';
    } else {
      overlayPath = r.getCellValueAsString(fRecipeFreeOverlay) || '';
    }
    outFields[fExpOverlay1.id] = overlayPath;

    exportPayload.push({ fields: outFields });
  }

  // ===== Write exports =====
  for (const b of chunk(exportPayload, 50)) await exportsTable.createRecordsAsync(b);

  // ===== Success =====
  await wavesTable.updateRecordAsync(waveRecordId, {
    [fWaveStatus.id]: normaliseSingleSelect(fWaveStatus, STATUS_PRINTED),
  });
}

try {
  await main();
} catch (err) {
  try {
    const { waveRecordId } = input.config();
    if (waveRecordId) {
      const wavesTable = base.getTable(TABLE_WAVES);
      const fWaveStatus = getFirstExistingField(wavesTable, ['Status', 'status']);
      if (fWaveStatus) {
        await wavesTable.updateRecordAsync(waveRecordId, {
          [fWaveStatus.id]: normaliseSingleSelect(fWaveStatus, STATUS_ERROR),
        });
      }
    }
  } catch (_) {}
  throw err;
}
