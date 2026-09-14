import fs from "fs";
import path from "path";

const API_BASE = "https://www.udrop.com/api/v2";

// 1. Parse accounts
let ACCOUNTS = [];
try {
  ACCOUNTS = JSON.parse(process.env.UDROP_ACCOUNTS_JSON || "[]");
} catch (e) {
  console.error("❌ Failed to parse UDROP_ACCOUNTS_JSON secret.");
  process.exit(1);
}

if (ACCOUNTS.length === 0) {
  console.error("❌ No accounts found in UDROP_ACCOUNTS_JSON.");
  process.exit(1);
}

// 2. Auth helper
async function authorize(key1, key2) {
  const res = await fetch(`${API_BASE}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key1, key2 })
  });
  const data = await res.json();
  if (data._status !== "success") throw new Error(`Auth failed: ${data.response}`);
  return { token: data.data.access_token, accountId: data.data.account_id };
}

// 3. Get free space in bytes
async function getFreeSpace(token, accountId) {
  try {
    const res = await fetch(`${API_BASE}/account/details`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: token, account_id: accountId })
    });
    const data = await res.json();

    if (data._status === "success" && data.data) {
      const total = Number(data.data.total_storage_bytes || data.data.storage_limit_bytes || 0);
      const used = Number(data.data.used_storage_bytes || data.data.storage_used_bytes || 0);
      
      // If unlimited or unmetered, return plenty of space
      if (total === 0) return 100 * 1024 * 1024 * 1024; 
      return Math.max(0, total - used);
    }
  } catch (err) {
    console.warn(`Could not check space: ${err.message}`);
  }
  // Default fallback if endpoint format differs: assume free space available
  return 10 * 1024 * 1024 * 1024;
}

// 4. File uploader using native FormData
async function uploadFile(filePath, fileName, token, accountId) {
  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer]);

  const form = new FormData();
  form.append("access_token", token);
  form.append("account_id", accountId);
  form.append("files", blob, fileName);

  const res = await fetch(`${API_BASE}/file/upload`, {
    method: "POST",
    body: form
  });
  const data = await res.json();
  if (data._status !== "success") {
    throw new Error(data.response || "Upload failed");
  }
  return data;
}

// 5. Main Distribution Loop
async function run() {
  const baseName = process.env.BASE_NAME || "Video";
  const files = fs.readdirSync(".")
    .filter(f => f.startsWith("part-") && f.endsWith(".mkv"))
    .sort();

  if (files.length === 0) {
    console.error("❌ No part files found to upload.");
    process.exit(1);
  }

  // Pre-authenticate and check capacity for all accounts
  const pool = [];
  for (const acc of ACCOUNTS) {
    try {
      console.log(`🔑 Checking account: [${acc.name}]...`);
      const auth = await authorize(acc.key1, acc.key2);
      const freeBytes = await getFreeSpace(auth.token, auth.accountId);
      console.log(`   Available space: ${(freeBytes / (1024 ** 3)).toFixed(2)} GB`);
      pool.push({ ...acc, ...auth, freeBytes });
    } catch (e) {
      console.warn(`   ⚠️ Skipped ${acc.name}: ${e.message}`);
    }
  }

  if (pool.length === 0) {
    console.error("❌ No valid authenticated accounts available.");
    process.exit(1);
  }

  // Distribute chunks
  let partIndex = 1;
  for (const file of files) {
    const stats = fs.statSync(file);
    const fileSize = stats.size;
    const targetName = `${baseName}.Part${partIndex}.mkv`;

    console.log(`\n📦 Processing: ${targetName} (${(fileSize / (1024 ** 3)).toFixed(2)} GB)`);

    // Find first account that has enough free space (with a 200MB safety buffer)
    const targetAcc = pool.find(acc => acc.freeBytes > (fileSize + 200 * 1024 * 1024));

    if (!targetAcc) {
      console.error(`❌ Out of storage! None of your accounts have enough free space for ${targetName}`);
      process.exit(1);
    }

    console.log(`🚀 Uploading to [${targetAcc.name}]...`);
    await uploadFile(file, targetName, targetAcc.token, targetAcc.accountId);
    console.log(`✅ Upload complete!`);

    // Deduct size from local pool tracking
    targetAcc.freeBytes -= fileSize;
    partIndex++;
  }

  console.log("\n🎉 All parts successfully distributed across your uDrop accounts!");
}

run();
