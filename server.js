const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// ⚙️ GITHUB CONFIGURATION
// ==========================================
const GITHUB_OWNER = "Ayush8481-dev"; 
const GITHUB_REPO = "Epgdata";        
const FILE_PREFIX = "Day";             
const FILE_SUFFIX = "Catchup.xml";     

// High-speed Native String replace for XML (Escape)
const escapeMap = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' };
const escapeXml = (unsafe) => {
    if (!unsafe) return "";
    return String(unsafe).replace(/[<>&'"]/g, c => escapeMap[c]);
};

// Ultra-Fast Native Date slicing into IST (+0530)
const formatXmltvTime = (epoch) => {
    const iso = new Date(Number(epoch) + 19800000).toISOString(); 
    return iso.substring(0,4) + iso.substring(5,7) + iso.substring(8,10) + iso.substring(11,13) + iso.substring(14,16) + iso.substring(17,19) + " +0530";
};

// ==========================================
// 🔒 SIMPLE TASK TRACKING (NO LOCK - ALLOW CONCURRENT)
// ==========================================
let activeTasks = new Map();

// ==========================================
// 🚀 API ENDPOINT
// ==========================================
app.get('/generate', async (req, res) => {
    const trigger = req.query.trigger === 'true';
    const updateMode = req.query.update === 'true';
    const offsetParam = req.query.id;

    // PRIORITY: Check update mode first
    if (updateMode) {
        // Return JSON immediately
        res.status(200).json({
            success: true,
            message: "Update rotation started!",
            mode: 'UPDATE',
            timestamp: new Date().toISOString()
        });
        
        // Run update task asynchronously
        runUpdateTask();
        return;
    }

    // Parse offset
    let offset = 0;
    if (offsetParam !== undefined && offsetParam !== null) {
        offset = parseInt(offsetParam);
        if (isNaN(offset) || offset < -9 || offset > 0) {
            return res.status(400).send('❌ Invalid offset. Must be between -9 and 0');
        }
    }

    const taskName = `GENERATE_DAY_${Math.abs(offset)}`;
    
    if (trigger) {
        res.status(200).json({ 
            success: true, 
            message: `Worker started. Generating Day ${Math.abs(offset)} Catchup.xml (Offset: ${offset})`,
            mode: 'GENERATE',
            offset: offset,
            timestamp: new Date().toISOString()
        });
        
        // Run generate task asynchronously
        runGenerateTask(offset);
    } else {
        // Run generate task synchronously
        const success = await runGenerateTask(offset);
        if (success) {
            res.send(`✅ Day ${Math.abs(offset)} Catchup.xml generated successfully!`);
        } else {
            res.status(500).send('❌ Failed to generate.');
        }
    }
});

// ==========================================
// 🛠️ GENERATE TASK - FOR SPECIFIC OFFSET
// ==========================================
async function runGenerateTask(offset) {
    const tempDir = '/tmp/epg_temp';
    const tempFile = path.join(tempDir, `Day${Math.abs(offset)}${FILE_SUFFIX}`);
    const targetFileName = `Day${Math.abs(offset)}${FILE_SUFFIX}`;
    
    try {
        // Create temp directory
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        console.log(`[GENERATE] ========================================`);
        console.log(`[GENERATE] Starting Day ${Math.abs(offset)} generation (Offset: ${offset})`);
        console.log(`[GENERATE] ========================================`);
        
        console.log(`[GENERATE] Fetching Channel List...`);
        const chReq = await fetch("https://raw.githubusercontent.com/Ayush8481Lab/Mm/refs/heads/main/AyushCatchup.json");
        const channelsData = await chReq.json();
        
        const validChannels = channelsData.filter(c => c.id);
        if (validChannels.length === 0) {
            console.log(`[GENERATE] No valid channels found.`);
            return false;
        }

        console.log(`[GENERATE] Processing ${validChannels.length} channels...`);
        
        // Process channels in batches of 200
        const BATCH_SIZE = 200;
        const channelBatches = [];
        
        for (let i = 0; i < validChannels.length; i += BATCH_SIZE) {
            channelBatches.push(validChannels.slice(i, i + BATCH_SIZE));
        }
        
        console.log(`[GENERATE] Total batches: ${channelBatches.length}`);
        
        // Store all programmes
        let allProgrammes = [];
        let totalProgrammeCount = 0;
        
        for (let batchIndex = 0; batchIndex < channelBatches.length; batchIndex++) {
            const batch = channelBatches[batchIndex];
            console.log(`[GENERATE] Processing batch ${batchIndex + 1}/${channelBatches.length} (${batch.length} channels)...`);
            
            const batchResults = await Promise.all(
                batch.map(async (channel) => {
                    try {
                        const data = await fetchChannelWithRetry(channel.id, offset);
                        
                        if (data && data.epg && data.epg.length > 0) {
                            const programmes = data.epg.map(show => {
                                const startXml = formatXmltvTime(show.startEpoch);
                                const stopXml = formatXmltvTime(show.endEpoch);
                                const titleXml = escapeXml(show.showname);
                                const descXml = show.description ? `\n    <desc>${escapeXml(show.description)}</desc>` : "";
                                const catXml = show.showCategory ? `\n    <category>${escapeXml(show.showCategory)}</category>` : "";
                                
                                return `  <programme start="${startXml}" stop="${stopXml}" channel="${channel.id}">\n    <title>${titleXml}</title>${descXml}${catXml}\n  </programme>`;
                            });
                            
                            return { channel, programmes };
                        }
                        
                        return { channel, programmes: [] };
                        
                    } catch (err) {
                        return { channel, programmes: [], error: err.message };
                    }
                })
            );
            
            for (const result of batchResults) {
                if (result.programmes && result.programmes.length > 0) {
                    allProgrammes.push(...result.programmes);
                    totalProgrammeCount += result.programmes.length;
                }
                
                if (result.error) {
                    console.error(`[GENERATE] Error: ${result.channel.name}: ${result.error}`);
                }
            }
            
            console.log(`[GENERATE] Batch ${batchIndex + 1} completed. Total: ${totalProgrammeCount}`);
            batchResults.length = 0;
        }
        
        console.log(`[GENERATE] All batches completed. Total programmes: ${totalProgrammeCount}`);
        
        // Write to file
        console.log(`[GENERATE] Writing XML to file...`);
        const writeStream = fs.createWriteStream(tempFile, { flags: 'w' });
        
        writeStream.write(`<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n`);
        
        validChannels.forEach(c => {
            writeStream.write(`  <channel id="${c.id}">\n    <display-name>${escapeXml(c.name)}</display-name>\n  </channel>\n`);
        });
        
        allProgrammes.forEach(programme => {
            writeStream.write(programme + '\n');
        });
        
        writeStream.write(`</tv>`);
        writeStream.end();
        
        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
        
        console.log(`[GENERATE] ✅ XML generated! Total: ${totalProgrammeCount}`);
        console.log(`[GENERATE] File size: ${(fs.statSync(tempFile).size / 1024 / 1024).toFixed(2)} MB`);
        
        // Upload to GitHub
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
        if (GITHUB_TOKEN) {
            await uploadFileToGitHub(tempFile, targetFileName, GITHUB_TOKEN);
        } else {
            console.error("[GENERATE] ❌ MISSING GITHUB TOKEN!");
        }
        
        // Clean up
        allProgrammes = [];
        if (fs.existsSync(tempFile)) {
            try {
                fs.unlinkSync(tempFile);
            } catch (e) {
                console.log(`[GENERATE] Could not delete temp file: ${e.message}`);
            }
        }
        
        console.log(`[GENERATE] ✅ Task completed successfully!`);
        return true;

    } catch (error) {
        console.error(`[GENERATE] FATAL ERROR:`, error.message);
        if (fs.existsSync(tempFile)) {
            try {
                fs.unlinkSync(tempFile);
            } catch (e) {
                // Ignore
            }
        }
        return false;
    }
}

// ==========================================
// 🔄 UPDATE TASK - ROTATE DAYS
// ==========================================
async function runUpdateTask() {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) {
        console.error("❌ MISSING GITHUB TOKEN!");
        return;
    }
    
    const tempDir = '/tmp/epg_rotation';
    
    try {
        console.log(`[UPDATE] ========================================`);
        console.log(`[UPDATE] Starting full day rotation process`);
        console.log(`[UPDATE] ========================================`);
        
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        // Step 1: Download existing files (Day 0 to Day 8)
        console.log(`[UPDATE] Step 1: Downloading existing files...`);
        const downloadedFiles = [];
        
        for (let i = 0; i <= 8; i++) {
            const fileName = `Day${i}${FILE_SUFFIX}`;
            const localPath = path.join(tempDir, fileName);
            
            const success = await downloadFileFromGitHub(fileName, localPath, GITHUB_TOKEN);
            if (success && fs.existsSync(localPath)) {
                const fileSize = fs.statSync(localPath).size;
                if (fileSize > 0) {
                    downloadedFiles.push({ day: i, fileName, localPath, size: fileSize });
                    console.log(`[UPDATE] Downloaded ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
                }
            } else {
                console.log(`[UPDATE] ${fileName} not found or empty, skipping.`);
            }
            
            await new Promise(r => setTimeout(r, 500));
        }
        
        console.log(`[UPDATE] Downloaded ${downloadedFiles.length} files.`);
        
        // Step 2: Delete all Day files from GitHub
        console.log(`[UPDATE] Step 2: Deleting all Day files from GitHub...`);
        for (let i = 0; i <= 9; i++) {
            const fileName = `Day${i}${FILE_SUFFIX}`;
            await deleteFileFromGitHub(fileName, GITHUB_TOKEN);
            await new Promise(r => setTimeout(r, 300));
        }
        console.log(`[UPDATE] All Day files deleted.`);
        
        // Step 3: Upload rotated files
        console.log(`[UPDATE] Step 3: Uploading rotated files...`);
        for (const fileInfo of downloadedFiles) {
            const newDay = fileInfo.day + 1;
            const newFileName = `Day${newDay}${FILE_SUFFIX}`;
            
            console.log(`[UPDATE] Uploading ${fileInfo.fileName} as ${newFileName}...`);
            await uploadFileToGitHub(fileInfo.localPath, newFileName, GITHUB_TOKEN);
            
            if (fs.existsSync(fileInfo.localPath)) {
                try {
                    fs.unlinkSync(fileInfo.localPath);
                } catch (e) {
                    // Ignore
                }
            }
            
            await new Promise(r => setTimeout(r, 500));
        }
        
        console.log(`[UPDATE] Rotated files uploaded.`);
        
        // Step 4: Generate new Day 0
        console.log(`[UPDATE] Step 4: Generating new Day 0...`);
        await runGenerateTask(0);
        
        console.log(`[UPDATE] ✅ Day rotation completed!`);
        
        // Clean up
        if (fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {
                // Ignore
            }
        }
        
    } catch (error) {
        console.error(`[UPDATE] Error:`, error.message);
        if (fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {
                // Ignore
            }
        }
    }
}

// ==========================================
// 🛠️ FETCH CHANNEL WITH RETRY
// ==========================================
async function fetchChannelWithRetry(channelId, offset) {
    const jioUrl = `https://jiotvapi.cdn.jio.com/apis/v1.3/getepg/get?channel_id=${channelId}&offset=${offset}`;
    let retries = 2;
    
    while (retries > 0) {
        try {
            const epgRes = await fetch(jioUrl, { 
                headers: { 'User-Agent': 'okhttp/4.2.2', 'os': 'android', 'Accept': '*/*' },
                signal: AbortSignal.timeout(10000)
            });
            
            if (epgRes.ok) {
                return await epgRes.json();
            }
            if (epgRes.status === 404) {
                return null;
            }
        } catch (err) {
            await new Promise(r => setTimeout(r, 300));
        }
        retries--;
    }
    return null;
}

// ==========================================
// ☁️ UPLOAD FILE TO GITHUB
// ==========================================
async function uploadFileToGitHub(filePath, fileName, token) {
    try {
        if (!fs.existsSync(filePath)) {
            console.error(`[GitHub] File not found: ${filePath}`);
            return false;
        }
        
        const fileSize = fs.statSync(filePath).size;
        if (fileSize === 0) {
            console.error(`[GitHub] File is empty: ${fileName}`);
            return false;
        }
        
        console.log(`[GitHub] Uploading ${fileName} (${(fileSize / 1024 / 1024).toFixed(2)} MB)...`);
        
        const fileContent = fs.readFileSync(filePath);
        const base64Content = fileContent.toString('base64');
        
        const githubFileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${fileName}`;
        
        // Check if file exists
        let fileSha = null;
        try {
            const checkRes = await fetch(githubFileUrl, {
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'User-Agent': 'Express-Catchup-Generator'
                }
            });
            
            if (checkRes.ok) {
                const fileData = await checkRes.json();
                fileSha = fileData.sha;
                console.log(`[GitHub] File exists, will update.`);
            }
        } catch (e) {
            // File doesn't exist
        }
        
        const requestBody = {
            message: `Update ${fileName} (${new Date().toISOString()})`,
            content: base64Content
        };
        
        if (fileSha) {
            requestBody.sha = fileSha;
        }
        
        const uploadRes = await fetch(githubFileUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Express-Catchup-Generator'
            },
            body: JSON.stringify(requestBody)
        });
        
        if (uploadRes.ok) {
            const responseData = await uploadRes.json();
            console.log(`✅ Uploaded ${fileName} (${(responseData.content.size / 1024 / 1024).toFixed(2)} MB)`);
            return true;
        } else {
            const errorData = await uploadRes.json();
            console.error(`❌ Upload failed for ${fileName}: ${errorData.message}`);
            return false;
        }
        
    } catch (error) {
        console.error(`❌ Upload error for ${fileName}:`, error.message);
        return false;
    }
}

// ==========================================
// 📥 DOWNLOAD FILE FROM GITHUB
// ==========================================
async function downloadFileFromGitHub(fileName, localPath, token) {
    try {
        const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/${fileName}`;
        
        const downloadRes = await fetch(rawUrl, {
            headers: { 
                'Authorization': `Bearer ${token}`,
                'Cache-Control': 'no-cache'
            }
        });
        
        if (!downloadRes.ok) {
            return false;
        }
        
        const contentText = await downloadRes.text();
        
        if (!contentText || contentText.length === 0) {
            return false;
        }
        
        fs.writeFileSync(localPath, contentText, 'utf-8');
        return true;
        
    } catch (error) {
        return false;
    }
}

// ==========================================
// 🗑️ DELETE FILE FROM GITHUB
// ==========================================
async function deleteFileFromGitHub(fileName, token) {
    const githubFileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${fileName}`;
    
    try {
        const checkRes = await fetch(githubFileUrl, {
            headers: { 
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Express-Catchup-Generator'
            }
        });
        
        if (!checkRes.ok) {
            return true; // File doesn't exist
        }
        
        const fileData = await checkRes.json();
        
        const deleteRes = await fetch(githubFileUrl, {
            method: 'DELETE',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Express-Catchup-Generator'
            },
            body: JSON.stringify({
                message: `Delete ${fileName}`,
                sha: fileData.sha
            })
        });
        
        if (deleteRes.ok) {
            console.log(`✅ Deleted ${fileName}`);
            return true;
        }
        return false;
        
    } catch (error) {
        return false;
    }
}

// ==========================================
// 📋 LIST ALL DAY FILES
// ==========================================
app.get('/list-days', async (req, res) => {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) {
        return res.status(500).send('Missing GitHub token');
    }
    
    try {
        const listUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/`;
        const listRes = await fetch(listUrl, {
            headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}` }
        });
        
        if (!listRes.ok) {
            return res.status(500).send('Failed to list files');
        }
        
        const files = await listRes.json();
        const dayFiles = files
            .filter(f => f.name.includes(FILE_SUFFIX) && f.name.startsWith(FILE_PREFIX))
            .sort((a, b) => a.name.localeCompare(b.name));
        
        const fileList = dayFiles.map(f => ({
            name: f.name,
            size: (f.size / 1024 / 1024).toFixed(2) + ' MB',
            download: f.download_url
        }));
        
        res.json({
            total: fileList.length,
            files: fileList
        });
        
    } catch (error) {
        console.error('Error listing files:', error);
        res.status(500).send('Error listing files');
    }
});

app.get('/', (req, res) => res.send("Catchup EPG Scraper is Running!"));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
