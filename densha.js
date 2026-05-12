// TokyoTosho provider for Hayase — via AnimeTosho JSON API
//
// tokyotosho.info has no CORS headers → blocked from hayase.app.
// AnimeTosho mirrors TT in real time and sends Access-Control-Allow-Origin: *.
// API: https://feed.animetosho.org/json?q=<query>&limit=100

const AT_JSON    = "https://feed.animetosho.org/json";
const REQ_DELAY  = 500; // ms between sequential requests to avoid 429
const MAX_TITLES = 3;   // max title variants to try per search

export default new class {
  url = atob("aHR0cHM6Ly93d3cudG9reW90b3Noby5pbmZvLw==");

  async _fetch(query) {
    const url = `${AT_JSON}?q=${encodeURIComponent(query)}&limit=100`;
    const res = await fetch(url);
    if (res.status === 429) throw new Error("Rate limited by AnimeTosho — try again shortly");
    if (!res.ok) throw new Error(`AnimeTosho error ${res.status}`);
    const json = await res.json();
    return Array.isArray(json) ? json : [];
  }

  async single(
    { media, episode, exclusions, episodeCount, absoluteEpisodeNumber },
    _,
    isBatch = false
  ) {
    if (!navigator.onLine) return [];

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

    const seen    = new Set();
    let   entries = [];

    for (let i = 0; i < titles.length; i++) {
      if (i > 0) await sleep(REQ_DELAY);
      try {
        const items = await this._fetch(buildQuery(titles[i], epPart));
        for (const item of items) {
          const hash = (item.info_hash || String(item.id)).toLowerCase();
          if (!seen.has(hash)) {
            seen.add(hash);
            entries.push(toEntry(item, hash));
          }
        }
        if (entries.length >= 50) break;
      } catch (e) {
        if (e.message.includes("Rate limited")) throw e;
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
      throw new Error(`Could not reach AnimeTosho!\n${e.message}`);
    }
  }
};

// ─── map AT JSON item → Hayase entry ────────────────────────────────────────
// AT JSON fields (top-level, all direct):
//   title, info_hash, id, magnet_uri, torrent_url, link
//   seeders, leechers, total_size, timestamp, num_files

function toEntry(item, hash) {
  return {
    title:     item.title     || "?",
    link:      item.magnet_uri || item.torrent_url || item.link || "?",
    seeders:   item.seeders   ?? 0,
    leechers:  item.leechers  ?? 0,
    downloads: item.num_files ?? 0,
    size:      item.total_size ?? 0,
    hash,
    accuracy:  "low",
    date:      new Date((item.timestamp ?? 0) * 1000)
  };
}

// ─── title helpers ───────────────────────────────────────────────────────────

function pickTitles(media) {
  const { romaji, english } = media.title;
  const candidates = [];

  const push = t => {
    if (!t || t.length <= 3) return;
    const norm = t.trim();
    if (!candidates.some(c => c.toLowerCase() === norm.toLowerCase()))
      candidates.push(norm);
  };

  push(romaji);
  if (english && english !== romaji) push(english);

  // Season alias (e.g. "2nd Season" → "S2")
  for (const t of [romaji, english]) {
    if (!t) continue;
    const m2 = t.match(/Season (\d)/i);
    const m1 = t.match(/(\d)(?:nd|rd|th) Season/i);
    if (m2) push(t.replace(/Season \d/i, `S${m2[1]}`));
    else if (m1) push(t.replace(/(\d)(?:nd|rd|th) Season/i, `S${m1[1]}`));
  }

  if (candidates.length === 0) {
    const syn = [...(media.synonyms || [])]
      .filter(s => s && s.length > 3)
      .sort((a, b) => a.length - b.length)[0];
    push(syn);
  }

  return candidates.slice(0, MAX_TITLES);
}

function buildQuery(title, epPart) {
  // AT search is plain substring — no special operators needed
  let q = title.replace(/[&?#]/g, " ").replace(/\s+/g, " ").trim();
  if (epPart) {
    const firstEp = epPart.match(/"([^"]+)"/)?.[1]?.replace(/[+v-]/g, "").trim();
    if (firstEp) q += ` ${firstEp}`;
  }
  return q;
}

// ─── shared helpers ──────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

function zeropad(v = 1, l = 2) {
  return (typeof v === "string" ? v : v.toString()).padStart(l, "0");
}

const epstring = ep =>
  `"E${zeropad(ep)}+"|"E${zeropad(ep)}v"|"+${zeropad(ep)}+"|"+${zeropad(ep)}v"|"+${zeropad(ep)}-"`;

function findEdge(media, type, formats = ["TV", "TV_SHORT"], skip) {
  let res = media.relations.edges.find(
    e => e.relationType === type && formats.includes(e.node.format)
  );
  if (!res && !skip && type === "SEQUEL")
    res = findEdge(media, type, ["TV", "TV_SHORT", "OVA"], true);
  return res;
}
