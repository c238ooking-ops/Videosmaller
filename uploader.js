import fs from "fs";
import https from "https";

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

// Keep-alive agent to maintain persistent TLS socket
const httpsAgent = new https.Agent({
  keepAlive: true,
  timeout: 180000
});

// 1. Authorize API v2
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

// 2. Exact account storage endpoint according to API docs (/account/package)
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

      // 0 represents unmetered/unlimited storage
      if (total === 0) return 500 * 1024 * 1024 * 1024;
      return Math.max(0, total - used);
    }
  } catch (err) {
    console.warn(`Storage query warning: ${err.message}`);
  }
  // Safe default fallback
  return 100 * 1024 * 1024 * 1024;
}

// 3. Multi-gigabyte safe streaming uploader with rate-pacing
function uploadStream(filePath, fileName, token, accountId) {
  return new Promise((resolve, reject) => {
    const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
    const stats = fs.statSync(filePath);
    const totalSize = stats.size;

    const head = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="access_token"`,
      "",
      token,
      `--${boundary}`,
      `Content-Disposition: form-data; name="account_id"`,
      "",
      accountId,
      `--${boundary}`,
      `Content-Disposition: form-data; name="files[]"; filename="${fileName}"`,
      "Content-Type: video/x-matroska",
      "",
      ""
    ].join("\r\n");

    const tail = `\r\n--${boundary}--\r\n`;
    const contentLength = Buffer.byteLength(head) + totalSize + Buffer.byteLength(tail);

    const req = https.request("https://www.udrop.com/api/v2/file/upload", {
      method: "POST",
      agent: httpsAgent,
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": contentLength,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      }
    }, (res) => {
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (data._status === "success") {
            resolve(data);
          } else {
            reject(new Error(data.response || JSON.stringify(data)));
          }
        } catch (e) {
          reject(new Error(`Invalid server response: ${body.substring(0, 300)}`));
        }
      });
    });

    req.on("error", reject);
    req.write(head);

    // 128KB buffer chunks with TCP flow control to avoid proxy socket drops
    const fileStream = fs.createReadStream(filePath, { highWaterMark: 128 * 1024 });
    let uploadedBytes = 0;
    let lastReport = 0;

    fileStream.on("data", (chunk) => {
      uploadedBytes += chunk.length;
      fileStream.pause();

      const canContinue = req.write(chunk);

      const now = Date.now();
      if (now - lastReport > 3000) {
        const pct = ((uploadedBytes / totalSize) * 100).toFixed(1);
        const mb = (uploadedBytes / (1024 * 1024)).toFixed(0);
        const totalMb = (totalSize / (1024 * 1024)).toFixed(0);
        console.log(`   ⏳ Transferred: ${mb}MB / ${totalMb}MB (${pct}%)`);
        lastReport = now;
      }

      // Allow TCP socket buffers to drain smoothly
      if (!canContinue) {
        req.once("drain", () => setTimeout(() => fileStream.resume(), 10));
      } else {
        setTimeout(() => fileStream.resume(), 10);
      }
    });

    fileStream.on("end", () => {
      req.write(tail);
      req.end();
    });

    fileStream.on("error", (err) => {
      req.destroy();
      reject(err);
    });
  });
}

// 4. Main distribution runner
async function run() {
  const baseName = process.env.BASE_NAME || "Video";
  const files = fs.readdirSync(".")
    .filter(f => f.startsWith("part-") && f.endsWith(".mkv"))
    .sort();

  if (files.length === 0) {
    console.error("❌ No split files found to upload.");
    process.exit(1);
  }

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

  const isMultiPart = files.length > 1;
  let partIndex = 1;

  for (const file of files) {
    const stats = fs.statSync(file);
    const fileSize = stats.size;
    const targetName = isMultiPart 
      ? `${baseName}.Part${partIndex}.mkv` 
      : `${baseName}.mkv`;

    console.log(`\n📦 Processing: ${targetName} (${(fileSize / (1024 ** 3)).toFixed(2)} GB)`);

    // Target account requires chunk size + 200MB safety buffer
    const targetAcc = pool.find(acc => acc.freeBytes > (fileSize + 200 * 1024 * 1024));
    if (!targetAcc) {
      console.error(`❌ Out of storage! No account has enough space for ${targetName}`);
      process.exit(1);
    }

    console.log(`🚀 Uploading to [${targetAcc.name}]...`);

    let uploaded = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await uploadStream(file, targetName, targetAcc.token, targetAcc.accountId);
        uploaded = true;
        console.log(`✅ Upload complete for ${targetName}!`);
        break;
      } catch (err) {
        console.warn(`   ⚠️ Attempt ${attempt} failed (${err.message}). Retrying in 5s...`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (!uploaded) {
      console.error(`❌ Failed to upload ${targetName} after 3 attempts.`);
      process.exit(1);
    }

    targetAcc.freeBytes -= fileSize;
    partIndex++;
  }

  console.log("\n🎉 All chunks successfully uploaded and distributed!");
}

run();
