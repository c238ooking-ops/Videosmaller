import fs from "fs";

const API_BASE = "https://www.udrop.com/api/v2";

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

const tunnelUrl = process.env.TUNNEL_URL;
const baseName = process.env.BASE_NAME || "Video";

if (!tunnelUrl) {
  console.error("❌ No TUNNEL_URL provided.");
  process.exit(1);
}

async function authorize(key1, key2) {
  const res = await fetch(`${API_BASE}/authorize`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ key1, key2 })
  });
  const data = await res.json();
  if (data._status !== "success") {
    throw new Error(`Auth failed: ${data.response || JSON.stringify(data)}`);
  }
  return { token: data.data.access_token, accountId: data.data.account_id };
}

async function getFreeSpace(token, accountId) {
  try {
    const res = await fetch(`${API_BASE}/account/package`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: token, account_id: accountId })
    });
    const data = await res.json();

    if (data._status === "success" && data.data) {
      const total = Number(data.data.total_storage_bytes || data.data.max_storage_bytes || 0);
      const used = Number(data.data.storage_used_bytes || data.data.total_storage_used || 0);
      if (total === 0) return 500 * 1024 * 1024 * 1024;
      return Math.max(0, total - used);
    }
  } catch (err) {
    console.warn(`Storage query warning: ${err.message}`);
  }
  return 100 * 1024 * 1024 * 1024;
}

// Submits the remote URL into uDrop's server-side download queue
async function remoteUrlUpload(downloadUrl, token, accountId) {
  const res = await fetch(`${API_BASE}/file/url_upload`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      access_token: token,
      account_id: accountId,
      url: downloadUrl
    })
  });
  const data = await res.json();
  if (data._status !== "success") {
    throw new Error(data.response || JSON.stringify(data));
  }
  return data;
}

async function run() {
  const filesDir = "./public_files";
  const rawFiles = fs.readdirSync(filesDir)
    .filter(f => f.startsWith("part-") && f.endsWith(".mkv"))
    .sort();

  if (rawFiles.length === 0) {
    console.error("❌ No split files found to upload.");
    process.exit(1);
  }

  // 1. Rename files locally to final target names so Python serves them cleanly
  const isMultiPart = rawFiles.length > 1;
  const readyFiles = [];

  let idx = 1;
  for (const f of rawFiles) {
    const targetName = isMultiPart ? `${baseName}.Part${idx}.mkv` : `${baseName}.mkv`;
    fs.renameSync(`${filesDir}/${f}`, `${filesDir}/${targetName}`);
    
    const size = fs.statSync(`${filesDir}/${targetName}`).size;
    readyFiles.push({ name: targetName, size });
    idx++;
  }

  // 2. Query account capacities
  const pool = [];
  for (const acc of ACCOUNTS) {
    try {
      console.log(`🔑 Authenticating & checking storage: [${acc.name}]...`);
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

  // 3. Queue files into uDrop via the tunnel URL
  for (const file of readyFiles) {
    console.log(`\n📦 Processing: ${file.name} (${(file.size / (1024 ** 3)).toFixed(2)} GB)`);

    const targetAcc = pool.find(acc => acc.freeBytes > (file.size + 200 * 1024 * 1024));
    if (!targetAcc) {
      console.error(`❌ Out of storage! No account has enough space for ${file.name}`);
      process.exit(1);
    }

    const publicDownloadUrl = `${tunnelUrl}/${encodeURIComponent(file.name)}`;
    console.log(`🚀 Sending Remote URL to [${targetAcc.name}]...`);
    console.log(`   🔗 Source: ${publicDownloadUrl}`);

    await remoteUrlUpload(publicDownloadUrl, targetAcc.token, targetAcc.accountId);
    console.log(`✅ Remote download successfully queued on uDrop servers!`);

    targetAcc.freeBytes -= file.size;
  }

  console.log("\n⏳ Waiting 45 seconds to allow uDrop servers to pull all files across the tunnel...");
  await new Promise(r => setTimeout(r, 45000));
  console.log("🎉 Transfer session complete!");
}

run();
