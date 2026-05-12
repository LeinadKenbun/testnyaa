// TokyoTosho provider for Hayase — via AnimeTosho JSON API
//
// CORS: tokyotosho.info blocks browser fetches; AnimeTosho mirrors TT in
//       real time and sends Access-Control-Allow-Origin: *.
// API:  https://feed.animetosho.org/json?q=<query>&limit=100
// Docs: https://animetosho.org/api

const AT_JSON     = "https://feed.animetosho.org/json";
const TT_SOURCE   = 2;   // AnimeTosho source_id for TokyoTosho
const REQ_DELAY   = 600; // ms between sequential requests (avoids 429)
const MAX_TITLES  = 3;   // only use the best N title variants per search

export default new class {
  url = atob("aHR0cHM6Ly93d3cudG9reW90b3Noby5pbmZvLw==");

  async _fetch(query) {
    const url = `${AT_JSON}?q=${encodeURIComponent(query)}&order=seeders&limit=100`;
    const res = await fetch(url);
    if (res.status === 429) throw new Error("Rate limited by AnimeTosho — try again in a moment");
    if (!res.ok) throw new Error(`AnimeTosho error ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.filter(item =>
      Array.isArray(item.trackers) &&
      item.trackers.some(t => t.source_id === TT_SOURCE)
    );
  }

  async single(
    { media, episode, exclusions, episodeCount, absoluteEpisodeNumber },
    _,
    isBatch = false
  ) {
    if (!navigator.onLine) return [];

    // Pick only the best title variants to minimise request count
    const titles     = pickTitles(media);
    const prequel    = findEdge(media, "PREQUEL")?.node;
    const sequel     = findEdge(media, "SEQUEL")?.node;
    const absoluteep = absoluteEpisodeNumber ?? episode;
    const episodes   = [episode];
    if (absoluteep !== episode && absoluteep > episodeCount) episodes.push(absoluteep);

    let epPart = "";
    if (episodeCount > 1) {
      if (isBatch) {
        const digits = Math.max(2, episodeCount.toString().length);
        epPart =
          `"${zeropad(1, digits)}-${zeropad(episodeCount, digits)}"` +
          `|"${zeropad(1, digits)}~${zeropad(episodeCount, digits)}"` +
          `|"1-${episodeCount}"|"1~${episodeCount}"` +
          `|"batch"|"complete"` +
          (prequel ? "" : '|"S01"');
      } else {
        epPart = episodes.map(epstring).join("|");
      }
    }

    // Fire requests sequentially with a small delay between each.
    // Parallel blasting caused 429s; sequential + delay stays under the limit.
    const seen    = new Set();
    let   entries = [];

    for (let i = 0; i < titles.length; i++) {
      if (i > 0) await sleep(REQ_DELAY);
      try {
        const results = await this._fetch(buildQuery(titles[i], epPart));
        for (const item of results) {
          const hash = item.info_hash?.toLowerCase() || String(item.id);
          if (!seen.has(hash)) {
            seen.add(hash);
            entries.push(toEntry(item, hash));
          }
        }
        // Stop early if we already have plenty of results
        if (entries.length >= 50) break;
      } catch (e) {
        if (e.message.includes("Rate limited")) throw e; // surface 429 immediately
        // other errors: skip this title variant and continue
      }
    }

    // Date-based prequel/sequel filtering
    const checkSequelDate =
      media.status === "FINISHED" &&
      (sequel?.status === "FINISHED" || sequel?.status === "RELEASING") &&
      sequel?.startDate;
    const sequelStartDate =
      checkSequelDate && new Date(Object.values(checkSequelDate).join(" "));

    const checkPrequelDate =
      (media.status === "FINISHED" || media.status === "RELEASING") &&
      prequel?.status === "FINISHED" && prequel?.endDate;
    const prequelEndDate =
      checkPrequelDate && new Date(Object.values(checkPrequelDate).join(" "));

    if (prequelEndDate)
      entries = entries.filter(e => e.date > new Date(+prequelEndDate + 10699393840));
    if (sequelStartDate && media.format === "TV")
      entries = entries.filter(e => e.date < new Date(+sequelStartDate - 10699393840));

    entries.sort((a, b) => b.seeders - a.seeders);
    return entries;
  }

  batch = (args, opts) => this.single(args, opts, true);
  movie = this.batch;

  async test() {
    try {
      const res = await fetch(`${AT_JSON}?q=test&limit=1`);
      if (!res.ok) throw new Error(res.statusText);
      if (!Array.isArray(await res.json())) throw new Error("Unexpected response");
      return true;
    } catch (e) {
      throw new Error(`Could not reach AnimeTosho (TokyoTosho mirror)!\n${e.message}`);
    }
  }
};

// ─── title selection ─────────────────────────────────────────────────────────
// Instead of generating every possible variant, pick at most MAX_TITLES
// candidates in priority order:
//   1. romaji title  (usually what TT uploaders use)
//   2. english title (if meaningfully different)
//   3. shortest synonym > 3 chars (as a fallback)

function pickTitles(media) {
  const { romaji, english, native } = media.title;
  const candidates = [];

  const push = t => {
    if (!t || t.length <= 3) return;
    // Normalise and de-duplicate
    const norm = t.trim();
    if (!candidates.some(c => c.toLowerCase() === norm.toLowerCase()))
      candidates.push(norm);
  };

  push(romaji);
  if (english && english !== romaji) push(english);

  // Add season alias if present
  for (const t of [romaji, english]) {
    if (!t) continue;
    const m2 = t.match(/Season (\d)/i);
    const m1 = t.match(/(\d)(?:nd|rd|th) Season/i);
    if (m2) push(t.replace(/Season \d/i, `S${m2[1]}`));
    else if (m1) push(t.replace(/(\d)(?:nd|rd|th) Season/i, `S${m1[1]}`));
  }

  // Fallback: shortest synonym
  if (candidates.length === 0) {
    const syn = [...(media.synonyms || [])]
      .filter(s => s && s.length > 3)
      .sort((a, b) => a.length - b.length)[0];
    push(syn);
  }

  return candidates.slice(0, MAX_TITLES);
}

// ─── entry shaping ───────────────────────────────────────────────────────────

function toEntry(item, hash) {
  const link = item.magnet_uri || item.torrent_url || item.link || "?";
  let seeders = 0, leechers = 0;
  for (const t of (item.trackers || [])) {
    seeders  = Math.max(seeders,  t.seeders  ?? 0);
    leechers = Math.max(leechers, t.leechers ?? 0);
  }
  return {
    title:     item.title || "?",
    link,
    seeders,
    leechers,
    downloads: item.num_files ?? 0,
    size:      item.total_size ?? 0,
    hash,
    accuracy:  "low",
    date:      new Date((item.timestamp ?? 0) * 1000)
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function zeropad(v = 1, l = 2) {
  return (typeof v === "string" ? v : v.toString()).padStart(l, "0");
}

const epstring = ep =>
  `"E${zeropad(ep)}+"|"E${zeropad(ep)}v"|"+${zeropad(ep)}+"|"+${zeropad(ep)}v"|"+${zeropad(ep)}-"`;

function buildQuery(title, epPart) {
  let q = title.replace(/&/g, "").replace(/\?/g, "").replace(/#/g, "");
  if (epPart) {
    const firstEp = epPart.match(/"([^"]+)"/)?.[1]?.replace(/[+v-]/g, "").trim();
    if (firstEp) q += ` ${firstEp}`;
  }
  return q.trim();
}

function findEdge(media, type, formats = ["TV", "TV_SHORT"], skip) {
  let res = media.relations.edges.find(
    e => e.relationType === type && formats.includes(e.node.format)
  );
  if (!res && !skip && type === "SEQUEL")
    res = findEdge(media, type, ["TV", "TV_SHORT", "OVA"], true);
  return res;
}
