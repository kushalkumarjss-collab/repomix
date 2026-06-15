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

// ========== AUTHENTICATION ==========
const SECRET_KEY = process.env.SECRET_KEY || "RepomixSecureKey2026!";

// ========== SESSION MANAGEMENT ==========
const MAX_SESSIONS = 3;
const sessions = new Map(); // sessionId -> { createdAt, lastAccessed, tempDir }

function createSession(sessionId) {
  // If max sessions reached, remove the least recent session (by lastAccessed)
  if (sessions.size >= MAX_SESSIONS) {
    let oldestSessionId = null;
    let oldestTime = Infinity;
    for (const [id, session] of sessions.entries()) {
      if (session.lastAccessed < oldestTime) {
        oldestTime = session.lastAccessed;
        oldestSessionId = id;
      }
    }
    if (oldestSessionId) {
      const oldSession = sessions.get(oldestSessionId);
      console.log(`🗑️ Removing least recent session: ${oldestSessionId} (last accessed: ${new Date(oldSession.lastAccessed).toISOString()})`);
      // Delete entire session folder
      if (fs.existsSync(oldSession.tempDir)) {
        fs.rmSync(oldSession.tempDir, { recursive: true, force: true });
        console.log(`📁 Deleted folder: ${oldSession.tempDir}`);
      }
      sessions.delete(oldestSessionId);
    }
  }
  
  // Create new session
  const tempDir = path.join(__dirname, 'temp', sessionId);
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  const session = {
    createdAt: Date.now(),
    lastAccessed: Date.now(),
    tempDir: tempDir
  };
  sessions.set(sessionId, session);
  console.log(`✅ Created session: ${sessionId}`);
  console.log(`📊 Active sessions: ${sessions.size}/${MAX_SESSIONS}`);
  return session;
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (session) {
    session.lastAccessed = Date.now();
    console.log(`🔄 Session accessed: ${sessionId}`);
    return session;
  }
  return null;
}

// Cleanup old sessions (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  const oneHourAgo = now - (60 * 60 * 1000);
  const toDelete = [];
  for (const [sessionId, session] of sessions.entries()) {
    if (session.createdAt < oneHourAgo) {
      toDelete.push(sessionId);
    }
  }
  for (const sessionId of toDelete) {
    const session = sessions.get(sessionId);
    console.log(`🗑️ Cleaning up old session: ${sessionId} (created ${new Date(session.createdAt).toISOString()})`);
    if (fs.existsSync(session.tempDir)) {
      fs.rmSync(session.tempDir, { recursive: true, force: true });
      console.log(`📁 Deleted folder: ${session.tempDir}`);
    }
    sessions.delete(sessionId);
  }
  if (toDelete.length > 0) {
    console.log(`📊 Active sessions after cleanup: ${sessions.size}/${MAX_SESSIONS}`);
  }
}, 60 * 60 * 1000); // Check every hour

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Auth middleware
function authenticate(req, res, next) {
  const authKey = req.headers['x-auth-key'];
  if (!authKey || authKey !== SECRET_KEY) {
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized. Invalid or missing X-Auth-Key header' 
    });
  }
  next();
}

// ========== TEMP DIRECTORY (Legacy - will be replaced by session dirs) ==========
const LEGACY_TEMP_DIR = path.join(__dirname, 'temp_legacy');
if (!fs.existsSync(LEGACY_TEMP_DIR)) {
  fs.mkdirSync(LEGACY_TEMP_DIR, { recursive: true });
}

// ========== CHECK 7z ==========
let has7z = false;
async function check7z() {
  try {
    await execPromise('7z --help');
    has7z = true;
    console.log('✅ 7z compression available (best for text files)');
  } catch {
    has7z = false;
    console.log('⚠️ 7z not found, using fallback compression');
  }
}
check7z();

// ========== GITHUB TOKENS ==========
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

// ========== CACHE ==========
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
  if (repoCache.has(key)) repoCache.delete(key);
  if (repoCache.size >= MAX_CACHE_SIZE) {
    let oldestKey = null;
    let oldestTime = Infinity;
    for (const [cacheKey, entry] of repoCache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = cacheKey;
      }
    }
    if (oldestKey) repoCache.delete(oldestKey);
  }
  const entry = new RepoCacheEntry(owner, repo, branch, repoId, fileTree, totalSize, fileContents);
  repoCache.set(key, entry);
  console.log(`✅ Cached: ${key}`);
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

// ========== BINARY DETECTION ==========
function isBinaryContent(content) {
  if (!content) return true;
  if (content.indexOf("\0") !== -1) return true;
  const binaryPattern = /[\x00-\x08\x0E-\x1F\x7F-\x9F]/;
  if (binaryPattern.test(content.substring(0, 1000))) return true;
  return false;
}

// ========== IMPROVED SHOULD IGNORE FUNCTION ==========
function shouldIgnore(filePath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  
  const normalizedPath = filePath.replace(/\\/g, '/').toLowerCase();
  
  for (let pattern of patterns) {
    let normalizedPattern = pattern.toLowerCase().replace(/\\/g, '/');
    
    // Check if it's a folder pattern (original pattern ends with /)
    const originalPattern = pattern;
    let isFolderPattern = originalPattern.endsWith('/');
    
    // Remove trailing slash if present for matching
    if (normalizedPattern.endsWith('/')) {
      normalizedPattern = normalizedPattern.slice(0, -1);
      isFolderPattern = true;
    }
    
    // Handle wildcard patterns
    if (normalizedPattern.includes('*')) {
      const regexPattern = '^' + normalizedPattern.replace(/\*/g, '.*') + '$';
      const regex = new RegExp(regexPattern);
      const fileName = normalizedPath.split('/').pop();
      if (regex.test(fileName)) {
        console.log(`  Ignored (wildcard): ${filePath} matches ${pattern}`);
        return true;
      }
    }
    
    // Check for exact folder match (with or without trailing slash)
    if (isFolderPattern) {
      // Check if any path part matches this folder name exactly
      const pathParts = normalizedPath.split('/');
      for (const part of pathParts) {
        if (part === normalizedPattern) {
          console.log(`  Ignored (folder match): ${filePath} matches ${pattern}`);
          return true;
        }
      }
      // Also check if path starts with this folder (for nested folders)
      if (normalizedPath.startsWith(normalizedPattern + '/')) {
        console.log(`  Ignored (folder prefix): ${filePath} matches ${pattern}`);
        return true;
      }
    } else {
      // Check for exact file match
      const fileName = normalizedPath.split('/').pop();
      if (fileName === normalizedPattern) {
        console.log(`  Ignored (file match): ${filePath} matches ${pattern}`);
        return true;
      }
      // Check if any folder matches (for patterns without trailing slash)
      const pathParts = normalizedPath.split('/');
      for (const part of pathParts) {
        if (part === normalizedPattern) {
          console.log(`  Ignored (folder name match): ${filePath} matches ${pattern}`);
          return true;
        }
      }
    }
  }
  return false;
}

// ========== ENHANCED COMMENT REMOVAL ==========
function removeCommentsFromCode(code, filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase();
  
  // JavaScript/TypeScript
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) {
    return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // Python
  if (ext === "py") {
    return code
      .replace(/#.*$/gm, "")
      .replace(/'''[\s\S]*?'''/g, "")
      .replace(/"""[\s\S]*?"""/g, "");
  }
  // HTML/XML
  if (["html", "xml", "svg"].includes(ext)) {
    return code.replace(/<!--[\s\S]*?-->/g, "");
  }
  // CSS/SCSS/SASS
  if (["css", "scss", "sass", "less"].includes(ext)) {
    return code.replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // JSON
  if (ext === "json") {
    return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // C/C++
  if (["c", "cpp", "h", "hpp", "cc", "cxx"].includes(ext)) {
    return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // Java
  if (ext === "java") {
    return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // Go
  if (ext === "go") {
    return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // Rust
  if (ext === "rs") {
    return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // Ruby
  if (ext === "rb") {
    return code.replace(/#.*$/gm, "").replace(/=begin[\s\S]*?=end/g, "");
  }
  // PHP
  if (ext === "php") {
    return code.replace(/\/\/.*$/gm, "").replace(/#.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // SQL
  if (ext === "sql") {
    return code.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // C#
  if (ext === "cs") {
    return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // Swift
  if (ext === "swift") {
    return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // Kotlin
  if (ext === "kt" || ext === "kts") {
    return code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  }
  // Shell scripts
  if (["sh", "bash", "zsh", "fish"].includes(ext)) {
    return code.replace(/#.*$/gm, "");
  }
  // Lua
  if (ext === "lua") {
    return code.replace(/--.*$/gm, "").replace(/--\[\[[\s\S]*?\]\]/g, "");
  }
  // Perl
  if (ext === "pl" || ext === "pm") {
    return code.replace(/#.*$/gm, "");
  }
  
  return code;
}

// ========== ENHANCED ASCII TREE BUILDER ==========
function buildAsciiTree(paths, showSizes = false, sizeMap = new Map()) {
  if (!paths.length) return "(empty)";
  
  const root = {};
  for (const p of paths) {
    const parts = p.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === parts.length - 1) {
        if (!node._files) node._files = [];
        node._files.push({ name: part, size: sizeMap.get(p) || 0 });
      } else {
        if (!node[part]) node[part] = {};
        node = node[part];
      }
    }
  }
  
  function formatSize(bytes) {
    if (bytes === 0) return "";
    if (bytes < 1024) return ` (${bytes} B)`;
    if (bytes < 1024 * 1024) return ` (${(bytes / 1024).toFixed(1)} KB)`;
    return ` (${(bytes / (1024 * 1024)).toFixed(1)} MB)`;
  }
  
  function renderNode(node, prefix = "") {
    let lines = [];
    const dirs = Object.keys(node).filter(k => k !== "_files").sort();
    const files = node._files ? [...node._files].sort((a, b) => a.name.localeCompare(b.name)) : [];
    const items = [
      ...dirs.map(d => ({ type: "dir", name: d, size: 0 })),
      ...files.map(f => ({ type: "file", name: f.name, size: f.size }))
    ];
    
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isLast = i === items.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const sizeDisplay = showSizes && item.size > 0 ? formatSize(item.size) : "";
      lines.push(`${prefix}${connector}${item.name}${item.type === "dir" ? "/" : ""}${sizeDisplay}`);
      if (item.type === "dir") {
        const childPrefix = prefix + (isLast ? "    " : "│   ");
        const childLines = renderNode(node[item.name], childPrefix);
        if (childLines) lines.push(childLines);
      }
    }
    return lines.join("\n");
  }
  
  const rootDirs = Object.keys(root).filter(k => k !== "_files").sort();
  const rootFiles = root._files ? [...root._files].sort((a, b) => a.name.localeCompare(b.name)) : [];
  const rootItems = [
    ...rootDirs.map(d => ({ type: "dir", name: d })),
    ...rootFiles.map(f => ({ type: "file", name: f.name }))
  ];
  
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

// ========== TEXT CONTENT GENERATION ==========
function generateTextContent(files, includeDirStructure, showLineNumbers, removeCommentsFlag, removeEmptyLines, sizeMap = new Map()) {
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
    output += buildAsciiTree(paths, true, sizeMap) + "\n\n";
    output += "#".repeat(80) + "\n\n";
  }
  
  for (const [filePath, content] of Object.entries(files)) {
    output += `\n${"#".repeat(80)}\n`;
    output += `File: ${filePath}\n`;
    output += `${"#".repeat(80)}\n\n`;
    
    let processedContent = content || "";
    if (removeCommentsFlag) {
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

// ========== COMPRESSION ==========
async function generateCompressedArchive(textContent, sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error('Session not found');
  }
  
  const tempTextFile = path.join(session.tempDir, `content.txt`);
  const tempArchiveFile = path.join(session.tempDir, `archive.7z`);
  
  fs.writeFileSync(tempTextFile, textContent, 'utf-8');
  
  if (has7z) {
    await execPromise(`7z a -t7z -mx=9 -mfb=273 -ms=on "${tempArchiveFile}" "${tempTextFile}"`);
    const data = fs.readFileSync(tempArchiveFile);
    fs.unlinkSync(tempTextFile);
    if (fs.existsSync(tempArchiveFile)) fs.unlinkSync(tempArchiveFile);
    return data;
  } else {
    const zlib = require('zlib');
    const compressed = zlib.gzipSync(textContent);
    fs.unlinkSync(tempTextFile);
    return compressed;
  }
}

// ========== ZIP GENERATION ==========
async function generateZipArchive(files, options, sizeMap = new Map(), sessionId) {
  return new Promise((resolve, reject) => {
    const archiver = require('archiver');
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    archive.on('data', chunk => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);
    
    if (options.includeDirStructure) {
      const filePaths = Object.keys(files);
      const structure = buildAsciiTree(filePaths, true, sizeMap);
      const structureContent = `Directory Structure:\n${'-'.repeat(80)}\n${structure}`;
      archive.append(structureContent, { name: '_directory_structure.txt' });
    }
    
    for (const [filePath, content] of Object.entries(files)) {
      let processedContent = content || "";
      if (options.removeComments) {
        processedContent = removeCommentsFromCode(processedContent, filePath);
      }
      if (options.removeEmptyLines) {
        processedContent = processedContent.split("\n").filter(l => l.trim().length > 0).join("\n");
      }
      archive.append(processedContent, { name: filePath });
    }
    
    archive.finalize();
  });
}

// ========== TEST ENDPOINT ==========
app.get('/test', authenticate, async (req, res) => {
  try {
    const token = getNextToken();
    const results = [];
    
    // Test unauthenticated rate limit
    try {
      const freeResponse = await fetch("https://api.github.com/rate_limit", {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "User-Agent": "Repomix-Backend"
        }
      });
      if (freeResponse.ok) {
        const data = await freeResponse.json();
        results.push({ 
          type: "FREE", 
          remaining: data.resources.core.remaining,
          limit: data.resources.core.limit
        });
      } else {
        results.push({ type: "FREE", remaining: 0, error: `HTTP ${freeResponse.status}` });
      }
    } catch (err) {
      results.push({ type: "FREE", remaining: 0, error: err.message });
    }
    
    // Test each token
    for (let i = 0; i < TOKENS.length; i++) {
      const token = TOKENS[i];
      const maskedToken = token.slice(0, 8) + "...." + token.slice(-4);
      try {
        const response = await fetch("https://api.github.com/rate_limit", {
          headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "Repomix-Backend"
          }
        });
        if (!response.ok) {
          results.push({ 
            token: maskedToken, 
            status: "❌ Invalid/Revoked", 
            remaining: 0,
            limit: 0
          });
          continue;
        }
        const data = await response.json();
        results.push({
          token: maskedToken,
          status: data.resources.core.remaining > 0 ? "✅ Working" : "⚠️ Rate Limited",
          remaining: data.resources.core.remaining,
          limit: data.resources.core.limit,
          used: data.resources.core.used
        });
      } catch (err) {
        results.push({ token: maskedToken, status: "❌ Error", remaining: 0, error: err.message });
      }
    }
    
    const sessionInfo = {
      activeSessions: sessions.size,
      maxSessions: MAX_SESSIONS,
      sessions: Array.from(sessions.entries()).map(([id, session]) => ({
        id: id,
        createdAt: new Date(session.createdAt).toISOString(),
        lastAccessed: new Date(session.lastAccessed).toISOString(),
        ageMinutes: ((Date.now() - session.createdAt) / 60000).toFixed(1)
      }))
    };
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      tokens: results,
      anonymousFree: results.find(r => r.type === "FREE")?.remaining || 0,
      sessions: sessionInfo,
      cacheSize: repoCache.size,
      compression: has7z ? "7z" : "fallback"
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== ANALYZE ENDPOINT (with ignore patterns) ==========
app.post('/api/analyze', authenticate, async (req, res) => {
  const { owner, repo, branch = 'main', ignorePatterns = [], sessionId } = req.body;
  
  if (!owner || !repo) {
    return res.status(400).json({ success: false, error: 'Missing owner or repo' });
  }
  
  // Create or get session
  let currentSessionId = sessionId;
  if (!currentSessionId) {
    currentSessionId = crypto.randomBytes(16).toString('hex');
    createSession(currentSessionId);
  } else {
    const session = getSession(currentSessionId);
    if (!session) {
      // Session expired or doesn't exist, create new one
      currentSessionId = crypto.randomBytes(16).toString('hex');
      createSession(currentSessionId);
    }
  }
  
  console.log(`\n📊 Analyzing: ${owner}/${repo} (Session: ${currentSessionId})`);
  console.log(`🚫 Ignore patterns: ${ignorePatterns.length ? ignorePatterns.join(', ') : 'none'}`);
  
  try {
    const cached = getFromCache(owner, repo, branch);
    
    if (cached) {
      const filteredTree = {};
      let totalSize = 0;
      let filteredCount = 0;
      
      console.log(`💾 Cache hit, filtering ${Object.keys(cached.fileTree).length} files...`);
      
      for (const [filePath, size] of Object.entries(cached.fileTree)) {
        const isBinary = isBinaryContent(cached.fileContents[filePath] || "");
        const shouldIgnoreFile = shouldIgnore(filePath, ignorePatterns);
        
        if (!shouldIgnoreFile && !isBinary) {
          filteredTree[filePath] = size;
          totalSize += size;
          filteredCount++;
        } else if (shouldIgnoreFile) {
          console.log(`  Filtered out (ignore rule): ${filePath}`);
        } else if (isBinary) {
          console.log(`  Filtered out (binary): ${filePath}`);
        }
      }
      
      console.log(`✅ Filtered ${filteredCount} files from cache (total size: ${(totalSize / 1024).toFixed(1)} KB)`);
      
      return res.json({
        success: true,
        fromCache: true,
        repoId: cached.repoId,
        fileTree: filteredTree,
        totalSize: totalSize,
        totalFiles: filteredCount,
        totalSizeKB: (totalSize / 1024).toFixed(1),
        sessionId: currentSessionId
      });
    }
    
    const token = getNextToken();
    const headers = {
      'User-Agent': 'Repomix-Render-Backend',
      'Accept': 'application/vnd.github+json'
    };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    
    const repoInfoUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const repoInfoResponse = await fetch(repoInfoUrl, { headers });
    if (!repoInfoResponse.ok) throw new Error(`GitHub API error: ${repoInfoResponse.status}`);
    const repoInfo = await repoInfoResponse.json();
    const repoId = repoInfo.id;
    const actualBranch = branch === 'main' ? (repoInfo.default_branch || 'main') : branch;
    
    const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${actualBranch}`;
    console.log(`⬇️ Downloading: ${zipUrl}`);
    const zipResponse = await fetch(zipUrl, { headers, redirect: 'follow' });
    if (!zipResponse.ok) throw new Error(`Download failed: ${zipResponse.status}`);
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
    
    const fileTree = {};
    const fileContents = {};
    let totalSize = 0;
    
    console.log(`📂 Processing ${entries.length} entries from ZIP...`);
    
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      
      let originalPath = entry.entryName;
      if (originalPath.startsWith(rootPrefix)) originalPath = originalPath.substring(rootPrefix.length);
      
      const size = entry.header.size;
      fileTree[originalPath] = size;
      totalSize += size;
      
      try {
        const content = entry.getData().toString('utf-8');
        if (!isBinaryContent(content)) {
          fileContents[originalPath] = content;
        } else {
          fileContents[originalPath] = `[Binary file - ${size} bytes]`;
        }
      } catch (err) {
        fileContents[originalPath] = `[Binary file - ${size} bytes]`;
      }
    }
    
    // Filter files based on ignore patterns and binary detection
    const filteredTree = {};
    let filteredSize = 0;
    let filteredCount = 0;
    
    console.log(`🔍 Filtering ${Object.keys(fileTree).length} files with patterns:`, ignorePatterns);
    
    for (const [filePath, size] of Object.entries(fileTree)) {
      const isBinary = isBinaryContent(fileContents[filePath] || "");
      const shouldIgnoreFile = shouldIgnore(filePath, ignorePatterns);
      
      if (!shouldIgnoreFile && !isBinary) {
        filteredTree[filePath] = size;
        filteredSize += size;
        filteredCount++;
      } else if (shouldIgnoreFile) {
        console.log(`  Filtered out (ignore rule): ${filePath}`);
      } else if (isBinary) {
        console.log(`  Filtered out (binary): ${filePath}`);
      }
    }
    
    console.log(`✅ Kept ${filteredCount} files (total size: ${(filteredSize / 1024).toFixed(1)} KB)`);
    
    // Store everything in cache (including filtered content)
    addToCache(owner, repo, actualBranch, repoId, fileTree, totalSize, fileContents);
    
    res.json({
      success: true,
      fromCache: false,
      repoId: repoId,
      fileTree: filteredTree,
      totalSize: filteredSize,
      totalFiles: filteredCount,
      totalSizeKB: (filteredSize / 1024).toFixed(1),
      sessionId: currentSessionId
    });
  } catch (error) {
    console.error(`❌ Analysis error: ${error.message}`);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ========== GENERATE TEXT (with session) ==========
app.post('/api/generate-text', authenticate, async (req, res) => {
  const { 
    owner, repo, branch = 'main', selectedPaths, repoId,
    includeDirStructure = true, showLineNumbers = false,
    removeComments: removeCommentsFlag = false, removeEmptyLines = false,
    chunkIndex = 0, sessionId = null
  } = req.body;
  
  if (!owner || !repo || !selectedPaths || !selectedPaths.length) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  
  // Verify session
  let currentSessionId = sessionId;
  if (!currentSessionId) {
    currentSessionId = crypto.randomBytes(16).toString('hex');
    createSession(currentSessionId);
  } else {
    const session = getSession(currentSessionId);
    if (!session) {
      currentSessionId = crypto.randomBytes(16).toString('hex');
      createSession(currentSessionId);
    }
  }
  
  const cached = getFromCache(owner, repo, branch);
  if (!cached || cached.repoId !== repoId) {
    return res.status(404).json({ 
      success: false, 
      error: 'Repository not in cache. Please run /api/analyze again.' 
    });
  }
  
  const session = getSession(currentSessionId);
  if (!session) {
    return res.status(400).json({ success: false, error: 'Session invalid' });
  }
  
  const tempFilePath = path.join(session.tempDir, `output.7z`);
  const chunkSize = 2 * 1024 * 1024;
  
  if (chunkIndex === 0) {
    const selectedFiles = {};
    const sizeMap = new Map();
    
    for (const filePath of selectedPaths) {
      const content = cached.fileContents[filePath] || `[File not found: ${filePath}]`;
      if (!isBinaryContent(content)) {
        selectedFiles[filePath] = content;
        sizeMap.set(filePath, content.length);
      } else {
        selectedFiles[filePath] = `[Binary file skipped: ${filePath}]`;
        sizeMap.set(filePath, 0);
      }
    }
    
    const textContent = generateTextContent(selectedFiles, includeDirStructure, showLineNumbers, removeCommentsFlag, removeEmptyLines, sizeMap);
    console.log(`📦 Generating 7z archive for ${selectedPaths.length} files...`);
    const archiveData = await generateCompressedArchive(textContent, currentSessionId);
    fs.writeFileSync(tempFilePath, archiveData);
    
    const totalSize = archiveData.length;
    const totalChunks = Math.ceil(totalSize / chunkSize);
    const firstChunk = archiveData.slice(0, chunkSize);
    
    console.log(`📊 7z Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB, ${totalChunks} chunks`);
    
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Chunk-Index', '0');
    res.setHeader('X-Total-Chunks', totalChunks);
    res.setHeader('X-Total-Size', totalSize);
    res.setHeader('X-Session-Id', currentSessionId);
    res.setHeader('X-Has-More', totalChunks > 1 ? 'true' : 'false');
    res.setHeader('X-Format', '7z');
    res.send(firstChunk);
    return;
  }
  
  if (!fs.existsSync(tempFilePath)) {
    return res.status(400).json({ success: false, error: 'Session expired or file not found' });
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
  if (isLastChunk) fs.unlinkSync(tempFilePath);
  
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Chunk-Index', chunkIndex);
  res.setHeader('X-Total-Chunks', totalChunks);
  res.setHeader('X-Total-Size', totalSize);
  res.setHeader('X-Complete', isLastChunk ? 'true' : 'false');
  res.send(buffer);
});

// ========== GENERATE ZIP (with session) ==========
app.post('/api/generate-zip', authenticate, async (req, res) => {
  const { 
    owner, repo, branch = 'main', selectedPaths, repoId,
    includeDirStructure = true, showLineNumbers = false,
    removeComments: removeCommentsFlag = false, removeEmptyLines = false,
    chunkIndex = 0, sessionId = null
  } = req.body;
  
  if (!owner || !repo || !selectedPaths || !selectedPaths.length) {
    return res.status(400).json({ success: false, error: 'Missing required fields' });
  }
  
  // Verify session
  let currentSessionId = sessionId;
  if (!currentSessionId) {
    currentSessionId = crypto.randomBytes(16).toString('hex');
    createSession(currentSessionId);
  } else {
    const session = getSession(currentSessionId);
    if (!session) {
      currentSessionId = crypto.randomBytes(16).toString('hex');
      createSession(currentSessionId);
    }
  }
  
  const cached = getFromCache(owner, repo, branch);
  if (!cached || cached.repoId !== repoId) {
    return res.status(404).json({ 
      success: false, 
      error: 'Repository not in cache. Please run /api/analyze again.' 
    });
  }
  
  const session = getSession(currentSessionId);
  if (!session) {
    return res.status(400).json({ success: false, error: 'Session invalid' });
  }
  
  const tempFilePath = path.join(session.tempDir, `output.zip`);
  const chunkSize = 2 * 1024 * 1024;
  
  if (chunkIndex === 0) {
    const selectedFiles = {};
    const sizeMap = new Map();
    
    for (const filePath of selectedPaths) {
      const content = cached.fileContents[filePath] || `[File not found: ${filePath}]`;
      if (!isBinaryContent(content)) {
        selectedFiles[filePath] = content;
        sizeMap.set(filePath, content.length);
      } else {
        selectedFiles[filePath] = `[Binary file skipped: ${filePath}]`;
        sizeMap.set(filePath, 0);
      }
    }
    
    const options = { includeDirStructure, showLineNumbers, removeComments: removeCommentsFlag, removeEmptyLines };
    console.log(`📦 Generating ZIP archive for ${selectedPaths.length} files...`);
    const archiveData = await generateZipArchive(selectedFiles, options, sizeMap, currentSessionId);
    fs.writeFileSync(tempFilePath, archiveData);
    
    const totalSize = archiveData.length;
    const totalChunks = Math.ceil(totalSize / chunkSize);
    const firstChunk = archiveData.slice(0, chunkSize);
    
    console.log(`📊 ZIP Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB, ${totalChunks} chunks`);
    
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Chunk-Index', '0');
    res.setHeader('X-Total-Chunks', totalChunks);
    res.setHeader('X-Total-Size', totalSize);
    res.setHeader('X-Session-Id', currentSessionId);
    res.setHeader('X-Has-More', totalChunks > 1 ? 'true' : 'false');
    res.send(firstChunk);
    return;
  }
  
  if (!fs.existsSync(tempFilePath)) {
    return res.status(400).json({ success: false, error: 'Session expired or file not found' });
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
  if (isLastChunk) fs.unlinkSync(tempFilePath);
  
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('X-Chunk-Index', chunkIndex);
  res.setHeader('X-Total-Chunks', totalChunks);
  res.setHeader('X-Total-Size', totalSize);
  res.setHeader('X-Complete', isLastChunk ? 'true' : 'false');
  res.send(buffer);
});

// ========== HEALTH CHECK ==========
app.get('/health', (req, res) => {
  res.json({ 
    status: 'alive', 
    compression: has7z ? '7z' : 'fallback',
    cacheSize: repoCache.size,
    auth: true,
    sessions: sessions.size,
    maxSessions: MAX_SESSIONS
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Repomix Backend running on port ${PORT}`);
  console.log(`🔐 Authentication: ${SECRET_KEY ? 'ENABLED' : 'DISABLED'}`);
  console.log(`👥 Max concurrent sessions: ${MAX_SESSIONS}`);
  console.log(`🗜️ Compression: ${has7z ? '7z (best for text)' : 'Fallback mode'}`);
  console.log(`📊 Analyze: POST /api/analyze (requires X-Auth-Key header)`);
  console.log(`📄 Text Preview: POST /api/generate-text (requires X-Auth-Key header)`);
  console.log(`📦 ZIP Download: POST /api/generate-zip (requires X-Auth-Key header)`);
  console.log(`🧪 Test endpoint: GET /test (requires X-Auth-Key header)`);
});
