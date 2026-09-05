const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// ⚙️ GITHUB CONFIGURATION
// ==========================================
const GITHUB_OWNER = "Ayush8481-dev"; // <--- CHANGE THIS IF NEEDED
const GITHUB_REPO = "Epgdata";        // <--- CHANGE THIS IF NEEDED
const FILE_PATH = "Catchup.xml";      // Uploaded to root directory

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
// Trigger normally for daily smart update (Offset 0). 
// Use ?full=true to manually force a fresh 9-day fetch of all offsets.
app.get('/generate', async (req, res) => {
    const trigger = req.query.trigger === 'true';
    const forceFull = req.query.full === 'true';

    if (trigger) {
        res.status(200).json({ success: true, message: `Worker started in background. Full Fetch: ${forceFull}` });
        runCatchupTask(forceFull); 
    } else {
        await runCatchupTask(forceFull);
        res.send(`✅ Catchup EPG update completed!`);
    }
});

// ==========================================
// 🛠️ CATCHUP EPG GENERATOR TASK
// ==========================================
async function runCatchupTask(forceFull) {
    try {
        console.log(`[EPG] Fetching new Channel List...`);
        const chReq = await fetch("https://raw.githubusercontent.com/Ayush8481Lab/Mm/refs/heads/main/AyushCatchup.json");
        const channelsData = await chReq.json();
        
        // Ensure channels have an ID
        const validChannels = channelsData.filter(c => c.id);
        if (validChannels.length === 0) return console.log(`[EPG] No valid channels found.`);

        // Time logic setup (IST)
        const now = new Date();
        const istTime = new Date(now.getTime() + 19800000); 
        const todayStr = istTime.toISOString().substring(0,10).replace(/-/g, ''); // e.g. "20231025"
        
        // 8 Days ago boundary
        const cutoffDate = new Date(istTime.getTime() - (8 * 86400000));
        const cutoffStr = cutoffDate.toISOString().substring(0,10).replace(/-/g, '');

        let offsetsToFetch = [0];
        let cachedProgrammes = [];
        const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

        // ==========================================
        // 📥 SMART CACHE FETCHER
        // ==========================================
        if (!forceFull && GITHUB_TOKEN) {
            console.log(`[EPG] Attempting to load existing Catchup.xml to cache old data...`);
            try {
                const cacheRes = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${FILE_PATH}`, {
                    headers: { 
                        'Authorization': `Bearer ${GITHUB_TOKEN}`,
                        'Accept': 'application/vnd.github.v3.raw', // Directly get raw decoded text
                        'Cache-Control': 'no-cache'
                    }
                });

                if (cacheRes.ok) {
                    const cacheXml = await cacheRes.text();
                    
                    // High-speed string split to parse old programmes without regex freezing
                    const progBlocks = cacheXml.split('</programme>');
                    for (let i = 0; i < progBlocks.length - 1; i++) {
                        const block = progBlocks[i];
                        const startIdx = block.indexOf('<programme ');
                        if (startIdx === -1) continue;
                        
                        const fullBlock = block.substring(startIdx) + '</programme>';
                        const dateMatch = fullBlock.match(/start="(\d{8})/);
                        
                        if (dateMatch) {
                            const progStartDay = dateMatch[1];
                            // Keep programme if it is older than today, but newer or equal to 8 days ago
                            if (progStartDay < todayStr && progStartDay >= cutoffStr) {
                                cachedProgrammes.push(fullBlock);
                            }
                        }
                    }
                    console.log(`[EPG] ✅ Cache Loaded! Retained ${cachedProgrammes.length} past programmes.`);
                } else {
                    console.log(`[EPG] No existing Catchup file found or failed. Forcing Full 9-Day Fetch.`);
                    forceFull = true; 
                }
            } catch (err) {
                console.log(`[EPG] Cache fetch error. Forcing Full 9-Day Fetch.`);
                forceFull = true;
            }
        }

        // Apply offsets based on scenario
        if (forceFull) {
            offsetsToFetch = [0, -1, -2, -3, -4, -5, -6, -7, -8];
            console.log(`[EPG] Proceeding with FULL FETCH of 9 Days (Offsets: 0 to -8)`);
        } else {
            console.log(`[EPG] Proceeding with DAILY FETCH (Offset: 0 only)`);
        }

        // ==========================================
        // 🔄 FETCH NEW DATA (WITH BATCHING)
        // ==========================================
        const newProgrammes = [];
        
        const fetchChannelWithRetry = async (channelId, offset) => {
            let jioUrl = `https://jiotvapi.cdn.jio.com/apis/v1.3/getepg/get?channel_id=${channelId}&offset=${offset}`;
            let retries = 3; 
            while (retries > 0) {
                try {
                    const epgRes = await fetch(jioUrl, { headers: { 'User-Agent': 'okhttp/4.2.2', 'os': 'android', 'Accept': '*/*' }});
                    if (epgRes.ok) return await epgRes.json();
                    if (epgRes.status === 404) return null;
                } catch (err) {
                    await new Promise(r => setTimeout(r, 600));
                }
                retries--;
            }
            return null;
        };

        // Batch requests to prevent overwhelming JioTV API
        const batchSize = 15; 
        for (let i = 0; i < validChannels.length; i += batchSize) {
            const batch = validChannels.slice(i, i + batchSize);
            console.log(`[EPG] Processing channels ${i + 1} to ${Math.min(i + batchSize, validChannels.length)}...`);
            
            const promises = batch.map(async (channel) => {
                const channelDataLines = [];
                for (const offset of offsetsToFetch) {
                    const data = await fetchChannelWithRetry(channel.id, offset);
                    if (data && data.epg && data.epg.length > 0) {
                        for (const show of data.epg) {
                            const startXml = formatXmltvTime(show.startEpoch);
                            const stopXml = formatXmltvTime(show.endEpoch);
                            const titleXml = escapeXml(show.showname);
                            const descXml = show.description ? `\n    <desc>${escapeXml(show.description)}</desc>` : "";
                            const catXml = show.showCategory ? `\n    <category>${escapeXml(show.showCategory)}</category>` : "";
                            
                            channelDataLines.push(`  <programme start="${startXml}" stop="${stopXml}" channel="${channel.id}">\n    <title>${titleXml}</title>${descXml}${catXml}\n  </programme>`);
                        }
                    }
                }
                return channelDataLines;
            });

            const results = await Promise.all(promises);
            results.flat().forEach(p => newProgrammes.push(p));
            await new Promise(r => setTimeout(r, 1000)); // 1s safety cooldown between batches
        }

        // ==========================================
        // 🧩 MERGE & COMPILE XML
        // ==========================================
        const channelXmlBlocks = validChannels.map(c => `  <channel id="${c.id}">\n    <display-name>${escapeXml(c.name)}</display-name>\n  </channel>`);

        const finalXml = `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n` + 
                         channelXmlBlocks.join('\n') + '\n' + 
                         cachedProgrammes.join('\n') + 
                         (cachedProgrammes.length > 0 ? '\n' : '') + 
                         newProgrammes.join('\n') + 
                         `\n</tv>`;

        // ==========================================
        // ☁️ UPLOAD TO GITHUB
        // ==========================================
        await uploadToGitHub(FILE_PATH, finalXml);

    } catch (error) {
        console.error(`[EPG] FATAL ERROR:`, error.message);
    }
}

// ==========================================
// ☁️ GITHUB DIRECT OVERWRITE UPLOADER
// ==========================================
async function uploadToGitHub(filePath, xmlContent) {
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    if (!GITHUB_TOKEN) return console.error("❌ MISSING GITHUB TOKEN!");

    console.log(`[GitHub] Preparing to update file: ${filePath}`);
    const githubFileUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;
    
    let fileSha = undefined;
    
    // Step 1: Check for existing file SHA to overwrite it directly (Prevents needing DELETE first)
    try {
        const checkExisting = await fetch(`${githubFileUrl}?t=${Date.now()}`, {
            headers: { 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Cache-Control': 'no-cache' }
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
    if (fileSha) requestBody.sha = fileSha; // Providing SHA overwrites existing file

    console.log(`[GitHub] 📤 Uploading XML...`);
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
