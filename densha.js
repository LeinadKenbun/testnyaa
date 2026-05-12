// TokyoTosho provider for Hayase — via AnimeTosho JSON API
//
// Why AnimeTosho and not tokyotosho.info directly:
//   TT has no CORS headers → blocked from hayase.app.
//   Public proxies (corsproxy.io, allorigins) also block hayase.app.
//   AnimeTosho mirrors TT in real time and has Access-Control-Allow-Origin: *.
//
// Why JSON and not the Torznab/RSS endpoint:
//   The RSS/XML endpoint is slow and we were firing it once per title variant,
//   causing a 10-second timeout. The JSON endpoint is much faster and supports
//   multiple search terms in one request.
//
// API: https://feed.animetosho.org/json?q=<query>
// Docs: https://animetosho.org/api  (scroll to "JSON API")

const AT_JSON = "https://feed.animetosho.org/json";

// AnimeTosho source IDs  (used to filter to TT-only results)
//   1 = Nyaa    2 = TokyoTosho    3 = AniDex (removed)
const TT_SOURCE_ID = 2;

export default new class {
  // Original TT URL kept for display; all fetches go through AnimeTosho
  url = atob("aHR0cHM6Ly93d3cudG9reW90b3Noby5pbmZvLw==");

  /**
   * Single JSON fetch for one query string.
   * Returns raw AT JSON array filtered to TT source entries.
   */
  async _fetch(query) {
    const url = `${AT_JSON}?q=${encodeURIComponent(query)}&order=seeders&limit=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`AnimeTosho JSON API error ${res.status}: ${res.statusText}`);
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    // Filter to TokyoTosho-source entries only
    return json.filter(item =>
      Array.isArray(item.trackers) &&
      item.trackers.some(t => t.source_id === TT_SOURCE_ID)
    );
  }

  async single(
    { media, episode, exclusions, episodeCount, absoluteEpisodeNumber },
    _,
    isBatch = false
  ) {
    if (!navigator.onLine) return [];

    const titles     = createTitle([...Object.values(media.title), ...media.synonyms]);
    const prequel    = findEdge(media, "PREQUEL")?.node;
    const sequel     = findEdge(media, "SEQUEL")?.node;
    const absoluteep = absoluteEpisodeNumber ?? episode;
    const episodes   = [episode];
    if (absoluteep !== episode && absoluteep > episodeCount) episodes.push(absoluteep);

    // Episode / batch suffix
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

    // Build one query per title variant, then fire ALL in parallel (Promise.all).
    // This avoids the sequential-waterfall timeout that killed the previous version.
    const queries = titles.map(t => buildQuery(t, epPart));
    const results = await Promise.allSettled(queries.map(q => this._fetch(q)));

    // Merge, deduplicate by infohash
    const seen    = new Set();
    let   entries = [];
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const item of r.value) {
        const hash = item.info_hash?.toLowerCase() || item.id?.toString() || "?";
        if (!seen.has(hash)) {
          seen.add(hash);
          entries.push(toEntry(item, hash));
        }
      }
    }

    // Date-based prequel/sequel filtering — same logic as Nyaa provider
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
      const json = await res.json();
      if (!Array.isArray(json)) throw new Error("Unexpected response from AnimeTosho JSON API");
      return true;
    } catch (e) {
      throw new Error(`Could not reach AnimeTosho (TokyoTosho mirror)!\n${e.message}`);
    }
  }
};

// ─── shape an AT JSON item into a Hayase torrent entry ───────────────────────

function toEntry(item, hash) {
  // Prefer magnet URI; fall back to direct .torrent link
  const link = item.magnet_uri || item.torrent_url || item.link || "?";

  // Seeder/leecher data lives inside item.trackers[]
  let seeders = 0, leechers = 0;
  if (Array.isArray(item.trackers)) {
    for (const t of item.trackers) {
      seeders  = Math.max(seeders,  t.seeders  ?? 0);
      leechers = Math.max(leechers, t.leechers ?? 0);
    }
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

// ─── helpers (identical logic to Nyaa provider) ──────────────────────────────

function zeropad(v = 1, l = 2) {
  return (typeof v === "string" ? v : v.toString()).padStart(l, "0");
}

const epstring = ep =>
  `"E${zeropad(ep)}+"|"E${zeropad(ep)}v"|"+${zeropad(ep)}+"|"+${zeropad(ep)}v"|"+${zeropad(ep)}-"`;

function buildQuery(title, epPart) {
  let q = title.replace(/%26/g, "&").replace(/%3F/g, "?").replace(/%23/g, "#");
  if (epPart) {
    // Pull the simplest ep token, e.g. "E01" from the OR-string
    const firstEp = epPart.match(/"([^"]+)"/)?.[1]?.replace(/[+v-]/g, "").trim();
    if (firstEp) q += ` ${firstEp}`;
  }
  return q;
}

function createTitle(_titles) {
  const grouped = [...new Set(_titles.filter(n => n != null && n.length > 3))];
  const titles  = [];
  const appendTitle = t => {
    const title = t.replace(/&/g, "%26").replace(/\?/g, "%3F").replace(/#/g, "%23");
    titles.push(title);
    const m2 = title.match(/Season (\d)/i);
    const m1 = title.match(/(\d)(?:nd|rd|th) Season/i);
    if (m2)      titles.push(title.replace(/Season \d/i,              `S${m2[1]}`));
    else if (m1) titles.push(title.replace(/(\d)(?:nd|rd|th) Season/i, `S${m1[1]}`));
  };
  for (const t of grouped) {
    appendTitle(t);
    if (t.includes("-")) appendTitle(t.replaceAll("-", ""));
  }
  return titles;
}

function findEdge(media, type, formats = ["TV", "TV_SHORT"], skip) {
  let res = media.relations.edges.find(
    e => e.relationType === type && formats.includes(e.node.format)
  );
  if (!res && !skip && type === "SEQUEL")
    res = findEdge(media, type, ["TV", "TV_SHORT", "OVA"], true);
  return res;
}
