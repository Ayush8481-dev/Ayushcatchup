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
const FILE_PATH = "Catchup.xml";      

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
// 🚀 API ENDPOINT - GENERATOR
// ==========================================
app.get('/generate', async (req, res) => {
    const trigger = req.query.trigger === 'true';
    const forceFull = req.query.full === 'true';

    if (trigger) {
        res.status(200).json({ success: true, message: `Worker started. Memory-Optimized mode active. Full Fetch: ${forceFull}` });
        runCatchupTask(forceFull); 
    } else {
        await runCatchupTask(forceFull);
        res.send(`✅ Catchup EPG update completed!`);
    }
});

// ==========================================
// 🛠️ MEMORY-OPTIMIZED GENERATOR TASK
// ==========================================
async function runCatchupTask(forceFull) {
    const tempDir = '/tmp/epg_temp';
    const tempFile = path.join(tempDir, 'catchup.xml');
    
    try {
        // Create temp directory
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        console.log(`[EPG] Fetching new Channel List...`);
        const chReq = await fetch("https://raw.githubusercontent.com/Ayush8481Lab/Mm/refs/heads/main/AyushCatchup.json");
        const channelsData = await chReq.json();
        
        const validChannels = channelsData.filter(c => c.id);
        if (validChannels.length === 0) return console.log(`[EPG] No valid channels found.`);

        const now = new Date();
        const istTime = new Date(now.getTime() + 19800000); 
        const todayStr = istTime.toISOString().substring(0,10).replace(/-/g, ''); 
        const cutoffDate = new Date(istTime.getTime() - (8 * 86400000));
        const cutoffStr = cutoffDate.toISOString().substring(0,10).replace(/-/g, '');

        let offsetsToFetch = [0];
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

        // Create write stream
        const writeStream = fs.createWriteStream(tempFile, { flags: 'w' });
        
        // Write XML header
        writeStream.write(`<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n`);
        
        // Write channels
        validChannels.forEach(c => {
            writeStream.write(`  <channel id="${c.id}">\n    <display-name>${escapeXml(c.name)}</display-name>\n  </channel>\n`);
        });

        // ==========================================
        // 📥 SMART CACHE FETCHER
        // ==========================================
        if (!forceFull && GITHUB_TOKEN) {
            console.log(`[EPG] Attempting to load existing Catchup.xml to cache old data...`);
            try {
                const cacheRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`, {
                    headers: { 
                        'Authorization': `Bearer ${GITHUB_TOKEN}`,
                        'Accept': 'application/vnd.github.v3.raw',
                        'Cache-Control': 'no-cache'
                    }
                });

                if (cacheRes.ok) {
                    let cacheXml = await cacheRes.text();
                    const progBlocks = cacheXml.split('</programme>');
                    let cachedCount = 0;
                    
                    for (let i = 0; i < progBlocks.length - 1; i++) {
                        const block = progBlocks[i];
                        const startIdx = block.indexOf('<programme ');
                        if (startIdx === -1) continue;
                        
                        const fullBlock = block.substring(startIdx) + '</programme>';
                        const dateMatch = fullBlock.match(/start="(\d{8})/);
                        
                        if (dateMatch) {
                            const progStartDay = dateMatch[1];
                            if (progStartDay < todayStr && progStartDay >= cutoffStr) {
                                writeStream.write(fullBlock + '\n');
                                cachedCount++;
                            }
                        }
                    }
                    console.log(`[EPG] ✅ Cache Loaded! Retained ${cachedCount} past programmes.`);
                    // Clear cacheXml from memory
                    cacheXml = null;
                } else {
                    console.log(`[EPG] File missing or failed. Forcing Full 9-Day Fetch.`);
                    forceFull = true; 
                }
            } catch (err) {
                console.log(`[EPG] Cache fetch error. Forcing Full 9-Day Fetch.`);
                forceFull = true;
            }
        }

        if (forceFull) {
            offsetsToFetch = [0, -1, -2, -3, -4, -5, -6, -7, -8];
            console.log(`[EPG] Proceeding with FULL FETCH of 9 Days (Offsets: 0 to -8)`);
        }

        const fetchChannelWithRetry = async (channelId, offset) => {
            let jioUrl = `https://jiotvapi.cdn.jio.com/apis/v1.3/getepg/get?channel_id=${channelId}&offset=${offset}`;
            let retries = 2;
            while (retries > 0) {
                try {
                    const epgRes = await fetch(jioUrl, { 
                        headers: { 'User-Agent': 'okhttp/4.2.2', 'os': 'android', 'Accept': '*/*' },
                        signal: AbortSignal.timeout(10000)
                    });
                    if (epgRes.ok) return await epgRes.json();
                    if (epgRes.status === 404) return null;
                } catch (err) {
                    await new Promise(r => setTimeout(r, 300));
                }
                retries--;
            }
            return null;
        };

        // Process channels sequentially
        let programmeCount = 0;
        
        for (let i = 0; i < validChannels.length; i++) {
            const channel = validChannels[i];
            
            try {
                // Fetch one day at a time
                for (const offset of offsetsToFetch) {
                    let data = await fetchChannelWithRetry(channel.id, offset);
                    
                    if (data && data.epg && data.epg.length > 0) {
                        for (const show of data.epg) {
                            const startXml = formatXmltvTime(show.startEpoch);
                            const stopXml = formatXmltvTime(show.endEpoch);
                            const titleXml = escapeXml(show.showname);
                            const descXml = show.description ? `\n    <desc>${escapeXml(show.description)}</desc>` : "";
                            const catXml = show.showCategory ? `\n    <category>${escapeXml(show.showCategory)}</category>` : "";
                            
                            writeStream.write(`  <programme start="${startXml}" stop="${stopXml}" channel="${channel.id}">\n    <title>${titleXml}</title>${descXml}${catXml}\n  </programme>\n`);
                            programmeCount++;
                        }
                    }
                    
                    // Clear data reference
                    data = null;
                    await new Promise(r => setTimeout(r, 50));
                }
                
                if ((i + 1) % 10 === 0 || i === validChannels.length - 1) {
                    console.log(`[EPG] Completed channel ${i + 1}/${validChannels.length}: ${channel.name} (Total programmes: ${programmeCount})`);
                }
                
            } catch (err) {
                console.error(`[EPG] Error processing channel ${channel.name}:`, err.message);
            }
        }

        // Close the write stream
        writeStream.write(`</tv>`);
        writeStream.end();
        
        // Wait for stream to finish
        await new Promise((resolve, reject) => {
            writeStream.on('finish', resolve);
            writeStream.on('error', reject);
        });
        
        console.log(`[EPG] ✅ XML generated! Total programmes: ${programmeCount}`);
        console.log(`[EPG] File size: ${(fs.statSync(tempFile).size / 1024 / 1024).toFixed(2)} MB`);
        
        // ==========================================
        // ☁️ UPLOAD IN PARTS
        // ==========================================
        await uploadFileInParts(tempFile, GITHUB_TOKEN);
        
        // Clean up temp file
        fs.unlinkSync(tempFile);
        console.log(`[EPG] ✅ Task completed successfully!`);

    } catch (error) {
        console.error(`[EPG] FATAL ERROR:`, error.message);
        // Clean up on error
        if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
        }
    }
}

// ==========================================
// ☁️ UPLOAD FILE IN PARTS (FIXED)
// ==========================================
async function uploadFileInParts(filePath, token) {
    if (!token) {
        console.error("❌ MISSING GITHUB TOKEN!");
        return;
    }

    const fileSize = fs.statSync(filePath).size;
    console.log(`[GitHub] Preparing to upload ${(fileSize / 1024 / 1024).toFixed(2)} MB file in parts...`);
    
    // Split into 5MB parts for base64 (5MB * 4/3 = 6.67MB base64)
    const PART_SIZE = 5 * 1024 * 1024; // 5MB per part
    const totalParts = Math.ceil(fileSize / PART_SIZE);
    
    console.log(`[GitHub] Splitting into ${totalParts} parts of 5MB each...`);
    
    try {
        // Read the entire file in chunks and upload each part
        const fileBuffer = fs.readFileSync(filePath);
        
        for (let i = 0; i < totalParts; i++) {
            const start = i * PART_SIZE;
            const end = Math.min(start + PART_SIZE, fileSize);
            let partBuffer = fileBuffer.subarray(start, end); // Changed to let
            
            // Upload each part as a separate file
            const partFileName = `${FILE_PATH}.part${String(i + 1).padStart(3, '0')}`;
            const partContent = partBuffer.toString('base64');
            
            console.log(`[GitHub] Uploading part ${i + 1}/${totalParts} (${(partBuffer.length / 1024 / 1024).toFixed(2)} MB)...`);
            
            const uploadResult = await uploadSingleFile(partFileName, partContent, token);
            
            if (uploadResult) {
                console.log(`✅ Part ${i + 1} uploaded successfully`);
            } else {
                console.error(`❌ Failed to upload part ${i + 1}`);
                break; // Stop if a part fails
            }
            
            // Clear references
            partBuffer = null;
            
            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }
            
            // Small delay between parts
            await new Promise(r => setTimeout(r, 500));
        }
        
        console.log(`[GitHub] ✅ All parts uploaded successfully!`);
        console.log(`[GitHub] Parts can be combined using: cat ${FILE_PATH}.part* > ${FILE_PATH}`);
        
    } catch (error) {
        console.error(`❌ [GitHub] Upload Error:`, error.message);
    }
}

// ==========================================
// ☁️ UPLOAD SINGLE FILE
// ==========================================
async function uploadSingleFile(fileName, contentBase64, token) {
    const githubFileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${fileName}`;
    
    try {
        // Check if file exists
        let fileSha = undefined;
        try {
            const checkExisting = await fetch(githubFileUrl, {
                headers: { 
                    'Authorization': `Bearer ${token}`,
                    'Cache-Control': 'no-cache',
                    'User-Agent': 'Express-Catchup-Generator'
                }
            });
            
            if (checkExisting.ok) {
                const existingFileData = await checkExisting.json();
                fileSha = existingFileData.sha;
            }
        } catch (e) {
            // File doesn't exist, create new
        }
        
        const requestBody = {
            message: `Update ${fileName} (${new Date().toISOString().substring(0, 10)})`,
            content: contentBase64
        };
        
        if (fileSha) {
            requestBody.sha = fileSha;
        }
        
        const uploadResponse = await fetch(githubFileUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Express-Catchup-Generator'
            },
            body: JSON.stringify(requestBody)
        });
        
        if (uploadResponse.ok) {
            const responseData = await uploadResponse.json();
            console.log(`✅ Uploaded ${fileName}`);
            return { sha: responseData.content.sha };
        } else {
            const errorData = await uploadResponse.json();
            console.error(`❌ Failed to upload ${fileName}:`, errorData.message);
            return null;
        }
        
    } catch (error) {
        console.error(`❌ Error uploading ${fileName}:`, error.message);
        return null;
    }
}

// ==========================================
// 📥 COMBINE PARTS ENDPOINT
// ==========================================
app.get('/combine', async (req, res) => {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) {
        return res.status(500).send('Missing GitHub token');
    }
    
    try {
        console.log(`[GitHub] Starting to combine parts...`);
        
        // List all part files
        const listUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/`;
        const listRes = await fetch(listUrl, {
            headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}` }
        });
        
        if (!listRes.ok) {
            return res.status(500).send('Failed to list files');
        }
        
        const files = await listRes.json();
        const partFiles = files
            .filter(f => f.name.startsWith(`${FILE_PATH}.part`))
            .sort((a, b) => a.name.localeCompare(b.name));
        
        if (partFiles.length === 0) {
            return res.status(404).send('No part files found');
        }
        
        console.log(`[GitHub] Found ${partFiles.length} part files`);
        
        // Download and combine all parts
        let combinedContent = '';
        
        for (const part of partFiles) {
            console.log(`[GitHub] Downloading ${part.name}...`);
            const downloadRes = await fetch(part.download_url, {
                headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}` }
            });
            
            if (downloadRes.ok) {
                const partContent = await downloadRes.text();
                combinedContent += partContent;
            }
        }
        
        // Upload combined file
        const finalContent = Buffer.from(combinedContent, 'utf-8').toString('base64');
        
        console.log(`[GitHub] Uploading combined file (${(combinedContent.length / 1024 / 1024).toFixed(2)} MB)...`);
        
        // Get current file SHA if exists
        let fileSha = undefined;
        const checkUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`;
        const checkRes = await fetch(checkUrl, {
            headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}` }
        });
        
        if (checkRes.ok) {
            const fileData = await checkRes.json();
            fileSha = fileData.sha;
        }
        
        const requestBody = {
            message: `Combine EPG parts (${new Date().toISOString().substring(0, 10)})`,
            content: finalContent
        };
        
        if (fileSha) {
            requestBody.sha = fileSha;
        }
        
        const uploadRes = await fetch(checkUrl, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Express-Catchup-Generator'
            },
            body: JSON.stringify(requestBody)
        });
        
        if (uploadRes.ok) {
            // Delete part files
            for (const part of partFiles) {
                await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${part.name}`, {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${GITHUB_TOKEN}`,
                        'Content-Type': 'application/json',
                        'User-Agent': 'Express-Catchup-Generator'
                    },
                    body: JSON.stringify({
                        message: `Delete part file ${part.name}`,
                        sha: part.sha
                    })
                });
            }
            
            res.send('✅ Parts combined and uploaded successfully!');
        } else {
            res.status(500).send('Failed to upload combined file');
        }
        
    } catch (error) {
        console.error('❌ Combine error:', error);
        res.status(500).send('Error combining parts');
    }
});

app.get('/', (req, res) => res.send("Catchup EPG Scraper is Running!"));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
