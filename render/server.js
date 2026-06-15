const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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

// Clean up old files every hour safely
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

// ========== HELPER: Generate Text File Content ==========
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

// ========== FIXED: Proper HTML comment removal ==========
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

// ========== HELPER: Generate ZIP Content ==========
async function generateZipContent(files, options) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    archive.on('data', chunk => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    
    // Generate the combined text content
    let content = '';
    content += '#'.repeat(80) + '\n';
    content += `REPOMIX EXPORT\n`;
    content += `Generated: ${new Date().toLocaleString()}\n`;
    content += `Total files: ${Object.keys(files).length}\n`;
    content += `Total size: ${(Object.values(files).reduce((sum, c) => sum + (c ? c.length : 0), 0) / 1024).toFixed(1)} KB\n`;
    content += '#'.repeat(80) + '\n\n';
    
    if (options.includeDirStructure) {
      const paths = Object.keys(files);
      content += "DIRECTORY STRUCTURE\n";
      content += "-".repeat(80) + "\n";
      content += buildAsciiTree(paths) + "\n\n";
      content += "#".repeat(80) + "\n\n";
    }
    
    for (const [filePath, fileContent] of Object.entries(files)) {
      let processedContent = fileContent || "";
      if (options.removeComments) {
        processedContent = removeCommentsFromCode(processedContent, filePath);
      }
      if (options.removeEmptyLines) {
        processedContent = processedContent.split("\n").filter(l => l.trim().length > 0).join("\n");
      }
      if (options.showLineNumbers) {
        const lines = processedContent.split("\n");
        const maxLineNum = Math.max(lines.length, 1).toString().length;
        processedContent = lines.map((line, idx) => {
          const lineNum = (idx + 1).toString().padStart(maxLineNum, " ");
          return `${lineNum} | ${line}`;
        }).join("\n");
      }
      
      content += `\n${"#".repeat(80)}\n`;
      content += `File: ${filePath}\n`;
      content += `${"#".repeat(80)}\n\n`;
      content += processedContent + "\n";
    }
    
    content += "\n" + "#".repeat(80) + "\n";
    content += "END OF CODEBASE\n";
    content += "#".repeat(80) + "\n";
    
    archive.append(content, { name: `repomix_export.txt` });
    archive.finalize();
  });
}

// ========== HELPER: Stream ZIP in Chunks ==========
async function streamZipInChunks(res, files, options, sessionId, chunkIndex, chunkSize = 2 * 1024 * 1024) {
  const tempFilePath = path.join(TEMP_DIR, `${sessionId}.zip`);
  
  if (chunkIndex === 0) {
    const zipBuffer = await generateZipContent(files, options);
    fs.writeFileSync(tempFilePath, zipBuffer);
    console.log(`📦 Created ZIP: ${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  }
  
  if (!fs.existsSync(tempFilePath)) {
    return res.status(400).json({ success: false, error: 'Session expired. Start from chunk 0.' });
  }
  
  const stats = fs.statSync(tempFilePath);
  const totalSize = stats.size;
  const totalChunks = Math.ceil(totalSize / chunkSize);
  const start = chunkIndex * chunkSize;
  
  if (start >= totalSize) {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    return res.json({ success: true, complete: true, chunkIndex, totalChunks, totalSize });
  }
  
  const end = Math.min(start + chunkSize, totalSize);
  const bufferLength = end - start;
  const buffer = Buffer.alloc(bufferLength);
  const fd = fs.openSync(tempFilePath, 'r');
  fs.readSync(fd, buffer, 0, bufferLength, start);
  fs.closeSync(fd);
  
  const isLastChunk = (end >= totalSize);
  if (isLastChunk) {
    fs.unlinkSync(tempFilePath);
    console.log(`🗑️ Deleted: ${path.basename(tempFilePath)}`);
  }
  
  // Convert buffer to base64 for JSON transport
  const contentBase64 = buffer.toString('base64');
  
  res.json({
    success: true,
    complete: isLastChunk,
    chunkIndex: chunkIndex,
    nextChunkIndex: chunkIndex + 1,
    totalChunks: totalChunks,
    totalSize: totalSize,
    chunkSize: bufferLength,
    content: contentBase64,
    isBase64: true,
    sessionId: sessionId
  });
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

// ========== STEP 2: Generate ZIP with Hybrid Approach ==========
app.post('/api/generate-zip', async (req, res) => {
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
  
  // Prepare selected files
  const selectedFiles = {};
  for (const filePath of selectedPaths) {
    selectedFiles[filePath] = cached.fileContents[filePath] || `[File not found: ${filePath}]`;
  }
  
  const options = { includeDirStructure, showLineNumbers, removeComments, removeEmptyLines };
  const currentSessionId = sessionId || `${owner}_${repo}_${repoId}_${crypto.randomBytes(4).toString('hex')}`;
  
  // For first chunk, calculate size and decide delivery method
  if (chunkIndex === 0) {
    // Generate ZIP to check size
    const zipBuffer = await generateZipContent(selectedFiles, options);
    const zipSizeMB = zipBuffer.length / (1024 * 1024);
    
    console.log(`📊 ZIP Size: ${zipSizeMB.toFixed(2)} MB`);
    
    // If ZIP is less than 2MB, send directly
    if (zipBuffer.length < 2 * 1024 * 1024) {
      console.log(`✅ Direct ZIP download (${zipSizeMB.toFixed(2)} MB < 2MB threshold)`);
      const filename = `repomix_${owner}_${repo}_${Date.now()}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', zipBuffer.length);
      return res.send(zipBuffer);
    }
    
    // Otherwise, start chunked session
    console.log(`📦 Starting chunked ZIP session (${zipSizeMB.toFixed(2)} MB > 2MB threshold)`);
    const tempFilePath = path.join(TEMP_DIR, `${currentSessionId}.zip`);
    fs.writeFileSync(tempFilePath, zipBuffer);
    
    // Return first chunk
    const chunkSize = 2 * 1024 * 1024; // 2MB chunks
    const totalChunks = Math.ceil(zipBuffer.length / chunkSize);
    const firstChunk = zipBuffer.slice(0, chunkSize);
    
    return res.json({
      success: true,
      complete: false,
      chunkIndex: 0,
      nextChunkIndex: 1,
      totalChunks: totalChunks,
      totalSize: zipBuffer.length,
      chunkSize: firstChunk.length,
      content: firstChunk.toString('base64'),
      isBase64: true,
      sessionId: currentSessionId,
      isChunked: true
    });
  }
  
  // Handle subsequent chunks
  const tempFilePath = path.join(TEMP_DIR, `${currentSessionId}.zip`);
  if (!fs.existsSync(tempFilePath)) {
    return res.status(400).json({ success: false, error: 'Session expired. Start from chunk 0.' });
  }
  
  const stats = fs.statSync(tempFilePath);
  const totalSize = stats.size;
  const chunkSize = 2 * 1024 * 1024;
  const totalChunks = Math.ceil(totalSize / chunkSize);
  const start = chunkIndex * chunkSize;
  
  if (start >= totalSize) {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    return res.json({ success: true, complete: true, chunkIndex, totalChunks, totalSize });
  }
  
  const end = Math.min(start + chunkSize, totalSize);
  const bufferLength = end - start;
  const buffer = Buffer.alloc(bufferLength);
  const fd = fs.openSync(tempFilePath, 'r');
  fs.readSync(fd, buffer, 0, bufferLength, start);
  fs.closeSync(fd);
  
  const isLastChunk = (end >= totalSize);
  if (isLastChunk) {
    fs.unlinkSync(tempFilePath);
    console.log(`🗑️ Deleted: ${path.basename(tempFilePath)}`);
  }
  
  res.json({
    success: true,
    complete: isLastChunk,
    chunkIndex: chunkIndex,
    nextChunkIndex: chunkIndex + 1,
    totalChunks: totalChunks,
    totalSize: totalSize,
    chunkSize: bufferLength,
    content: buffer.toString('base64'),
    isBase64: true,
    sessionId: currentSessionId,
    isChunked: true
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  const tempFiles = fs.readdirSync(TEMP_DIR).length;
  res.json({ 
    status: 'alive', 
    service: 'repomix-backend-v3',
    timestamp: new Date().toISOString(),
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

// ========== GRACEFUL SHUTDOWN CLEANUP ==========
function cleanupTempFiles() {
  console.log('🧹 Cleaning up temporary files...');
  try {
    const files = fs.readdirSync(TEMP_DIR);
    let deletedCount = 0;
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      try {
        fs.unlinkSync(filePath);
        deletedCount++;
      } catch (err) {
        console.error(`Failed to delete ${file}:`, err.message);
      }
    });
    console.log(`✅ Deleted ${deletedCount} temporary file(s)`);
  } catch (err) {
    console.error('Cleanup error:', err.message);
  }
}

process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM received. Cleaning up...');
  cleanupTempFiles();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 SIGINT received. Cleaning up...');
  cleanupTempFiles();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception:', err);
  cleanupTempFiles();
  process.exit(1);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Repomix Backend running on port ${PORT}`);
  console.log(`🔧 Health: http://localhost:${PORT}/health`);
  console.log(`📊 Analyze: POST /api/analyze`);
  console.log(`📦 Generate ZIP: POST /api/generate-zip (hybrid: direct if <2MB, else chunked)`);
  console.log(`💾 Cache: ${MAX_CACHE_SIZE} repos (LRU)`);
  console.log(`📁 Temp: ${TEMP_DIR}`);
  console.log(`🔑 Tokens: ${TOKENS.length}\n`);
});
