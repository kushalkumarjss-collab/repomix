const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Create temp directory for storing generated files
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  console.log(`📁 Created temp directory: ${TEMP_DIR}`);
}

// Check if 7z is available
let has7z = false;
async function check7z() {
  try {
    await execPromise('7z --help');
    has7z = true;
    console.log('✅ 7z compression available (better compression than ZIP)');
  } catch {
    has7z = false;
    console.log('⚠️ 7z not found, using fallback method');
  }
}
check7z();

// Clean up old files every hour
setInterval(() => {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  fs.readdir(TEMP_DIR, (err, files) => {
    if (err) return;
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      fs.stat(filePath, (err, stats) => {
        if (err) return;
        if (stats.isFile() && stats.mtimeMs < oneHourAgo) {
          fs.unlink(filePath, (err) => {
            if (!err) console.log(`🗑️ Cleaned up expired temp file: ${file}`);
          });
        }
      });
    });
  });
}, 60 * 60 * 1000);

// Parse tokens from environment variable
const TOKENS = process.env.GITHUB_TOKENS 
  ? process.env.GITHUB_TOKENS.split(',').filter(t => t.trim())
  : [];
let currentTokenIndex = 0;

function getNextToken() {
  if (TOKENS.length === 0) return null;
  const token = TOKENS[currentTokenIndex];
  currentTokenIndex = (currentTokenIndex + 1) % TOKENS.length;
  return token;
}

// ========== IN-MEMORY CACHE FOR REPO METADATA ==========
const repoCache = new Map();
const MAX_CACHE_SIZE = 5;

class RepoCacheEntry {
  constructor(owner, repo, branch, repoId, fileTree, totalSize, fileContents) {
    this.owner = owner;
    this.repo = repo;
    this.branch = branch;
    this.repoId = repoId;
    this.fileTree = fileTree;
    this.totalSize = totalSize;
    this.fileContents = fileContents;
    this.timestamp = Date.now();
    this.lastAccessed = Date.now();
    this.accessCount = 1;
  }
  updateAccess() {
    this.accessCount++;
    this.lastAccessed = Date.now();
  }
}

function addToCache(owner, repo, branch, repoId, fileTree, totalSize, fileContents) {
  const key = `${owner}/${repo}/${branch}`.toLowerCase();
  if (repoCache.has(key)) {
    repoCache.delete(key);
  }
  if (repoCache.size >= MAX_CACHE_SIZE) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [cacheKey, entry] of repoCache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = cacheKey;
      }
    }
    if (oldestKey) {
      console.log(`🗑️ Removing cold cache entry: ${oldestKey}`);
      repoCache.delete(oldestKey);
    }
  }
  const entry = new RepoCacheEntry(owner, repo, branch, repoId, fileTree, totalSize, fileContents);
  repoCache.set(key, entry);
  console.log(`✅ Cached: ${key} (Cache size: ${repoCache.size}/${MAX_CACHE_SIZE})`);
}

function getFromCache(owner, repo, branch) {
  const key = `${owner}/${repo}/${branch}`.toLowerCase();
  const entry = repoCache.get(key);
  if (entry) {
    entry.updateAccess();
    console.log(`💾 Cache HIT: ${key}`);
    return entry;
  }
  console.log(`❌ Cache MISS: ${key}`);
  return null;
}

// ========== HELPER: Generate Text Content ==========
function generateTextFileContent(files, includeDirStructure = true, showLineNumbers = false, removeComments = false, removeEmptyLines = false) {
  let output = "";
  output += "#".repeat(80) + "\n";
  output += `REPOMIX EXPORT\n`;
  output += `Generated: ${new Date().toLocaleString()}\n`;
  output += `Total files: ${Object.keys(files).length}\n`;
  output += `Total size: ${(Object.values(files).reduce((sum, c) => sum + (c ? c.length : 0), 0) / 1024).toFixed(1)} KB\n`;
  output += "#".repeat(80) + "\n\n";
  
  if (includeDirStructure) {
    const paths = Object.keys(files);
    output += "DIRECTORY STRUCTURE\n";
    output += "-".repeat(80) + "\n";
    output += buildAsciiTree(paths) + "\n\n";
    output += "#".repeat(80) + "\n\n";
  }
  
  for (const [filePath, content] of Object.entries(files)) {
    output += `\n${"#".repeat(80)}\n`;
    output += `File: ${filePath}\n`;
    output += `${"#".repeat(80)}\n\n`;
    
    let processedContent = content || "";
    if (removeComments) {
      processedContent = removeCommentsFromCode(processedContent, filePath);
    }
    if (removeEmptyLines) {
      processedContent = processedContent.split("\n").filter(l => l.trim().length > 0).join("\n");
    }
    if (showLineNumbers) {
      const lines = processedContent.split("\n");
      const maxLineNum = Math.max(lines.length, 1).toString().length;
      processedContent = lines.map((line, idx) => {
        const lineNum = (idx + 1).toString().padStart(maxLineNum, " ");
        return `${lineNum} | ${line}`;
      }).join("\n");
    }
    output += processedContent + "\n";
  }
  
  output += "\n" + "#".repeat(80) + "\n";
  output += "END OF CODEBASE\n";
  output += "#".repeat(80) + "\n";
  return output;
}

function buildAsciiTree(paths) {
  if (!paths.length) return "(empty)";
  const root = {};
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        if (!node._files) node._files = [];
        node._files.push(part);
      } else {
        if (!node[part]) node[part] = {};
        node = node[part];
      }
    }
  }
  
  function renderNode(node, prefix = "") {
    let lines = [];
    const dirs = Object.keys(node).filter(k => k !== "_files").sort();
    const files = node._files ? [...node._files].sort() : [];
    const items = [...dirs.map(d => ({ type: "dir", name: d })), ...files.map(f => ({ type: "file", name: f }))];
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isLast = i === items.length - 1;
      const connector = isLast ? "└── " : "├── ";
      lines.push(`${prefix}${connector}${item.name}${item.type === "dir" ? "/" : ""}`);
      if (item.type === "dir") {
        const childPrefix = prefix + (isLast ? "    " : "│   ");
        const childLines = renderNode(node[item.name], childPrefix);
        if (childLines) lines.push(childLines);
      }
    }
    return lines.join("\n");
  }
  
  const rootDirs = Object.keys(root).filter(k => k !== "_files").sort();
  const rootFiles = root._files ? [...root._files].sort() : [];
  const rootItems = [...rootDirs.map(d => ({ type: "dir", name: d })), ...rootFiles.map(f => ({ type: "file", name: f }))];
  let result = [];
  
  for (let i = 0; i < rootItems.length; i++) {
    const item = rootItems[i];
    const isLast = i === rootItems.length - 1;
    const connector = isLast ? "└── " : "├── ";
    result.push(`${connector}${item.name}${item.type === "dir" ? "/" : ""}`);
    if (item.type === "dir") {
      const childPrefix = isLast ? "    " : "│   ";
      const childLines = renderNode(root[item.name], childPrefix);
      if (childLines) result.push(childLines);
    }
  }
  return result.join("\n");
}

function removeCommentsFromCode(code, filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) {
    return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  if (ext === "py") {
    return code.replace(/#.*$/gm, "").replace(/'''[\s\S]*?'''/g, "").replace(/"""[\s\S]*?"""/g, "");
  }
  if (ext === "html") return code.replace(/<!--[\s\S]*?-->/g, "");
  if (ext === "css") return code.replace(/\/\*[\s\S]*?\*\//g, "");
  if (["c", "cpp", "h", "hpp", "java", "go", "rs", "php", "cs", "swift", "kt", "scala"].includes(ext)) {
    return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  return code;
}

// ========== Generate 7z Archive (if available) ==========
async function generate7zContent(textContent, sessionId) {
  const tempTextFile = path.join(TEMP_DIR, `${sessionId}.txt`);
  const temp7zFile = path.join(TEMP_DIR, `${sessionId}.7z`);
  
  fs.writeFileSync(tempTextFile, textContent, 'utf-8');
  
  if (has7z) {
    // Use 7z with maximum compression
    await execPromise(`7z a -t7z -mx=9 -mfb=273 -ms=on "${temp7zFile}" "${tempTextFile}"`);
    const data = fs.readFileSync(temp7zFile);
    
    // Clean up
    fs.unlinkSync(tempTextFile);
    if (fs.existsSync(temp7zFile)) fs.unlinkSync(temp7zFile);
    
    return data;
  } else {
    // Fallback to ZIP if 7z not available
    const archiver = require('archiver');
    return new Promise((resolve, reject) => {
      const chunks = [];
      const archive = archiver('zip', { zlib: { level: 9 } });
      archive.on('data', chunk => chunks.push(chunk));
      archive.on('end', () => {
        fs.unlinkSync(tempTextFile);
        resolve(Buffer.concat(chunks));
      });
      archive.on('error', reject);
      archive.append(textContent, { name: 'repomix_export.txt' });
      archive.finalize();
    });
  }
}

// ========== STEP 1: Analyze Repo ==========
app.post('/api/analyze', async (req, res) => {
  const { owner, repo, branch = 'main', ignorePatterns = [] } = req.body;
  if (!owner || !repo) {
    return res.status(400).json({ success: false, error: 'Missing owner or repo' });
  }
  
  console.log(`\n📊 Analyzing: ${owner}/${repo}:${branch}`);
  
  try {
    const cached = getFromCache(owner, repo, branch);
    if (cached) {
      const filteredTree = {};
      let totalSize = 0;
      for (const [filePath, size] of Object.entries(cached.fileTree)) {
        const shouldIgnore = ignorePatterns.some(pattern => 
          filePath.toLowerCase().includes(pattern.toLowerCase())
        );
        if (!shouldIgnore) {
          filteredTree[filePath] = size;
          totalSize += size;
        }
      }
      return res.json({
        success: true,
        fromCache: true,
        repoId: cached.repoId,
        fileTree: filteredTree,
        totalSize: totalSize,
        totalFiles: Object.keys(filteredTree).length,
        totalSizeKB: (totalSize / 1024).toFixed(1)
      });
    }
    
    const token = getNextToken();
    const headers = {
      'User-Agent': 'Repomix-Render-Backend',
      'Accept': 'application/vnd.github+json'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      console.log(`🔑 Using token: ${token.substring(0, 8)}...`);
    } else {
      console.log('⚠️ No token configured (rate limits apply)');
    }
    
    const repoInfoUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const repoInfoResponse = await fetch(repoInfoUrl, { headers });
    if (!repoInfoResponse.ok) {
      throw new Error(`GitHub API error: ${repoInfoResponse.status}`);
    }
    const repoInfo = await repoInfoResponse.json();
    const repoId = repoInfo.id;
    const actualBranch = branch === 'main' ? (repoInfo.default_branch || 'main') : branch;
    const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${actualBranch}`;
    
    console.log(`⬇️ Downloading: ${zipUrl}`);
    const zipResponse = await fetch(zipUrl, { headers, redirect: 'follow' });
    if (!zipResponse.ok) {
      throw new Error(`Download failed: ${zipResponse.status}`);
    }
    
    const zipBuffer = await zipResponse.buffer();
    console.log(`✅ Downloaded ${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();
    let rootPrefix = '';
    for (const entry of entries) {
      if (entry.entryName.includes('/')) {
        rootPrefix = entry.entryName.split('/')[0] + '/';
        break;
      }
    }
    console.log(`📁 Root prefix: ${rootPrefix}`);
    
    const fileTree = {};
    const fileContents = {};
    let totalSize = 0;
    
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      let originalPath = entry.entryName;
      if (originalPath.startsWith(rootPrefix)) {
        originalPath = originalPath.substring(rootPrefix.length);
      }
      const size = entry.header.size;
      fileTree[originalPath] = size;
      totalSize += size;
      try {
        fileContents[originalPath] = entry.getData().toString('utf-8');
      } catch (err) {
        fileContents[originalPath] = `[Binary file - ${size} bytes]`;
      }
    }
    
    addToCache(owner, repo, actualBranch, repoId, fileTree, totalSize, fileContents);
    
    const filteredTree = {};
    let filteredSize = 0;
    for (const [filePath, size] of Object.entries(fileTree)) {
      const shouldIgnore = ignorePatterns.some(pattern => 
        filePath.toLowerCase().includes(pattern.toLowerCase())
      );
      if (!shouldIgnore) {
        filteredTree[filePath] = size;
        filteredSize += size;
      }
    }
    
    console.log(`✅ Analysis complete: ${Object.keys(filteredTree).length} files (${(filteredSize / 1024).toFixed(1)} KB)`);
    res.json({
      success: true,
      fromCache: false,
      repoId: repoId,
      fileTree: filteredTree,
      totalSize: filteredSize,
      totalFiles: Object.keys(filteredTree).length,
      totalSizeKB: (filteredSize / 1024).toFixed(1)
    });
  } catch (error) {
    console.error(`❌ Analysis error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== STEP 2: Generate Compressed Archive (7z or ZIP) and Send Text Preview ==========
app.post('/api/generate', async (req, res) => {
  const { 
    owner, repo, branch = 'main', selectedPaths, repoId,
    includeDirStructure = true, showLineNumbers = false,
    removeComments = false, removeEmptyLines = false,
    chunkIndex = 0, sessionId = null
  } = req.body;
  
  if (!owner || !repo || !selectedPaths || !selectedPaths.length) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  
  const cached = getFromCache(owner, repo, branch);
  if (!cached || cached.repoId !== repoId) {
    return res.status(404).json({ 
      success: false, 
      error: 'Repository not in cache. Please run /api/analyze again.' 
    });
  }
  
  // Prepare selected files and generate text content
  const selectedFiles = {};
  for (const filePath of selectedPaths) {
    selectedFiles[filePath] = cached.fileContents[filePath] || `[File not found: ${filePath}]`;
  }
  
  const textContent = generateTextFileContent(
    selectedFiles,
    includeDirStructure,
    showLineNumbers,
    removeComments,
    removeEmptyLines
  );
  
  const currentSessionId = sessionId || `${owner}_${repo}_${repoId}_${crypto.randomBytes(4).toString('hex')}`;
  const tempFilePath = path.join(TEMP_DIR, `${currentSessionId}.7z`);
  const chunkSize = 2 * 1024 * 1024; // 2MB chunks
  
  // First chunk - generate archive and send first chunk
  if (chunkIndex === 0) {
    console.log(`📦 Generating archive for ${selectedPaths.length} files...`);
    const archiveData = await generate7zContent(textContent, currentSessionId);
    fs.writeFileSync(tempFilePath, archiveData);
    
    const totalSize = archiveData.length;
    const totalChunks = Math.ceil(totalSize / chunkSize);
    const firstChunk = archiveData.slice(0, chunkSize);
    
    console.log(`📊 Archive size: ${(totalSize / 1024 / 1024).toFixed(2)} MB, ${totalChunks} chunks`);
    
    // Also send the text preview in the same response
    res.json({
      success: true,
      textPreview: textContent,  // Send text preview for display
      archiveData: firstChunk.toString('base64'),  // Send first chunk as base64
      archiveFormat: has7z ? '7z' : 'zip',
      totalChunks: totalChunks,
      totalSize: totalSize,
      chunkIndex: 0,
      sessionId: currentSessionId,
      hasMoreChunks: totalChunks > 1
    });
    return;
  }
  
  // Subsequent chunks
  if (!fs.existsSync(tempFilePath)) {
    return res.status(400).json({ success: false, error: 'Session expired' });
  }
  
  const stats = fs.statSync(tempFilePath);
  const totalSize = stats.size;
  const totalChunks = Math.ceil(totalSize / chunkSize);
  const start = chunkIndex * chunkSize;
  
  if (start >= totalSize) {
    fs.unlinkSync(tempFilePath);
    return res.json({ success: true, complete: true });
  }
  
  const end = Math.min(start + chunkSize, totalSize);
  const buffer = Buffer.alloc(end - start);
  const fd = fs.openSync(tempFilePath, 'r');
  fs.readSync(fd, buffer, 0, buffer.length, start);
  fs.closeSync(fd);
  
  const isLastChunk = (end >= totalSize);
  if (isLastChunk) {
    fs.unlinkSync(tempFilePath);
  }
  
  res.json({
    success: true,
    archiveData: buffer.toString('base64'),
    chunkIndex: chunkIndex,
    totalChunks: totalChunks,
    hasMoreChunks: !isLastChunk
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const tempFiles = fs.readdirSync(TEMP_DIR).length;
  res.json({ 
    status: 'alive', 
    service: 'repomix-backend-v4',
    timestamp: new Date().toISOString(),
    compression: has7z ? '7z' : 'zip',
    tokensConfigured: TOKENS.length,
    cacheSize: repoCache.size,
    tempFiles: tempFiles
  });
});

// Cache stats endpoint
app.get('/api/cache/stats', (req, res) => {
  const stats = [];
  for (const [key, entry] of repoCache.entries()) {
    stats.push({
      key: key,
      filesCount: Object.keys(entry.fileTree).length,
      totalSizeKB: (entry.totalSize / 1024).toFixed(1),
      ageSeconds: Math.floor((Date.now() - entry.timestamp) / 1000),
      accessCount: entry.accessCount
    });
  }
  res.json({ cacheSize: repoCache.size, maxSize: MAX_CACHE_SIZE, entries: stats });
});

// Cleanup
function cleanupTempFiles() {
  console.log('🧹 Cleaning up temporary files...');
  try {
    const files = fs.readdirSync(TEMP_DIR);
    files.forEach(file => {
      try { fs.unlinkSync(path.join(TEMP_DIR, file)); } catch(e) {}
    });
    console.log(`✅ Cleaned up ${files.length} files`);
  } catch(e) {}
}

process.on('SIGTERM', () => { cleanupTempFiles(); process.exit(0); });
process.on('SIGINT', () => { cleanupTempFiles(); process.exit(0); });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Repomix Backend running on port ${PORT}`);
  console.log(`🔧 Health: http://localhost:${PORT}/health`);
  console.log(`📊 Analyze: POST /api/analyze`);
  console.log(`📦 Generate: POST /api/generate (7z compressed + text preview)`);
  console.log(`💾 Cache: ${MAX_CACHE_SIZE} repos (LRU)`);
  console.log(`📁 Temp: ${TEMP_DIR}`);
  console.log(`🔑 Tokens: ${TOKENS.length}\n`);
});
