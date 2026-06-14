const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const AdmZip = require('adm-zip');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));

// Parse tokens from environment variable (comma-separated, no spaces)
// Example: TOKENS=ghp_token1,ghp_token2,ghp_token3
const TOKENS = process.env.GITHUB_TOKENS 
  ? process.env.GITHUB_TOKENS.split(',').filter(t => t.trim())
  : [];

let currentTokenIndex = 0;

// Round-robin token selection
function getNextToken() {
  if (TOKENS.length === 0) return null;
  const token = TOKENS[currentTokenIndex];
  currentTokenIndex = (currentTokenIndex + 1) % TOKENS.length;
  return token;
}

// Health check endpoint (for cron-job.org to keep service alive)
app.get('/health', (req, res) => {
  res.json({ 
    status: 'alive', 
    service: 'repomix-backend',
    timestamp: new Date().toISOString(),
    tokensConfigured: TOKENS.length
  });
});

// Main fetch endpoint
app.post('/api/fetch-repo', async (req, res) => {
  const { owner, repo, branch = 'main', selectedPaths } = req.body;
  
  if (!owner || !repo || !selectedPaths || !selectedPaths.length) {
    return res.status(400).json({ 
      success: false, 
      error: 'Missing required fields: owner, repo, selectedPaths' 
    });
  }
  
  console.log(`\n📦 Fetching ${selectedPaths.length} files from ${owner}/${repo}:${branch}`);
  console.log(`📋 Selected files: ${selectedPaths.slice(0, 5).join(', ')}${selectedPaths.length > 5 ? '...' : ''}`);
  
  const startTime = Date.now();
  
  try {
    // Get a GitHub token (round-robin)
    const token = getNextToken();
    const headers = {
      'User-Agent': 'Repomix-Render-Backend',
      'Accept': 'application/vnd.github+json'
    };
    
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
      console.log(`🔑 Using token: ${token.substring(0, 8)}... (${TOKENS.indexOf(token) + 1}/${TOKENS.length})`);
    } else {
      console.log('⚠️ No tokens configured, using unauthenticated requests (rate limits apply)');
    }
    
    // Download repository as ZIP
    const zipUrl = `https://api.github.com/repos/${owner}/${repo}/zipball/${branch}`;
    console.log(`⬇️ Downloading from: ${zipUrl}`);
    
    const zipResponse = await fetch(zipUrl, {
      headers: headers,
      redirect: 'follow'
    });
    
    if (!zipResponse.ok) {
      throw new Error(`GitHub API error: ${zipResponse.status} ${zipResponse.statusText}`);
    }
    
    const zipBuffer = await zipResponse.buffer();
    console.log(`✅ Downloaded ${(zipBuffer.length / 1024 / 1024).toFixed(2)} MB`);
    
    // Extract files from ZIP
    console.log('📂 Extracting files from ZIP...');
    const zip = new AdmZip(zipBuffer);
    const entries = zip.getEntries();
    
    // Find the root folder (GitHub adds a prefix like "repo-name-hash/")
    let rootPrefix = '';
    for (const entry of entries) {
      if (entry.entryName.includes('/')) {
        rootPrefix = entry.entryName.split('/')[0] + '/';
        break;
      }
    }
    console.log(`📁 Root prefix: ${rootPrefix}`);
    
    // Extract only selected files
    const files = {};
    let foundCount = 0;
    let notFoundCount = 0;
    
    for (const path of selectedPaths) {
      const fullPath = rootPrefix + path;
      const entry = zip.getEntry(fullPath);
      
      if (entry && !entry.isDirectory) {
        try {
          const content = entry.getData().toString('utf-8');
          files[path] = content;
          foundCount++;
        } catch (err) {
          // Binary file or decode error
          files[path] = `[Binary file - ${entry.header.size} bytes]`;
          foundCount++;
        }
      } else {
        notFoundCount++;
        files[path] = `[File not found: ${path}]`;
      }
    }
    
    const totalSize = Object.values(files).reduce((sum, content) => sum + content.length, 0);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    
    console.log(`✅ Extracted ${foundCount}/${selectedPaths.length} files (${notFoundCount} not found)`);
    console.log(`📊 Total size: ${(totalSize / 1024).toFixed(1)} KB`);
    console.log(`⏱️ Completed in ${elapsed} seconds`);
    
    res.json({
      success: true,
      files: files,
      stats: {
        count: foundCount,
        totalSize: totalSize,
        totalSizeKB: (totalSize / 1024).toFixed(1),
        timeSeconds: elapsed,
        notFound: notFoundCount
      }
    });
    
  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'Repomix Backend',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      fetchRepo: 'POST /api/fetch-repo'
    },
    configuration: {
      tokensConfigured: TOKENS.length,
      tokenStrategy: 'Round-robin'
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Repomix Backend running on port ${PORT}`);
  console.log(`🔧 Health check: http://localhost:${PORT}/health`);
  console.log(`📦 API endpoint: http://localhost:${PORT}/api/fetch-repo`);
  console.log(`🔑 Tokens configured: ${TOKENS.length}\n`);
});
