If goal is any of Iteration, Homunculus, Screening.

Inputs - input.config().
Name: waveRecordId,
Value: Airtable record ID,

Secrets - input.secret().
Name: AUTH0_CLIENT_SECRET,
Secret: AUTH0_CLIENT_SECRET,
Name: AUTH0_CLIENT_ID,
Secret: AUTH0_CLIENT_ID,


/*******************************************************
 * Automation: Export Recipes -> POST /api/v1/pipelines/
 *
 * Trigger: Waves.Status == "Print-CSV"
 * Success: set Waves.Status = "Printed"
 * Failure: set Waves.Status = "Error"
 *
 * v6 changelog (2026-05-27):
 *   [NEW] Dark disclaimer support. Per-recipe overlay selection based on
 *         body asset's disclaimer_style field (singleSelect: white | black).
 *         White bodies (default) get the standard overlay from Wave.disclaimer.
 *         Black bodies get the dark_variant of the same disclaimer record.
 *         Both ratio variants (9x16 / 16x9) resolved at startup.
 *
 *         New fields read:
 *           Assets.disclaimer_style    (singleSelect, fldOj0fUM6dwmp3Ov)
 *           Overlays.dark_variant      (multipleRecordLinks, fldSrNVYfxrzx4I4S)
 *
 *         posToInfo now carries assetId so the per-recipe body lookup works.
 *         Falls back to white overlay if dark_variant is not set or empty.
 *
 * v5 changelog (2026-05-21):
 *   [NEW] Sticker (second overlay) support. Wave.sticker link field
 *         resolves to an Overlays record. Its path goes into the task-level
 *         "overlay_all" field of the Builder API payload.
 *         Same ratio convention as disclaimer. Falls back gracefully if
 *         Wave.sticker is empty.
 *
 * v4 changelog (2026-05-15):
 *   [NEW] Ratio-aware overlays. Reads both s3_link_9x16 / s3_link_16x9.
 *         In the recipe loop picks the one matching Recipe.ratio.
 *
 * v3 changelog (2026-05-15):
 *   [NEW] Multi-aspect-ratio source paths. 16x9 appends "_16x9" before
 *         ".mp4" in every slot path. 9x16 uses canonical "{name}.mp4".
 *
 * v2 changelog (2026-05-15):
 *   [NEW] Manifest block. folder_name, result_name, task_number, etc.
 *******************************************************/

const TABLE_WAVES = 'Waves';
const TABLE_RECIPES = 'Recipes';
const TABLE_RECIPE_SLOTS = 'Recipe Slots';
const TABLE_CONSTRUCTOR_SLOTS = 'Constructor Slots';
const TABLE_ASSETS = 'Assets';
const TABLE_DISCLAIMERS = 'Overlays';
const TABLE_TASKS = 'Tasks';

const AUDIO_PREFIX = '/martech/video_builder/source_assets/audio/';
const VIDEO_PREFIX = '/martech/video_builder/source_assets/video/Assets';

const LAUNCH_DATE_TZ = 'Europe/Nicosia';
const CREO_NAME_SEPARATOR = '_';

const API_BASE_URL = 'https://mtech.fstr.app';
const AUTH0_TOKEN_URL = 'https://simple-prod-payment.us.auth0.com/oauth/token';
const AUTH0_AUDIENCE = 'https://mtech.fstr.app';
const DEFAULT_CODEC = 'h264';
const DEFAULT_VOLUME = 0.80;

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

function buildVideoPath(assetFileName, ratio) {
  if (!assetFileName) return '';
  const suffix = (ratio === '16x9') ? '_16x9' : '';
  return `${VIDEO_PREFIX}/${assetFileName}${suffix}.mp4`;
}
function buildAudioPath(musicFileName) { return musicFileName ? `${AUDIO_PREFIX}${musicFileName}` : ''; }
function toS3Path(url) {
  if (!url) return '';
  const idx = url.indexOf('martech/');
  return idx !== -1 ? url.slice(idx) : url;
}

function normaliseSingleSelect(field, name) {
  if (!field) return null;
  if (field.type !== 'singleSelect') return name;
  return name ? { name } : null;
}

function getSingleSelectName(cell) {
  if (!cell) return null;
  if (typeof cell === 'string') return cell;
  if (cell && typeof cell === 'object' && 'name' in cell) return cell.name;
  return null;
}

function findLinkFieldTo(table, linkedTable) {
  const linkedId = linkedTable.id;
  return table.fields.find(f =>
    f.type === 'multipleRecordLinks' &&
    f.options &&
    f.options.linkedTableId === linkedId
  ) || null;
}

function isEndcard(rolesValue) {
  if (!rolesValue) return false;
  if (typeof rolesValue === 'string') return rolesValue.toLowerCase().includes('endcard');
  if (Array.isArray(rolesValue)) return rolesValue.some(v => v && typeof v.name === 'string' && v.name.toLowerCase().includes('endcard'));
  if (typeof rolesValue === 'object' && rolesValue.name) return rolesValue.name.toLowerCase().includes('endcard');
  return false;
}

function todayIsoInTz(tz) {
  return new Date().toLocaleDateString('sv-SE', { timeZone: tz });
}

function generateUUID() {
  const ms = Date.now();
  const h1 = Math.floor(ms / 0x10000).toString(16).padStart(8, '0');
  const h2 = (ms & 0xffff).toString(16).padStart(4, '0');
  const h3 = '7' + (Math.random() * 0x1000 | 0).toString(16).padStart(3, '0');
  const h4 = (0x8 | (Math.random() * 4 | 0)).toString(16)
           + (Math.random() * 0x1000 | 0).toString(16).padStart(3, '0');
  const h5 = (Math.random() * 0x1000000 | 0).toString(16).padStart(6, '0')
           + (Math.random() * 0x1000000 | 0).toString(16).padStart(6, '0');
  return `${h1}-${h2}-${h3}-${h4}-${h5}`;
}

async function main() {
  const { waveRecordId } = input.config();
  if (!waveRecordId) throw new Error('Missing input: waveRecordId');

  const wavesTable = base.getTable(TABLE_WAVES);
  const recipesTable = base.getTable(TABLE_RECIPES);
  const recipeSlotsTable = base.getTable(TABLE_RECIPE_SLOTS);
  const constructorSlotsTable = base.getTable(TABLE_CONSTRUCTOR_SLOTS);
  const assetsTable = base.getTable(TABLE_ASSETS);
  const disclaimersTable = base.getTable(TABLE_DISCLAIMERS);
  const tasksTable = base.getTable(TABLE_TASKS);

  // ===== Wave fields =====
  const fWaveStatus = getFirstExistingField(wavesTable, ['Status', 'status']);
  if (!fWaveStatus) throw new Error('Waves.Status not found');

  const fWaveDisclaimer = getFirstExistingField(wavesTable, ['disclaimer', 'Disclaimer']);
  if (!fWaveDisclaimer) throw new Error('Waves.disclaimer link field not found');

  const fWaveSticker = getFirstExistingField(wavesTable, ['sticker', 'Sticker']);
  const fWaveTasks = getFirstExistingField(wavesTable, ['Tasks']);

  const wave = await wavesTable.selectRecordAsync(waveRecordId, {
    fields: [fWaveStatus.id, fWaveDisclaimer.id, fWaveSticker?.id, fWaveTasks?.id].filter(Boolean),
  });
  if (!wave) throw new Error('Wave not found');

  const statusName = wave.getCellValueAsString(fWaveStatus);
  if (statusName !== STATUS_PRINT) return;

  // ===== Overlays: disclaimer s3 paths (both ratios, both styles) =====
  const fDisclaimerS39x16 = getFirstExistingField(disclaimersTable, ['s3_link_9x16', 's3_link_9х16', 's3_link']);
  if (!fDisclaimerS39x16) throw new Error('Overlays.s3_link_9x16 field not found');

  const fDisclaimerS316x9 = getFirstExistingField(disclaimersTable, ['s3_link_16x9']);

  // v6: dark_variant field on Overlays
  const fDisclaimerDarkVariant = getFirstExistingField(disclaimersTable, ['dark_variant']);

  const disclaimerLinks = getLinks(wave.getCellValue(fWaveDisclaimer));

  // White (default) overlay paths
  let overlayPath9x16 = '';
  let overlayPath16x9 = '';
  // Dark overlay paths (for assets with disclaimer_style = black)
  let darkOverlayPath9x16 = '';
  let darkOverlayPath16x9 = '';

  if (disclaimerLinks.length > 0) {
    const disclaimerRecord = await disclaimersTable.selectRecordAsync(disclaimerLinks[0].id, {
      fields: [fDisclaimerS39x16.id, fDisclaimerS316x9?.id, fDisclaimerDarkVariant?.id].filter(Boolean),
    });

    if (disclaimerRecord) {
      overlayPath9x16 = disclaimerRecord.getCellValueAsString(fDisclaimerS39x16) || '';
      overlayPath16x9 = fDisclaimerS316x9
        ? (disclaimerRecord.getCellValueAsString(fDisclaimerS316x9) || '')
        : '';

      // v6: resolve dark variant
      if (fDisclaimerDarkVariant) {
        const darkLinks = getLinks(disclaimerRecord.getCellValue(fDisclaimerDarkVariant));
        if (darkLinks.length > 0) {
          const darkRecord = await disclaimersTable.selectRecordAsync(darkLinks[0].id, {
            fields: [fDisclaimerS39x16.id, fDisclaimerS316x9?.id].filter(Boolean),
          });
          if (darkRecord) {
            darkOverlayPath9x16 = darkRecord.getCellValueAsString(fDisclaimerS39x16) || '';
            darkOverlayPath16x9 = fDisclaimerS316x9
              ? (darkRecord.getCellValueAsString(fDisclaimerS316x9) || '')
              : darkOverlayPath9x16;
          }
        }
      }
    }
  }

  // Fallback: if 16x9 path missing, use 9x16
  if (!overlayPath16x9) overlayPath16x9 = overlayPath9x16;
  // Fallback chain for dark overlay:
  //   dark 9x16 missing → use white 9x16 (no dark variant configured at all)
  //   dark 16x9 missing → use dark 9x16 (not white 16x9: preserve dark style)
  if (!darkOverlayPath9x16) darkOverlayPath9x16 = overlayPath9x16;
  if (!darkOverlayPath16x9) darkOverlayPath16x9 = darkOverlayPath9x16;

  // ===== Sticker paths =====
  let stickerPath9x16 = '';
  let stickerPath16x9 = '';
  if (fWaveSticker) {
    const stickerLinks = getLinks(wave.getCellValue(fWaveSticker));
    if (stickerLinks.length > 0) {
      const stickerRecord = await disclaimersTable.selectRecordAsync(stickerLinks[0].id, {
        fields: [fDisclaimerS39x16.id, fDisclaimerS316x9?.id].filter(Boolean),
      });
      if (stickerRecord) {
        stickerPath9x16 = stickerRecord.getCellValueAsString(fDisclaimerS39x16) || '';
        stickerPath16x9 = fDisclaimerS316x9
          ? (stickerRecord.getCellValueAsString(fDisclaimerS316x9) || '')
          : '';
      }
    }
  }
  if (!stickerPath16x9) stickerPath16x9 = stickerPath9x16;

  // ===== Link fields =====
  const rfRecipesToWaves = findLinkFieldTo(recipesTable, wavesTable);
  if (!rfRecipesToWaves) throw new Error('Recipes -> Waves link field not found');

  const rfRS_Recipe = findLinkFieldTo(recipeSlotsTable, recipesTable);
  const rfRS_ConstructorSlot = findLinkFieldTo(recipeSlotsTable, constructorSlotsTable);
  const rfRS_Asset = findLinkFieldTo(recipeSlotsTable, assetsTable);
  if (!rfRS_Recipe || !rfRS_ConstructorSlot || !rfRS_Asset) {
    throw new Error('Recipe Slots: missing link fields');
  }

  const fRecipeMusic = getFirstExistingField(recipesTable, ['music', 'Music']);
  if (!fRecipeMusic) throw new Error('Recipes.music field not found');

  const fRecipeAutoId = getFirstExistingField(recipesTable, ['auto_id']);
  if (!fRecipeAutoId) throw new Error('Recipes.auto_id field not found');

  const fRecipeCreative = getFirstExistingField(recipesTable, ['Creative']);
  const fRecipeVolume = getFirstExistingField(recipesTable, ['volume', 'music_volume']);
  const fRecipeRatio = getFirstExistingField(recipesTable, ['ratio', 'aspect_ratio']);

  const fCS_SlotNumber = getFirstExistingField(constructorSlotsTable, ['slot_number', 'slot number', 'slot']);
  if (!fCS_SlotNumber) throw new Error('Constructor Slots.slot_number not found');

  const fAssetName = getFirstExistingField(assetsTable, ['Asset name', 'asset_name', 'Name', 'name']);
  if (!fAssetName) throw new Error('Assets.Asset name not found');

  const fAssetRoles = getFirstExistingField(assetsTable, ['Roles_allowed', 'roles_allowed']);
  if (!fAssetRoles) throw new Error('Assets.Roles_allowed not found');

  // v6: disclaimer_style field on Assets
  const fAssetDisclaimerStyle = getFirstExistingField(assetsTable, ['disclaimer_style']);

  // ===== Load recipes for wave =====
  const recipesQuery = await recipesTable.selectRecordsAsync({
    fields: [rfRecipesToWaves.id, fRecipeMusic.id, fRecipeAutoId.id,
             fRecipeCreative?.id, fRecipeVolume?.id, fRecipeRatio?.id].filter(Boolean),
  });

  const waveRecipes = recipesQuery.records.filter(r => {
    const wLinks = getLinks(r.getCellValue(rfRecipesToWaves));
    return wLinks.some(x => x.id === waveRecordId);
  });

  if (waveRecipes.length === 0) {
    await wavesTable.updateRecordAsync(waveRecordId, {
      [fWaveStatus.id]: normaliseSingleSelect(fWaveStatus, STATUS_PRINTED),
    });
    return;
  }

  const recipesSorted = waveRecipes.slice().sort((a, b) => {
    const idA = Number(a.getCellValue(fRecipeAutoId)) || 0;
    const idB = Number(b.getCellValue(fRecipeAutoId)) || 0;
    return idA - idB;
  });

  const recipeIdSet = new Set(recipesSorted.map(r => r.id));

  // ===== Constructor slots -> slot_number =====
  const csQuery = await constructorSlotsTable.selectRecordsAsync({ fields: [fCS_SlotNumber.id] });
  const slotNumberByConstructorSlotId = new Map();
  for (const cs of csQuery.records) {
    const sn = Number(cs.getCellValue(fCS_SlotNumber)) || 0;
    if (sn > 0) slotNumberByConstructorSlotId.set(cs.id, sn);
  }

  const maxSlots = slotNumberByConstructorSlotId.size > 0
    ? Math.max(...slotNumberByConstructorSlotId.values())
    : 0;
  if (!maxSlots) throw new Error('Constructor Slots: no valid slot_number values found');

  // ===== Assets: names, roles, disclaimer_style =====
  const assetsQueryFields = [fAssetName.id, fAssetRoles.id];
  if (fAssetDisclaimerStyle) assetsQueryFields.push(fAssetDisclaimerStyle.id);

  const assetsQuery = await assetsTable.selectRecordsAsync({ fields: assetsQueryFields });

  const assetNameById = new Map();
  const assetIsEndcardById = new Map();
  // v6: disclaimer_style per asset (default: 'white')
  const assetDisclaimerStyle = new Map();

  for (const a of assetsQuery.records) {
    const fn = a.getCellValueAsString(fAssetName) || a.name;
    assetNameById.set(a.id, fn);
    assetIsEndcardById.set(a.id, isEndcard(a.getCellValue(fAssetRoles)));
    if (fAssetDisclaimerStyle) {
      assetDisclaimerStyle.set(
        a.id,
        getSingleSelectName(a.getCellValue(fAssetDisclaimerStyle)) || 'white'
      );
    }
  }

  // ===== Recipe slots: recipe -> slotNumber -> {assetFile, endcard, assetId} =====
  // v6: assetId added to enable per-recipe disclaimer_style lookup
  const rsQuery = await recipeSlotsTable.selectRecordsAsync({
    fields: [rfRS_Recipe.id, rfRS_ConstructorSlot.id, rfRS_Asset.id],
  });

  const recipeToPosToSlotInfo = new Map();
  for (const r of recipesSorted) recipeToPosToSlotInfo.set(r.id, new Map());

  for (const rs of rsQuery.records) {
    const rLinks = getLinks(rs.getCellValue(rfRS_Recipe));
    const sLinks = getLinks(rs.getCellValue(rfRS_ConstructorSlot));
    const aLinks = getLinks(rs.getCellValue(rfRS_Asset));
    if (!rLinks[0] || !sLinks[0] || !aLinks[0]) continue;

    const rid = rLinks[0].id;
    if (!recipeIdSet.has(rid)) continue;

    const csId = sLinks[0].id;
    const pos = slotNumberByConstructorSlotId.get(csId);
    if (!pos || pos < 1) continue;

    const aid = aLinks[0].id;
    const assetFile = assetNameById.get(aid) || '';
    const endcard = assetIsEndcardById.get(aid) || false;

    recipeToPosToSlotInfo.get(rid).set(pos, { assetFile, endcard, assetId: aid }); // v6: assetId
  }

  // ===== Manifest data =====
  let firstPackName = '';
  let taskFunnelName = '';
  let taskLang = '';
  let taskFlow = '';

  if (fWaveTasks) {
    const taskLinks = getLinks(wave.getCellValue(fWaveTasks));
    if (taskLinks[0]) {
      const task = await tasksTable.selectRecordAsync(taskLinks[0].id);
      if (task) {
        const fT_lang = safeGetField(tasksTable, 'lang');
        const fT_flow = safeGetField(tasksTable, 'flow');
        const fT_funnel = safeGetField(tasksTable, 'funnel');
        const fT_Packs = safeGetField(tasksTable, 'Packs');

        if (fT_lang) taskLang = task.getCellValueAsString(fT_lang) || '';
        if (fT_flow) taskFlow = getSingleSelectName(task.getCellValue(fT_flow)) || '';
        if (fT_funnel) {
          const fLinks = getLinks(task.getCellValue(fT_funnel));
          taskFunnelName = fLinks[0]?.name || '';
        }

        if (fT_Packs) {
          const packLinks = getLinks(task.getCellValue(fT_Packs));
          let minNum = Infinity;
          for (const p of packLinks) {
            const m = String(p.name || '').match(/(\d+)$/);
            const n = m ? Number(m[1]) : 0;
            if (n > 0 && n < minNum) {
              minNum = n;
              firstPackName = p.name;
            }
          }
          if (!firstPackName && packLinks.length > 0) {
            firstPackName = packLinks[0].name || '';
          }
        }
      }
    }
  }

  const launchDateIso = todayIsoInTz(LAUNCH_DATE_TZ);
  console.log('Manifest:', JSON.stringify({ firstPackName, taskFunnelName, taskLang, taskFlow }));

  const firstCreoName = (() => {
    for (const r of recipesSorted) {
      const links = fRecipeCreative ? getLinks(r.getCellValue(fRecipeCreative)) : [];
      if (links[0]?.name) return links[0].name;
    }
    return '';
  })();
  const firstApproachName = firstCreoName ? (firstCreoName.split(CREO_NAME_SEPARATOR)[0] || '') : '';

  const [ly, lm, ld] = launchDateIso.split('-');
  const launchDateFormatted = `${ld}-${lm}-${ly.slice(2)}`;

  const folderName = firstPackName && firstApproachName
    ? `${firstPackName}_${firstApproachName}_${launchDateFormatted}`
    : (wave.name || waveRecordId);
  const resolvedFolderName = `martech/video_builder/creatives/${folderName}`;

  // ===== Build pipeline tasks =====
  const pipelineTasks = recipesSorted.map((r) => {
    const posToInfo = recipeToPosToSlotInfo.get(r.id) || new Map();
    const musicFilename = r.getCellValueAsString(fRecipeMusic) || '';

    const volRaw = fRecipeVolume ? r.getCellValue(fRecipeVolume) : null;
    const audioVolume = (Array.isArray(volRaw) && typeof volRaw[0] === 'number' && !isNaN(volRaw[0]))
      ? volRaw[0]
      : DEFAULT_VOLUME;
    const audios = musicFilename
      ? [{ audio_path: toS3Path(buildAudioPath(musicFilename)), volume: audioVolume }]
      : [];

    const recipeRatio = fRecipeRatio
      ? (getSingleSelectName(r.getCellValue(fRecipeRatio)) || '9x16')
      : '9x16';

    // v6: determine overlay based on body asset's disclaimer_style.
    // Body = slot 2 (iteration constructor convention).
    // If slot 2 absent or field not configured → defaults to 'white'.
    const bodySlotInfo = posToInfo.get(2);
    const bodyDisclaimerStyle = bodySlotInfo?.assetId
      ? (assetDisclaimerStyle.get(bodySlotInfo.assetId) || 'white')
      : 'white';

    // Select white or dark overlay path based on style and ratio
    let recipeOverlayPath;
    if (bodyDisclaimerStyle === 'black') {
      recipeOverlayPath = (recipeRatio === '16x9') ? darkOverlayPath16x9 : darkOverlayPath9x16;
    } else {
      recipeOverlayPath = (recipeRatio === '16x9') ? overlayPath16x9 : overlayPath9x16;
    }

    const recipeStickerPath = (recipeRatio === '16x9') ? stickerPath16x9 : stickerPath9x16;

    const videos = [];
    for (let pos = 1; pos <= maxSlots; pos++) {
      const info = posToInfo.get(pos);
      if (!info || !info.assetFile) continue;

      videos.push({
        video_path: toS3Path(buildVideoPath(info.assetFile, recipeRatio)),
        overlay_path: (!info.endcard && recipeOverlayPath) ? toS3Path(recipeOverlayPath) : '',
        brightness: 0,
        volume: 1,
      });
    }

    const creLinks = fRecipeCreative ? getLinks(r.getCellValue(fRecipeCreative)) : [];
    const creoName = creLinks[0]?.name || '';

    const overlayAll = recipeStickerPath ? toS3Path(recipeStickerPath) : '';

    return { videos, audios, result_name: `${creoName}.mp4`, overlay_all: overlayAll };
  });

  // ===== Auth0: access token =====
  const tokenResp = await fetch(AUTH0_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: input.secret('AUTH0_CLIENT_ID'),
      client_secret: input.secret('AUTH0_CLIENT_SECRET'),
      audience: AUTH0_AUDIENCE,
      grant_type: 'client_credentials',
    }),
  });

  if (!tokenResp.ok) {
    const err = await tokenResp.json();
    throw new Error(`Auth0 token error (${tokenResp.status}): ${err.error} — ${err.error_description}`);
  }

  const { access_token } = await tokenResp.json();

  // ===== POST to pipeline API =====
  const requestBody = {
    initial_task_type: 'initiate_video_builder',
    pipeline_id: generateUUID(),
    payload: {
      mode: 'predefined',
      settings: {
        folder_name: resolvedFolderName,
        codec: DEFAULT_CODEC,
      },
      predefined_data: {
        tasks: pipelineTasks,
      },
    },
  };

  console.log('Pipeline request body:', JSON.stringify(requestBody, null, 2));

  const apiUrl = `${API_BASE_URL}/api/public/v1/pipelines/`;
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${access_token}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Pipeline API error ${response.status}: ${errorText}`);
  }

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