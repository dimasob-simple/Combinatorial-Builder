/*******************************************************
 * Wave Recipes Generator (Automation-ready) — HOMUNCULUS MODE
 * Source of truth for assets: Waves.assets_for_wave
 * Mode: TOP-UP always (create until target_creatives reached)
 *
 * Trigger: Waves.Status == "Run" AND Waves.goal == "Homunculus"
 * Script will set:
 *   - Status -> "Autofilled" at start (locks wave out of trigger condition)
 *   - Status -> "Print-CSV" on success
 *   - Status -> "Error" on failure
 *
 * v5 changelog (2026-05-26):
 *   [NEW] Total duration constraint. Each generated concept's sum of
 *         Asset.duration_sec across all slots must be <= MAX_TOTAL_DURATION_SEC.
 *         Currently hardcoded to 60s; future: Task.max_total_duration_sec.
 *         Implementation:
 *           - Assets.duration_sec field is REQUIRED — script throws upfront
 *             if the field is missing from the base.
 *           - Assets with missing or non-positive duration_sec are
 *             hard-excluded from the wave pool (logged with count).
 *           - genPickForSlot filters available pool by remaining budget MINUS
 *             a reservation for future slots (suffix-sum of min durations) —
 *             prevents the picker from grabbing a long asset early and
 *             starving later slots.
 *           - tryGenerateOneRecipe tracks runningDuration, passes remaining,
 *             safety-checks final sum. Slot count and roles are NEVER trimmed
 *             to fit budget — concepts that don't fit are discarded entirely
 *             and the picker retries with different earlier picks.
 *           - Pre-flight feasibility check: sum(min duration per slot) must
 *             fit budget, else throw immediately with a clear message.
 *           - If the wave can't yield the requested number of unique recipes
 *             under the cap, NOTHING is created (no Recipes, no Packs, no
 *             Creatives). Wave is left in Error status with a detailed log
 *             showing produced/target counts and categorised failure reasons.
 *         Edge cases:
 *           - Missing/zero duration_sec -> asset dropped from pool.
 *           - All assets dropped -> throw upfront.
 *           - Slot pool empty after duration reservation -> attempt fails,
 *             retry with different combination.
 *           - Even minimum combination exceeds budget -> throw upfront.
 *   [FIX] Header comment status name aligned with STATUS_SUCCESS constant
 *         (Print-CSV, not Completed).
 *
 * v4 changelog (2026-05-15):
 *   [NEW] Multi-aspect-ratio support. Task.aspect_ratio is now a
 *         multipleSelects field — script generates one Recipe + one
 *         Creative per (concept × ratio) pair, all linked to the same
 *         Pack with the same concept_index.
 *         Rules:
 *           - Empty Task.aspect_ratio → default ['9x16'].
 *           - 1x1 currently skipped at generation (no S3 infra yet).
 *           - 9x16 generates whenever requested (always ITR flow).
 *           - 16x9 generates only when ALL concept assets have
 *             s3_sync_status_16x9 = "Uploaded" (always RES flow).
 *           - If Task asks 16x9-only (no 9x16), wave pool is pre-filtered
 *             to assets with 16x9 versions, so selection produces no holes.
 *         Recipe.ratio singleSelect is set per Recipe (drives Recipe.flow_tag
 *         formula and print_csv path resolution).
 *
 * v3 changelog (2026-05-15):
 *   [NEW]   Block "Create Packs + Creatives" after Recipe Slots.
 *           Reads packing parameters from Task (via Wave.Tasks),
 *           distributes selected[] into Packs by pack_strategy,
 *           reserves pack_numbers under Task.assignee,
 *           creates Packs with deterministic name ({initials}{NNN}),
 *           creates Creatives with deterministic creo_name and all links.
 *
 * v2 changelog (2026-04-24):
 *   [FIX]   Candidate-gen loop no longer spins forever on small pools.
 *   [OPT]   numCandidates bounded by theoretical upper-bound.
 *   [DIAG]  Console.log diagnostics on candidate generation.
 *
 * Slot matching logic (universal empty):
 * - allowed_roles empty => any roles OK; else asset.roles_allowed intersects
 * - allowed_production_flows empty => any flow OK; else asset.production_flow in allowed
 * - allowed_subformats empty => any subformat OK; else asset.subformat in allowed
 *
 * Music assignment (ONLY_EMPTY):
 * 1) If Waves.music has tracks -> round-robin assign to Recipes.music
 * 2) Else -> for each recipe, take first Assets.default music by slot order
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

// Waves.Status values
const STATUS_LOCK = "Autofilled";
const STATUS_SUCCESS = "Print-CSV";
const STATUS_ERROR = "Error";

// v5: total concept duration cap.
// TODO: replace hardcode with Task.max_total_duration_sec — read in main()
// after taskForRatios is loaded, fall back to this constant when empty.
const MAX_TOTAL_DURATION_SEC = 60;

// Tunables (keep conservative; tweak later)
const T = {
  POS_EXPOSURE_WEIGHT: 1.0,
  GLOBAL_EXPOSURE_WEIGHT: 0.9,
  ROLE_FIT_BONUS_SPECIALIST: 0.9,
  ROLE_FIT_BONUS_MULTI: 0.25,
  ADJ_PAIR_PENALTY: 1.4,
  COOCCUR_PENALTY: 0.25,
  MAX_SCAN_CANDIDATES: 4000,
};

// Candidate generation sizing
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

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
  if (Array.isArray(cell))
    return cell.map((x) => (x && x.name ? x.name : String(x))).filter(Boolean);
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
function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function incMap(m, k, by = 1) {
  m.set(k, (m.get(k) || 0) + by);
}
function canonicalPair(a, b) {
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}
function pad3(n) {
  return String(n).padStart(3, "0");
}

// ---------- ratio helpers (v4 multi-aspect-ratio) ----------
function flowForRatio(ratio) {
  return ratio === "9x16" ? "ITR" : "RES";
}

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

function positionWeights(numSlots) {
  const maxW = 6;
  const minW = 1;
  if (numSlots <= 1) return [maxW];
  const step = (maxW - minW) / (numSlots - 1);
  const w = [];
  for (let i = 0; i < numSlots; i++) w.push(maxW - step * i);
  return w;
}

function slotPrimaryRole(slotAllowedRoles) {
  if (!slotAllowedRoles || slotAllowedRoles.length !== 1) return null;
  return slotAllowedRoles[0];
}
function roleFitBonus(assetRoles, primaryRole) {
  if (!primaryRole) return 0;
  if (!assetRoles || assetRoles.length === 0) return 0;
  const has = assetRoles.includes(primaryRole);
  if (!has) return 0;
  if (assetRoles.length === 1) return T.ROLE_FIT_BONUS_SPECIALIST;
  return T.ROLE_FIT_BONUS_MULTI;
}

function intersects(arrA, arrB) {
  if (!arrA || !arrB || arrA.length === 0 || arrB.length === 0) return false;
  const setB = new Set(arrB);
  return arrA.some((x) => setB.has(x));
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

  const fWaveTasks = wavesTable.getField("Tasks");
  const taskLinks = waveRecord.getCellValue(fWaveTasks) || [];
  if (!Array.isArray(taskLinks) || taskLinks.length === 0) {
    throw new Error(
      "Wave has no linked Task — cannot resolve packing parameters",
    );
  }
  const taskId = taskLinks[0].id;

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
    throw new Error("Task.assignee is empty — required for Pack numbering");
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

  const fTeam_initials = teamTable.getField("member_initials");
  const assignee = await teamTable.selectRecordAsync(assigneeId);
  const initials = assignee ? assignee.getCellValue(fTeam_initials) : null;
  if (!initials)
    throw new Error(`Team member ${assigneeId} has no member_initials`);

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

  const packNumbers = await reservePackNumbers(
    packsTable,
    assigneeId,
    numPacks,
  );

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

  const creativesPayload = [];

  for (let packIdx = 0; packIdx < packsDistribution.length; packIdx++) {
    const recipeIndices = packsDistribution[packIdx];
    const packId = createdPackIds[packIdx];
    const packName = `${initials}${pad3(packNumbers[packIdx])}`;

    let indexInPack = 1;
    for (const conceptIdx of recipeIndices) {
      const slotsArr = selected[conceptIdx].slots;
      const recipesMap = conceptRecipes[conceptIdx];

      const hookAssetId = findAssetIdByRole(slotsArr, "Hook");
      const bodyAssetId = findAssetIdByRole(slotsArr, "Body");
      const endcardAssetId = findAssetIdByRole(slotsArr, "Endcard");

      let approach;
      if (approachOverride) {
        approach = approachOverride;
      } else if (mode === "iteration") {
        const hookName = (hookAssetId && getCanonical(hookAssetId)) || "Hook";
        const bodyName = (bodyAssetId && getCanonical(bodyAssetId)) || "Body";
        approach = `${hookName}-${bodyName}`;
      } else {
        approach = "Homunculus";
      }

      const safeApproach = sanitiseForName(approach);
      const safeFunnel = sanitiseForName(funnelName);
      const safeLang = sanitiseForName(lang);

      for (const [ratio, recipeId] of recipesMap.entries()) {
        const flow = flowForRatio(ratio);
        const creoName = `${safeApproach}_${safeFunnel}_${flow}_Video_${packName}_${ratio}_${safeLang}_${indexInPack}`;

        const fields = {
          [fC_creo_name.id]: creoName,
          [fC_Wave.id]: [{ id: waveRecord.id }],
          [fC_Pack_link.id]: [{ id: packId }],
          [fC_recipes.id]: [{ id: recipeId }],
          [fC_Tasks.id]: [{ id: taskId }],
        };
        if (hookAssetId) fields[fC_hook.id] = [{ id: hookAssetId }];
        if (bodyAssetId) fields[fC_body.id] = [{ id: bodyAssetId }];
        if (endcardAssetId && fC_picshot)
          fields[fC_picshot.id] = [{ id: endcardAssetId }];

        creativesPayload.push({ fields });
      }
      indexInPack++;
    }
  }

  for (const batch of chunk(creativesPayload, 50)) {
    await creativesTable.createRecordsAsync(batch);
  }

  console.log(
    `Created ${createdPackIds.length} Packs (numbers ${packNumbers.join(", ")}) and ${creativesPayload.length} Creatives`,
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
    "# target_creatives",
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
  const fWavePlatform = getFirstExistingField(wavesTable, [
    "platform",
    "Platform",
  ]);
  const fWaveFunnel = getFirstExistingField(wavesTable, ["Funnel", "funnel"]);

  if (!fWaveStatus) throw new Error("Waves.Status field not found");
  if (!fWaveTarget) throw new Error("Waves.target_creatives field not found");
  if (!fWaveConstructorLink)
    throw new Error("Waves.Constructor field not found");
  if (!fWaveAssetsForWave)
    throw new Error("Waves.assets_for_wave field not found");

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
  if (!Array.isArray(assetsForWaveLinks) || assetsForWaveLinks.length === 0)
    throw new Error("Wave.assets_for_wave is empty");

  const waveMusicItems = fWaveMusic
    ? asMusicItems(wave.getCellValue(fWaveMusic))
    : [];
  const waveOverlaysLinks = fWaveOverlays
    ? wave.getCellValue(fWaveOverlays) || []
    : [];
  const wavePlatform = fWavePlatform
    ? getSingleSelectName(wave.getCellValue(fWavePlatform))
    : null;
  const waveFunnelLinks = fWaveFunnel
    ? wave.getCellValue(fWaveFunnel) || []
    : [];

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
    throw new Error(
      "Missing required link fields between Recipes/Recipe Slots and Waves/Constructors/Constructor Slots/Assets",
    );
  }

  const fRecipeMusic = getFirstExistingField(recipesTable, ["music", "Music"]);
  const fRecipeOverlays = getFirstExistingField(recipesTable, [
    "overlays",
    "Overlays",
  ]);

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
    "allowed roles",
  ]);
  const fCS_AllowedFlows = getFirstExistingField(constructorSlotsTable, [
    "allowed_production_flows",
    "allowed production flows",
  ]);
  const fCS_AllowedSubformats = getFirstExistingField(constructorSlotsTable, [
    "allowed_subformats",
    "allowed subformats",
  ]);

  if (!fCS_Constructor || !fCS_SlotNumber)
    throw new Error(
      "Constructor Slots: missing Constructor or slot_number field",
    );

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
    .map((r) => {
      const slotNumber = Number(r.getCellValue(fCS_SlotNumber)) || 0;
      const allowedRoles = getMultiNames(
        fCS_AllowedRoles ? r.getCellValue(fCS_AllowedRoles) : null,
      );
      const allowedFlows = getMultiNames(
        fCS_AllowedFlows ? r.getCellValue(fCS_AllowedFlows) : null,
      );
      const allowedSubformats = getMultiNames(
        fCS_AllowedSubformats ? r.getCellValue(fCS_AllowedSubformats) : null,
      );
      return {
        id: r.id,
        slotNumber,
        allowedRoles,
        allowedFlows,
        allowedSubformats,
        primaryRole: slotPrimaryRole(allowedRoles),
      };
    })
    .sort((a, b) => a.slotNumber - b.slotNumber);

  if (constructorSlots.length === 0)
    throw new Error("No Constructor Slots found for this constructor");

  const numSlots = constructorSlots.length;
  const weights = positionWeights(numSlots);
  const slotIndexById = new Map();
  for (let i = 0; i < numSlots; i++)
    slotIndexById.set(constructorSlots[i].id, i);

  // Assets in wave pool
  const fA_Roles = getFirstExistingField(assetsTable, [
    "roles_allowed",
    "allowed_roles",
    "roles allowed",
  ]);
  const fA_Flow = getFirstExistingField(assetsTable, [
    "production_flow",
    "production flow",
  ]);
  const fA_Subformat = getFirstExistingField(assetsTable, [
    "subformat",
    "Subformat",
  ]);
  const fA_DefaultMusic = getFirstExistingField(assetsTable, [
    "default music",
    "Default music",
    "default_music",
    "Default Music",
  ]);
  const fA_Canonical = getFirstExistingField(assetsTable, [
    "canonical_name",
    "Canonical name",
  ]);
  const fA_S3Sync16x9 = getFirstExistingField(assetsTable, [
    "s3_sync_status_16x9",
  ]);
  // v5: Asset.duration_sec — number field, used to cap total concept duration
  const fA_Duration = getFirstExistingField(assetsTable, [
    "duration_sec",
    "duration sec",
    "Duration sec",
  ]);

  const assetIdsSet = new Set(
    assetsForWaveLinks.map((x) => x.id).filter(Boolean),
  );

  const aQuery = await assetsTable.selectRecordsAsync({
    fields: [
      fA_Roles?.id,
      fA_Flow?.id,
      fA_Subformat?.id,
      fA_DefaultMusic?.id,
      fA_Canonical?.id,
      fA_S3Sync16x9?.id,
      fA_Duration?.id,
    ].filter(Boolean),
  });

  let waveAssets = aQuery.records.filter((a) => assetIdsSet.has(a.id));
  if (waveAssets.length === 0)
    throw new Error("No Assets found by assets_for_wave links (broken links?)");

  // v5: Assets.duration_sec is required — if the field doesn't exist in the base,
  // refuse to run rather than silently ignore the cap.
  if (!fA_Duration) {
    throw new Error(
      "Assets.duration_sec field not found — required for total duration cap. Add the field to Assets or remove the cap.",
    );
  }

  const assetInfo = new Map();
  const validWaveAssets = [];
  let excludedNoDuration = 0;

  for (const a of waveAssets) {
    const sync16 = fA_S3Sync16x9
      ? getSingleSelectName(a.getCellValue(fA_S3Sync16x9))
      : null;
    const durRaw = a.getCellValue(fA_Duration);
    const durNum =
      durRaw === null || durRaw === undefined || durRaw === ""
        ? NaN
        : Number(durRaw);

    // v5: hard-exclude assets without a positive duration_sec.
    // Per spec — we must know the duration to enforce the cap; assuming 0 would
    // let unmeasured assets pass any filter and silently inflate concept length.
    if (!Number.isFinite(durNum) || durNum <= 0) {
      excludedNoDuration++;
      continue;
    }

    assetInfo.set(a.id, {
      roles: getMultiNames(fA_Roles ? a.getCellValue(fA_Roles) : null),
      flow: getSingleSelectName(fA_Flow ? a.getCellValue(fA_Flow) : null),
      subformat: getSingleSelectName(
        fA_Subformat ? a.getCellValue(fA_Subformat) : null,
      ),
      defaultMusicLinks: fA_DefaultMusic
        ? getMultiLinks(a.getCellValue(fA_DefaultMusic)) || []
        : [],
      canonical: fA_Canonical
        ? a.getCellValue(fA_Canonical) || a.name || ""
        : a.name || "",
      has16x9: sync16 === "Uploaded",
      durationSec: durNum,
    });
    validWaveAssets.push(a);
  }

  if (excludedNoDuration > 0) {
    console.log(
      `Excluded ${excludedNoDuration}/${waveAssets.length} assets from wave pool: missing or non-positive duration_sec`,
    );
  }

  waveAssets = validWaveAssets;
  if (waveAssets.length === 0) {
    throw new Error(
      `All wave assets excluded: none have a positive duration_sec. ` +
        `Populate Asset.duration_sec on the wave's assets_for_wave before running.`,
    );
  }

  // ===== v4: read Task.aspect_ratio (multipleSelects) =====
  const fT_aspect_ratio_main = tasksTable.getField("aspect_ratio");
  const waveTaskLinks = wave.getCellValue(wavesTable.getField("Tasks")) || [];
  if (!Array.isArray(waveTaskLinks) || waveTaskLinks.length === 0) {
    throw new Error("Wave has no linked Task");
  }
  const taskForRatios = await tasksTable.selectRecordAsync(waveTaskLinks[0].id);
  const { wanted: taskRatios, onlyResize } = parseTaskRatios(
    taskForRatios ? taskForRatios.getCellValue(fT_aspect_ratio_main) : null,
  );

  // v5: resolve max total duration.
  // TODO (future, dynamic): read Task.max_total_duration_sec here, e.g.:
  //   const fT_max_dur = safeGetField(tasksTable, 'max_total_duration_sec');
  //   const taskMaxDur = fT_max_dur && taskForRatios ? Number(taskForRatios.getCellValue(fT_max_dur)) : null;
  //   const maxTotalDuration = (taskMaxDur && taskMaxDur > 0) ? taskMaxDur : MAX_TOTAL_DURATION_SEC;
  const maxTotalDuration =
    wavePlatform === "Applovin" ? MAX_TOTAL_DURATION_SEC : Infinity;
  console.log(
    `v5 duration cap: platform=${wavePlatform || "unknown"}, maxTotalDuration=${Number.isFinite(maxTotalDuration) ? maxTotalDuration + "s" : "unlimited"}`,
  );

  if (onlyResize) {
    const before = waveAssets.length;
    waveAssets = waveAssets.filter((a) => assetInfo.get(a.id).has16x9);
    console.log(
      `16x9-only mode: filtered wave pool ${before} → ${waveAssets.length} assets`,
    );
    if (waveAssets.length === 0) {
      throw new Error(
        "16x9-only Task: no assets in wave pool have s3_sync_status_16x9 = Uploaded",
      );
    }
  }
  console.log(
    `v4 ratios: wanted=[${taskRatios.join(",")}] onlyResize=${onlyResize}`,
  );

  // Slot pools (universal empty constraints)
  const slotPools = new Map();
  const slotMeta = [];
  for (const s of constructorSlots) {
    const candidates = [];
    for (const a of waveAssets) {
      const info = assetInfo.get(a.id);
      if (s.allowedRoles.length > 0) {
        if (!intersects(info.roles, s.allowedRoles)) continue;
      }
      if (s.allowedFlows.length > 0) {
        if (!info.flow || !s.allowedFlows.includes(info.flow)) continue;
      }
      if (s.allowedSubformats.length > 0) {
        if (!info.subformat || !s.allowedSubformats.includes(info.subformat))
          continue;
      }
      candidates.push(a.id);
    }
    if (candidates.length === 0) {
      throw new Error(
        `Slot ${s.slotNumber} has empty candidate pool (check allowed_* constraints)`,
      );
    }
    slotPools.set(s.id, candidates);

    // v5: per-slot duration diagnostics
    const durations = candidates.map(
      (id) => assetInfo.get(id).durationSec || 0,
    );
    const minDur = durations.length ? Math.min(...durations) : 0;
    const maxDur = durations.length ? Math.max(...durations) : 0;
    const avgDur = durations.length
      ? (durations.reduce((s, d) => s + d, 0) / durations.length).toFixed(1)
      : 0;

    slotMeta.push({
      slotId: s.id,
      slotNumber: s.slotNumber,
      poolSize: candidates.length,
      primaryRole: s.primaryRole,
      minDur,
      maxDur,
      avgDur,
    });
  }

  console.log(
    `Wave pool: ${waveAssets.length} assets | Slots: ${numSlots} | Per-slot pools: ${slotMeta.map((s) => `slot${s.slotNumber}=${s.poolSize}(dur min/avg/max=${s.minDur}/${s.avgDur}/${s.maxDur}s)`).join(", ")}`,
  );

  // v5: feasibility sanity — sum of min durations must fit budget
  const minPossibleDuration = slotMeta.reduce((sum, s) => sum + s.minDur, 0);
  if (minPossibleDuration > maxTotalDuration) {
    throw new Error(
      `Infeasible duration budget: even minimum-duration assets per slot sum to ${minPossibleDuration}s, ` +
        `but cap is ${maxTotalDuration}s. Loosen the cap or curate shorter assets into the wave pool.`,
    );
  }

  // v5: precompute suffix sums of min durations for future-slot reservation.
  // minSuffixSum[i] = sum of min durations from slot i (inclusive) to last slot.
  // Picker for slot i reserves minSuffixSum[i+1] from remaining budget so it
  // doesn't pick a long asset early and starve later slots.
  // Heuristic — actual future need may exceed the reservation when the min-duration
  // asset is already used in an earlier slot, but failures with retry handle that.
  const minSuffixSum = new Array(numSlots + 1).fill(0);
  for (let i = numSlots - 1; i >= 0; i--) {
    minSuffixSum[i] = slotMeta[i].minDur + minSuffixSum[i + 1];
  }

  // Existing Recipes for wave+constructor
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
      const okW =
        Array.isArray(wLinks) && wLinks.some((x) => x.id === waveRecordId);
      const okC =
        Array.isArray(cLinks) && cLinks.some((x) => x.id === constructorId);
      return okW && okC;
    },
  );

  const existingRecipeIds = existingForWaveAndConstructor.map((r) => r.id);

  const existingConceptCount = existingForWaveAndConstructor.filter((r) => {
    if (!fRecipeRatioMain) return true;
    const ratio = getSingleSelectName(r.getCellValue(fRecipeRatioMain));
    return !ratio || ratio === "9x16";
  }).length;

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

  // Stats for diversity
  const usageGlobal = new Map();
  const exposureGlobal = new Map();
  const usagePos = Array.from({ length: numSlots }, () => new Map());
  const exposurePos = Array.from({ length: numSlots }, () => new Map());
  const adjPairUsage = new Map();
  const cooccurUsage = new Map();
  const existingSignatures = new Set();

  for (const a of waveAssets) {
    usageGlobal.set(a.id, 0);
    exposureGlobal.set(a.id, 0);
  }

  function applyRecipeToStats(slotsArr) {
    for (let i = 0; i < numSlots; i++) {
      const id = slotsArr[i];
      incMap(usageGlobal, id, 1);
      incMap(usagePos[i], id, 1);
      incMap(exposureGlobal, id, weights[i]);
      incMap(exposurePos[i], id, weights[i]);
    }
    for (let i = 0; i < numSlots - 1; i++) {
      const a = slotsArr[i];
      const b = slotsArr[i + 1];
      incMap(adjPairUsage, `${i}|${a}->${b}`, 1);
    }
    for (let i = 0; i < numSlots; i++) {
      for (let j = i + 1; j < numSlots; j++) {
        incMap(cooccurUsage, canonicalPair(slotsArr[i], slotsArr[j]), 1);
      }
    }
  }

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

      const aid = aLinks[0].id;
      mapRecipeToSlots.get(rid)[idx] = aid;
    }

    for (const slotsArr of mapRecipeToSlots.values()) {
      const ok = slotsArr.every((x) => !!x);
      if (!ok) continue;
      const sig = slotsArr.join("|");
      existingSignatures.add(sig);
      applyRecipeToStats(slotsArr);
    }
  }

  // Candidate generation
  let theoreticalMax = 1;
  for (const meta of slotMeta) {
    theoreticalMax *= meta.poolSize;
    if (theoreticalMax > 1000000) {
      theoreticalMax = 1000000;
      break;
    }
  }

  const defaultCandidates = clamp(targetCreatives * 60, 600, 2500);
  const numCandidates = clamp(
    Math.min(defaultCandidates, theoreticalMax * 2),
    needToCreate,
    6000,
  );

  const genExposureGlobal = new Map();
  const genExposurePos = Array.from({ length: numSlots }, () => new Map());
  for (const a of waveAssets) genExposureGlobal.set(a.id, 0);

  // v5: slot-level diagnostic — counts picks rejected purely by duration filter
  // (pool had non-empty available before duration check, empty after).
  // Used in stall error to distinguish "cap too tight" from "pool too narrow".
  let durationFails = 0;

  // v5: remainingDuration parameter restricts pool to assets fitting the budget.
  // Reserves minSuffixSum[slotIdx+1] for future slots — picker can't grab a long
  // asset early at the cost of starving later slots.
  function genPickForSlot(slotIdx, slotId, usedInRecipe, remainingDuration) {
    const pool = slotPools.get(slotId) || [];
    let available = pool.filter((id) => !usedInRecipe.has(id));
    const beforeDurFilter = available.length;

    // v5: filter by remaining duration budget, reserving min sum for future slots
    const reservedForFuture = minSuffixSum[slotIdx + 1];
    const usableBudget = remainingDuration - reservedForFuture;
    available = available.filter((id) => {
      const d = assetInfo.get(id)?.durationSec || 0;
      return d <= usableBudget;
    });

    if (available.length === 0) {
      // pool had assets but none fit the budget — count as duration-cap fail
      if (beforeDurFilter > 0) durationFails++;
      return null;
    }

    const primary = slotMeta[slotIdx].primaryRole;

    let bestScore = Infinity;
    for (const id of available) {
      const pe = genExposurePos[slotIdx].get(id) || 0;
      const ge = genExposureGlobal.get(id) || 0;
      let score = pe + 0.7 * ge;
      const roles = assetInfo.get(id)?.roles || [];
      score -= roleFitBonus(roles, primary) * 0.35;
      if (score < bestScore) bestScore = score;
    }

    const best = available.filter((id) => {
      const pe = genExposurePos[slotIdx].get(id) || 0;
      const ge = genExposureGlobal.get(id) || 0;
      let score = pe + 0.7 * ge;
      const roles = assetInfo.get(id)?.roles || [];
      score -= roleFitBonus(roles, primary) * 0.35;
      return score === bestScore;
    });

    return pickRandom(best);
  }

  // v5: tryGenerateOneRecipe tracks runningDuration through slot picks
  function tryGenerateOneRecipe(maxAttempts = 80) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const used = new Set();
      const slots = [];
      let runningDuration = 0;
      let ok = true;

      for (let i = 0; i < numSlots; i++) {
        const slotId = constructorSlots[i].id;
        const remaining = maxTotalDuration - runningDuration;
        const assetId = genPickForSlot(i, slotId, used, remaining);
        if (!assetId) {
          ok = false;
          break;
        }
        slots.push(assetId);
        used.add(assetId);
        runningDuration += assetInfo.get(assetId).durationSec || 0;
      }
      if (!ok) continue;

      // v5: safety net — should never trigger because picker filters strictly,
      // but guards against arithmetic drift / future picker changes
      if (runningDuration > maxTotalDuration) continue;

      const sig = slots.join("|");
      if (existingSignatures.has(sig)) continue;

      for (let i = 0; i < numSlots; i++) {
        const id = slots[i];
        incMap(genExposureGlobal, id, weights[i]);
        incMap(genExposurePos[i], id, weights[i]);
      }
      return slots;
    }
    return null;
  }

  const candidateSet = new Set();
  const candidates = [];
  let fails = 0;
  let collisions = 0;
  const STALL_LIMIT = Math.max(400, needToCreate * 20);

  while (candidates.length < numCandidates) {
    const slots = tryGenerateOneRecipe();
    if (!slots) {
      fails++;
      if (fails > STALL_LIMIT) break;
      continue;
    }
    const sig = slots.join("|");
    if (candidateSet.has(sig)) {
      collisions++;
      if (collisions > STALL_LIMIT) break;
      continue;
    }
    candidateSet.add(sig);
    candidates.push({ slots, signature: sig });
  }

  console.log(
    `Candidate generation: target=${numCandidates}, produced=${candidates.length}, fails=${fails}, collisions=${collisions}, theoreticalMax≈${theoreticalMax}`,
  );

  if (candidates.length < needToCreate) {
    const poolsInfo = slotMeta
      .map(
        (s) =>
          `slot${s.slotNumber}=${s.poolSize}(min/avg/max=${s.minDur}/${s.avgDur}/${s.maxDur}s)`,
      )
      .join(", ");

    // v5: classify the dominant cause so the operator knows what to fix.
    // durationFails counts slot-level rejections by duration filter.
    // fails counts whole-recipe attempt exhaustions (80 internal tries each).
    // collisions counts recipes that were generated but duplicated an earlier signature.
    let likelyCause;
    if (durationFails > (fails + collisions) * 2) {
      likelyCause =
        "duration cap too tight for this asset mix — loosen cap or curate shorter assets";
    } else if (collisions > fails) {
      likelyCause =
        "signature space exhausted — wave pool too narrow for the requested unique count, or too many existing recipes";
    } else {
      likelyCause =
        "slot pools too narrow after constraints — broaden roles/flows/subformats or add more assets to the wave";
    }

    throw new Error(
      `Generation stalled: produced ${candidates.length}/${needToCreate} unique recipes.\n` +
        `Failure breakdown:\n` +
        `  - ${fails} whole-recipe attempts exhausted (each tried up to 80 internal picks)\n` +
        `  - ${collisions} candidates dropped as duplicates of earlier-generated signatures\n` +
        `  - ${durationFails} slot picks rejected by duration cap\n` +
        `Duration: cap=${maxTotalDuration}s, min feasible sum across slots=${minPossibleDuration}s.\n` +
        `Pools: ${poolsInfo}.\n` +
        `Theoretical unique max ≈ ${theoreticalMax}.\n` +
        `Likely cause: ${likelyCause}.\n` +
        `No Recipes, Packs or Creatives were created.`,
    );
  }

  // Greedy selection
  function scoreIncrement(candidateSlots) {
    let score = 0;

    for (let i = 0; i < numSlots; i++) {
      const id = candidateSlots[i];
      const pe = exposurePos[i].get(id) || 0;
      const ge = exposureGlobal.get(id) || 0;
      score += T.POS_EXPOSURE_WEIGHT * (1 / (1 + pe));
      score += T.GLOBAL_EXPOSURE_WEIGHT * (1 / (1 + ge));
      const primary = slotMeta[i].primaryRole;
      const roles = assetInfo.get(id)?.roles || [];
      score += roleFitBonus(roles, primary);
    }

    for (let i = 0; i < numSlots - 1; i++) {
      const a = candidateSlots[i];
      const b = candidateSlots[i + 1];
      const key = `${i}|${a}->${b}`;
      const c = adjPairUsage.get(key) || 0;
      score -= T.ADJ_PAIR_PENALTY * c;
    }

    for (let i = 0; i < numSlots; i++) {
      for (let j = i + 1; j < numSlots; j++) {
        const key = canonicalPair(candidateSlots[i], candidateSlots[j]);
        const c = cooccurUsage.get(key) || 0;
        score -= T.COOCCUR_PENALTY * c;
      }
    }

    return score;
  }

  function applyCandidate(candidateSlots) {
    for (let i = 0; i < numSlots; i++) {
      const id = candidateSlots[i];
      incMap(usageGlobal, id, 1);
      incMap(usagePos[i], id, 1);
      incMap(exposureGlobal, id, weights[i]);
      incMap(exposurePos[i], id, weights[i]);
    }
    for (let i = 0; i < numSlots - 1; i++) {
      const a = candidateSlots[i];
      const b = candidateSlots[i + 1];
      incMap(adjPairUsage, `${i}|${a}->${b}`, 1);
    }
    for (let i = 0; i < numSlots; i++) {
      for (let j = i + 1; j < numSlots; j++) {
        incMap(
          cooccurUsage,
          canonicalPair(candidateSlots[i], candidateSlots[j]),
          1,
        );
      }
    }
  }

  const remaining = candidates.slice();
  const selected = [];
  for (let t = 0; t < needToCreate; t++) {
    let bestIdx = -1;
    let bestScore = -Infinity;

    const scanN = Math.min(remaining.length, T.MAX_SCAN_CANDIDATES);
    for (let i = 0; i < scanN; i++) {
      const s = scoreIncrement(remaining[i].slots);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0];
    selected.push(chosen);
    applyCandidate(chosen.slots);
  }

  // v5: log duration distribution of selected concepts
  const selectedDurations = selected.map((c) =>
    c.slots.reduce((sum, id) => sum + (assetInfo.get(id).durationSec || 0), 0),
  );
  const minSel = selectedDurations.length ? Math.min(...selectedDurations) : 0;
  const maxSel = selectedDurations.length ? Math.max(...selectedDurations) : 0;
  const avgSel = selectedDurations.length
    ? (
        selectedDurations.reduce((s, d) => s + d, 0) / selectedDurations.length
      ).toFixed(1)
    : 0;
  console.log(
    `Selected concepts duration: min/avg/max = ${minSel}/${avgSel}/${maxSel}s (cap=${maxTotalDuration}s)`,
  );

  // ===== v4: determine available ratios per concept =====
  const conceptRatios = selected.map((c) => {
    const available = taskRatios.filter((r) =>
      conceptSupportsRatio(c.slots, r, assetInfo),
    );
    return available;
  });

  const skippedConcepts = conceptRatios.filter((rs) => rs.length === 0).length;
  if (skippedConcepts > 0) {
    console.log(
      `Skipped ${skippedConcepts}/${selected.length} concepts: no usable ratio in [${taskRatios.join(",")}]`,
    );
  }

  const fRecipeRatio = getFirstExistingField(recipesTable, ["ratio"]);
  const createPayload = [];
  const recipePayloadMeta = [];

  for (let i = 0; i < selected.length; i++) {
    for (const ratio of conceptRatios[i]) {
      const fields = {};
      fields[rfRecipesToConstructors.id] = [{ id: constructorId }];
      fields[rfRecipesToWaves.id] = [{ id: waveRecordId }];
      if (fRecipeRatio) fields[fRecipeRatio.id] = { name: ratio };
      if (
        fRecipeOverlays &&
        Array.isArray(waveOverlaysLinks) &&
        waveOverlaysLinks.length > 0
      ) {
        fields[fRecipeOverlays.id] = waveOverlaysLinks.map((x) => ({
          id: x.id,
        }));
      }
      createPayload.push({ fields });
      recipePayloadMeta.push({ conceptIdx: i, ratio });
    }
  }

  let createdRecipeIds = [];
  for (const batch of chunk(createPayload, 50)) {
    const ids = await recipesTable.createRecordsAsync(batch);
    createdRecipeIds = createdRecipeIds.concat(ids);
  }

  if (createdRecipeIds.length !== createPayload.length) {
    throw new Error(
      `Mismatch: createdRecipeIds=${createdRecipeIds.length}, expected=${createPayload.length}`,
    );
  }

  const conceptRecipes = selected.map(() => new Map());
  for (let k = 0; k < createdRecipeIds.length; k++) {
    const { conceptIdx, ratio } = recipePayloadMeta[k];
    conceptRecipes[conceptIdx].set(ratio, createdRecipeIds[k]);
  }

  const rsPayload = [];
  for (let k = 0; k < createdRecipeIds.length; k++) {
    const recipeId = createdRecipeIds[k];
    const { conceptIdx } = recipePayloadMeta[k];
    const cand = selected[conceptIdx];

    for (let sIdx = 0; sIdx < numSlots; sIdx++) {
      const slot = constructorSlots[sIdx];
      const assetId = cand.slots[sIdx];

      const fields = {};
      fields[rfRS_Recipe.id] = [{ id: recipeId }];
      fields[rfRS_ConstructorSlot.id] = [{ id: slot.id }];
      fields[rfRS_Asset.id] = [{ id: assetId }];
      rsPayload.push({ fields });
    }
  }

  for (const batch of chunk(rsPayload, 50)) {
    await recipeSlotsTable.createRecordsAsync(batch);
  }

  console.log(
    `Created ${createdRecipeIds.length} Recipes across ${selected.length} concepts (avg ${(createdRecipeIds.length / Math.max(1, selected.length)).toFixed(2)} per concept)`,
  );

  const packSelected = [];
  const packConceptRecipes = [];
  for (let i = 0; i < selected.length; i++) {
    if (conceptRecipes[i].size > 0) {
      packSelected.push(selected[i]);
      packConceptRecipes.push(conceptRecipes[i]);
    }
  }

  await createPacksAndCreatives({
    mode: "homunculus",
    wavesTable,
    waveRecord: wave,
    constructorSlots,
    selected: packSelected,
    conceptRecipes: packConceptRecipes,
    assetInfo,
  });

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

// ================== MUSIC ASSIGNMENT (ONLY_EMPTY) ==================
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
    const okW =
      Array.isArray(wLinks) && wLinks.some((x) => x.id === waveRecordId);
    const okC =
      Array.isArray(cLinks) && cLinks.some((x) => x.id === constructorId);
    return okW && okC;
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

    for (const batch of chunk(upd, 50)) {
      await recipesTable.updateRecordsAsync(batch);
    }
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

  const allAssetIdsInRecipes = new Set();

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
    allAssetIdsInRecipes.add(aid);

    if (!recipeToSlotsArr.has(rid))
      recipeToSlotsArr.set(rid, Array(numSlots).fill(null));
    recipeToSlotsArr.get(rid)[idx] = aid;
  }

  const assetDefaultMusic = new Map();
  const assetsQuery = await assetsTable.selectRecordsAsync({
    fields: [fA_DefaultMusic.id],
  });
  for (const a of assetsQuery.records) {
    if (!allAssetIdsInRecipes.has(a.id)) continue;
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

  for (const batch of chunk(upd2, 50)) {
    await recipesTable.updateRecordsAsync(batch);
  }
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
