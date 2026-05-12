// TokyoTosho provider for Hayase
//
// CORS PROBLEM & SOLUTION
// ───────────────────────
// tokyotosho.info does NOT send CORS headers, so direct browser fetches are
// blocked on hayase.app (and any other web origin).  Public CORS proxies like
// corsproxy.io and allorigins also block hayase.app.
//
// The fix: use the AnimeTosho (AT) feed API, which:
//   • Has proper CORS headers (Access-Control-Allow-Origin: *)
//   • Mirrors the full TokyoTosho catalogue in real time
//   • Exposes source=2 to filter for TokyoTosho-only entries
//   • Returns richer metadata (seeders, size, infohash) than TT's own RSS
//
// API docs: https://animetosho.org/api
// Feed API: https://feed.animetosho.org/api  (CORS-safe)
//
// Torznab category IDs used:
//   cat=5070  →  Anime  (covers TT filter=1 Anime + filter=7 Raws)
//   cat=6070  →  XXX    (covers TT filter=4,12 Hentai)

const AT_API = "https://feed.animetosho.org/api";

const sizeMap = {
  B: 1, KB: 1000, MB: 1e6, GB: 1e9, TB: 1e12,
  KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4
};

export default new class {
  // Original TT URL — kept for reference only; fetches go via AnimeTosho
  url = atob("aHR0cHM6Ly93d3cudG9reW90b3Noby5pbmZvLw==");

  _cat(media) {
    return (media.isAdult || media.genres?.includes("Hentai")) ? 6070 : 5070;
  }

  async _search(query, cat) {
    if (!navigator.onLine) return [];
    const url =
      `${AT_API}?t=search` +
      `&q=${encodeURIComponent(query)}` +
      `&source=2` +        // TokyoTosho only
      `&cat=${cat}` +
      `&extended=1` +
      `&limit=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`AnimeTosho API error: ${res.statusText}`);
    return parseATItems(await res.text());
  }

  async single(
    { media, episode, exclusions, episodeCount, absoluteEpisodeNumber },
    _,
    isBatch = false
  ) {
    if (!navigator.onLine) return [];

    const titles     = createTitle([...Object.values(media.title), ...media.synonyms]);
    const cat        = this._cat(media);
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

    for (const title of titles) {
      const q = buildQuery(title, epPart, exclusions);
      try {
        for (const entry of await this._search(q, cat)) {
          if (!seen.has(entry.hash)) {
            seen.add(entry.hash);
            entries.push(entry);
          }
        }
      } catch { /* one title failing shouldn't abort everything */ }
    }

    // Date-based prequel/sequel filtering — identical to Nyaa provider
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
      const res = await fetch(`${AT_API}?t=search&q=test&source=2&limit=1`);
      if (!res.ok) throw new Error(res.statusText);
      const xml = await res.text();
      if (!xml.includes("<rss") && !xml.includes("<channel"))
        throw new Error("Unexpected response from AnimeTosho API");
      return true;
    } catch (e) {
      throw new Error(`Could not reach AnimeTosho (TokyoTosho mirror)!\n${e.message}`);
    }
  }
};

// ─── helpers ────────────────────────────────────────────────────────────────

function zeropad(v = 1, l = 2) {
  return (typeof v === "string" ? v : v.toString()).padStart(l, "0");
}

const epstring = ep =>
  `"E${zeropad(ep)}+"|"E${zeropad(ep)}v"|"+${zeropad(ep)}+"|"+${zeropad(ep)}v"|"+${zeropad(ep)}-"`;

function buildQuery(title, epPart) {
  let q = title.replace(/%26/g, "&").replace(/%3F/g, "?").replace(/%23/g, "#");
  if (epPart) {
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
    if (m2)      titles.push(title.replace(/Season \d/i,             `S${m2[1]}`));
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

/**
 * Parse AnimeTosho Torznab RSS XML.
 *
 * Key tags per <item>:
 *   <title>…</title>
 *   <enclosure url="…torrent" length="…" type="application/x-bittorrent"/>
 *   <pubDate>…</pubDate>
 *   <torznab:attr name="seeders"  value="N"/>
 *   <torznab:attr name="leechers" value="N"/>
 *   <torznab:attr name="grabs"    value="N"/>
 *   <torznab:attr name="infohash" value="…"/>  ← always present
 *   <torznab:attr name="size"     value="N"/>  ← bytes
 */
function parseATItems(xml) {
  if (!xml) return [];
  const items     = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const c = match[1];

    const title =
      /<title><!\[CDATA\[(.+?)\]\]><\/title>/i.exec(c)?.[1] ||
      /<title>(.+?)<\/title>/i.exec(c)?.[1] || "?";

    const enclosureUrl = /enclosure[^>]+url="([^"]+)"/i.exec(c)?.[1];
    const pageLink     = /<link>([^<]+)<\/link>/i.exec(c)?.[1]?.trim() || "?";
    const link         = enclosureUrl || pageLink;

    const pubDate = /<pubDate>(.+?)<\/pubDate>/i.exec(c)?.[1] ?? 0;

    const attr = name => {
      const re = new RegExp(
        `(?:torznab|newznab):attr[^>]+name="${name}"[^>]+value="([^"]*)"`, "i"
      );
      return re.exec(c)?.[1] ?? null;
    };

    const seeders     = Number(attr("seeders")  ?? 0);
    const leechers    = Number(attr("leechers") ?? 0);
    const downloads   = Number(attr("grabs")    ?? 0);
    const sizeInBytes = parseInt(attr("size") ?? /enclosure[^>]+length="(\d+)"/i.exec(c)?.[1] ?? "0", 10);
    const hash        = attr("infohash") || /([0-9a-fA-F]{40})/.exec(link)?.[1] || "?";

    items.push({
      title: decodeEntities(title),
      link,
      seeders,
      leechers,
      downloads,
      size: sizeInBytes,
      hash,
      accuracy: "low",
      date: new Date(pubDate)
    });
  }
  return items;
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
