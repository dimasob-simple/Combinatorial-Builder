Inputs.
These let you use values from previous automation triggers and actions. Use in your script with input.config().

Name: waveRecordId,
Value: Airtable record ID,

Name: foundA,
Value: List of Airtable record ID,

Name: foundB,
Value: List of Airtable record ID,

// CONFIG — проверь имена таблицы и поля
const WAVES_TABLE = "Waves";
const ASSETS_LINK_FIELD_IN_WAVES = "assets_for_wave"; // link to Assets

// INPUTS from automation
const inputConfig = input.config();
const waveRecordId = inputConfig.waveRecordId;
const foundA = inputConfig.foundA || []; // array of record ids
const foundB = inputConfig.foundB || []; // array of record ids

// merge + dedupe
const merged = Array.from(new Set([...foundA, ...foundB]));

// update wave
const waves = base.getTable(WAVES_TABLE);
await waves.updateRecordAsync(waveRecordId, {
  [ASSETS_LINK_FIELD_IN_WAVES]: merged.map(id => ({ id }))
});

output.set("linked_assets_count", merged.length);