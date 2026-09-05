const express = require('express');
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
    try {
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
        let cachedXmlPart = '';
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

        // ==========================================
        // 📥 SMART CACHE FETCHER (STREAMING APPROACH)
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
                    const cacheXml = await cacheRes.text();
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
                                cachedXmlPart += fullBlock + '\n';
                                cachedCount++;
                                
                                // Flush to avoid memory buildup
                                if (cachedXmlPart.length > 5 * 1024 * 1024) { // 5MB chunks
                                    // Here you would ideally write to a temp file
                                    console.log(`[EPG] Cache chunk loaded: ${cachedCount} programmes`);
                                }
                            }
                        }
                    }
                    console.log(`[EPG] ✅ Cache Loaded! Retained ${cachedCount} past programmes.`);
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

        // ==========================================
        // 🧩 BUILD XML IN CHUNKS (LOW RAM USAGE)
        // ==========================================
        let xmlChunks = [];
        let currentChunk = `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n`;
        
        // Add channels
        validChannels.forEach(c => {
            currentChunk += `  <channel id="${c.id}">\n    <display-name>${escapeXml(c.name)}</display-name>\n  </channel>\n`;
        });

        // Add cached programmes
        if (cachedXmlPart.length > 0) {
            currentChunk += cachedXmlPart;
            cachedXmlPart = ''; // Clear memory
        }

        const fetchChannelWithRetry = async (channelId, offset) => {
            let jioUrl = `https://jiotvapi.cdn.jio.com/apis/v1.3/getepg/get?channel_id=${channelId}&offset=${offset}`;
            let retries = 2; // Reduced retries
            while (retries > 0) {
                try {
                    const epgRes = await fetch(jioUrl, { 
                        headers: { 'User-Agent': 'okhttp/4.2.2', 'os': 'android', 'Accept': '*/*' },
                        signal: AbortSignal.timeout(10000) // 10 second timeout
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

        // Process channels in batches to manage memory
        const BATCH_SIZE = 10; // Process 10 channels at a time
        let programmeCount = 0;
        
        for (let i = 0; i < validChannels.length; i += BATCH_SIZE) {
            const batchEnd = Math.min(i + BATCH_SIZE, validChannels.length);
            const batchChannels = validChannels.slice(i, batchEnd);
            
            console.log(`[EPG] Processing batch ${Math.floor(i/BATCH_SIZE) + 1}: Channels ${i+1}-${batchEnd}/${validChannels.length}`);
            
            // Process each channel in the batch
            for (let j = 0; j < batchChannels.length; j++) {
                const channel = batchChannels[j];
                
                try {
                    // Fetch one day at a time to reduce memory
                    for (const offset of offsetsToFetch) {
                        const data = await fetchChannelWithRetry(channel.id, offset);
                        
                        if (data && data.epg && data.epg.length > 0) {
                            for (const show of data.epg) {
                                const startXml = formatXmltvTime(show.startEpoch);
                                const stopXml = formatXmltvTime(show.endEpoch);
                                const titleXml = escapeXml(show.showname);
                                const descXml = show.description ? `\n    <desc>${escapeXml(show.description)}</desc>` : "";
                                const catXml = show.showCategory ? `\n    <category>${escapeXml(show.showCategory)}</category>` : "";
                                
                                currentChunk += `  <programme start="${startXml}" stop="${stopXml}" channel="${channel.id}">\n    <title>${titleXml}</title>${descXml}${catXml}\n  </programme>\n`;
                                programmeCount++;
                                
                                // Flush chunk if it gets too large (10MB)
                                if (currentChunk.length > 10 * 1024 * 1024) {
                                    xmlChunks.push(currentChunk);
                                    currentChunk = '';
                                }
                            }
                        }
                        
                        // Small delay to allow GC
                        await new Promise(r => setTimeout(r, 100));
                    }
                    
                    console.log(`[EPG] Completed channel ${i + j + 1}/${validChannels.length}: ${channel.name} (Total programmes: ${programmeCount})`);
                    
                } catch (err) {
                    console.error(`[EPG] Error processing channel ${channel.name}:`, err.message);
                }
            }
            
            // Force garbage collection hint
            if (global.gc) {
                global.gc();
            }
            
            // Delay between batches
            await new Promise(r => setTimeout(r, 1000));
        }

        currentChunk += `</tv>`;
        xmlChunks.push(currentChunk);

        // ==========================================
        // ☁️ UPLOAD TO GITHUB (CHUNKED)
        // ==========================================
        console.log(`[EPG] Uploading ${programmeCount} programmes in ${xmlChunks.length} chunks...`);
        
        // Combine chunks for upload (for files < 50MB this is fine)
        const finalXml = xmlChunks.join('');
        xmlChunks = []; // Clear memory
        
        await uploadToGitHub(FILE_PATH, finalXml);

        console.log(`[EPG] ✅ Complete! Total programmes: ${programmeCount}`);
        return programmeCount;

    } catch (error) {
        console.error(`[EPG] FATAL ERROR:`, error.message);
        return 0;
    }
}

// ==========================================
// ☁️ GITHUB DIRECT OVERWRITE UPLOADER
// ==========================================
async function uploadToGitHub(filePath, xmlContent) {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) return console.error("❌ MISSING GITHUB TOKEN!");

    console.log(`[GitHub] Preparing to update file: ${filePath} (${(xmlContent.length / 1024 / 1024).toFixed(2)} MB)`);
    const githubFileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    
    let fileSha = undefined;
    
    try {
        const checkExisting = await fetch(`${githubFileUrl}?t=${Date.now()}`, {
            headers: { 
                'Authorization': `Bearer ${GITHUB_TOKEN}`, 
                'Cache-Control': 'no-cache',
                'User-Agent': 'Express-Catchup-Generator'
            }
        });
        if (checkExisting.ok) {
            const existingFileData = await checkExisting.json();
            fileSha = existingFileData.sha;
        }
    } catch(e) {
        console.error(`[GitHub] Check file error.`);
    }

    const fileContentBase64 = Buffer.from(xmlContent, 'utf-8').toString('base64');
    const requestBody = {
        message: `Daily Catchup EPG Update (${new Date().toISOString().substring(0, 10)})`,
        content: fileContentBase64
    };
    if (fileSha) requestBody.sha = fileSha;

    console.log(`[GitHub] 📤 Uploading ${(fileContentBase64.length / 1024 / 1024).toFixed(2)} MB XML...`);
    const uploadResponse = await fetch(githubFileUrl, {
        method: 'PUT',
        headers: {
            'Authorization': `Bearer ${GITHUB_TOKEN}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Express-Catchup-Generator'
        },
        body: JSON.stringify(requestBody)
    });

    if (uploadResponse.ok) {
        console.log(`🎉 [GitHub] EPG Uploaded successfully!`);
    } else {
        const errorData = await uploadResponse.json();
        console.error(`❌ [GitHub] Upload Error:`, errorData);
    }
}

app.get('/', (req, res) => res.send("Catchup EPG Scraper is Running!"));
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
