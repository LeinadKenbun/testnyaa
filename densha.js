// TokyoTosho provider — mirrors the structure of the Nyaa provider
// Covers filter=1 (Anime) and filter=7 (Raws); hentai categories (4,12,13,14) for adult content
// RSS URL: https://www.tokyotosho.info/rss.php?filter=<cats>&terms=<query>

const sizeMap = {
  B:   1,
  KB:  1000,
  MB:  1000 ** 2,
  GB:  1000 ** 3,
  TB:  1000 ** 4,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4
};

export default new class {
  // https://www.tokyotosho.info/
  url = atob("aHR0cHM6Ly93d3cudG9reW90b3Noby5pbmZvLw==");

  // Category IDs:
  // 1  = Anime      7  = Raws
  // 4  = Hentai    12  = Hentai (Anime)   13 = Hentai (Manga)   14 = Hentai (Games)
  // 11 = Batch     15 = JAV

  _cats(media) {
    if (media.isAdult || media.genres?.includes("Hentai")) return "4,12";
    return "1,7";
  }

  async _search(query, cats) {
    if (!navigator.onLine) return [];
    const url =
      `${this.url}rss.php` +
      `?filter=${encodeURIComponent(cats)}` +
      `&terms=${encodeURIComponent(query)}`;
    return parseRSSItems(await getRSSContent(url));
  }

  async single(
    {
      media,
      episode,
      exclusions,
      episodeCount,
      absoluteEpisodeNumber
    },
    _,
    isBatch = false
  ) {
    if (!navigator.onLine) return [];

    const titles   = createTitle([...Object.values(media.title), ...media.synonyms]);
    const cats     = this._cats(media);
    const prequel  = findEdge(media, "PREQUEL")?.node;
    const sequel   = findEdge(media, "SEQUEL")?.node;
    const absoluteep = absoluteEpisodeNumber ?? episode;
    const episodes = [episode];
    if (absoluteep !== episode && absoluteep > episodeCount) episodes.push(absoluteep);

    // Build episode or batch suffix
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

    // TokyoTosho supports a simple `terms` query — build the best single-string search
    // by using the most common/short title and appending the episode string.
    // We iterate over all title variants and merge results, deduplicating by hash.
    const seen   = new Set();
    let   entries = [];

    for (const title of titles) {
      const q = buildQuery(title, epPart, exclusions);
      const results = await this._search(q, cats);
      for (const entry of results) {
        if (!seen.has(entry.hash)) {
          seen.add(entry.hash);
          entries.push(entry);
        }
      }
    }

    // Date-based filtering (same logic as Nyaa provider)
    const checkSequelDate =
      media.status === "FINISHED" &&
      (sequel?.status === "FINISHED" || sequel?.status === "RELEASING") &&
      sequel?.startDate;
    const sequelStartDate =
      checkSequelDate && new Date(Object.values(checkSequelDate).join(" "));

    const checkPrequelDate =
      (media.status === "FINISHED" || media.status === "RELEASING") &&
      prequel?.status === "FINISHED" &&
      prequel?.endDate;
    const prequelEndDate =
      checkPrequelDate && new Date(Object.values(checkPrequelDate).join(" "));

    if (prequelEndDate)
      entries = entries.filter(e => e.date > new Date(+prequelEndDate + 10699393840));
    if (sequelStartDate && media.format === "TV")
      entries = entries.filter(e => e.date < new Date(+sequelStartDate - 10699393840));

    // Sort by seeders descending (TokyoTosho RSS has no native sort param)
    entries.sort((a, b) => b.seeders - a.seeders);

    return entries;
  }

  batch = (args, opts) => this.single(args, opts, true);
  movie = this.batch;

  async test() {
    try {
      const res = await fetch(`${this.url}rss.php?filter=1`);
      if (!res.ok) throw new Error(`Failed to load data from ${this.url}! Is the site down?`);
      return true;
    } catch (error) {
      throw new Error(
        `Could not reach ${this.url}! Does the site work in your region?`
      );
    }
  }
};

// ─── helpers ────────────────────────────────────────────────────────────────

function zeropad(v = 1, l = 2) {
  return (typeof v === "string" ? v : v.toString()).padStart(l, "0");
}

const epstring = ep =>
  `"E${zeropad(ep)}+"|"E${zeropad(ep)}v"|"+${zeropad(ep)}+"|"+${zeropad(ep)}v"|"+${zeropad(ep)}-"`;

/**
 * Build a query string suitable for TokyoTosho's `terms` parameter.
 * TokyoTosho does not support OR-queries, so we call _search once per title
 * variant and merge in the caller. Here we just produce one clean query.
 */
function buildQuery(title, epPart, exclusions = []) {
  // TokyoTosho `terms` is a simple substring search — no advanced operators.
  // Strip URL-encoded chars that Nyaa needs but TT doesn't understand.
  let q = title
    .replace(/%26/g, "&")
    .replace(/%3F/g, "?")
    .replace(/%23/g, "#");

  // Append episode identifier — pick the first variant (simplest form)
  if (epPart) {
    // Pull the first quoted token, e.g. `"E01+"` → `E01`
    const firstEp = epPart.match(/"([^"]+)"/)?.[1]?.replace(/[+v-]/g, "").trim();
    if (firstEp) q += ` ${firstEp}`;
  }

  return q;
}

function createTitle(_titles) {
  const grouped = [...new Set(_titles.filter(n => n != null && n.length > 3))];
  const titles  = [];

  const appendTitle = t => {
    const title  = t.replace(/&/g, "%26").replace(/\?/g, "%3F").replace(/#/g, "%23");
    titles.push(title);
    const match2 = title.match(/Season (\d)/i);
    const match1 = title.match(/(\d)(?:nd|rd|th) Season/i);
    if (match2)      titles.push(title.replace(/Season \d/i,            `S${match2[1]}`));
    else if (match1) titles.push(title.replace(/(\d)(?:nd|rd|th) Season/i, `S${match1[1]}`));
  };

  for (const t of grouped) {
    appendTitle(t);
    if (t.includes("-")) appendTitle(t.replaceAll("-", ""));
  }
  return titles;
}

function findEdge(media, type, formats = ["TV", "TV_SHORT"], skip) {
  let res = media.relations.edges.find(
    edge => edge.relationType === type && formats.includes(edge.node.format)
  );
  if (!res && !skip && type === "SEQUEL")
    res = findEdge(media, type, ["TV", "TV_SHORT", "OVA"], true);
  return res;
}

/**
 * Parse TokyoTosho RSS items.
 *
 * TokyoTosho item structure (relevant tags):
 *   <title>…</title>
 *   <link>https://www.tokyotosho.info/details.php?id=…</link>
 *   <description>…</description>   — may contain "Size: X MB, Seeders: N, …"
 *   <enclosure url="https://…torrent" length="…" type="application/x-bittorrent"/>
 *   <pubDate>…</pubDate>
 *   <tt:size>…</tt:size>           — if the tt namespace is present
 *   <tt:seeds>…</tt:seeds>
 *   <tt:leech>…</tt:leech>
 *   <tt:downloads>…</tt:downloads>
 *   Infohash is NOT in the RSS; we derive a stub from the torrent URL.
 */
function parseRSSItems(xml) {
  if (!xml) return [];

  const items      = [];
  const itemRegex  = /<item>([\s\S]*?)<\/item>/g;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const c = match[1];

    const title =
      /<title><!\[CDATA\[(.+?)\]\]><\/title>/i.exec(c)?.[1] ||
      /<title>(.+?)<\/title>/i.exec(c)?.[1] ||
      "?";

    // Prefer enclosure URL as the direct .torrent link; fall back to <link>
    const enclosureUrl = /enclosure[^>]+url="([^"]+)"/i.exec(c)?.[1];
    const pageLink     = /<link>([^<]+)<\/link>/i.exec(c)?.[1]?.trim() || "?";
    const link         = enclosureUrl || pageLink;

    const pubDate = /<pubDate>(.+?)<\/pubDate>/i.exec(c)?.[1] ?? 0;

    // tt:* namespace tags (most common in TokyoTosho RSS)
    const seeders   = Number(/<tt:seeds>(.+?)<\/tt:seeds>/i.exec(c)?.[1]   ?? 0);
    const leechers  = Number(/<tt:leech>(.+?)<\/tt:leech>/i.exec(c)?.[1]   ?? 0);
    const downloads = Number(/<tt:downloads>(.+?)<\/tt:downloads>/i.exec(c)?.[1] ?? 0);

    // Size: prefer tt:size, then enclosure length, then parse description
    let sizeInBytes = 0;
    const ttSize = /<tt:size>(.+?)<\/tt:size>/i.exec(c)?.[1];
    if (ttSize) {
      const m = ttSize.match(/([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/i);
      sizeInBytes = m
        ? parseFloat(m[1]) * (sizeMap[m[2]] || 1)
        : parseFloat(ttSize) || 0;
    } else {
      const encLen = /enclosure[^>]+length="(\d+)"/i.exec(c)?.[1];
      if (encLen) {
        sizeInBytes = parseInt(encLen, 10);
      } else {
        // Try to parse "Size: 350.5 MB" from <description>
        const descRaw =
          /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i.exec(c)?.[1] ||
          /<description>([\s\S]*?)<\/description>/i.exec(c)?.[1] || "";
        const sm = descRaw.match(/Size:\s*([\d.]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)/i);
        if (sm) sizeInBytes = parseFloat(sm[1]) * (sizeMap[sm[2]] || 1);
      }
    }

    // Derive a hash stub from the torrent URL (TokyoTosho RSS has no explicit hash field)
    const hash =
      /([0-9a-fA-F]{40})/.exec(link)?.[1] ||
      /id=(\d+)/.exec(link)?.[1] ||
      "?";

    items.push({
      title: decodeHTMLEntities(title),
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

function decodeHTMLEntities(str) {
  return str
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g,  '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'");
}

async function getRSSContent(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed fetching RSS!\n" + res.statusText);
    return await res.text();
  } catch (e) {
    throw new Error("Failed fetching RSS!\n" + e.message);
  }
}
