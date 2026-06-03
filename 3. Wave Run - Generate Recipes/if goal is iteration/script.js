/*******************************************************
 * Wave Recipes Generator — ITERATION MODE
 * Deterministic enumeration of valid combinations
 *
 * Use this script only for Waves.goal == "Iteration"
 *
 * v5 changelog (2026-05-27):
 *   [NEW] ALC (AppLovin Correct) platform support.
 *         When Task.platform includes 'AppLovin', the script generates
 *         additional recipes per concept using ALC body versions.
 *         ALC body resolved via Assets.platform_correct_versions — the
 *         linked asset whose platforms_allowed includes 'AppLovin'.
 *         Falls back to original body if no ALC version exists.
 *
 *         flowForPlatformAndRatio(platform, ratio) replaces flowForRatio:
 *           AppLovin → ALC (any ratio)
 *           Google   → GGC (any ratio)
 *           Meta     → ITR (9x16) | RES (16x9)
 *
 *         conceptRecipes[i] now maps 'ratio:platform' →
 *           {recipeId, flow, ratio, alcBodyId}.
 *         createPacksAndCreatives receives this richer structure and:
 *           - uses ALC body canonical name in approach_name
 *           - links Creative.body to the ALC asset
 *           - skips picshot for ALC creatives
 *
 * v4 changelog (2026-05-21):
 *   [NEW] Resize-style tag in creo_name. For Iteration mode + 16x9,
 *         appends "-FullS" to the approach part.
 *         Format: {Hook}-{Body}-FullS_{Funnel}_RES_Video_{Pack}_16x9_{lang}_{N}
 *         Only for non-ALC recipes. ALC is always 9x16 in practice.
 *
 * v3 changelog (2026-05-15):
 *   [NEW] Multi-aspect-ratio support. Task.aspect_ratio is now a
 *         multipleSelects field.
 *
 * v2 changelog (2026-05-15):
 *   [NEW] Create Packs + Creatives after Recipe Slots.
 *******************************************************/

// ================== CONFIG ==================
const TABLE_WAVES = "Waves";
const TABLE_ASSETS = "Assets";
const TABLE_CONSTRUCTORS = "Constructors";
const TABLE_CONSTRUCTOR_SLOTS = "Constructor Slots";
const TABLE_RECIPES = "Recipes";
const TABLE_RECIPE_SLOTS = "Recipe Slots";
const TABLE_MUSIC = "Music";
const TABLE_TASKS = "Tasks";
const TABLE_PACKS = "Packs";
const TABLE_CREATIVES = "Creatives";
const TABLE_TEAM = "Team";

const STATUS_LOCK = "Autofilled";
const STATUS_SUCCESS = "Print-CSV";
const STATUS_ERROR = "Error";

const ITERATION_SLOT_GRANULARITY = {
  1: "brick",
  2: "full_body",
  3: "brick",
};

const SUPPORTED_SLOT_COUNTS = [2, 3];

// ================== HELPERS ==================
function safeGetField(table, name) {
  try {
    return table.getField(name);
  } catch {
    return null;
  }
}

function getFirstExistingField(table, names) {
  for (const n of names) {
    const f = safeGetField(table, n);
    if (f) return f;
  }
  return null;
}

function getSingleSelectName(cell) {
  if (!cell) return null;
  if (typeof cell === "string") return cell;
  if (cell && typeof cell === "object" && "name" in cell) return cell.name;
  return null;
}

function getMultiNames(cell) {
  if (!cell) return [];
  if (Array.isArray(cell)) {
    return cell.map((x) => (x && x.name ? x.name : String(x))).filter(Boolean);
  }
  if (typeof cell === "string") return [cell];
  if (cell && typeof cell === "object" && "name" in cell) return [cell.name];
  return [];
}

function getMultiLinks(cell) {
  if (!cell) return [];
  return Array.isArray(cell) ? cell : [];
}

function findLinkFieldTo(table, linkedTable) {
  const linkedId = linkedTable.id;
  return (
    table.fields.find(
      (ff) =>
        ff.type === "multipleRecordLinks" &&
        ff.options &&
        ff.options.linkedTableId === linkedId,
    ) || null
  );
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function pad3(n) {
  return String(n).padStart(3, "0");
}

// ---------- ratio helpers ----------
function parseTaskRatios(rawCellValue) {
  const raw = getMultiNames(rawCellValue);
  let wanted = raw.filter((r) => r === "9x16" || r === "16x9");
  if (wanted.length === 0) wanted = ["9x16"];
  const onlyResize = wanted.length === 1 && wanted[0] === "16x9";
  return { wanted, onlyResize };
}

function conceptSupportsRatio(slotsArr, ratio, assetInfo) {
  if (ratio === "9x16") return true;
  if (ratio === "16x9") {
    return slotsArr.every((assetId) => {
      const info = assetInfo.get(assetId);
      return !!(info && info.has16x9);
    });
  }
  return false;
}

// v5: platform-aware flow. Replaces flowForRatio(ratio).
// Rules:
//   AppLovin alone         → ITR
//   AppLovin + Meta/Google → ALC
//   16x9 (any platform)    → RES
//   Google + corrected body (alcBodyId set) → GGC
//   Google + original body (alcBodyId null) → ITR
//   Meta                   → ITR
function flowForPlatformAndRatio(
  platform,
  ratio,
  alcBodyId,
  hasMeta,
  hasGoogle,
) {
  const p = platform.toLowerCase();
  if (p === "applovin") return hasMeta || hasGoogle ? "ALC" : "ITR";
  if (ratio === "16x9") return "RES";
  if (p === "google") return alcBodyId ? "GGC" : "ITR";
  return "ITR";
}

// v5: find platform-corrected version of a body asset.
// Returns corrected assetId, or null if none found → caller uses original.
function findCorrectVersion(bodyAssetId, platform, assetInfo) {
  const info = assetInfo.get(bodyAssetId);
  if (
    !info ||
    !info.platformCorrectVersions ||
    info.platformCorrectVersions.length === 0
  )
    return null;
  for (const link of info.platformCorrectVersions) {
    const vInfo = assetInfo.get(link.id);
    const plat = platform.toLowerCase();
    if (vInfo && vInfo.platformsAllowed.some((p) => p.toLowerCase() === plat))
      return link.id;
  }
  return null;
}

// v5: resolve which body to use for a given platform.
// Priority: corrected version → original (if platforms_allowed includes platform) → skip.
// Returns { shouldCreate: bool, bodyId: string|null }
//   bodyId null  = use original body as-is in Recipe Slots
//   bodyId recXX = use this corrected asset
function resolveBodyForPlatform(originalBodyId, platform, assetInfo) {
  if (!originalBodyId) return { shouldCreate: false, bodyId: null };

  // 1. Corrected version for this platform takes priority
  const correctedId = findCorrectVersion(originalBodyId, platform, assetInfo);
  if (correctedId) return { shouldCreate: true, bodyId: correctedId };

  // 2. Original is natively approved for this platform
  const info = assetInfo.get(originalBodyId);
  const plat = platform.toLowerCase();
  if (info && info.platformsAllowed.some((p) => p.toLowerCase() === plat)) {
    return { shouldCreate: true, bodyId: null };
  }

  // 3. No valid body — skip this platform for this concept
  return { shouldCreate: false, bodyId: null };
}

function sanitiseForName(s) {
  if (s === null || s === undefined) return "";
  return String(s).trim().replace(/_+/g, "-");
}

function normaliseForField(field, value) {
  if (!field) return value;
  if (value === undefined) return null;

  switch (field.type) {
    case "singleSelect": {
      if (!value) return null;
      if (typeof value === "string") return { name: value };
      if (typeof value === "object" && value.name) return { name: value.name };
      return null;
    }
    case "multipleRecordLinks": {
      const links = Array.isArray(value) ? value : [];
      return links.map((x) => ({ id: x.id || x }));
    }
    case "number": {
      if (value === null || value === "" || value === undefined) return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    default: {
      if (value === null || value === undefined) return "";
      if (typeof value === "string") return value;
      return String(value);
    }
  }
}

function asMusicItems(cell) {
  if (!cell) return [];
  if (Array.isArray(cell)) return cell.filter(Boolean);
  if (typeof cell === "string") return [cell];
  if (cell && typeof cell === "object" && "name" in cell) return [cell.name];
  return [];
}

function intersects(arrA, arrB) {
  if (!arrA || !arrB || arrA.length === 0 || arrB.length === 0) return false;
  const setB = new Set(arrB);
  return arrA.some((x) => setB.has(x));
}

function getExpectedIterationGranularity(slotNumber) {
  return ITERATION_SLOT_GRANULARITY[slotNumber] || null;
}

async function reservePackNumbers(packsTable, creatorRecId, count) {
  const fPackNumber = packsTable.getField("pack_number");
  const fPackCreator = packsTable.getField("creator");

  const query = await packsTable.selectRecordsAsync({
    fields: [fPackNumber.id, fPackCreator.id],
  });

  let maxNumber = 0;
  for (const r of query.records) {
    const creator = r.getCellValue(fPackCreator);
    if (!creator || !Array.isArray(creator)) continue;
    if (!creator.some((c) => c.id === creatorRecId)) continue;
    const n = Number(r.getCellValue(fPackNumber)) || 0;
    if (n > maxNumber) maxNumber = n;
  }

  const reserved = [];
  for (let i = 1; i <= count; i++) reserved.push(maxNumber + i);
  return reserved;
}

// ================== CREATE PACKS + CREATIVES ==================
// v5: conceptRecipes[i] = Map<'ratio:platform', {recipeId, flow, ratio, alcBodyId}>
async function createPacksAndCreatives(params) {
  const {
    mode,
    wavesTable,
    waveRecord,
    constructorSlots,
    selected,
    conceptRecipes,
    assetInfo,
  } = params;

  if (!selected || selected.length === 0) return;

  const tasksTable = base.getTable(TABLE_TASKS);
  const packsTable = base.getTable(TABLE_PACKS);
  const creativesTable = base.getTable(TABLE_CREATIVES);
  const teamTable = base.getTable(TABLE_TEAM);

  // ===== 1. Resolve Task =====
  const fWaveTasks = wavesTable.getField("Tasks");
  const taskLinks = waveRecord.getCellValue(fWaveTasks) || [];
  if (!Array.isArray(taskLinks) || taskLinks.length === 0) {
    throw new Error("Wave has no linked Task");
  }
  const taskId = taskLinks[0].id;

  // ===== 2. Task fields =====
  const fT_assignee = tasksTable.getField("assignee");
  const fT_pack_strategy = tasksTable.getField("pack_strategy");
  const fT_max_per_pack = tasksTable.getField("max_per_pack");
  const fT_group_by_slot = tasksTable.getField("group_by_slot");
  const fT_approach_override = tasksTable.getField("approach_name_override");
  const fT_lang = tasksTable.getField("lang");
  const fT_funnel = tasksTable.getField("funnel");

  const task = await tasksTable.selectRecordAsync(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const assigneeLinks = task.getCellValue(fT_assignee) || [];
  if (!Array.isArray(assigneeLinks) || assigneeLinks.length === 0) {
    throw new Error("Task.assignee is empty");
  }
  const assigneeId = assigneeLinks[0].id;

  const packStrategy =
    getSingleSelectName(task.getCellValue(fT_pack_strategy)) || "flat";
  const maxPerPack = Number(task.getCellValue(fT_max_per_pack)) || 4;
  const groupBySlot =
    getSingleSelectName(task.getCellValue(fT_group_by_slot)) || "body";
  const approachOverride = task.getCellValue(fT_approach_override) || null;
  const lang = task.getCellValue(fT_lang) || "EN";

  const funnelLinks = task.getCellValue(fT_funnel) || [];
  if (!Array.isArray(funnelLinks) || funnelLinks.length === 0) {
    throw new Error("Task.funnel is empty");
  }
  const funnelName = funnelLinks[0].name;

  // ===== 3. Assignee initials =====
  const fTeam_initials = teamTable.getField("member_initials");
  const assignee = await teamTable.selectRecordAsync(assigneeId);
  const initials = assignee ? assignee.getCellValue(fTeam_initials) : null;
  if (!initials)
    throw new Error(`Team member ${assigneeId} has no member_initials`);

  // ===== 4. Slot roles =====
  const slotRoles = constructorSlots.map((s) => {
    if (s.allowedRoles && s.allowedRoles.length > 0) return s.allowedRoles[0];
    return null;
  });

  function findAssetIdByRole(slotsArr, roleLabel) {
    for (let i = 0; i < slotsArr.length; i++) {
      if (slotRoles[i] === roleLabel) return slotsArr[i];
    }
    return null;
  }

  function getCanonical(assetId) {
    const info = assetInfo.get(assetId);
    return (info && info.canonical) || "";
  }

  // ===== 5. Distribute selected[] into packs =====
  function distribute() {
    const indices = selected.map((_, i) => i);

    if (packStrategy === "single") {
      return [indices];
    }

    if (packStrategy === "grouped") {
      const targetRole = groupBySlot === "hook" ? "Hook" : "Body";
      const groups = new Map();
      for (const idx of indices) {
        const groupAssetId = findAssetIdByRole(selected[idx].slots, targetRole);
        const key = groupAssetId || "__ungrouped__";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(idx);
      }
      const packs = [];
      for (const groupIndices of groups.values()) {
        for (const ch of chunk(groupIndices, maxPerPack)) {
          packs.push(ch);
        }
      }
      return packs;
    }

    return chunk(indices, maxPerPack);
  }

  const packsDistribution = distribute();
  const numPacks = packsDistribution.length;

  // ===== 6. Reserve pack_numbers =====
  const packNumbers = await reservePackNumbers(
    packsTable,
    assigneeId,
    numPacks,
  );

  // ===== 7. Create Packs =====
  const fP_name = packsTable.getField("name");
  const fP_pack_number = packsTable.getField("pack_number");
  const fP_creator = packsTable.getField("creator");
  const fP_task_link = packsTable.getField("task_link");

  const packsPayload = packsDistribution.map((_, i) => ({
    fields: {
      [fP_name.id]: `${initials}${pad3(packNumbers[i])}`,
      [fP_pack_number.id]: packNumbers[i],
      [fP_creator.id]: [{ id: assigneeId }],
      [fP_task_link.id]: [{ id: taskId }],
    },
  }));

  let createdPackIds = [];
  for (const batch of chunk(packsPayload, 50)) {
    const ids = await packsTable.createRecordsAsync(batch);
    createdPackIds = createdPackIds.concat(ids);
  }

  // ===== 8. Build creo_name + create Creatives =====
  const fC_creo_name = creativesTable.getField("creo_name");
  const fC_Wave = creativesTable.getField("Wave");
  const fC_Pack_link = creativesTable.getField("Pack_link");
  const fC_recipes = creativesTable.getField("recipes");
  const fC_Tasks = creativesTable.getField("Tasks");
  const fC_hook = creativesTable.getField("hook");
  const fC_body = creativesTable.getField("body");
  let fC_picshot = null;
  try {
    fC_picshot = creativesTable.getField("picshot");
  } catch {}
  const fC_Flow = safeGetField(creativesTable, "Flow");
  const fC_policy_of = safeGetField(creativesTable, "policy_of");

  const creativesPayload = [];
  const creativesPayloadMeta = []; // tracks {conceptIdx, ratio, platform} for policy_of linking

  for (let packIdx = 0; packIdx < packsDistribution.length; packIdx++) {
    const recipeIndices = packsDistribution[packIdx];
    const packId = createdPackIds[packIdx];
    const packName = `${initials}${pad3(packNumbers[packIdx])}`;

    let indexInPack = 1;
    for (const conceptIdx of recipeIndices) {
      const slotsArr = selected[conceptIdx].slots;
      // v5: conceptRecipes[i] = Map<'ratio:platform', {recipeId, flow, ratio, alcBodyId}>
      const recipesMap = conceptRecipes[conceptIdx];

      const hookAssetId = findAssetIdByRole(slotsArr, "Hook");
      const bodyAssetId = findAssetIdByRole(slotsArr, "Body"); // original body
      const endcardAssetId = findAssetIdByRole(slotsArr, "Endcard");

      for (const [, entry] of recipesMap.entries()) {
        const {
          recipeId,
          flow,
          ratio,
          alcBodyId,
          platform: entryPlatform,
        } = entry;

        // v5: effective body — ALC version if set, else original
        const effectiveBodyId = alcBodyId || bodyAssetId;
        const isAlc = flow === "ALC";

        // approach_name: override > hook-body (using effective body)
        let approach;
        if (approachOverride) {
          approach = approachOverride;
        } else if (mode === "iteration") {
          const hookName = (hookAssetId && getCanonical(hookAssetId)) || "Hook";
          const bodyName =
            (effectiveBodyId && getCanonical(effectiveBodyId)) || "Body";
          approach = `${hookName}-${bodyName}`;
        } else {
          approach = "Homunculus";
        }

        const safeApproach = sanitiseForName(approach);
        const safeFunnel = sanitiseForName(funnelName);
        const safeLang = sanitiseForName(lang);

        // v5: resize tag only for non-ALC 16x9 (ALC is never resized in current setup)
        const resizeTag =
          mode === "iteration" && ratio === "16x9" && !isAlc ? "-FullS" : "";

        const creoName = `${safeApproach}${resizeTag}_${safeFunnel}_${flow}_Video_${packName}_${ratio}_${safeLang}_${indexInPack}`;

        const fields = {
          [fC_creo_name.id]: creoName,
          [fC_Wave.id]: [{ id: waveRecord.id }],
          [fC_Pack_link.id]: [{ id: packId }],
          [fC_recipes.id]: [{ id: recipeId }],
          [fC_Tasks.id]: [{ id: taskId }],
        };

        if (hookAssetId) fields[fC_hook.id] = [{ id: hookAssetId }];
        if (effectiveBodyId) fields[fC_body.id] = [{ id: effectiveBodyId }];
        // Flow singleSelect
        if (fC_Flow) fields[fC_Flow.id] = normaliseForField(fC_Flow, flow);
        // AppLovin does not use picshot regardless of flow tag
        if (
          entryPlatform.toLowerCase() !== "applovin" &&
          endcardAssetId &&
          fC_picshot
        ) {
          fields[fC_picshot.id] = [{ id: endcardAssetId }];
        }

        creativesPayload.push({ fields });
        creativesPayloadMeta.push({
          conceptIdx,
          ratio,
          platform: entry.platform,
        });
      }
      indexInPack++;
    }
  }

  // Pass 1: create all creatives, collect IDs in order
  let allCreatedCreativeIds = [];
  for (const batch of chunk(creativesPayload, 50)) {
    const ids = await creativesTable.createRecordsAsync(batch);
    allCreatedCreativeIds = allCreatedCreativeIds.concat(ids);
  }

  // Pass 2: link ALC/GGC creatives to their Meta sibling via policy_of
  if (
    fC_policy_of &&
    allCreatedCreativeIds.length === creativesPayloadMeta.length
  ) {
    // Build concept+ratio → Meta creative ID map
    const metaIdMap = new Map(); // key: `${conceptIdx}:${ratio}`
    for (let i = 0; i < allCreatedCreativeIds.length; i++) {
      const { conceptIdx, ratio, platform } = creativesPayloadMeta[i];
      if (platform.toLowerCase() === "meta") {
        metaIdMap.set(`${conceptIdx}:${ratio}`, allCreatedCreativeIds[i]);
      }
    }
    // Build update list for ALC/GGC
    const policyUpdates = [];
    for (let i = 0; i < allCreatedCreativeIds.length; i++) {
      const { conceptIdx, ratio, platform } = creativesPayloadMeta[i];
      if (platform.toLowerCase() === "meta") continue;
      const metaId = metaIdMap.get(`${conceptIdx}:${ratio}`);
      if (metaId) {
        policyUpdates.push({
          id: allCreatedCreativeIds[i],
          fields: { [fC_policy_of.id]: [{ id: metaId }] },
        });
      }
    }
    for (const batch of chunk(policyUpdates, 50)) {
      await creativesTable.updateRecordsAsync(batch);
    }
    console.log(
      `Linked policy_of on ${policyUpdates.length} ALC/GGC creatives`,
    );
  }

  console.log(
    `Created ${createdPackIds.length} Packs and ${creativesPayload.length} Creatives`,
  );
}

// ================== MAIN ==================
async function main() {
  const { waveRecordId } = input.config();
  if (!waveRecordId) throw new Error("Missing input: waveRecordId");

  const wavesTable = base.getTable(TABLE_WAVES);
  const assetsTable = base.getTable(TABLE_ASSETS);
  const constructorsTable = base.getTable(TABLE_CONSTRUCTORS);
  const constructorSlotsTable = base.getTable(TABLE_CONSTRUCTOR_SLOTS);
  const recipesTable = base.getTable(TABLE_RECIPES);
  const recipeSlotsTable = base.getTable(TABLE_RECIPE_SLOTS);
  const musicTable = base.getTable(TABLE_MUSIC);
  const tasksTable = base.getTable(TABLE_TASKS);

  const wave = await wavesTable.selectRecordAsync(waveRecordId);
  if (!wave) throw new Error("Wave not found");

  const fWaveStatus = getFirstExistingField(wavesTable, ["Status", "status"]);
  const fWaveTarget = getFirstExistingField(wavesTable, [
    "target_creatives",
    "target creatives",
  ]);
  const fWaveConstructorLink = getFirstExistingField(wavesTable, [
    "Constructor",
    "constructor",
  ]);
  const fWaveAssetsForWave = getFirstExistingField(wavesTable, [
    "assets_for_wave",
    "assets for wave",
  ]);
  const fWaveMusic = getFirstExistingField(wavesTable, ["music", "Music"]);
  const fWaveOverlays = getFirstExistingField(wavesTable, [
    "overlays",
    "Overlays",
  ]);

  if (!fWaveStatus) throw new Error("Waves.Status not found");
  if (!fWaveTarget) throw new Error("Waves.target_creatives not found");
  if (!fWaveConstructorLink) throw new Error("Waves.Constructor not found");
  if (!fWaveAssetsForWave) throw new Error("Waves.assets_for_wave not found");

  await wavesTable.updateRecordAsync(waveRecordId, {
    [fWaveStatus.id]: normaliseForField(fWaveStatus, STATUS_LOCK),
  });

  const targetCreatives = Number(wave.getCellValue(fWaveTarget)) || 0;
  if (!targetCreatives || targetCreatives <= 0) {
    await wavesTable.updateRecordAsync(waveRecordId, {
      [fWaveStatus.id]: normaliseForField(fWaveStatus, STATUS_SUCCESS),
    });
    return;
  }

  const constructorLinked = wave.getCellValue(fWaveConstructorLink) || [];
  const constructorId =
    Array.isArray(constructorLinked) && constructorLinked[0]?.id
      ? constructorLinked[0].id
      : null;
  if (!constructorId) throw new Error("Wave.Constructor is empty");

  const assetsForWaveLinks = wave.getCellValue(fWaveAssetsForWave) || [];
  if (!Array.isArray(assetsForWaveLinks) || assetsForWaveLinks.length === 0) {
    throw new Error("Wave.assets_for_wave is empty");
  }

  const waveMusicItems = fWaveMusic
    ? asMusicItems(wave.getCellValue(fWaveMusic))
    : [];
  const waveOverlaysLinks = fWaveOverlays
    ? wave.getCellValue(fWaveOverlays) || []
    : [];

  // Link discovery
  const rfRecipesToWaves = findLinkFieldTo(recipesTable, wavesTable);
  const rfRecipesToConstructors = findLinkFieldTo(
    recipesTable,
    constructorsTable,
  );
  const rfRS_Recipe = findLinkFieldTo(recipeSlotsTable, recipesTable);
  const rfRS_ConstructorSlot = findLinkFieldTo(
    recipeSlotsTable,
    constructorSlotsTable,
  );
  const rfRS_Asset = findLinkFieldTo(recipeSlotsTable, assetsTable);

  if (
    !rfRecipesToWaves ||
    !rfRecipesToConstructors ||
    !rfRS_Recipe ||
    !rfRS_ConstructorSlot ||
    !rfRS_Asset
  ) {
    throw new Error("Missing required link fields");
  }

  const fRecipeMusic = getFirstExistingField(recipesTable, ["music", "Music"]);
  const fRecipeOverlays = getFirstExistingField(recipesTable, [
    "overlays",
    "Overlays",
  ]);

  // Constructor slots
  const fCS_Constructor = getFirstExistingField(constructorSlotsTable, [
    "Constructor",
    "constructor",
  ]);
  const fCS_SlotNumber = getFirstExistingField(constructorSlotsTable, [
    "slot_number",
    "slot number",
    "slot",
  ]);
  const fCS_AllowedRoles = getFirstExistingField(constructorSlotsTable, [
    "allowed_roles",
    "roles_allowed",
  ]);
  const fCS_AllowedFlows = getFirstExistingField(constructorSlotsTable, [
    "allowed_production_flows",
  ]);
  const fCS_AllowedSubformats = getFirstExistingField(constructorSlotsTable, [
    "allowed_subformats",
  ]);

  if (!fCS_Constructor || !fCS_SlotNumber) {
    throw new Error("Constructor Slots: missing required fields");
  }

  const csQuery = await constructorSlotsTable.selectRecordsAsync({
    fields: [
      fCS_Constructor.id,
      fCS_SlotNumber.id,
      fCS_AllowedRoles?.id,
      fCS_AllowedFlows?.id,
      fCS_AllowedSubformats?.id,
    ].filter(Boolean),
  });

  const constructorSlots = csQuery.records
    .filter((r) => {
      const linked = r.getCellValue(fCS_Constructor) || [];
      return (
        Array.isArray(linked) && linked.some((x) => x.id === constructorId)
      );
    })
    .map((r) => ({
      id: r.id,
      slotNumber: Number(r.getCellValue(fCS_SlotNumber)) || 0,
      allowedRoles: getMultiNames(
        fCS_AllowedRoles ? r.getCellValue(fCS_AllowedRoles) : null,
      ),
      allowedFlows: getMultiNames(
        fCS_AllowedFlows ? r.getCellValue(fCS_AllowedFlows) : null,
      ),
      allowedSubformats: getMultiNames(
        fCS_AllowedSubformats ? r.getCellValue(fCS_AllowedSubformats) : null,
      ),
    }))
    .sort((a, b) => a.slotNumber - b.slotNumber);

  if (constructorSlots.length === 0)
    throw new Error("No Constructor Slots found");

  if (!SUPPORTED_SLOT_COUNTS.includes(constructorSlots.length)) {
    throw new Error(
      `Iteration script supports ${SUPPORTED_SLOT_COUNTS.join(" or ")} slots, got ${constructorSlots.length}`,
    );
  }

  const numSlots = constructorSlots.length;
  const slotIndexById = new Map();
  for (let i = 0; i < numSlots; i++)
    slotIndexById.set(constructorSlots[i].id, i);

  // ===== Assets pool =====
  const fA_Roles = getFirstExistingField(assetsTable, [
    "roles_allowed",
    "allowed_roles",
  ]);
  const fA_Flow = getFirstExistingField(assetsTable, [
    "production_flow",
    "production flow",
  ]);
  const fA_Subformat = getFirstExistingField(assetsTable, [
    "subformat",
    "Subformat",
  ]);
  const fA_Granularity = getFirstExistingField(assetsTable, [
    "granularity",
    "Granularity",
  ]);
  const fA_DefaultMusic = getFirstExistingField(assetsTable, [
    "default music",
    "default_music",
  ]);
  const fA_Canonical = getFirstExistingField(assetsTable, [
    "canonical_name",
    "Canonical name",
  ]);
  const fA_S3Sync16x9 = getFirstExistingField(assetsTable, [
    "s3_sync_status_16x9",
  ]);
  // v5: ALC support fields
  const fA_PlatformCorrect = getFirstExistingField(assetsTable, [
    "platform_correct_versions",
  ]);
  const fA_PlatformsAllowed = getFirstExistingField(assetsTable, [
    "platforms_allowed",
  ]);

  if (!fA_Granularity) throw new Error("Assets.granularity not found");

  const assetIdsSet = new Set(
    assetsForWaveLinks.map((x) => x.id).filter(Boolean),
  );

  const aQuery = await assetsTable.selectRecordsAsync({
    fields: [
      fA_Roles?.id,
      fA_Flow?.id,
      fA_Subformat?.id,
      fA_Granularity.id,
      fA_DefaultMusic?.id,
      fA_Canonical?.id,
      fA_S3Sync16x9?.id,
      fA_PlatformCorrect?.id,
      fA_PlatformsAllowed?.id,
    ].filter(Boolean),
  });

  // Load ALL assets into assetInfo (not just wave pool) so ALC bodies are resolvable
  // even if they're not directly in assets_for_wave.
  const assetInfo = new Map();
  for (const a of aQuery.records) {
    const sync16 = fA_S3Sync16x9
      ? getSingleSelectName(a.getCellValue(fA_S3Sync16x9))
      : null;
    assetInfo.set(a.id, {
      roles: getMultiNames(fA_Roles ? a.getCellValue(fA_Roles) : null),
      flow: getSingleSelectName(fA_Flow ? a.getCellValue(fA_Flow) : null),
      subformat: getSingleSelectName(
        fA_Subformat ? a.getCellValue(fA_Subformat) : null,
      ),
      granularity: getSingleSelectName(a.getCellValue(fA_Granularity)),
      defaultMusicLinks: fA_DefaultMusic
        ? getMultiLinks(a.getCellValue(fA_DefaultMusic)) || []
        : [],
      canonical: fA_Canonical
        ? a.getCellValue(fA_Canonical) || a.name || ""
        : a.name || "",
      has16x9: sync16 === "Uploaded",
      // v5:
      platformsAllowed: getMultiNames(
        fA_PlatformsAllowed ? a.getCellValue(fA_PlatformsAllowed) : null,
      ),
      platformCorrectVersions: fA_PlatformCorrect
        ? getMultiLinks(a.getCellValue(fA_PlatformCorrect)) || []
        : [],
    });
  }

  // Wave asset pool — only assets explicitly in assets_for_wave
  let waveAssets = aQuery.records.filter((a) => assetIdsSet.has(a.id));
  if (waveAssets.length === 0)
    throw new Error("No Assets found by assets_for_wave links");

  // ===== Read Task: ratios + platform =====
  const fT_aspect_ratio_main = tasksTable.getField("aspect_ratio");
  const fT_platform_main = tasksTable.getField("platform"); // fld2Cj35FGGXAodX6

  const waveTaskLinks = wave.getCellValue(wavesTable.getField("Tasks")) || [];
  if (!Array.isArray(waveTaskLinks) || waveTaskLinks.length === 0) {
    throw new Error("Wave has no linked Task");
  }
  const taskForRatios = await tasksTable.selectRecordAsync(waveTaskLinks[0].id);

  const { wanted: taskRatios, onlyResize } = parseTaskRatios(
    taskForRatios ? taskForRatios.getCellValue(fT_aspect_ratio_main) : null,
  );

  // v5: read Task.platform
  const taskPlatforms = taskForRatios
    ? getMultiNames(taskForRatios.getCellValue(fT_platform_main))
    : [];
  // Default to Meta if field empty (backward compat)
  const taskPlatformsLower = taskPlatforms.map((p) => p.toLowerCase());
  const hasMeta = taskPlatformsLower.includes("meta");
  const hasAppLovin = taskPlatformsLower.includes("applovin");
  const hasGoogle = taskPlatformsLower.includes("google");
  if (!hasMeta && !hasAppLovin && !hasGoogle) {
    throw new Error(
      "Task.platform is empty — at least one platform must be selected",
    );
  }
  console.log(
    `v5 platforms: [${taskPlatforms.join(",")}] hasMeta=${hasMeta} hasAppLovin=${hasAppLovin} hasGoogle=${hasGoogle}`,
  );

  if (onlyResize) {
    const before = waveAssets.length;
    waveAssets = waveAssets.filter((a) => assetInfo.get(a.id).has16x9);
    console.log(
      `16x9-only mode: filtered pool ${before} → ${waveAssets.length}`,
    );
    if (waveAssets.length === 0) {
      throw new Error(
        "16x9-only: no assets with s3_sync_status_16x9 = Uploaded",
      );
    }
  }
  console.log(
    `v3 ratios: wanted=[${taskRatios.join(",")}] onlyResize=${onlyResize}`,
  );

  // ===== Slot pools with iteration granularity filter =====
  const slotPools = new Map();
  for (const s of constructorSlots) {
    const candidates = [];
    const expectedGranularity = getExpectedIterationGranularity(s.slotNumber);

    if (!expectedGranularity) {
      throw new Error(`No iteration granularity for slot ${s.slotNumber}`);
    }

    for (const a of waveAssets) {
      const info = assetInfo.get(a.id);

      if (s.allowedRoles.length > 0 && !intersects(info.roles, s.allowedRoles))
        continue;
      if (
        s.allowedFlows.length > 0 &&
        (!info.flow || !s.allowedFlows.includes(info.flow))
      )
        continue;
      if (
        s.allowedSubformats.length > 0 &&
        (!info.subformat || !s.allowedSubformats.includes(info.subformat))
      )
        continue;
      if (info.granularity !== expectedGranularity) continue;

      candidates.push(a.id);
    }

    if (candidates.length === 0) {
      throw new Error(
        `Slot ${s.slotNumber} has empty pool (expected granularity: ${expectedGranularity})`,
      );
    }

    slotPools.set(s.id, candidates);
  }

  // ===== Existing recipes =====
  const fRecipeRatioMain = getFirstExistingField(recipesTable, [
    "ratio",
    "aspect_ratio",
  ]);

  const existingRecipesQuery = await recipesTable.selectRecordsAsync({
    fields: [
      rfRecipesToWaves.id,
      rfRecipesToConstructors.id,
      fRecipeMusic?.id,
      fRecipeRatioMain?.id,
    ].filter(Boolean),
  });

  const existingForWaveAndConstructor = existingRecipesQuery.records.filter(
    (r) => {
      const wLinks = r.getCellValue(rfRecipesToWaves) || [];
      const cLinks = r.getCellValue(rfRecipesToConstructors) || [];
      return (
        Array.isArray(wLinks) &&
        wLinks.some((x) => x.id === waveRecordId) &&
        Array.isArray(cLinks) &&
        cLinks.some((x) => x.id === constructorId)
      );
    },
  );

  const existingRecipeIds = existingForWaveAndConstructor.map((r) => r.id);

  // Count existing concepts.
  // Count 9x16 recipes per concept for top-up runs.
  // Google 9x16 ITR is merged with Meta when both present → doesn't add to count.
  // Google 9x16 only adds when Meta is absent (standalone Google ITR).
  const platformCount9x16 =
    (hasMeta ? 1 : 0) + (hasAppLovin ? 1 : 0) + (hasGoogle && !hasMeta ? 1 : 0);
  const existingRaw9x16 = existingForWaveAndConstructor.filter((r) => {
    if (!fRecipeRatioMain) return true;
    const ratio = getSingleSelectName(r.getCellValue(fRecipeRatioMain));
    return !ratio || ratio === "9x16";
  }).length;
  const existingConceptCount = Math.round(existingRaw9x16 / platformCount9x16);

  const needToCreate = Math.max(0, targetCreatives - existingConceptCount);

  if (needToCreate === 0) {
    await assignMusic({
      recipesTable,
      recipeSlotsTable,
      assetsTable,
      musicTable,
      rfRecipesToWaves,
      rfRecipesToConstructors,
      rfRS_Recipe,
      rfRS_ConstructorSlot,
      rfRS_Asset,
      fRecipeMusic,
      waveRecordId,
      constructorId,
      waveMusicItems,
      numSlots,
      slotIndexById,
      fA_DefaultMusic,
    });
    await wavesTable.updateRecordAsync(waveRecordId, {
      [fWaveStatus.id]: normaliseForField(fWaveStatus, STATUS_SUCCESS),
    });
    return;
  }

  // ===== Existing signatures =====
  const existingSignatures = new Set();

  if (existingRecipeIds.length > 0) {
    const rsQuery = await recipeSlotsTable.selectRecordsAsync({
      fields: [rfRS_Recipe.id, rfRS_ConstructorSlot.id, rfRS_Asset.id],
    });

    const mapRecipeToSlots = new Map();
    for (const rid of existingRecipeIds)
      mapRecipeToSlots.set(rid, Array(numSlots).fill(null));

    for (const rs of rsQuery.records) {
      const rLinks = rs.getCellValue(rfRS_Recipe) || [];
      const sLinks = rs.getCellValue(rfRS_ConstructorSlot) || [];
      const aLinks = rs.getCellValue(rfRS_Asset) || [];
      if (
        !Array.isArray(rLinks) ||
        !Array.isArray(sLinks) ||
        !Array.isArray(aLinks)
      )
        continue;
      if (rLinks.length === 0 || sLinks.length === 0 || aLinks.length === 0)
        continue;

      const rid = rLinks[0].id;
      if (!mapRecipeToSlots.has(rid)) continue;

      const csId = sLinks[0].id;
      const idx = slotIndexById.get(csId);
      if (idx === undefined) continue;

      mapRecipeToSlots.get(rid)[idx] = aLinks[0].id;
    }

    for (const slotsArr of mapRecipeToSlots.values()) {
      if (!slotsArr.every((x) => !!x)) continue;
      existingSignatures.add(slotsArr.join("|"));
    }
  }

  // ===== Deterministic enumeration =====
  const selected = [];
  const selectedSignatures = new Set();

  function enumerate(slotIdx, currentSlots, usedAssetIds) {
    if (selected.length >= needToCreate) return;

    if (slotIdx === numSlots) {
      const sig = currentSlots.join("|");
      if (existingSignatures.has(sig) || selectedSignatures.has(sig)) return;
      selected.push({ slots: [...currentSlots], signature: sig });
      selectedSignatures.add(sig);
      return;
    }

    const slot = constructorSlots[slotIdx];
    const pool = slotPools.get(slot.id) || [];

    for (const assetId of pool) {
      if (usedAssetIds.has(assetId)) continue;
      usedAssetIds.add(assetId);
      currentSlots.push(assetId);

      enumerate(slotIdx + 1, currentSlots, usedAssetIds);

      currentSlots.pop();
      usedAssetIds.delete(assetId);

      if (selected.length >= needToCreate) return;
    }
  }

  enumerate(0, [], new Set());

  if (selected.length < needToCreate) {
    throw new Error(
      `Not enough combinations: found ${selected.length}, need ${needToCreate}`,
    );
  }

  // ===== Available ratios per concept =====
  const conceptRatios = selected.map((c) => {
    return taskRatios.filter((r) =>
      conceptSupportsRatio(c.slots, r, assetInfo),
    );
  });

  const skippedConcepts = conceptRatios.filter((rs) => rs.length === 0).length;
  if (skippedConcepts > 0) {
    console.log(
      `Skipped ${skippedConcepts}/${selected.length} concepts: no usable ratio`,
    );
  }

  // ===== Create Recipes: one per (concept, ratio, platform-context) =====
  // Standard platforms = Meta/Google → one recipe per ratio
  // AppLovin → additional recipe per ratio (with ALC body substitution at Recipe Slot level)
  // Note: if taskPlatforms is empty (legacy), we generate one Meta recipe per ratio.
  const fRecipeRatio = getFirstExistingField(recipesTable, ["ratio"]);

  const createPayload = [];
  // v5: extended meta per recipe
  // {conceptIdx, ratio, platform, alcBodyId}
  const recipePayloadMeta = [];

  // Helper: find body slot index in constructorSlots
  const bodySlotIndex = constructorSlots.findIndex(
    (s) => s.allowedRoles.includes("Body") || s.slotNumber === 2,
  );

  for (let i = 0; i < selected.length; i++) {
    for (const ratio of conceptRatios[i]) {
      const baseFields = {};
      baseFields[rfRecipesToConstructors.id] = [{ id: constructorId }];
      baseFields[rfRecipesToWaves.id] = [{ id: waveRecordId }];
      if (fRecipeRatio) baseFields[fRecipeRatio.id] = { name: ratio };
      if (
        fRecipeOverlays &&
        Array.isArray(waveOverlaysLinks) &&
        waveOverlaysLinks.length > 0
      ) {
        baseFields[fRecipeOverlays.id] = waveOverlaysLinks.map((x) => ({
          id: x.id,
        }));
      }

      const originalBodyId =
        bodySlotIndex >= 0 ? selected[i].slots[bodySlotIndex] : null;

      // Meta recipe — only 9x16, Meta does not get resize creatives
      if (hasMeta && ratio === "9x16") {
        createPayload.push({ fields: { ...baseFields } });
        recipePayloadMeta.push({
          conceptIdx: i,
          ratio,
          platform: "Meta",
          alcBodyId: null,
        });
      }

      // v5: ALC (AppLovin) — 9x16 only.
      // Priority: corrected version → original (if platforms_allowed includes AppLovin) → skip.
      if (hasAppLovin && ratio === "9x16") {
        const { shouldCreate: alcShouldCreate, bodyId: alcBodyId } =
          resolveBodyForPlatform(originalBodyId, "AppLovin", assetInfo);
        if (alcShouldCreate) {
          createPayload.push({ fields: { ...baseFields } });
          recipePayloadMeta.push({
            conceptIdx: i,
            ratio,
            platform: "AppLovin",
            alcBodyId,
          });
        }
      }

      // Google — creates recipe if body is approved for Google (native or corrected).
      // alcBodyId (gccBodyId) is set only when a corrected version exists → GGC flow.
      // Original body with no corrected version + Meta present → skip (Meta ITR covers both).
      // Original body with no corrected version + no Meta → create ITR.
      if (hasGoogle) {
        const { shouldCreate: gccShouldCreate, bodyId: gccBodyId } =
          resolveBodyForPlatform(originalBodyId, "Google", assetInfo);
        if (gccShouldCreate) {
          const isRedundantItr = !gccBodyId && hasMeta && ratio === "9x16";
          if (!isRedundantItr) {
            const effectiveBodyId = gccBodyId || originalBodyId;
            const effectiveBodyInfo = assetInfo.get(effectiveBodyId);
            const gccSupports16x9 =
              ratio !== "16x9" ||
              !!(effectiveBodyInfo && effectiveBodyInfo.has16x9);
            if (gccSupports16x9) {
              createPayload.push({ fields: { ...baseFields } });
              recipePayloadMeta.push({
                conceptIdx: i,
                ratio,
                platform: "Google",
                alcBodyId: gccBodyId,
              });
            }
          }
        }
      }
    }
  }

  let createdRecipeIds = [];
  for (const batch of chunk(createPayload, 50)) {
    const ids = await recipesTable.createRecordsAsync(batch);
    createdRecipeIds = createdRecipeIds.concat(ids);
  }

  if (createdRecipeIds.length !== createPayload.length) {
    throw new Error(
      `Recipe ID mismatch: got ${createdRecipeIds.length}, expected ${createPayload.length}`,
    );
  }

  // ===== Build conceptRecipes: Map<'ratio:platform', {recipeId, flow, ratio, alcBodyId}> =====
  const conceptRecipes = selected.map(() => new Map());
  for (let k = 0; k < createdRecipeIds.length; k++) {
    const { conceptIdx, ratio, platform, alcBodyId } = recipePayloadMeta[k];
    const flow = flowForPlatformAndRatio(
      platform,
      ratio,
      alcBodyId,
      hasMeta,
      hasGoogle,
    );
    const key = `${ratio}:${platform}`;
    conceptRecipes[conceptIdx].set(key, {
      recipeId: createdRecipeIds[k],
      flow,
      ratio,
      alcBodyId,
      platform, // stored for policy_of linking in createPacksAndCreatives
    });
  }

  // ===== Create Recipe Slots =====
  // v5: for ALC recipes, substitute body slot with ALC body (if resolved)
  const rsPayload = [];
  for (let k = 0; k < createdRecipeIds.length; k++) {
    const recipeId = createdRecipeIds[k];
    const { conceptIdx, alcBodyId } = recipePayloadMeta[k];
    const cand = selected[conceptIdx];

    const { platform: recipePlatform } = recipePayloadMeta[k];
    const isAlcRecipe = recipePlatform.toLowerCase() === "applovin";

    for (let sIdx = 0; sIdx < numSlots; sIdx++) {
      const slot = constructorSlots[sIdx];

      // v5: skip endcard slot for AppLovin — picshot not used on AppLovin
      const isEndcardSlot =
        slot.allowedRoles.includes("Endcard") || slot.slotNumber === 3;
      if (isAlcRecipe && isEndcardSlot) continue;

      // v5: use ALC body for body slot of ALC recipes
      const isBodySlot =
        slot.allowedRoles.includes("Body") || slot.slotNumber === 2;
      const assetId = isBodySlot && alcBodyId ? alcBodyId : cand.slots[sIdx];

      rsPayload.push({
        fields: {
          [rfRS_Recipe.id]: [{ id: recipeId }],
          [rfRS_ConstructorSlot.id]: [{ id: slot.id }],
          [rfRS_Asset.id]: [{ id: assetId }],
        },
      });
    }
  }

  for (const batch of chunk(rsPayload, 50)) {
    await recipeSlotsTable.createRecordsAsync(batch);
  }

  const recipeCount = createdRecipeIds.length;
  const conceptCount = selected.length;
  console.log(
    `Created ${recipeCount} Recipes across ${conceptCount} concepts (${(recipeCount / Math.max(1, conceptCount)).toFixed(2)} per concept)`,
  );

  // Drop concepts with no recipes for pack distribution
  const packSelected = [];
  const packConceptRecipes = [];
  for (let i = 0; i < selected.length; i++) {
    if (conceptRecipes[i].size > 0) {
      packSelected.push(selected[i]);
      packConceptRecipes.push(conceptRecipes[i]);
    }
  }

  // ===== Create Packs + Creatives =====
  await createPacksAndCreatives({
    mode: "iteration",
    wavesTable,
    waveRecord: wave,
    constructorSlots,
    selected: packSelected,
    conceptRecipes: packConceptRecipes,
    assetInfo,
  });

  // ===== Assign music =====
  await assignMusic({
    recipesTable,
    recipeSlotsTable,
    assetsTable,
    musicTable,
    rfRecipesToWaves,
    rfRecipesToConstructors,
    rfRS_Recipe,
    rfRS_ConstructorSlot,
    rfRS_Asset,
    fRecipeMusic,
    waveRecordId,
    constructorId,
    waveMusicItems,
    numSlots,
    slotIndexById,
    fA_DefaultMusic,
  });

  await wavesTable.updateRecordAsync(waveRecordId, {
    [fWaveStatus.id]: normaliseForField(fWaveStatus, STATUS_SUCCESS),
  });
}

// ================== MUSIC ASSIGNMENT ==================
async function assignMusic(params) {
  const {
    recipesTable,
    recipeSlotsTable,
    assetsTable,
    musicTable,
    rfRecipesToWaves,
    rfRecipesToConstructors,
    rfRS_Recipe,
    rfRS_ConstructorSlot,
    rfRS_Asset,
    fRecipeMusic,
    waveRecordId,
    constructorId,
    waveMusicItems,
    numSlots,
    slotIndexById,
    fA_DefaultMusic,
  } = params;

  if (!fRecipeMusic) return;

  const allRQuery = await recipesTable.selectRecordsAsync({
    fields: [rfRecipesToWaves.id, rfRecipesToConstructors.id, fRecipeMusic.id],
  });

  const allRecipes = allRQuery.records.filter((r) => {
    const wLinks = r.getCellValue(rfRecipesToWaves) || [];
    const cLinks = r.getCellValue(rfRecipesToConstructors) || [];
    return (
      Array.isArray(wLinks) &&
      wLinks.some((x) => x.id === waveRecordId) &&
      Array.isArray(cLinks) &&
      cLinks.some((x) => x.id === constructorId)
    );
  });

  allRecipes.sort((a, b) => String(a.name).localeCompare(String(b.name)));

  const isEmptyMusic = (rec) => {
    const v = rec.getCellValue(fRecipeMusic);
    if (!v) return true;
    if (Array.isArray(v) && v.length === 0) return true;
    if (typeof v === "string" && v.trim() === "") return true;
    return false;
  };

  if (waveMusicItems && waveMusicItems.length > 0) {
    if (fRecipeMusic.type === "multipleRecordLinks") {
      const hasIds = waveMusicItems.some(
        (x) => x && typeof x === "object" && x.id,
      );
      if (!hasIds) return;
    }

    const upd = [];
    for (let i = 0; i < allRecipes.length; i++) {
      const r = allRecipes[i];
      if (!isEmptyMusic(r)) continue;

      const track = waveMusicItems[i % waveMusicItems.length];
      let valueToSet = null;
      if (fRecipeMusic.type === "multipleRecordLinks") {
        valueToSet = [track];
      } else if (fRecipeMusic.type === "singleSelect") {
        valueToSet = typeof track === "string" ? track : track?.name || "";
      } else {
        valueToSet =
          typeof track === "string" ? track : track?.name || track?.id || "";
      }
      upd.push({
        id: r.id,
        fields: {
          [fRecipeMusic.id]: normaliseForField(fRecipeMusic, valueToSet),
        },
      });
    }
    for (const batch of chunk(upd, 50))
      await recipesTable.updateRecordsAsync(batch);
    return;
  }

  if (!fA_DefaultMusic) return;

  const allRecipeIdSet = new Set(allRecipes.map((r) => r.id));

  const rsQueryAll = await recipeSlotsTable.selectRecordsAsync({
    fields: [rfRS_Recipe.id, rfRS_ConstructorSlot.id, rfRS_Asset.id],
  });

  const recipeToSlotsArr = new Map();
  for (const r of allRecipes)
    recipeToSlotsArr.set(r.id, Array(numSlots).fill(null));

  const allAssetIds = new Set();
  for (const rs of rsQueryAll.records) {
    const rLinks = rs.getCellValue(rfRS_Recipe) || [];
    const sLinks = rs.getCellValue(rfRS_ConstructorSlot) || [];
    const aLinks = rs.getCellValue(rfRS_Asset) || [];
    if (
      !Array.isArray(rLinks) ||
      !Array.isArray(sLinks) ||
      !Array.isArray(aLinks)
    )
      continue;
    if (rLinks.length === 0 || sLinks.length === 0 || aLinks.length === 0)
      continue;

    const rid = rLinks[0].id;
    if (!allRecipeIdSet.has(rid)) continue;

    const csId = sLinks[0].id;
    const idx = slotIndexById.get(csId);
    if (idx === undefined) continue;

    const aid = aLinks[0].id;
    allAssetIds.add(aid);
    recipeToSlotsArr.get(rid)[idx] = aid;
  }

  const assetDefaultMusic = new Map();
  const assetsQuery = await assetsTable.selectRecordsAsync({
    fields: [fA_DefaultMusic.id],
  });
  for (const a of assetsQuery.records) {
    if (!allAssetIds.has(a.id)) continue;
    const links = getMultiLinks(a.getCellValue(fA_DefaultMusic)) || [];
    assetDefaultMusic.set(a.id, links.length > 0 ? links[0] : null);
  }

  const upd2 = [];
  for (const r of allRecipes) {
    if (!isEmptyMusic(r)) continue;
    const slotsArr = recipeToSlotsArr.get(r.id) || [];
    let chosenTrackLink = null;
    for (let i = 0; i < numSlots; i++) {
      const aid = slotsArr[i];
      if (!aid) continue;
      const tlink = assetDefaultMusic.get(aid);
      if (tlink && tlink.id) {
        chosenTrackLink = tlink;
        break;
      }
    }
    if (!chosenTrackLink) continue;

    let valueToSet = null;
    if (fRecipeMusic.type === "multipleRecordLinks") {
      valueToSet = [chosenTrackLink];
    } else if (fRecipeMusic.type === "singleSelect") {
      valueToSet = chosenTrackLink.name || "";
    } else {
      valueToSet = chosenTrackLink.name || chosenTrackLink.id || "";
    }
    upd2.push({
      id: r.id,
      fields: {
        [fRecipeMusic.id]: normaliseForField(fRecipeMusic, valueToSet),
      },
    });
  }
  for (const batch of chunk(upd2, 50))
    await recipesTable.updateRecordsAsync(batch);
}

// ================== RUN ==================
try {
  await main();
} catch (err) {
  try {
    const { waveRecordId } = input.config();
    if (waveRecordId) {
      const wavesTable = base.getTable(TABLE_WAVES);
      const fWaveStatus = getFirstExistingField(wavesTable, [
        "Status",
        "status",
      ]);
      if (fWaveStatus) {
        await wavesTable.updateRecordAsync(waveRecordId, {
          [fWaveStatus.id]: normaliseForField(fWaveStatus, STATUS_ERROR),
        });
      }
    }
  } catch (_) {}
  throw err;
}
