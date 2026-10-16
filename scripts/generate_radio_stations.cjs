// scripts/generate_radio_stations.cjs
const fs = require('fs');
const path = require('path');

async function main() {
  console.log('[RadioGen] Fetching top 3,000 global radio stations from Radio Browser API...');
  const API = 'https://de1.api.radio-browser.info';
  
  try {
    const [res1, res2, res3, res4, res5] = await Promise.all([
      fetch(`${API}/json/stations/search?limit=1500&hidebroken=true&lastcheckok=1&order=votes&reverse=true&is_https=true`),
      fetch(`${API}/json/stations/search?limit=1500&hidebroken=true&lastcheckok=1&order=clickcount&reverse=true&is_https=true`),
      fetch(`${API}/json/stations/search?limit=800&hidebroken=true&lastcheckok=1&order=bitrate&reverse=true&is_https=true`),
      fetch(`${API}/json/stations/bytag/synthwave?limit=300&hidebroken=true&lastcheckok=1`),
      fetch(`${API}/json/stations/bytag/ambient?limit=300&hidebroken=true&lastcheckok=1`)
    ]);

    const list1 = await res1.json();
    const list2 = await res2.json();
    const list3 = await res3.json();
    const list4 = await res4.json();
    const list5 = await res5.json();

    const seen = new Set();
    const combined = [];

    const BAD_EXT = /\.(pls|asx|ram|qtl)(\?|#|$)/i;

    for (const st of [...list1, ...list2, ...list3, ...list4, ...list5]) {
      const url = st.url_resolved || st.url;
      if (!url || seen.has(url) || !st.name) continue;
      if (BAD_EXT.test(url)) continue;
      if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
      seen.add(url);

      combined.push({
        id: st.stationuuid,
        name: st.name.trim(),
        url: url,
        url_resolved: url,
        country: st.country || 'Global',
        countrycode: st.countrycode || '',
        state: st.state || '',
        tags: st.tags || '',
        genre: st.tags ? st.tags.split(',')[0].trim() : 'Various',
        codec: st.codec || 'MP3',
        bitrate: st.bitrate || 128,
        logo: st.favicon || '',
        votes: st.votes || 0,
        clickcount: st.clickcount || 0
      });
      if (combined.length >= 3000) break;
    }

    console.log(`[RadioGen] Collected ${combined.length} unique live radio stations!`);

    const outJsonPathSrc = path.resolve(__dirname, '..', 'src', 'web', 'public', 'radio-stations.json');
    const outJsonPathDist = path.resolve(__dirname, '..', 'dist', 'web', 'public', 'radio-stations.json');

    const jsonStr = JSON.stringify(combined, null, 2);
    fs.writeFileSync(outJsonPathSrc, jsonStr, 'utf8');
    fs.writeFileSync(outJsonPathDist, jsonStr, 'utf8');
    console.log(`[RadioGen] Saved ${combined.length} stations to src/ and dist/ radio-stations.json (${(jsonStr.length / 1024 / 1024).toFixed(2)} MB)`);

  } catch (err) {
    console.error('[RadioGen] Error fetching stations:', err);
    process.exit(1);
  }
}

main();
